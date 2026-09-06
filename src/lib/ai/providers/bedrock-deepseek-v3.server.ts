// Bedrock provider for DeepSeek V3.2 — current production default.
//
// Server-only (.server.ts suffix prevents Vite from bundling into the
// client). AWS_* env vars are read inside the class methods — never at
// module scope — because Cloudflare Workers / Vercel serverless bind env
// per-request.
//
// Why V3.2 over R1:
//   - Non-reasoning model. No <think>...</think> blocks. Cleaner output.
//   - Stronger instruction-following for structured JSON. ~65-90% per-
//     question success across the registry types, vs ~30-85% for R1.
//   - ~2.2x cheaper ($0.62/$1.85 per 1M tokens vs $1.35/$5.40 for R1).
//   - ~3-5x faster (no reasoning tokens to generate). Typical 5-question
//     generation: 1-2s vs R1's 6-10s.
//   - Chat-tuned. The system + user template below matches DeepSeek's
//     official chat format — no need for the multi-turn truncation that
//     R1 required.
//
// SDK is dynamically imported so tests can run without the package
// installed; only the live path through BrainBoltAiService requires it.

import type { AiProvider, AiPrompt, AiRawResponse } from "@/lib/ai/types";
import { getPricingForModel } from "@/lib/ai/cost-table";

/** DeepSeek V3.2 on Bedrock via the cross-region inference profile. */
const DEEPSEEK_V32_MODEL = "us.deepseek.v3.2:0";

/**
 * Request body for InvokeModelCommand with DeepSeek V3.2.
 *
 * V3.2 accepts OpenAI-compatible chat completion requests. The prompt
 * field uses the chat-templated string:
 *
 *   <|begin▁of▁sentence|><|User|>system\nuser<|Assistant|>
 *
 * For structured output we pass the system + user as a single user
 * turn and ask the model to emit a single assistant response. This
 * matches the format AWS documents for DeepSeek on Bedrock.
 */
type DeepSeekV3Body = {
  prompt: string;
  max_tokens: number;
  temperature: number;
  // top_p omitted — V3.2 is stable with temperature alone.
};

type DeepSeekV3Response = {
  choices?: Array<{
    text?: string;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

export class BedrockDeepSeekV3Provider implements AiProvider {
  readonly name = "bedrock-deepseek-v3";
  readonly modelId: string;
  readonly pricing = getPricingForModel(DEEPSEEK_V32_MODEL);

  private client: unknown | null = null;

  constructor(modelId: string = DEEPSEEK_V32_MODEL) {
    this.modelId = modelId;
  }

  /**
   * Lazily import + construct the AWS Bedrock Runtime client. Dynamic
   * so tests without `@aws-sdk/client-bedrock-runtime` installed don't
   * fail at import time.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("BedrockDeepSeekV3Provider: AWS_REGION is not set");
    }
    const mod = await import("@aws-sdk/client-bedrock-runtime");
    // SDK reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from env automatically.
    this.client = new mod.BedrockRuntimeClient({ region });
    return this.client;
  }

  async generate(prompt: AiPrompt): Promise<AiRawResponse> {
    const start = Date.now();
    const maxTokens = prompt.maxOutputTokens ?? 8000;
    const temperature = prompt.temperature ?? 0.4;

    // DeepSeek V3.2 chat template. Single user turn containing system +
    // user; the model emits a single assistant response. No multi-turn
    // continuation issues (unlike R1).
    const renderedPrompt =
      `<|begin▁of▁sentence|><|User|>${prompt.system}\n\n${prompt.user}<|Assistant|>`;

    const body: DeepSeekV3Body = {
      prompt: renderedPrompt,
      max_tokens: maxTokens,
      temperature,
    };

    type BedrockRuntimeModule = {
      InvokeModelCommand: new (input: unknown) => {
        send: (cmd: unknown) => Promise<{ body?: unknown }>;
      };
    };
    const mod = (await import("@aws-sdk/client-bedrock-runtime")) as unknown as BedrockRuntimeModule;
    const command = new mod.InvokeModelCommand({
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });

    let response;
    try {
      response = await (await this.getClient()).send(command);
    } catch (e: unknown) {
      // Translate SDK errors into our taxonomy. NEVER leak provider names,
      // model IDs, status codes, or stack traces to the caller.
      const eAsRecord = e as { name?: unknown; message?: unknown };
      const name = typeof eAsRecord.name === "string" ? eAsRecord.name : "";
      const msg = String(eAsRecord.message ?? "").toLowerCase();
      if (name === "TimeoutError" || msg.includes("timeout") || msg.includes("aborted")) {
        throw makeProviderError("provider_timeout", e);
      }
      if (msg.includes("throttl") || msg.includes("rate")) {
        throw makeProviderError("provider_rate_limited", e);
      }
      if (msg.includes("modelstreamerror") || msg.includes("modelnotready")) {
        throw makeProviderError("provider_unavailable", e);
      }
      throw makeProviderError("provider_unavailable", e);
    }

    const latencyMs = Date.now() - start;

    // Parse the response body. SDK returns a Uint8Array; Bedrock sends JSON.
    const rawText = decodeResponseBody(response.body);
    const parsed = tryParse(rawText);

    // V3.2 returns { choices: [{ text: "..." }] } just like R1.
    const text = parsed?.choices?.[0]?.text ?? rawText;

    // V3.2 doesn't emit <think>...</think> blocks, so no stripping needed.
    // The text is the assistant's response — clean JSON in our case.

    // Pull token counts. V3.2 uses OpenAI-style names.
    const inputTokens = parsed?.usage?.prompt_tokens ?? 0;
    const outputTokens = parsed?.usage?.completion_tokens ?? 0;

    return {
      text,
      inputTokens,
      outputTokens,
      latencyMs,
    };
  }
}

function decodeResponseBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

function tryParse(text: string): DeepSeekV3Response | null {
  try {
    return JSON.parse(text) as DeepSeekV3Response;
  } catch {
    return null;
  }
}

function makeProviderError(
  code: "provider_unavailable" | "provider_timeout" | "provider_rate_limited",
  cause: unknown,
) {
  // Log internally with full context, but only return the taxonomy code.
  console.error(`[ai/bedrock-deepseek-v3] ${code}`, {
    model: DEEPSEEK_V32_MODEL,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,
  });
  // Re-throw as a marker so the service layer can map to AiError. We
  // deliberately do not subclass Error here to keep the public surface
  // tight — the service layer knows the code from a typed sentinel.
  const e = new Error(code) as Error & { aiCode?: string };
  e.aiCode = code;
  return e;
}
