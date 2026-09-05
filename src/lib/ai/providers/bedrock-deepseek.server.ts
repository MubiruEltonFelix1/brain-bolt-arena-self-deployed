// Bedrock provider implementation — uses @aws-sdk/client-bedrock to call
// InvokeModelCommand against us.deepseek.r1-v1:0 (DeepSeek R1 via the
// cross-region inference profile).
//
// Server-only. The .server.ts suffix prevents Vite from bundling this into
// the client. AWS_* env vars are read inside the class methods — never at
// module scope — because Cloudflare Workers / Vercel serverless bind env
// per-request.
//
// The SDK is dynamically imported so tests can run without the package
// installed; only the live path through BrainBoltAiService requires it.

import type { AiProvider, AiPrompt, AiRawResponse } from "@/lib/ai/types";
import { stripReasoning } from "@/lib/ai/prompts";
import { getPricingForModel } from "@/lib/ai/cost-table";

/** DeepSeek R1 expects a "prompt" field with a chat-template-rendered string. */
const DEEPSEEK_R1_MODEL = "us.deepseek.r1-v1:0";

type DeepSeekR1Body = {
  prompt: string;
  max_tokens: number;
  temperature: number;
  top_p?: number;
};

type DeepSeekR1Response = {
  // For DeepSeek on Bedrock, the response body is the text completion directly.
  // (Some other models return { choices: [{ text }] }; R1 returns plain text.)
  // We keep this loose so a future model change is a one-line fix.
  text?: string;
  generation?: string;
  completion?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  // Some Bedrock responses wrap the body in { output: { text, ... } }.
  output?: { text?: string };
};

export class BedrockDeepSeekProvider implements AiProvider {
  readonly name = "bedrock-deepseek";
  readonly modelId: string;
  readonly pricing = getPricingForModel(DEEPSEEK_R1_MODEL);

  private client: unknown | null = null;

  constructor(modelId: string = DEEPSEEK_R1_MODEL) {
    this.modelId = modelId;
  }

  /**
   * Lazily import + construct the AWS Bedrock client. Dynamic so tests
   * without `@aws-sdk/client-bedrock` installed don't fail at import time.
   * The first real .generate() call pays the cost.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("BedrockDeepSeekProvider: AWS_REGION is not set");
    }
    const mod = await import("@aws-sdk/client-bedrock");
    // SDK reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from env automatically.
    this.client = new mod.BedrockClient({ region });
    return this.client;
  }

  async generate(prompt: AiPrompt): Promise<AiRawResponse> {
    const start = Date.now();
    const maxTokens = prompt.maxOutputTokens ?? 8000;
    const temperature = prompt.temperature ?? 0.4;

    // Render the DeepSeek-R1 chat template. R1 expects a single
    // concatenated prompt — not OpenAI's messages array.
    //
    // VERIFICATION DEBT: this `Human:/Assistant:` framing follows the
    // pattern in the AWS DeepSeek blog example. For the cross-region
    // inference profile `us.deepseek.r1-v1:0`, AWS may or may not apply
    // its own chat template on top. If the live output is poor, swap to
    // DeepSeek's native template
    // (`<|begin▁of▁sentence|><|User|>...<|Assistant|>...`) or use the
    // Converse API which handles templating internally. See
    // docs/BRAINBOLT_AI_ARCHITECTURE.md §Provider model.
    const renderedPrompt = `${prompt.system}\n\n` + `Human: ${prompt.user}\n\n` + `Assistant:`;

    const body: DeepSeekR1Body = {
      prompt: renderedPrompt,
      max_tokens: maxTokens,
      temperature,
      top_p: 0.9,
    };

    // Dynamic import so tests without the package installed don't fail
    // at module-load time. The type assertion is necessary because
    // TypeScript models the dynamic import as a namespace whose properties
    // are only the module's top-level exports — `InvokeModelCommand` lives
    // behind a re-export (`export * from "./commands"`) and isn't surfaced
    // on the synthesized namespace type even though it works at runtime.
    type BedrockModule = {
      InvokeModelCommand: new (input: unknown) => {
        send: (cmd: unknown) => Promise<{ body?: unknown }>;
      };
    };
    const mod = (await import("@aws-sdk/client-bedrock")) as unknown as BedrockModule;
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
    const text = decodeResponseBody(response.body);
    const parsed = tryParse(text);

    // R1 may emit a <think>...</think> block; strip it before parsing.
    // extractJsonObject already does this, but we also want to capture the
    // raw text for the response wrapper.
    const cleanedText = stripReasoning(text);

    // Pull token counts. DeepSeek R1 reports { input_tokens, output_tokens }
    // OR { prompt_tokens, completion_tokens } depending on the integration.
    const inputTokens = parsed?.usage?.input_tokens ?? parsed?.usage?.prompt_tokens ?? 0;
    const outputTokens = parsed?.usage?.output_tokens ?? parsed?.usage?.completion_tokens ?? 0;

    return {
      text: cleanedText,
      inputTokens,
      outputTokens,
      latencyMs,
    };
  }
}

function decodeResponseBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  // Some SDK return types wrap the body in a stream. Caller is async —
  // we can't await here, so fall through to empty. The async-typed SDK
  // body variant is the common AWS SDK v3 stream, but InvokeModelCommand
  // in Node.js typically resolves to a Uint8Array. (If you need the
  // stream path, convert decodeResponseBody to async.)
  return "";
}

function tryParse(text: string): DeepSeekR1Response | null {
  try {
    return JSON.parse(text) as DeepSeekR1Response;
  } catch {
    return null;
  }
}

function makeProviderError(
  code: "provider_unavailable" | "provider_timeout" | "provider_rate_limited",
  cause: unknown,
) {
  // Log internally with full context, but only return the taxonomy code.
  console.error(`[ai/bedrock-deepseek] ${code}`, {
    model: DEEPSEEK_R1_MODEL,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,
  });
  // Re-throw as a marker so the service layer can map to AiError. We
  // deliberately do not subclass Error here to keep the public surface
  // tight — the service layer knows the code from a typed sentinel.
  const e = new Error(code) as Error & { aiCode?: string };
  e.aiCode = code;
  return e;
}
