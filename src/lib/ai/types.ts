// Shared types for the Brain Bolt AI service.
//
// Surface (provider → service → serverFn → client) is typed end-to-end:
//   * The provider returns a raw AiResponse; the service translates to a
//     validated draft + UsageRecord.
//   * Server functions return a typed envelope — never throw raw errors.
//     The client renders friendly messages from the AiError.code alone.

import type { BrainBoltQuestion, BrainBoltQuiz } from "@/lib/quiz/validate";

/* ------------------------------------------------------------------ */
/* Error taxonomy — users see friendly messages, never provider errors */
/* ------------------------------------------------------------------ */

export type AiErrorCode =
  | "not_authorized"
  | "over_limit"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rate_limited"
  | "invalid_output"
  | "validation_failed"
  | "unknown";

/**
 * User-facing message per error code. The client renders this verbatim.
 * NEVER include provider names, model IDs, status codes, or stack traces.
 */
export const FRIENDLY_MESSAGES: Record<AiErrorCode, string> = {
  not_authorized: "You're not allowed to generate questions for this quiz.",
  over_limit:
    "You asked for more questions than Brain Bolt AI can create in one batch. Try a smaller number.",
  provider_unavailable:
    "Brain Bolt AI couldn't create the questions right now. Please try again in a moment.",
  provider_timeout:
    "Brain Bolt AI is taking longer than usual. Please try again, or try a smaller batch.",
  provider_rate_limited: "Brain Bolt AI is busy right now. Please wait a moment and try again.",
  invalid_output:
    "Brain Bolt AI returned an unexpected response. Please try again, or change your topic or instructions.",
  validation_failed:
    "Some generated questions need to be regenerated before they can be added to your quiz.",
  unknown: "Something went wrong while generating questions. Please try again.",
};

export class AiError extends Error {
  code: AiErrorCode;
  constructor(code: AiErrorCode, cause?: unknown) {
    super(FRIENDLY_MESSAGES[code]);
    this.code = code;
    this.name = "AiError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* ------------------------------------------------------------------ */
/* Request & response shapes                                            */
/* ------------------------------------------------------------------ */

export type Difficulty = "easy" | "medium" | "hard";

/**
 * Subset of the question-registry types that the AI service can generate.
 * image_mcq / image_reveal / audio require real media URLs that an LLM
 * cannot invent — see Phase 8E docs/BRAINBOLT_AI_ARCHITECTURE.md §Media.
 */
export const SUPPORTED_AI_TYPES = [
  "mcq",
  "true_false",
  "number",
  "type",
  "ordering",
  "feedback",
  "map_pin",
] as const;

export type SupportedAiType = (typeof SUPPORTED_AI_TYPES)[number];

/** Hard cap on a single generation batch. Mirrored from service.server.ts. */
export const MAX_GENERATION_COUNT = 20;

/** Minimum questions per generation request (single question is allowed). */
export const MIN_GENERATION_COUNT = 1;

export type GenerateQuestionsRequest = {
  /** Quiz the questions will be added to. Authorization scope. */
  quizId: string;
  /** Required. Free-text topic or theme. */
  topic: string;
  /** 1..MAX_GENERATION_COUNT. Hard cap = 20 (server-enforced). */
  count: number;
  /** Difficulty instruction passed to the prompt. */
  difficulty: Difficulty;
  /** Subset of the registry types. At least 1 required. */
  types: SupportedAiType[];
  /** Optional creator note (natural-language, max 500 chars). */
  instructions?: string;
  /**
   * Optional existing-question-text payload so the model can avoid dupes.
   * The server fetches and trims this; the client never sends the whole quiz.
   */
  existingQuestionTexts?: string[];
};

export type RegenerateQuestionRequest = {
  quizId: string;
  /** The question to replace, in its validated LLM-facing shape. */
  replace: BrainBoltQuestion;
  /** Optional creator note (max 500 chars). */
  instructions?: string;
};

/**
 * Per-call usage log entry. Mirrors the ai_usage_log table columns.
 */
export type UsageRecord = {
  principalId: string;
  capability: "ai.generate_questions" | "ai.regenerate_question";
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  success: boolean;
  errorKind: AiErrorCode | null;
};

/**
 * Single-result envelope returned by the server function. Either draft is
 * populated (success) or error.code is set (failure). draft+error is also
 * valid for partial-failure scenarios (e.g. count_mismatch warning).
 */
export type GenerationResult = {
  draft: BrainBoltQuiz | null;
  warnings: string[];
  error: AiErrorCode | null;
};

export type RegenerationResult = {
  question: BrainBoltQuestion | null;
  warnings: string[];
  error: AiErrorCode | null;
};

/* ------------------------------------------------------------------ */
/* Provider interface                                                   */
/* ------------------------------------------------------------------ */

/**
 * Provider abstraction. One implementation today (Bedrock + DeepSeek R1);
 * future providers (OpenAI, Anthropic direct, self-hosted) drop in here.
 */
export interface AiProvider {
  readonly name: string;
  readonly modelId: string;
  /** Cost per million tokens — must match aws.amazon.com/bedrock/pricing/. */
  readonly pricing: { inputPerMTok: number; outputPerMTok: number };
  /** Generate a completion from a fully-rendered prompt. */
  generate(prompt: AiPrompt): Promise<AiRawResponse>;
}

export interface BrainBoltAiServiceOptions {
  /** Override the default provider (used by tests). */
  provider?: AiProvider;
}

export type AiPrompt = {
  system: string;
  user: string;
  /** Soft cap on output tokens. Defaults to 8000. */
  maxOutputTokens?: number;
  /** Sampling temperature. Defaults to 0.4. */
  temperature?: number;
};

export type AiRawResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};
