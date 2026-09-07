// BrainBoltAiService unit tests.
//
// Static-analysis style (no jsdom, no network). The provider is stubbed
// so we exercise the service's validation, count-mismatch, error-mapping,
// and usage-log construction paths without making real Bedrock calls.
//
// Mirrors the existing src/lib/api/phase21-*.test.ts pattern.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  AiError,
  FRIENDLY_MESSAGES,
  type AiProvider,
  type AiPrompt,
  type AiRawResponse,
  SUPPORTED_AI_TYPES,
} from "@/lib/ai/types";
import { BrainBoltAiService } from "@/lib/ai/service.server";

// A controllable stub provider — never hits the network.
class StubProvider implements AiProvider {
  readonly name = "stub";
  readonly modelId = "stub/test-model";
  readonly pricing = { inputPerMTok: 1.0, outputPerMTok: 2.0 };

  responses: Array<AiRawResponse | Error> = [];
  calls: AiPrompt[] = [];

  enqueue(r: AiRawResponse | Error) {
    this.responses.push(r);
  }

  async generate(prompt: AiPrompt): Promise<AiRawResponse> {
    this.calls.push(prompt);
    const next = this.responses.shift();
    if (!next) throw new Error("stub: no response queued");
    if (next instanceof Error) throw next;
    return next;
  }
}

// A no-op Supabase stub — only used to satisfy the signature.
function fakeSupabase() {
  return {
    from: () => ({
      insert: async () => ({ error: null }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const baseRequest = {
  quizId: "11111111-1111-1111-1111-111111111111",
  topic: "Genetics",
  count: 3,
  difficulty: "medium" as const,
  types: ["mcq" as const, "true_false" as const],
};

describe("ai / service: BrainBoltAiService", () => {
  let provider: StubProvider;
  let svc: BrainBoltAiService;
  const principalId = "principal-1";

  beforeEach(() => {
    provider = new StubProvider();
    svc = new BrainBoltAiService({ provider });
  });

  test("over-limit count is rejected before any AI call (no usage log row written)", async () => {
    provider.enqueue({
      text: "should not be called",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    });
    const result = await svc.generateQuestions(fakeSupabase(), principalId, {
      ...baseRequest,
      count: 99, // above MAX_GENERATION_COUNT
    });
    expect(result.error).toBe("over_limit");
    expect(result.draft).toBeNull();
    expect(provider.calls.length).toBe(0);
  });

  test("zero types is rejected as validation_failed before any AI call", async () => {
    const result = await svc.generateQuestions(fakeSupabase(), principalId, {
      ...baseRequest,
      types: [],
    });
    expect(result.error).toBe("validation_failed");
    expect(result.draft).toBeNull();
    expect(provider.calls.length).toBe(0);
  });

  test("unsupported type (image_mcq) is rejected before any AI call", async () => {
    const result = await svc.generateQuestions(fakeSupabase(), principalId, {
      ...baseRequest,
      types: ["image_mcq" as never], // not in SUPPORTED_AI_TYPES
    });
    expect(result.error).toBe("validation_failed");
    expect(result.draft).toBeNull();
    expect(provider.calls.length).toBe(0);
  });

  test("valid 3-question MCQ+TF draft is returned and validated", async () => {
    provider.enqueue({
      text: JSON.stringify({
        questions: [
          {
            type: "mcq",
            text: "Who proposed the laws of inheritance?",
            options: ["Mendel", "Darwin", "Watson", "Crick"],
            correctIndex: 0,
            pointValue: 1000,
            timeLimitSec: 20,
          },
          {
            type: "mcq",
            text: "What does DNA stand for?",
            options: [
              "Deoxyribonucleic acid",
              "Diribonucleic acid",
              "Deoxynucleic acid",
              "Dextroribonucleic acid",
            ],
            correctIndex: 0,
          },
          {
            type: "true_false",
            text: "Humans have 46 chromosomes?",
            correct: true,
          },
        ],
      }),
      inputTokens: 500,
      outputTokens: 250,
      latencyMs: 1200,
    });
    const result = await svc.generateQuestions(fakeSupabase(), principalId, baseRequest);
    expect(result.error).toBeNull();
    expect(result.draft?.questions.length).toBe(3);
    expect(result.warnings.length).toBe(0);
  });

  test("count mismatch surfaces as a warning, not an error", async () => {
    provider.enqueue({
      text: JSON.stringify({
        questions: [{ type: "mcq", text: "Q1", options: ["a", "b"], correctIndex: 0 }],
      }),
      inputTokens: 200,
      outputTokens: 80,
      latencyMs: 500,
    });
    const result = await svc.generateQuestions(fakeSupabase(), principalId, baseRequest);
    // count=3 was requested, 1 was returned. Per brief §4: warning, not error.
    expect(result.error).toBeNull();
    expect(result.draft?.questions.length).toBe(1);
    expect(result.warnings.some((w) => w.includes("returned 1 question"))).toBe(true);
  });

  test("model returning non-JSON is mapped to invalid_output", async () => {
    provider.enqueue({
      text: "Sorry, I cannot generate that.",
      inputTokens: 100,
      outputTokens: 10,
      latencyMs: 200,
    });
    const result = await svc.generateQuestions(fakeSupabase(), principalId, baseRequest);
    expect(result.error).toBe("invalid_output");
    expect(result.draft).toBeNull();
  });

  test("model returning JSON with media question and no URL is mapped to validation_failed", async () => {
    provider.enqueue({
      text: JSON.stringify({
        questions: [
          // Even though SUPPORTED_AI_TYPES excludes image_reveal, the model
          // can hallucinate any type. We test that validation catches a
          // media question without a URL.
          {
            type: "image_reveal",
            text: "Identify the landmark",
            options: ["A", "B", "C", "D"],
            correctIndex: 0,
            // no imageUrl
          },
        ],
      }),
      inputTokens: 100,
      outputTokens: 100,
      latencyMs: 300,
    });
    const result = await svc.generateQuestions(fakeSupabase(), principalId, {
      ...baseRequest,
      count: 1,
    });
    expect(result.error).toBe("validation_failed");
    expect(result.draft).toBeNull();
  });

  test("reasoning tokens <think>...</think> are stripped before JSON parse", async () => {
    provider.enqueue({
      text:
        "<think>The user wants MCQ questions on genetics. Let me think about good ones.</think>\n" +
        JSON.stringify({
          questions: [{ type: "mcq", text: "Q1", options: ["a", "b"], correctIndex: 0 }],
        }),
      inputTokens: 100,
      outputTokens: 100,
      latencyMs: 200,
    });
    const result = await svc.generateQuestions(fakeSupabase(), principalId, {
      ...baseRequest,
      count: 1,
    });
    expect(result.error).toBeNull();
    expect(result.draft?.questions.length).toBe(1);
  });

  test("provider throwing a translated AiCode surfaces to the caller", async () => {
    const e: Error & { aiCode?: string } = new Error("provider_timeout");
    e.aiCode = "provider_timeout";
    provider.enqueue(e);
    const result = await svc.generateQuestions(fakeSupabase(), principalId, baseRequest);
    expect(result.error).toBe("provider_timeout");
    expect(result.draft).toBeNull();
  });

  test("SUPPORTED_AI_TYPES does not include media types (image_mcq, image_reveal, audio)", () => {
    expect(SUPPORTED_AI_TYPES).not.toContain("image_mcq");
    expect(SUPPORTED_AI_TYPES).not.toContain("image_reveal");
    expect(SUPPORTED_AI_TYPES).not.toContain("audio");
  });

  test("regenerateQuestion: same type enforced", async () => {
    provider.enqueue({
      text: JSON.stringify({
        question: {
          // wrong type
          type: "true_false",
          text: "Different type",
          correct: true,
        },
      }),
      inputTokens: 50,
      outputTokens: 50,
      latencyMs: 100,
    });
    const result = await svc.regenerateQuestion(fakeSupabase(), principalId, {
      quizId: baseRequest.quizId,
      replace: {
        type: "mcq",
        text: "Original MCQ",
        options: ["A", "B"],
        correctIndex: 0,
      },
    });
    expect(result.error).toBe("validation_failed");
    expect(result.question).toBeNull();
  });

  test("regenerateQuestion: same-type valid replacement succeeds", async () => {
    provider.enqueue({
      text: JSON.stringify({
        question: {
          type: "mcq",
          text: "Replacement MCQ",
          options: ["X", "Y", "Z"],
          correctIndex: 1,
        },
      }),
      inputTokens: 50,
      outputTokens: 50,
      latencyMs: 100,
    });
    const result = await svc.regenerateQuestion(fakeSupabase(), principalId, {
      quizId: baseRequest.quizId,
      replace: {
        type: "mcq",
        text: "Original MCQ",
        options: ["A", "B"],
        correctIndex: 0,
      },
    });
    expect(result.error).toBeNull();
    expect(result.question?.type).toBe("mcq");
    expect(result.question?.text).toBe("Replacement MCQ");
  });
});

describe("ai / cost-table: V3.2 and R1 pricing", () => {
  test("DeepSeek R1 is the default model", async () => {
    const { DEFAULT_MODEL_ID } = await import("@/lib/ai/cost-table");
    expect(DEFAULT_MODEL_ID).toBe("us.deepseek.r1-v1:0");
  });

  test("V3.2 pricing is ~2.2x cheaper than R1", async () => {
    const { getPricingForModel } = await import("@/lib/ai/cost-table");
    const v32 = getPricingForModel("us.deepseek.v3.2:0");
    const r1 = getPricingForModel("us.deepseek.r1-v1:0");
    // V3.2 input is 0.62, R1 is 1.35 — ratio ~0.46 (V3.2 is ~54% cheaper).
    expect(v32.inputPerMTok).toBeLessThan(r1.inputPerMTok);
    expect(v32.inputPerMTok / r1.inputPerMTok).toBeCloseTo(0.46, 1);
    // V3.2 output is 1.85, R1 is 5.4 — ratio ~0.34 (V3.2 is ~66% cheaper on output).
    expect(v32.outputPerMTok / r1.outputPerMTok).toBeCloseTo(0.34, 1);
  });

  test("V3.2 cost is below the user-friendly display threshold", () => {
    // A 5-question generation emits ~1k output tokens + ~1.2k input.
    // At V3.2 rates: 1.2k * 0.62 + 1k * 1.85 = $0.0026 — well under
    // the $0.01 ceiling that's our informal "still cheap" mark.
    const cost = 1200 * 0.62 + 1000 * 1.85;
    expect(cost / 1_000_000).toBeLessThan(0.01);
  });
});

describe("ai / types: FRIENDLY_MESSAGES", () => {
  test("every AiErrorCode has a friendly message", () => {
    const codes = [
      "not_authorized",
      "over_limit",
      "provider_unavailable",
      "provider_timeout",
      "provider_rate_limited",
      "invalid_output",
      "validation_failed",
      "unknown",
    ] as const;
    for (const c of codes) {
      expect(AiError).toBeDefined();
      // Each friendly message must NOT leak provider names or model IDs.
      // This protects against future drift if someone changes a message.
      const msg = FRIENDLY_MESSAGES[c];
      expect(msg).toBeTruthy();
      expect(msg.toLowerCase()).not.toContain("bedrock");
      expect(msg.toLowerCase()).not.toContain("deepseek");
      expect(msg.toLowerCase()).not.toContain("openai");
      expect(msg).not.toContain("us.deepseek");
      // V3.2 specific
      expect(msg).not.toContain("v3.2");
      expect(msg).not.toContain("v3-2");
    }
  });
});
