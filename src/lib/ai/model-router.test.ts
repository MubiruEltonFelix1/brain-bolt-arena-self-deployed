// Model router tests — no network, no AWS. Exercises task→model config and
// the kill switch. Provider construction is exercised by the service tests
// with stubbed providers.

import { afterEach, describe, expect, test } from "bun:test";
import { modelRouter, PrepTask, prepAiEnabled } from "@/lib/ai/model-router";
import { prepTaskConfig } from "@/lib/ai/cost-table";

const TASKS: PrepTask[] = [
  "ocr",
  "visual_interpretation",
  "question_generate",
  "question_regenerate",
  "quality_review",
  "simple",
];

describe("ai / router: task model configuration", () => {
  test("every task resolves to a configured model", () => {
    for (const t of TASKS) {
      const cfg = prepTaskConfig(t);
      expect(cfg.modelId).toBeTruthy();
      expect(cfg.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  test("ocr defaults to Claude Haiku", () => {
    expect(prepTaskConfig("ocr").modelId).toBe("anthropic.claude-3-5-haiku-20241022-v1:0");
  });

  test("visual_interpretation and quality_review default to Claude Sonnet", () => {
    expect(prepTaskConfig("visual_interpretation").modelId).toBe(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(prepTaskConfig("quality_review").modelId).toBe(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
  });

  test("question_generate defaults to DeepSeek V3.2", () => {
    expect(prepTaskConfig("question_generate").modelId).toBe("deepseek.v3.2");
  });

  test("router modelIdFor matches prepTaskConfig", () => {
    for (const t of TASKS) {
      expect(modelRouter.modelIdFor(t)).toBe(prepTaskConfig(t).modelId);
    }
  });

  test("pricingFor returns a price entry per task", () => {
    for (const t of TASKS) {
      const p = modelRouter.pricingFor(t);
      expect(p.inputPerMTok).toBeGreaterThan(0);
      expect(p.outputPerMTok).toBeGreaterThan(0);
      expect(p.source).toBeTruthy();
    }
  });

  test("estimateCost mirrors cost-table estimateCost", () => {
    const t: PrepTask = "question_generate";
    const expected = 1200 * 0.62 + 1000 * 1.85;
    expect(modelRouter.estimateCost(t, 1200, 1000) * 1e6).toBeCloseTo(expected, 0);
  });
});

describe("ai / router: prep AI kill switch", () => {
  const orig = process.env.PREP_AI_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.PREP_AI_ENABLED;
    else process.env.PREP_AI_ENABLED = orig;
  });

  test("defaults to enabled", () => {
    delete process.env.PREP_AI_ENABLED;
    expect(prepAiEnabled()).toBe(true);
  });

  test("disabled when PREP_AI_ENABLED=false", () => {
    process.env.PREP_AI_ENABLED = "false";
    expect(prepAiEnabled()).toBe(false);
  });

  test("enabled for any other value", () => {
    process.env.PREP_AI_ENABLED = "true";
    expect(prepAiEnabled()).toBe(true);
  });
});
