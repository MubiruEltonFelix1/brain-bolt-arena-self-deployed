// End-to-end generation retry-contract tests (M1, M6).
//
// The real LLM module (llm.ts) is mocked so the full generateQuiz loop can be
// exercised without network: malformed JSON must become a structured failure
// inside the retry contract, never an uncaught exception.

import { describe, expect, mock, test } from "bun:test";

let llmResponse: string = "";
let callCount = 0;

mock.module("../src/llm.ts", () => ({
  chatCompletion: async () => {
    callCount++;
    return llmResponse;
  },
  stripJson: (raw: string) => raw,
}));

const { generateQuiz } = await import("../src/generate");

const LLM = { baseUrl: "http://localhost:1/v1", apiKey: "", model: "test-model" };

const VALID_ONE_QUESTION = JSON.stringify({
  title: "T",
  questions: [{ type: "mcq", text: "q", options: ["a", "b"], correctIndex: 0 }],
});

describe("generateQuiz retry contract (M1)", () => {
  test("malformed JSON never escapes the retry contract", async () => {
    callCount = 0;
    llmResponse = '{"a": 1,}';

    const result = await generateQuiz(LLM, { topic: "t", questionCount: 5 });

    expect(callCount).toBe(2); // both passes attempted, both failed cleanly
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.validation.errors[0]?.field).toBe("json");
    }
  });

  test("plain non-JSON output is a structured failure after two attempts", async () => {
    callCount = 0;
    llmResponse = "Sorry, I cannot write that quiz.";

    const result = await generateQuiz(LLM, { topic: "t" });

    expect(callCount).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validation.errors[0]?.field).toBe("json");
    }
  });

  test("valid output succeeds on the first pass", async () => {
    callCount = 0;
    llmResponse = VALID_ONE_QUESTION;

    const result = await generateQuiz(LLM, { topic: "t", questionCount: 1 });

    expect(result.ok).toBe(true);
    expect(callCount).toBe(1);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.exactMatch).toBe(true);
      expect(result.generatedCount).toBe(1);
    }
  });
});

describe("question count visibility (M6)", () => {
  test("count mismatch is reported, not silent", async () => {
    callCount = 0;
    llmResponse = VALID_ONE_QUESTION; // 1 question

    const result = await generateQuiz(LLM, { topic: "t", questionCount: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requestedCount).toBe(10);
      expect(result.generatedCount).toBe(1);
      expect(result.exactMatch).toBe(false);
      expect(result.validation.warnings.some((w) => w.field === "questionCount")).toBe(true);
    }
  });

  test("exact count produces no count warning", async () => {
    callCount = 0;
    llmResponse = VALID_ONE_QUESTION;

    const result = await generateQuiz(LLM, { topic: "t", questionCount: 1 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exactMatch).toBe(true);
      expect(result.validation.warnings.some((w) => w.field === "questionCount")).toBe(false);
    }
  });
});
