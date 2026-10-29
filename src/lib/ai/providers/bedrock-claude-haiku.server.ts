// Bedrock provider for Claude 3.5 Haiku — multimodal OCR / scanned-page reading.
//
// Uses @aws-sdk/client-bedrock-runtime InvokeModelCommand against the
// anthropic.claude-3-5-haiku-20241022-v1:0 model via Bedrock's Anthropic
// `messages` API format (image + text content blocks).
//
// Fast, cheap, strong image+text input. Used for OCR of scanned PDFs and
// photos of pages. Text-only documents are handled by the deterministic
// pdf-parse path, not by this provider.
//
// Server-only (.server.ts suffix prevents Vite from bundling into the
// client). AWS_* env vars are read inside the class methods — never at
// module scope — because Cloudflare Workers / Vercel serverless bind env
// per-request.

import type { AiProvider, AiPrompt, AiRawResponse } from "@/lib/ai/types";
import { getPricingForModel } from "@/lib/ai/cost-table";

const DEFAULT_MODEL = "anthropic.claude-3-5-haiku-20241022-v1:0";

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

export class BedrockClaudeHaikuProvider implements AiProvider {
  readonly name = "bedrock-claude-haiku";
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
      throw new Error("BedrockClaudeHaikuProvider: AWS_REGION is not set");
    }
    const mod = await import("@aws-sdk/client-bedrock-runtime");
    this.client = new mod.BedrockRuntimeClient({ region });
    return this.client;
  }

  async generate(prompt: AiPrompt): Promise<AiRawResponse> {
    const start = Date.now();
    const maxTokens = prompt.maxOutputTokens ?? 4000;
    const temperature = prompt.temperature ?? 0.2;

    const contentBlocks: ClaudeContentBlock[] = [];
    if (prompt.images && prompt.images.length > 0) {
      for (const img of prompt.images) {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        });
      }
    }
    contentBlocks.push({ type: "text", text: prompt.user });

    const body: ClaudeBody = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      temperature,
      system: prompt.system,
      messages: [{ role: "user", content: contentBlocks }],
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
  console.error(`[ai/bedrock-claude-haiku] ${code}`, {
    model: DEFAULT_MODEL,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,
  });
  const e = new Error(code) as Error & { aiCode?: string };
  e.aiCode = code;
  return e;
}
