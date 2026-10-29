// Bedrock provider for Claude 3.5 Sonnet — diagrams/tables/charts/math
// interpretation and quality review.
//
// Uses @aws-sdk/client-bedrock-runtime InvokeModelCommand against the
// anthropic.claude-3-5-sonnet-20241022-v2:0 model via Bedrock's Anthropic
// `messages` API format. Supports image + text content blocks for visual
// reasoning; plain text for quality review.
//
// Stronger reasoning than Haiku, higher cost. Reserved for visual
// interpretation and independent quality review (a different model from the
// generation model, so its output is advisory cross-check, not proof).
//
// Server-only (.server.ts suffix). AWS_* env vars read inside methods, never
// at module scope.

import type { AiProvider, AiPrompt, AiRawResponse } from "@/lib/ai/types";
import { getPricingForModel } from "@/lib/ai/cost-table";

const DEFAULT_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type ClaudeMessage = { role: "user" | "assistant"; content: ClaudeContentBlock[] };

type ClaudeBody = {
  anthropic_version: "bedrock-2023-05-31";
  max_tokens: number;
  temperature: number;
  system?: string;
  messages: ClaudeMessage[];
};

type ClaudeResponse = {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
};

export class BedrockClaudeSonnetProvider implements AiProvider {
  readonly name = "bedrock-claude-sonnet";
  readonly modelId: string;
  readonly pricing = getPricingForModel(DEFAULT_MODEL);

  private client: unknown | null = null;

  constructor(modelId: string = DEFAULT_MODEL) {
    this.modelId = modelId;
  }

  private async getClient(): Promise<unknown> {
    if (this.client) return this.client;
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("BedrockClaudeSonnetProvider: AWS_REGION is not set");
    }
    const mod = await import("@aws-sdk/client-bedrock-runtime");
    this.client = new mod.BedrockRuntimeClient({ region });
    return this.client;
  }

  async generate(prompt: AiPrompt): Promise<AiRawResponse> {
    const start = Date.now();
    const maxTokens = prompt.maxOutputTokens ?? 4000;
    const temperature = prompt.temperature ?? 0.2;

    const body: ClaudeBody = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      temperature,
      system: prompt.system,
      messages: [{ role: "user", content: [{ type: "text", text: prompt.user }] }],
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
      const client = (await this.getClient()) as {
        send: (cmd: unknown) => Promise<{ body?: unknown }>;
      };
      response = await client.send(command);
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
      if (msg.includes("modelstreamerror") || msg.includes("modelnotready")) {
        throw makeProviderError("provider_unavailable", e);
      }
      throw makeProviderError("provider_unavailable", e);
    }

    const latencyMs = Date.now() - start;

    const rawText = decodeResponseBody(response.body);
    const parsed = tryParse(rawText);

    const textBlock = parsed?.content?.find((b) => b.type === "text");
    const text = textBlock?.text ?? rawText;

    const inputTokens = parsed?.usage?.input_tokens ?? 0;
    const outputTokens = parsed?.usage?.output_tokens ?? 0;

    return { text, inputTokens, outputTokens, latencyMs };
  }
}

function decodeResponseBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

function tryParse(text: string): ClaudeResponse | null {
  try {
    return JSON.parse(text) as ClaudeResponse;
  } catch {
    return null;
  }
}

function makeProviderError(
  code: "provider_unavailable" | "provider_timeout" | "provider_rate_limited",
  cause: unknown,
) {
  console.error(`[ai/bedrock-claude-sonnet] ${code}`, {
    model: DEFAULT_MODEL,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,
  });
  const e = new Error(code) as Error & { aiCode?: string };
  e.aiCode = code;
  return e;
}
