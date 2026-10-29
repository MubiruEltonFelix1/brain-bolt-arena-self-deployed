// Per-model token pricing for cost estimation.
//
// Single source of truth for the cost column in ai_usage_log. Verify against
// https://aws.amazon.com/bedrock/pricing/ when adding a new model entry.

export type ModelPricing = {
  inputPerMTok: number; // USD per 1M input tokens
  outputPerMTok: number; // USD per 1M output tokens
  /** Source-of-truth citation for humans reviewing this number. */
  source: string;
};

/**
 * Bedrock DeepSeek R1 (us.deepseek.r1-v1:0) — current default. Verified
 * 2026-08-22 from aws.amazon.com/bedrock/pricing/ (DeepSeek-R1 example).
 * Reasoning model — output includes <think>...</think> blocks that the
 * provider strips before parsing.
 */
const DEEPSEEK_R1_BEDROCK: ModelPricing = {
  inputPerMTok: 1.35,
  outputPerMTok: 5.4,
  source: "aws.amazon.com/bedrock/pricing/ — DeepSeek-R1 example",
};

/**
 * Bedrock DeepSeek V3.2 — kept as an alternative. Non-reasoning chat
 * model with strong instruction-following for structured output.
 * Verified 2026-08-22 against aws.amazon.com/bedrock/pricing/ (DeepSeek
 * V3.2 example). ~2.2x cheaper than R1 for the same generation.
 *
 * Switch back to V3.2 by setting BRAINBOLT_AI_PROVIDER=bedrock-deepseek-v3
 * and BRAINBOLT_AI_MODEL=deepseek.v3.2.
 */
const DEEPSEEK_V32_BEDROCK: ModelPricing = {
  inputPerMTok: 0.62,
  outputPerMTok: 1.85,
  source: "aws.amazon.com/bedrock/pricing/ — DeepSeek V3.2 example",
};

/**
 * Claude 3.5 Haiku on Bedrock — multimodal OCR / scanned-page reading.
 * Fast, cheap, strong image+text input. Verified against
 * aws.amazon.com/bedrock/pricing/ (Claude 3.5 Haiku example).
 */
const CLAUDE_35_HAIKU_BEDROCK: ModelPricing = {
  inputPerMTok: 1.0,
  outputPerMTok: 5.0,
  source: "aws.amazon.com/bedrock/pricing/ — Claude 3.5 Haiku example",
};

/**
 * Claude 3.5 Sonnet on Bedrock — diagrams/tables/charts/math interpretation
 * and quality review. Stronger reasoning, higher cost. Verified against
 * aws.amazon.com/bedrock/pricing/ (Claude 3.5 Sonnet example).
 */
const CLAUDE_35_SONNET_BEDROCK: ModelPricing = {
  inputPerMTok: 3.0,
  outputPerMTok: 15.0,
  source: "aws.amazon.com/bedrock/pricing/ — Claude 3.5 Sonnet example",
};

const PRICING_TABLE: Record<string, ModelPricing> = {
  "us.deepseek.r1-v1:0": DEEPSEEK_R1_BEDROCK,
  "deepseek.v3.2": DEEPSEEK_V32_BEDROCK,
  "anthropic.claude-3-5-haiku-20241022-v1:0": CLAUDE_35_HAIKU_BEDROCK,
  "anthropic.claude-3-5-sonnet-20241022-v2:0": CLAUDE_35_SONNET_BEDROCK,
};

/** Default model when BRAINBOLT_AI_MODEL is unset (legacy text-generation path). */
export const DEFAULT_MODEL_ID = "us.deepseek.r1-v1:0";

/** Default model for source-grounded question generation (Phase 10 prep pipeline). */
export const PREP_DEFAULT_GENERATE_MODEL = "deepseek.v3.2";

/* ------------------------------------------------------------------ */
/* Prep-pipeline task model configuration                             */
/*                                                                    */
/* Read inside server functions (never at module scope) because
 * Cloudflare Workers / Vercel serverless bind env per request.
 * Each default mirrors AI_QUIZ_PREP_MODEL_ROUTING.md. Override via env.
/* ------------------------------------------------------------------ */

export const PREP_TASK_DEFAULTS: Record<
  string,
  { modelId: string; maxOutputTokens: number; temperature: number }
> = {
  ocr: {
    modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
    maxOutputTokens: 4000,
    temperature: 0.2,
  },
  visual_interpretation: {
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    maxOutputTokens: 4000,
    temperature: 0.2,
  },
  question_generate: {
    modelId: "deepseek.v3.2",
    maxOutputTokens: 8000,
    temperature: 0.4,
  },
  question_regenerate: {
    modelId: "deepseek.v3.2",
    maxOutputTokens: 2000,
    temperature: 0.5,
  },
  quality_review: {
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    maxOutputTokens: 3000,
    temperature: 0.2,
  },
  simple: {
    modelId: "deepseek.v3.2",
    maxOutputTokens: 4000,
    temperature: 0.3,
  },
} as const;

/** Env var names that override the per-task model. */
export const PREP_MODEL_ENV: Record<string, string> = {
  ocr: "PREP_MODEL_OCR",
  visual_interpretation: "PREP_MODEL_VISUAL",
  question_generate: "PREP_MODEL_GENERATE",
  question_regenerate: "PREP_MODEL_REGENERATE",
  quality_review: "PREP_MODEL_QUALITY",
  simple: "PREP_MODEL_SIMPLE",
} as const;

/** Administrative kill switch for all prep-pipeline AI calls. Read per-request. */
export const PREP_AI_ENABLED_ENV = "PREP_AI_ENABLED";

export function prepTaskConfig(task: string): {
  modelId: string;
  maxOutputTokens: number;
  temperature: number;
} {
  const envKey = PREP_MODEL_ENV[task as keyof typeof PREP_MODEL_ENV];
  const modelId = envKey ? (process.env[envKey] ?? PREP_TASK_DEFAULTS[task]?.modelId) : undefined;
  const base = PREP_TASK_DEFAULTS[task] ?? PREP_TASK_DEFAULTS.simple;
  return {
    modelId: modelId ?? base.modelId,
    maxOutputTokens: base.maxOutputTokens,
    temperature: base.temperature,
  };
}

/** Whether the prep-pipeline AI is administratively enabled. Defaults to true. */
export function isPrepAiEnabled(): boolean {
  return process.env[PREP_AI_ENABLED_ENV] !== "false";
}

export function getPricingForModel(modelId: string): ModelPricing {
  return (
    PRICING_TABLE[modelId] ?? {
      // Fallback to the most conservative pricing we know when a new model
      // is configured. The cost column will still be a non-zero number so
      // the usage log is meaningful — but admins should verify before
      // relying on the dollar value.
      inputPerMTok: 5.0,
      outputPerMTok: 25.0,
      source: "conservative fallback — model not in PRICING_TABLE; verify before quoting",
    }
  );
}

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = getPricingForModel(modelId);
  return (inputTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok;
}
