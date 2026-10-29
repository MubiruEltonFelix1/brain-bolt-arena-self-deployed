// Task-based Bedrock model router for the Phase 10 AI Quiz Preparation pipeline.
//
// Reuses the existing `AiProvider` interface (`src/lib/ai/types.ts`) and the
// per-model pricing in `cost-table.ts`. Selects provider + model by task
// rather than hardcoding one model everywhere. All model IDs and token
// budgets come from `cost-table.ts` (env-overridable defaults), never inline.
//
// Server-only module — AWS credentials and region are read inside provider
// methods at request time, never at module scope, never shipped to the client.
//
// Usage:
//   const router = new ModelRouter();
//   const response = await router.generate("question_generate", { system, user });
//   const cost = router.estimateCost("question_generate", inputTokens, outputTokens);
//
// A shared `modelRouter` singleton is exported for server fns that don't need
// per-request router state. Construct one per request if you need isolation.

import type { AiProvider, AiPrompt, AiRawResponse } from "@/lib/ai/types";
import {
  estimateCost,
  getPricingForModel,
  isPrepAiEnabled,
  prepTaskConfig,
} from "@/lib/ai/cost-table";
import { BedrockClaudeHaikuProvider } from "@/lib/ai/providers/bedrock-claude-haiku.server";
import { BedrockClaudeSonnetProvider } from "@/lib/ai/providers/bedrock-claude-sonnet.server";
import { BedrockDeepSeekV3Provider } from "@/lib/ai/providers/bedrock-deepseek-v3.server";

export type PrepTask =
  | "ocr"
  | "visual_interpretation"
  | "question_generate"
  | "question_regenerate"
  | "quality_review"
  | "simple";

export const PREP_MAX_CONCURRENCY_DEFAULT = 3;
export const PREP_MAX_BATCH_TOKENS_DEFAULT = 30000;
export const PREP_MAX_STAGE_RETRIES_DEFAULT = 3;

/** Env guard checked at the top of every prep server fn. */
export function prepAiEnabled(): boolean {
  return isPrepAiEnabled();
}

/**
 * Routes a generation to the least-expensive suitable model for the task.
 * Constructs a fresh provider per call so the modelId (resolved from env at
 * request time) is always current — providers are cheap (AWS client is lazy).
 */
export class ModelRouter {
  private newProvider(task: PrepTask, modelId: string): AiProvider {
    switch (task) {
      case "ocr":
        return new BedrockClaudeHaikuProvider(modelId);
      case "visual_interpretation":
      case "quality_review":
        return new BedrockClaudeSonnetProvider(modelId);
      case "question_generate":
      case "question_regenerate":
      case "simple":
        return new BedrockDeepSeekV3Provider(modelId);
    }
  }

  /** The model ID that would be used for the task (env override respected). */
  modelIdFor(task: PrepTask): string {
    return prepTaskConfig(task).modelId;
  }

  /** A fresh provider instance for the task, built with the request-time modelId. */
  providerFor(task: PrepTask): AiProvider {
    return this.newProvider(task, this.modelIdFor(task));
  }

  maxOutputTokensFor(task: PrepTask): number {
    return prepTaskConfig(task).maxOutputTokens;
  }

  temperatureFor(task: PrepTask): number {
    return prepTaskConfig(task).temperature;
  }

  tokenBudgetFor(): number {
    return PREP_MAX_BATCH_TOKENS_DEFAULT;
  }

  concurrencyFor(): number {
    return PREP_MAX_CONCURRENCY_DEFAULT;
  }

  maxStageRetries(): number {
    return PREP_MAX_STAGE_RETRIES_DEFAULT;
  }

  /** Pricing for the task's model (for cost estimation / display). */
  pricingFor(task: PrepTask) {
    return getPricingForModel(this.modelIdFor(task));
  }

  /** Estimate USD cost for a task call. Mirrors the usage-log cost column. */
  estimateCost(task: PrepTask, inputTokens: number, outputTokens: number): number {
    return estimateCost(this.modelIdFor(task), inputTokens, outputTokens);
  }

  /**
   * Generate a completion routed to the task's provider+model. Throws
   * provider-translated errors (mapped to AiErrorCode by the service layer).
   */
  async generate(task: PrepTask, prompt: AiPrompt): Promise<AiRawResponse> {
    const cfg = prepTaskConfig(task);
    const provider = this.newProvider(task, cfg.modelId);
    return provider.generate({
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: prompt.maxOutputTokens ?? cfg.maxOutputTokens,
      temperature: prompt.temperature ?? cfg.temperature,
    });
  }
}

/** Shared router for server fns that don't need per-request isolation. */
export const modelRouter = new ModelRouter();
