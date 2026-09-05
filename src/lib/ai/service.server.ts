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
      const candidate: BrainBoltQuiz = {
        ...emptyQuizShell(),
        questions: (parsedByVersion as { questions: unknown[] }).questions as BrainBoltQuestion[],
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
      if (got !== req.count) {
        warnings.push(`Brain Bolt AI returned ${got} questions; you asked for ${req.count}.`);
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

      const newQuestion = (parsedByVersion as { question: unknown }).question as BrainBoltQuestion;
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

// Convenience re-export so callers can write:
//   const svc = new BrainBoltAiService();
//   await svc.generateQuestions(...)
// without remembering the constructor.
export { AiError };
