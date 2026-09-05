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
import { estimateCost } from "@/lib/ai/cost-table";
import { BedrockDeepSeekProvider } from "@/lib/ai/providers/bedrock-deepseek.server";
import { recordUsage } from "@/lib/ai/usage-log.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// Re-export for callers that imported MAX_GENERATION_COUNT from this module.
export { MAX_GENERATION_COUNT };

/**
 * Singleton-style service. Construct one per request (cheap) so the
 * provider can capture per-request env (Cloudflare Workers / Vercel
 * serverless bind env at request time).
 */
export class BrainBoltAiService {
  private provider: import("@/lib/ai/types").AiProvider;

  constructor(opts: BrainBoltAiServiceOptions = {}) {
    if (opts.provider) {
      this.provider = opts.provider;
    } else {
      const providerName = process.env.BRAINBOLT_AI_PROVIDER ?? "bedrock-deepseek";
      const modelId = process.env.BRAINBOLT_AI_MODEL ?? "us.deepseek.r1-v1:0";
      switch (providerName) {
        case "bedrock-deepseek":
          this.provider = new BedrockDeepSeekProvider(modelId);
          break;
        default:
          throw new Error(`BrainBoltAiService: unknown BRAINBOLT_AI_PROVIDER "${providerName}"`);
      }
    }
  }

  /**
   * Generate `req.count` questions on `req.topic`. Returns a typed envelope.
   * NEVER throws — failure modes are mapped to AiErrorCode.
   *
   * Over-limit requests are rejected before any AI call (no usage log row
   * for the rejected call — the user didn't pay for nothing).
   */
  async generateQuestions(
    supabaseAdmin: SupabaseClient,
    principalId: string,
    req: GenerateQuestionsRequest,
  ): Promise<GenerationResult> {
    // Server-side guards. The client validates too (defense in depth) but
    // these run unconditionally on every server call.
    if (req.count < MIN_GENERATION_COUNT || req.count > MAX_GENERATION_COUNT) {
      return await this.recordAndReturn(supabaseAdmin, {
        draft: null,
        warnings: [],
        error: "over_limit",
        principalId,
        capability: "ai.generate_questions",
        promptVersion: "generate_questions_v1",
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
        capability: "ai.generate_questions",
        promptVersion: "generate_questions_v1",
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
          capability: "ai.generate_questions",
          promptVersion: "generate_questions_v1",
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

    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let rawText: string | null = null;

    try {
      const response = await this.provider.generate({
        system,
        user,
        maxOutputTokens: 8000,
        temperature: 0.4,
      });
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
          capability: "ai.generate_questions",
          promptVersion: "generate_questions_v1",
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
          capability: "ai.generate_questions",
          promptVersion: "generate_questions_v1",
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
          capability: "ai.generate_questions",
          promptVersion: "generate_questions_v1",
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
          capability: "ai.generate_questions",
          promptVersion: "generate_questions_v1",
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
        capability: "ai.generate_questions",
        promptVersion: "generate_questions_v1",
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
        capability: "ai.generate_questions",
        promptVersion: "generate_questions_v1",
        inputTokens,
        outputTokens,
        latencyMs,
        success: false,
      });
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
      capability: "ai.generate_questions" | "ai.regenerate_question";
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
    capability: "ai.generate_questions" | "ai.regenerate_question";
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
  const text = typeof r.question === "string"
    ? r.question
    : typeof r.text === "string"
      ? r.text
      : null;
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
            ? options[r.correctIndex] ?? null
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
