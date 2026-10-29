// Brain Bolt AI service.
//
// Single entry point for AI-powered question generation. Server-only (.server.ts).
//
// Responsibilities:
//   1. Compose a prompt via PROMPT_VERSIONS.
//   2. Call the configured provider.
//   3. Parse + validate the response via shared validateQuiz.
//   4. Record a row in ai_usage_log via recordUsage.
//   5. Return a typed GenerationResult envelope.
//
// NEVER throws raw provider errors. Always returns GenerationResult with
// either draft + null error or null draft + AiError.code.

import {
  AiError,
  MAX_GENERATION_COUNT,
  MIN_GENERATION_COUNT,
  SUPPORTED_AI_TYPES,
  type AiErrorCode,
  type BrainBoltAiServiceOptions,
  type GenerateQuestionsRequest,
  type GenerationResult,
  type RegenerateQuestionRequest,
  type RegenerationResult,
  type SupportedAiType,
  type UsageRecord,
} from "@/lib/ai/types";

import { PROMPT_VERSIONS, emptyQuizShell, extractJsonObject } from "@/lib/ai/prompts";
import { validateQuiz, type BrainBoltQuestion, type BrainBoltQuiz } from "@/lib/quiz/validate";
import { DEFAULT_MODEL_ID, estimateCost } from "@/lib/ai/cost-table";
import { BedrockDeepSeekV3Provider } from "@/lib/ai/providers/bedrock-deepseek-v3.server";
import { BedrockDeepSeekProvider } from "@/lib/ai/providers/bedrock-deepseek.server";
import { recordUsage } from "@/lib/ai/usage-log.server";
import { ModelRouter, PrepTask, modelRouter, prepAiEnabled } from "@/lib/ai/model-router";
import { prepTaskConfig } from "@/lib/ai/cost-table";
import { PROMPT_PREP_VERSIONS } from "@/lib/ai/prep-prompts";
import type { SupabaseClient } from "@supabase/supabase-js";

// Re-export for callers that imported MAX_GENERATION_COUNT from this module.
export { MAX_GENERATION_COUNT };

/** Optional task-scoped generation controls. When `task` is set, the call is
 * routed through the ModelRouter (task-based model selection) instead of the
 * singleton provider, and usage is attributed to an `ai.prep_*` capability. */
export type AiServiceCallOptions = {
  /** Prep-pipeline task (routes to a task-appropriate model). Optional. */
  task?: PrepTask;
};

/**
 * Singleton-style service. Construct one per request (cheap) so the
 * provider can capture per-request env (Cloudflare Workers / Vercel
 * serverless bind env at request time).
 */
export class BrainBoltAiService {
  private provider: import("@/lib/ai/types").AiProvider;
  private router: ModelRouter | null = null;

  constructor(opts: BrainBoltAiServiceOptions & { router?: ModelRouter } = {}) {
    if (opts.provider) {
      this.provider = opts.provider;
      if (opts.router) this.router = opts.router;
      return;
    }
    // Pick a provider by BRAINBOLT_AI_PROVIDER env (default: bedrock-deepseek).
    // Pick a model by BRAINBOLT_AI_MODEL env (default: DeepSeek R1).
    //
    // V3.2 is still supported — set BRAINBOLT_AI_PROVIDER=bedrock-deepseek-v3
    // and BRAINBOLT_AI_MODEL=us.deepseek.v3.2:0 to opt in. V3.2 is cheaper
    // and faster, but R1 stays the default because its structured-output
    // quality has been more reliable in production so far.
    const providerName = process.env.BRAINBOLT_AI_PROVIDER ?? "bedrock-deepseek";
    const modelId = process.env.BRAINBOLT_AI_MODEL ?? DEFAULT_MODEL_ID;
    switch (providerName) {
      case "bedrock-deepseek-v3":
        this.provider = new BedrockDeepSeekV3Provider(modelId);
        break;
      case "bedrock-deepseek":
        this.provider = new BedrockDeepSeekProvider(modelId);
        break;
      default:
        throw new Error(`BrainBoltAiService: unknown BRAINBOLT_AI_PROVIDER "${providerName}"`);
    }
    if (opts.router) this.router = opts.router;
  }

  /**
   * Reconstructs kill switch state from the latest ai.kill_switch_toggled
   * audit row in ai_usage_log. estimated_cost_usd = 1 means enabled.
   */
  private async isKillSwitchEnabled(supabaseAdmin: SupabaseClient): Promise<boolean> {
    const { data } = await supabaseAdmin
      .from("ai_usage_log")
      .select("estimated_cost_usd")
      .eq("capability", "ai.kill_switch_toggled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.estimated_cost_usd === 1;
  }

  /**
   * Generate `req.count` questions on `req.topic`. Returns a typed envelope.
   * NEVER throws — failure modes are mapped to AiErrorCode.
   *
   * When `options.task` is set, the call is routed through the ModelRouter
   * (task-based model selection, e.g. `question_generate`) and usage is
   * attributed to the `ai.prep_generate` capability. The legacy text
   * generation path (`task` unset) is unchanged.
   *
   * Over-limit requests are rejected before any AI call (no usage log row
   * for the rejected call — the user didn't pay for nothing).
   */
  async generateQuestions(
    supabaseAdmin: SupabaseClient,
    principalId: string,
    req: GenerateQuestionsRequest,
    options: AiServiceCallOptions = {},
  ): Promise<GenerationResult> {
    const task = options.task;
    const isPrep = task !== undefined;

    // Prep administrative kill switch — checked before any Bedrock call.
    // When PREP_AI_ENABLED=false, no new prep Bedrock requests are initiated.
    const capability: "ai.generate_questions" | "ai.prep_generate" = isPrep
      ? "ai.prep_generate"
      : "ai.generate_questions";
    const promptVersion = isPrep ? `prep_generate_${task!}_v1` : "generate_questions_v1";
    const router = this.router ?? modelRouter;

    if (isPrep && !prepAiEnabled()) {
      return await this.recordAndReturn(supabaseAdmin, {
        draft: null,
        warnings: [],
        error: "over_limit",
        principalId,
        capability,
        promptVersion,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        success: false,
      });
    }

    // Legacy kill switch (Mission Control) — applies to the text-generation
    // path. Prep has its own PREP_AI_ENABLED guard above.
    if (!isPrep && (await this.isKillSwitchEnabled(supabaseAdmin))) {
      return await this.recordAndReturn(supabaseAdmin, {
        draft: null,
        warnings: [],
        error: "over_limit",
        principalId,
        capability,
        promptVersion,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        success: false,
      });
    }

    // Server-side guards. The client validates too (defense in depth) but
    // these run unconditionally on every server call.
    if (req.count < MIN_GENERATION_COUNT || req.count > MAX_GENERATION_COUNT) {
      return await this.recordAndReturn(supabaseAdmin, {
        draft: null,
        warnings: [],
        error: "over_limit",
        principalId,
        capability,
        promptVersion,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        success: false,
      });
    }
    if (req.types.length === 0) {
      return await this.recordAndReturn(supabaseAdmin, {
        draft: null,
        warnings: [],
        error: "validation_failed",
        principalId,
        capability,
        promptVersion,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        success: false,
      });
    }
    // Reject unsupported types before any AI call.
    const supportedSet: ReadonlySet<SupportedAiType> = new Set(SUPPORTED_AI_TYPES);
    for (const t of req.types) {
      if (!supportedSet.has(t)) {
        return await this.recordAndReturn(supabaseAdmin, {
          draft: null,
          warnings: [],
          error: "validation_failed",
          principalId,
          capability,
          promptVersion,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          success: false,
        });
      }
    }

    const version = PROMPT_VERSIONS.generate_questions_v1;
    const system = version.system;
    const user = version.buildUser(req);

    // Task-aware token budget and temperature (legacy path keeps 8000/0.4).
    const maxOutputTokens = isPrep ? prepTaskConfig(task!).maxOutputTokens : 8000;
    const temperature = isPrep ? prepTaskConfig(task!).temperature : 0.4;

    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let rawText: string | null = null;

    try {
      let response;
      if (isPrep) {
        response = await router.generate(task!, {
          system,
          user,
          maxOutputTokens,
          temperature,
        });
      } else {
        response = await this.provider.generate({
          system,
          user,
          maxOutputTokens,
          temperature,
        });
      }
      inputTokens = response.inputTokens;
      outputTokens = response.outputTokens;
      latencyMs = response.latencyMs;
      rawText = response.text;

      // Parse JSON.
      const parsed = extractJsonObject(response.text);
      if (!parsed) {
        return await this.recordAndReturn(supabaseAdmin, {
          draft: null,
          warnings: [],
          error: "invalid_output",
          principalId,
          capability,
          promptVersion,
          inputTokens,
          outputTokens,
          latencyMs,
          success: false,
        });
      }

      // Run the provider-specific parse first (cheap, just shape check).
      const parsedByVersion = version.parse(parsed);
      if (!parsedByVersion) {
        return await this.recordAndReturn(supabaseAdmin, {
          draft: null,
          warnings: [],
          error: "invalid_output",
          principalId,
          capability,
          promptVersion,
          inputTokens,
          outputTokens,
          latencyMs,
          success: false,
        });
      }

      // Build a quiz shell around the parsed questions and run validateQuiz.
      // First map each model-shape question to the canonical BrainBolt
      // shape (the model emits `question` / `correct_answer` / etc., the
      // validator expects `text` / `correctIndex` / etc.). Drop any
      // questions we can't map cleanly.
      const rawQuestions = (parsedByVersion as { questions: unknown[] }).questions;
      const mappedQuestions = rawQuestions
        .map(modelQuestionToCanonical)
        .filter((q): q is BrainBoltQuestion => q !== null);
      const candidate: BrainBoltQuiz = {
        ...emptyQuizShell(),
        questions: mappedQuestions,
      };
      const report = validateQuiz(candidate);

      if (!report.valid) {
        return await this.recordAndReturn(supabaseAdmin, {
          draft: null,
          warnings: report.warnings.map((w) => w.message),
          error: "validation_failed",
          principalId,
          capability,
          promptVersion,
          inputTokens,
          outputTokens,
          latencyMs,
          success: false,
        });
      }

      // Count-mismatch check (brief §4): if requested count != generated,
      // surface as a warning (partial draft), not a hard error.
      const warnings: string[] = [...report.warnings.map((w) => w.message)];
      const got = candidate.questions.length;
      if (got === 0) {
        // Every question failed mapping. Treat as validation failure so
        // the creator sees the friendly error rather than a confusing empty
        // draft.
        return await this.recordAndReturn(supabaseAdmin, {
          draft: null,
          warnings,
          error: "validation_failed",
          principalId,
          capability,
          promptVersion,
          inputTokens,
          outputTokens,
          latencyMs,
          success: false,
        });
      }
      if (got !== req.count) {
        warnings.push(
          `Brain Bolt AI returned ${got} question${got === 1 ? "" : "s"}; you asked for ${req.count}.`,
        );
      }

      // Only return the first N questions if the model overshot. Never
      // silently drop a question the creator didn't see.
      let finalQuestions = candidate.questions;
      if (got > req.count) {
        finalQuestions = candidate.questions.slice(0, req.count);
        warnings.push(`Brain Bolt AI returned more than requested; kept the first ${req.count}.`);
      }

      return await this.recordAndReturn(supabaseAdmin, {
        draft: { ...emptyQuizShell(), questions: finalQuestions },
        warnings,
        error: null,
        principalId,
        capability,
        promptVersion,
        inputTokens,
        outputTokens,
        latencyMs,
        success: true,
      });
    } catch (e: unknown) {
      // Provider threw (translated to AiCode by the provider).
      const eAsRecord = e as { aiCode?: unknown };
      const errorCode: AiErrorCode =
        typeof eAsRecord.aiCode === "string"
          ? (eAsRecord.aiCode as AiErrorCode)
          : "provider_unavailable";
      // Log internally but never propagate.
      console.error("[ai/service] generateQuestions failed", {
        principalId,
        rawTextPreview: rawText?.slice(0, 200),
        cause: e instanceof Error ? { name: e.name, message: e.message } : e,
      });
      return await this.recordAndReturn(supabaseAdmin, {
        draft: null,
        warnings: [],
        error: errorCode,
        principalId,
        capability,
        promptVersion,
        inputTokens,
        outputTokens,
        latencyMs,
        success: false,
      });
    }
  }

  /**
   * Generate source-grounded questions for the prep pipeline.
   *
   * Mirrors generateQuestions but accepts source excerpts (page/section
   * anchors) and returns the canonical questions PLUS the per-question
   * source refs the server records in prep_sources. The model may emit extra
   * citation fields (page/section/excerpt) which are captured here and
   * stripped before validateQuiz so they never reach the question schema.
   *
   * NEVER throws. Returns { questions, sources } on success or null + error
   * on failure.
   */
  async generateGroundedQuestions(
    supabaseAdmin: SupabaseClient,
    principalId: string,
    req: {
      topic: string;
      count: number;
      difficulty: string;
      types: string[];
      instructions?: string;
      excerpts: Array<{ page: number; section?: string; excerpt: string }>;
      existingQuestionTexts?: string[];
    },
    task: PrepTask = "question_generate",
  ): Promise<{
    questions: BrainBoltQuestion[];
    sources: Array<{
      questionIndex: number;
      page: number;
      section: string | null;
      excerpt: string;
    }>;
    warnings: string[];
    error: AiErrorCode | null;
  }> {
    const router = this.router ?? modelRouter;
    const capability = "ai.prep_generate";
    const promptVersion = `prep_generate_${task}_v1`;

    // Prep administrative kill switch.
    if (!prepAiEnabled()) {
      return { questions: [], sources: [], warnings: [], error: "over_limit" };
    }

    // Guard counts before any AI call.
    if (req.count < MIN_GENERATION_COUNT || req.count > MAX_GENERATION_COUNT) {
      return { questions: [], sources: [], warnings: [], error: "over_limit" };
    }
    if (req.excerpts.length === 0) {
      return { questions: [], sources: [], warnings: [], error: "validation_failed" };
    }

    const version = PROMPT_PREP_VERSIONS.prep_generate_question_generate_v1;
    const system = version.system;
    const user = version.buildUser(req as Parameters<typeof version.buildUser>[0]);

    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let rawText: string | null = null;

    try {
      const cfg = prepTaskConfig(task);
      const response = await router.generate(task, {
        system,
        user,
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: cfg.temperature,
      });
      inputTokens = response.inputTokens;
      outputTokens = response.outputTokens;
      latencyMs = response.latencyMs;
      rawText = response.text;

      const parsed = extractJsonObject(response.text);
      if (!parsed) {
        await recordUsage(
          supabaseAdmin,
          this.buildUsageRecord({
            principalId,
            capability,
            promptVersion,
            inputTokens,
            outputTokens,
            latencyMs,
            success: false,
            errorKind: "invalid_output",
          }),
        );
        return { questions: [], sources: [], warnings: [], error: "invalid_output" };
      }
      const parsedByVersion = version.parse(parsed);
      if (!parsedByVersion) {
        await recordUsage(
          supabaseAdmin,
          this.buildUsageRecord({
            principalId,
            capability,
            promptVersion,
            inputTokens,
            outputTokens,
            latencyMs,
            success: false,
            errorKind: "invalid_output",
          }),
        );
        return { questions: [], sources: [], warnings: [], error: "invalid_output" };
      }

      const rawQuestions = (parsedByVersion as { questions: unknown[] }).questions;
      const questions: BrainBoltQuestion[] = [];
      const sources: Array<{
        questionIndex: number;
        page: number;
        section: string | null;
        excerpt: string;
      }> = [];

      rawQuestions.forEach((r, i) => {
        const q = modelQuestionToCanonical(r);
        if (!q) return;
        const questionIndex = questions.length;
        questions.push(q);
        const src = r as Record<string, unknown>;
        sources.push({
          questionIndex,
          page: typeof src.page === "number" ? src.page : 0,
          section: typeof src.section === "string" ? src.section : null,
          excerpt: typeof src.excerpt === "string" ? src.excerpt : "",
        });
      });

      const candidate: BrainBoltQuiz = { ...emptyQuizShell(), questions };
      const report = validateQuiz(candidate);
      if (!report.valid || questions.length === 0) {
        await recordUsage(
          supabaseAdmin,
          this.buildUsageRecord({
            principalId,
            capability,
            promptVersion,
            inputTokens,
            outputTokens,
            latencyMs,
            success: false,
            errorKind: "validation_failed",
          }),
        );
        return {
          questions: [],
          sources: [],
          warnings: report.warnings.map((w) => w.message),
          error: "validation_failed",
        };
      }

      const warnings: string[] = [...report.warnings.map((w) => w.message)];
      if (questions.length !== req.count) {
        warnings.push(
          `Brain Bolt AI returned ${questions.length} question${questions.length === 1 ? "" : "s"}; you asked for ${req.count}.`,
        );
      }

      await recordUsage(
        supabaseAdmin,
        this.buildUsageRecord({
          principalId,
          capability,
          promptVersion,
          inputTokens,
          outputTokens,
          latencyMs,
          success: true,
          errorKind: null,
        }),
      );
      return { questions, sources, warnings, error: null };
    } catch (e: unknown) {
      const eAsRecord = e as { aiCode?: unknown };
      const errorCode: AiErrorCode =
        typeof eAsRecord.aiCode === "string"
          ? (eAsRecord.aiCode as AiErrorCode)
          : "provider_unavailable";
      console.error("[ai/service] generateGroundedQuestions failed", {
        principalId,
        rawTextPreview: rawText?.slice(0, 200),
        cause: e instanceof Error ? { name: e.name, message: e.message } : e,
      });
      await recordUsage(
        supabaseAdmin,
        this.buildUsageRecord({
          principalId,
          capability,
          promptVersion,
          inputTokens,
          outputTokens,
          latencyMs,
          success: false,
          errorKind: errorCode,
        }),
      );
      return { questions: [], sources: [], warnings: [], error: errorCode };
    }
  }

  /**
   * Regenerate ONE question. Mirrors generateQuestions but with a single-
   * question prompt and stricter token budget.
   */
  async regenerateQuestion(
    supabaseAdmin: SupabaseClient,
    principalId: string,
    req: RegenerateQuestionRequest,
  ): Promise<RegenerationResult> {
    // Kill switch — when enabled by an admin via Mission Control, all AI
    // generation is blocked before any provider call is made.
    if (await this.isKillSwitchEnabled(supabaseAdmin)) {
      return {
        question: null,
        warnings: [],
        error: "over_limit",
      };
    }

    const version = PROMPT_VERSIONS.regenerate_question_v1;
    const system = version.system;
    const user = version.buildUser(req);

    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let rawText: string | null = null;

    const recordArgs: {
      principalId: string;
      capability: "ai.regenerate_question";
      promptVersion: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      success: boolean;
      errorKind: AiErrorCode | null;
    } = {
      principalId,
      capability: "ai.regenerate_question",
      promptVersion: "regenerate_question_v1",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      success: false,
      errorKind: null,
    };

    try {
      const response = await this.provider.generate({
        system,
        user,
        maxOutputTokens: 2000,
        temperature: 0.5,
      });
      inputTokens = response.inputTokens;
      outputTokens = response.outputTokens;
      latencyMs = response.latencyMs;
      rawText = response.text;
      recordArgs.inputTokens = inputTokens;
      recordArgs.outputTokens = outputTokens;
      recordArgs.latencyMs = latencyMs;

      const parsed = extractJsonObject(response.text);
      if (!parsed) {
        recordArgs.success = false;
        recordArgs.errorKind = "invalid_output";
        await recordUsage(supabaseAdmin, this.buildUsageRecord(recordArgs));
        return { question: null, warnings: [], error: "invalid_output" };
      }
      const parsedByVersion = version.parse(parsed);
      if (!parsedByVersion) {
        recordArgs.success = false;
        recordArgs.errorKind = "invalid_output";
        await recordUsage(supabaseAdmin, this.buildUsageRecord(recordArgs));
        return { question: null, warnings: [], error: "invalid_output" };
      }

      const newQuestion = modelQuestionToCanonical(
        (parsedByVersion as { question: unknown }).question,
      );
      if (!newQuestion) {
        recordArgs.success = false;
        recordArgs.errorKind = "validation_failed";
        recordArgs.inputTokens = inputTokens;
        recordArgs.outputTokens = outputTokens;
        recordArgs.latencyMs = latencyMs;
        await recordUsage(supabaseAdmin, this.buildUsageRecord(recordArgs));
        return {
          question: null,
          warnings: ["Returned question could not be mapped to a known type."],
          error: "validation_failed",
        };
      }
      const report = validateQuiz({
        ...emptyQuizShell(),
        questions: [newQuestion],
      });
      if (!report.valid) {
        recordArgs.success = false;
        recordArgs.errorKind = "validation_failed";
        await recordUsage(supabaseAdmin, this.buildUsageRecord(recordArgs));
        return {
          question: null,
          warnings: report.warnings.map((w) => w.message),
          error: "validation_failed",
        };
      }
      // Same-type check (the model MUST replace with the same type).
      if (newQuestion.type !== req.replace.type) {
        recordArgs.success = false;
        recordArgs.errorKind = "validation_failed";
        await recordUsage(supabaseAdmin, this.buildUsageRecord(recordArgs));
        return {
          question: null,
          warnings: [
            `Returned type "${newQuestion.type}" doesn't match the original "${req.replace.type}".`,
          ],
          error: "validation_failed",
        };
      }

      recordArgs.success = true;
      recordArgs.errorKind = null;
      await recordUsage(supabaseAdmin, this.buildUsageRecord(recordArgs));
      return { question: newQuestion, warnings: [], error: null };
    } catch (e: unknown) {
      const eAsRecord = e as { aiCode?: unknown };
      const errorCode: AiErrorCode =
        typeof eAsRecord.aiCode === "string"
          ? (eAsRecord.aiCode as AiErrorCode)
          : "provider_unavailable";
      console.error("[ai/service] regenerateQuestion failed", {
        principalId,
        rawTextPreview: rawText?.slice(0, 200),
        cause: e instanceof Error ? { name: e.name, message: e.message } : e,
      });
      recordArgs.success = false;
      recordArgs.errorKind = errorCode;
      recordArgs.inputTokens = inputTokens;
      recordArgs.outputTokens = outputTokens;
      recordArgs.latencyMs = latencyMs;
      await recordUsage(supabaseAdmin, this.buildUsageRecord(recordArgs));
      return { question: null, warnings: [], error: errorCode };
    }
  }

  private async recordAndReturn(
    supabaseAdmin: SupabaseClient,
    args: {
      draft: BrainBoltQuiz | null;
      warnings: string[];
      error: AiErrorCode | null;
      principalId: string;
      capability: "ai.generate_questions" | "ai.prep_generate" | "ai.regenerate_question";
      promptVersion: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      success: boolean;
    },
  ): Promise<GenerationResult> {
    await recordUsage(supabaseAdmin, {
      principalId: args.principalId,
      capability: args.capability,
      model: this.provider.modelId,
      promptVersion: args.promptVersion,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      latencyMs: args.latencyMs,
      estimatedCostUsd: estimateCost(this.provider.modelId, args.inputTokens, args.outputTokens),
      success: args.success,
      errorKind: args.error,
    });
    return { draft: args.draft, warnings: args.warnings, error: args.error };
  }

  private buildUsageRecord(args: {
    principalId: string;
    capability:
      | "ai.generate_questions"
      | "ai.regenerate_question"
      | "ai.prep_generate"
      | "ai.prep_quality_review";
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    success: boolean;
    errorKind: AiErrorCode | null;
  }): UsageRecord {
    return {
      principalId: args.principalId,
      capability: args.capability,
      model: this.provider.modelId,
      promptVersion: args.promptVersion,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      latencyMs: args.latencyMs,
      estimatedCostUsd: estimateCost(this.provider.modelId, args.inputTokens, args.outputTokens),
      success: args.success,
      errorKind: args.errorKind,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Model output → canonical Brain Bolt question shape                  */
/* ------------------------------------------------------------------ */

/**
 * The model emits questions in a "natural" shape with field names that
 * LLMs tend to follow reliably (`question`, `correct_answer` as text, etc.).
 * The canonical Brain Bolt shape uses `text`, `correctIndex`, and other
 * fields that match the question-registry and validateQuiz expectations.
 *
 * This mapper converts model output to the canonical shape. It also does
 * defensive defaults (clamping range, defaulting tolerance) so the
 * downstream validateQuiz gate is more likely to accept the draft.
 *
 * Returns `null` for individual questions that can't be mapped cleanly
 * (e.g. unknown type, missing required fields). The caller is expected
 * to drop the nulls before passing to validateQuiz.
 */
export function modelQuestionToCanonical(raw: unknown): BrainBoltQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type : null;
  const text =
    typeof r.question === "string" ? r.question : typeof r.text === "string" ? r.text : null;
  if (!type || !text) return null;

  switch (type) {
    case "mcq": {
      const options = Array.isArray(r.options)
        ? r.options.filter((o): o is string => typeof o === "string" && o.length > 0)
        : [];
      if (options.length < 2) return null;
      const correctAnswer =
        typeof r.correct_answer === "string"
          ? r.correct_answer
          : typeof r.correctIndex === "number"
            ? (options[r.correctIndex] ?? null)
            : null;
      if (correctAnswer === null) return null;
      // Resolve text → index.
      const correctIndex = options.findIndex(
        (o) => o.toLowerCase().trim() === correctAnswer.toLowerCase().trim(),
      );
      if (correctIndex === -1) return null;
      return {
        type: "mcq",
        text,
        options,
        correctIndex,
      };
    }
    case "true_false": {
      if (typeof r.correct === "boolean") {
        return { type: "true_false", text, correct: r.correct };
      }
      if (typeof r.correct_answer === "string") {
        const v = r.correct_answer.trim().toLowerCase();
        if (v === "true" || v === "t" || v === "yes") {
          return { type: "true_false", text, correct: true };
        }
        if (v === "false" || v === "f" || v === "no") {
          return { type: "true_false", text, correct: false };
        }
      }
      return null;
    }
    case "number": {
      const correctNumber =
        typeof r.correct_number === "number"
          ? r.correct_number
          : typeof r.correctNumber === "number"
            ? r.correctNumber
            : null;
      const min = typeof r.min === "number" ? r.min : null;
      const max = typeof r.max === "number" ? r.max : null;
      if (correctNumber === null || min === null || max === null) return null;
      const tolerance =
        typeof r.tolerance === "number" && r.tolerance >= 0
          ? r.tolerance
          : Math.max((max - min) * 0.1, 1);
      const format =
        typeof r.format === "string" &&
        ["general", "year", "decimal", "percentage", "currency"].includes(r.format)
          ? (r.format as "general" | "year" | "decimal" | "percentage" | "currency")
          : "general";
      return {
        type: "number",
        text,
        correctNumber,
        min,
        max,
        tolerance,
        format,
      };
    }
    case "type": {
      const acceptedAnswers = Array.isArray(r.accepted_answers)
        ? r.accepted_answers.filter((a): a is string => typeof a === "string" && a.length > 0)
        : Array.isArray(r.acceptedAnswers)
          ? r.acceptedAnswers.filter((a): a is string => typeof a === "string" && a.length > 0)
          : [];
      if (acceptedAnswers.length === 0) return null;
      return { type: "type", text, acceptedAnswers };
    }
    case "ordering": {
      const items = Array.isArray(r.items)
        ? r.items.filter((i): i is string => typeof i === "string" && i.length > 0)
        : [];
      if (items.length < 2) return null;
      return { type: "ordering", text, items };
    }
    case "feedback": {
      return { type: "feedback", text };
    }
    case "map_pin": {
      const lat = typeof r.lat === "number" ? r.lat : null;
      const lng = typeof r.lng === "number" ? r.lng : null;
      if (lat === null || lng === null) return null;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
      const maxDistanceKm =
        typeof r.max_distance_km === "number" && r.max_distance_km > 0
          ? r.max_distance_km
          : typeof r.maxDistanceKm === "number" && r.maxDistanceKm > 0
            ? r.maxDistanceKm
            : 5000;
      return { type: "map_pin", text, lat, lng, maxDistanceKm };
    }
    default:
      return null;
  }
}

// Convenience re-export so callers can write:
//   const svc = new BrainBoltAiService();
//   await svc.generateQuestions(...)
// without remembering the constructor.
export { AiError };
