// Bedrock provider implementation — uses @aws-sdk/client-bedrock-runtime
// to call InvokeModelCommand against us.deepseek.r1-v1:0 (DeepSeek R1
// via the cross-region inference profile).
//
// Server-only. The .server.ts suffix prevents Vite from bundling this into
// the client. AWS_* env vars are read inside the class methods — never at
// module scope — because Cloudflare Workers / Vercel serverless bind env
// per-request.
//
// Package note: `@aws-sdk/client-bedrock` is the management plane (CRUD
// on custom models, etc.). The actual inference commands
// (InvokeModelCommand, ConverseCommand, etc.) live in
// `@aws-sdk/client-bedrock-runtime`. The SDK is dynamically imported so
// tests can run without the package installed.

import type { AiProvider, AiPrompt, AiRawResponse } from "@/lib/ai/types";
import { stripReasoning } from "@/lib/ai/prompts";
import { getPricingForModel } from "@/lib/ai/cost-table";

/** DeepSeek R1 on Bedrock via the cross-region inference profile. */
const DEEPSEEK_R1_MODEL = "us.deepseek.r1-v1:0";

/** Body sent to InvokeModelCommand. */
type DeepSeekR1Body = {
  prompt: string;
  max_tokens: number;
  temperature: number;
  top_p?: number;
};

/**
 * Response body from InvokeModelCommand for DeepSeek R1.
 *
 * The actual structure is OpenAI completions-style:
 *   { choices: [{ text: "...", finish_reason: "..." }],
 *     usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * Token counts may appear as `prompt_tokens` / `completion_tokens` (the
 * names this model uses) or `input_tokens` / `output_tokens` (other Bedrock
 * models). Both are handled.
 */
type DeepSeekR1Response = {
  choices?: Array<{
    text?: string;
    finish_reason?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
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
   * Lazily import + construct the AWS Bedrock Runtime client. Dynamic
   * so tests without `@aws-sdk/client-bedrock-runtime` installed don't
   * fail at import time. The first real .generate() call pays the cost.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("BedrockDeepSeekProvider: AWS_REGION is not set");
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

    // Render the DeepSeek-R1 prompt. We DO NOT use a Human:/Assistant:
    // chat template — the model ignores our framing and uses its own
    // multi-turn template under the hood. The plain "Instruction: ...
    // Response:" format works because the model interprets the
    // instruction block as a single user turn and emits a single
    // completion. We then strip any multi-turn continuation (subsequent
    // Human:/Assistant: blocks) before parsing.
    const renderedPrompt =
      `${prompt.system}\n\n` + `Instruction: ${prompt.user}\n\n` + `Response:`;

    const body: DeepSeekR1Body = {
      prompt: renderedPrompt,
      max_tokens: maxTokens,
      temperature,
      top_p: 0.9,
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

    // DeepSeek R1 returns { choices: [{ text: "..." }] }. We take the first
    // choice's text. R1 frequently continues the conversation with a
    // synthesized "User:" / "Assistant:" turn even when instructed not to
    // (the model treats the prompt as the start of an open-ended chat
    // session). We truncate at the first "User:" / "Human:" marker so
    // only the first response makes it into the JSON parser.
    const textFromChoices = parsed?.choices?.[0]?.text;
    const fullText = textFromChoices ?? rawText;
    const firstTurn = fullText.split(/\n+(?:User|Human):/i)[0] ?? fullText;

    // The model is also prone to emitting <think>...</think> reasoning
    // blocks — strip them defensively.
    const cleanedText = stripReasoning(firstTurn);

    // Pull token counts. DeepSeek R1 uses `prompt_tokens` / `completion_tokens`.
    const inputTokens =
      parsed?.usage?.input_tokens ?? parsed?.usage?.prompt_tokens ?? 0;
    const outputTokens =
      parsed?.usage?.output_tokens ?? parsed?.usage?.completion_tokens ?? 0;

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
