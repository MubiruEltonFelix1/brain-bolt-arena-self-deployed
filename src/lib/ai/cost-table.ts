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
 * and BRAINBOLT_AI_MODEL=us.deepseek.v3.2:0.
 */
const DEEPSEEK_V32_BEDROCK: ModelPricing = {
  inputPerMTok: 0.62,
  outputPerMTok: 1.85,
  source: "aws.amazon.com/bedrock/pricing/ — DeepSeek V3.2 example",
};

const PRICING_TABLE: Record<string, ModelPricing> = {
  "us.deepseek.r1-v1:0": DEEPSEEK_R1_BEDROCK,
  "us.deepseek.v3.2:0": DEEPSEEK_V32_BEDROCK,
};

/** Default model when BRAINBOLT_AI_MODEL is unset. */
export const DEFAULT_MODEL_ID = "us.deepseek.r1-v1:0";

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
