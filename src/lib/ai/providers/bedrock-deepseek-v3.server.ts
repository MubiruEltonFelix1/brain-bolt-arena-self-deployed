// Bedrock provider for DeepSeek V3.2.
//
// DeepSeek V3.2 uses the in-Region Bedrock model ID `deepseek.v3.2` and the
// Converse API. It does not accept the old `{ prompt, max_tokens }` body used
// by the previous InvokeModel implementation.
//
// Server-only (.server.ts suffix prevents Vite from bundling this into the
// client). AWS credentials are resolved by the AWS SDK on the server.

import type { AiProvider, AiPrompt, AiRawResponse } from "@/lib/ai/types";
import { getPricingForModel } from "@/lib/ai/cost-table";

const DEEPSEEK_V32_MODEL = "deepseek.v3.2";

type ConverseResponse = {
  output?: {
    message?: {
      content?: Array<{
        text?: string;
      }>;
    };
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  metrics?: {
    latencyMs?: number;
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

  /** Create the Bedrock Runtime client lazily so importing this module does not
   * require AWS configuration. Environment variables are read per request. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("BedrockDeepSeekV3Provider: AWS_REGION is not set");
    }

    const mod = await import("@aws-sdk/client-bedrock-runtime");
    this.client = new mod.BedrockRuntimeClient({ region });
    return this.client;
  }

  async generate(prompt: AiPrompt): Promise<AiRawResponse> {
    const start = Date.now();
    const maxTokens = prompt.maxOutputTokens ?? 8000;
    const temperature = prompt.temperature ?? 0.4;

    const mod = await import("@aws-sdk/client-bedrock-runtime");
    const command = new mod.ConverseCommand({
      modelId: this.modelId,
      system: [{ text: prompt.system }],
      messages: [
        {
          role: "user",
          content: [{ text: prompt.user }],
        },
      ],
      inferenceConfig: {
        maxTokens,
        temperature,
      },
      // Keep structured question JSON in the normal text content.
      additionalModelRequestFields: { reasoning_effort: "none" },
    });

    let response: ConverseResponse;
    try {
      response = (await (await this.getClient()).send(command)) as ConverseResponse;
    } catch (e: unknown) {
      const eAsRecord = e as { name?: unknown; message?: unknown };
      const name = typeof eAsRecord.name === "string" ? eAsRecord.name : "";
      const msg = String(eAsRecord.message ?? "").toLowerCase();

      if (name === "TimeoutError" || msg.includes("timeout") || msg.includes("aborted")) {
        throw makeProviderError("provider_timeout", e);
      }
      if (msg.includes("throttl") || msg.includes("rate")) {
        throw makeProviderError("provider_rate_limited", e);
      }
      throw makeProviderError("provider_unavailable", e);
    }

    const content = response.output?.message?.content ?? [];
    const text = content
      .flatMap((block) => (typeof block.text === "string" ? [block.text] : []))
      .join("\n");

    return {
      text,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      latencyMs: response.metrics?.latencyMs ?? Date.now() - start,
    };
  }
}

function makeProviderError(
  code: "provider_unavailable" | "provider_timeout" | "provider_rate_limited",
  cause: unknown,
) {
  // Log the provider cause on the server, but return only the public error code.
  console.error(`[ai/bedrock-deepseek-v3] ${code}`, {
    model: DEEPSEEK_V32_MODEL,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,
  });

  const error = new Error(code) as Error & { aiCode?: string };
  error.aiCode = code;
  return error;
}
-