// Minimal OpenAI-compatible chat completions client (fetch-based, no provider
// SDKs). One baseURL + key + model covers OpenAI, Anthropic's compat layer,
// Groq, DeepSeek, OpenRouter, Ollama, LM Studio, etc.

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export type ChatCompletionOptions = {
  temperature?: number;
  /** Request structured JSON output; falls back to plain text if unsupported. */
  jsonMode?: boolean;
  timeoutMs?: number;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly providerBody?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Calls POST {baseUrl}/chat/completions and returns the assistant's content.
 * When `jsonMode` is set, requests `response_format: {type:"json_object"}` and
 * retries once without it if the endpoint rejects it (Ollama and LM Studio
 * ignore or refuse that field).
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<string> {
  const { temperature = 0.7, jsonMode = false, timeoutMs = 60_000 } = options;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  const attempt = async (useJsonMode: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature,
          ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new LlmError(
          `LLM request failed (${res.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
          res.status,
          body,
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new LlmError("LLM returned an empty completion");
      }
      return content;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new LlmError(`LLM request timed out after ${timeoutMs}ms`);
      }
      throw new LlmError(`LLM request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  if (jsonMode) {
    try {
      return await attempt(true);
    } catch (err) {
      if (
        err instanceof LlmError &&
        (err.status === 400 || err.status === 404 || err.status === 422)
      ) {
        // Endpoint doesn't support response_format — retry plain.
        return attempt(false);
      }
      throw err;
    }
  }
  return attempt(false);
}

/**
 * Extracts the first balanced {...} JSON object from an LLM reply, tolerating
 * markdown fences, prose around the JSON, and leading garbage.
 */
export function stripJson(raw: string): string {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = text.indexOf("{");
  if (start < 0) throw new LlmError("No JSON object found in LLM output");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new LlmError("Unbalanced JSON object in LLM output");
}
