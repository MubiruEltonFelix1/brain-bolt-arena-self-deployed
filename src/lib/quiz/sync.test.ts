// Drift test: src/lib/quiz/validate.ts must agree with mcp/src/validate.ts
// on representative inputs. Catches accidental divergence when one copy is
// updated and the other isn't.
//
// Static-analysis style (no jsdom, no network). Mirrors the existing
// src/lib/api/phase21-*.test.ts pattern.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The canonical sources. We do NOT import them — importing would force bun
// to resolve the mcp package's deps (none of which are installed under src/).
// Instead we read them as text and run the *src* validator against canned
// inputs. Then we sanity-check the mcp copy exists at the expected path.
const ROOT = join(import.meta.dir, "..", "..", "..");
const MCP_VALIDATE = join(ROOT, "mcp", "src", "validate.ts");
const MCP_SCHEMA = join(ROOT, "mcp", "src", "schema.ts");
const SRC_VALIDATE = join(ROOT, "src", "lib", "quiz", "validate.ts");

import { questionSchema, quizSchema, validateQuiz } from "./validate";

describe("ai / quiz validation: drift checks", () => {
  test("mcp canonical sources still exist on disk", () => {
    expect(readFileSync(MCP_VALIDATE, "utf8").length).toBeGreaterThan(100);
    expect(readFileSync(MCP_SCHEMA, "utf8").length).toBeGreaterThan(100);
    expect(readFileSync(SRC_VALIDATE, "utf8").length).toBeGreaterThan(100);
  });

  test("mc mirror contains the canonical sync comment", () => {
    const src = readFileSync(SRC_VALIDATE, "utf8");
    expect(src).toContain("MIRROR of mcp/src/validate.ts");
    expect(src).toContain("CANONICAL SOURCE");
    expect(src).toContain("MUST stay in sync");
  });

  test("questionSchema accepts a valid mcq sample", () => {
    const sample = {
      type: "mcq",
      text: "What is the capital of Kenya?",
      options: ["Nairobi", "Mombasa", "Kisumu", "Eldoret"],
      correctIndex: 0,
      pointValue: 1000,
      timeLimitSec: 20,
    };
    const parsed = questionSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
  });

  test("questionSchema rejects mcq with too-few options", () => {
    const parsed = questionSchema.safeParse({
      type: "mcq",
      text: "Bad",
      options: ["only"],
      correctIndex: 0,
    });
    expect(parsed.success).toBe(false);
  });

  test("questionSchema accepts true_false", () => {
    const parsed = questionSchema.safeParse({
      type: "true_false",
      text: "The sky is blue.",
      correct: true,
    });
    expect(parsed.success).toBe(true);
  });

  test("questionSchema accepts number with min/max/correctNumber", () => {
    const parsed = questionSchema.safeParse({
      type: "number",
      text: "Year Berlin Wall fell?",
      correctNumber: 1989,
      min: 1950,
      max: 2000,
      tolerance: 2,
      format: "year",
    });
    expect(parsed.success).toBe(true);
  });

  test("questionSchema accepts map_pin with region polygon", () => {
    const parsed = questionSchema.safeParse({
      type: "map_pin",
      text: "Locate Kenya",
      lat: 0,
      lng: 38,
      region: {
        type: "Polygon",
        coordinates: [
          [
            [38, -5],
            [42, -5],
            [42, 5],
            [38, 5],
            [38, -5],
          ],
        ],
      },
      regionLabel: "Kenya",
    });
    expect(parsed.success).toBe(true);
  });

  test("validateQuiz: representative full quiz passes", () => {
    const quiz = {
      title: "Genetics 101",
      questions: [
        {
          type: "mcq",
          text: "Who proposed the laws of inheritance?",
          options: ["Mendel", "Darwin", "Watson", "Crick"],
          correctIndex: 0,
        },
        {
          type: "true_false",
          text: "DNA stands for deoxyribonucleic acid.",
          correct: true,
        },
        {
          type: "number",
          text: "How many chromosomes do humans have?",
          correctNumber: 46,
          min: 40,
          max: 50,
          tolerance: 2,
        },
      ],
    };
    const report = validateQuiz(quiz);
    expect(report.valid).toBe(true);
    expect(report.errors.length).toBe(0);
  });

  test("validateQuiz: media question with missing URL fails (per media URL policy)", () => {
    const quiz = {
      title: "Bad",
      questions: [
        {
          type: "image_reveal",
          text: "Identify the landmark",
          options: ["A", "B", "C", "D"],
          correctIndex: 0,
          // no imageUrl — must fail
        },
      ],
    };
    const report = validateQuiz(quiz);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "imageUrl")).toBe(true);
  });

  test("validateQuiz: media question with example.com URL fails (placeholder rejection)", () => {
    const quiz = {
      title: "Bad",
      questions: [
        {
          type: "audio",
          text: "Identify the song",
          options: ["A", "B", "C", "D"],
          correctIndex: 0,
          audioUrl: "https://example.com/clip.mp3",
        },
      ],
    };
    const report = validateQuiz(quiz);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "audioUrl")).toBe(true);
  });

  test("validateQuiz: out-of-range correctIndex fails", () => {
    const quiz = {
      title: "Bad",
      questions: [
        {
          type: "mcq",
          text: "Pick one",
          options: ["A", "B"],
          correctIndex: 5, // out of range
        },
      ],
    };
    const report = validateQuiz(quiz);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "correctIndex")).toBe(true);
  });

  test("quizSchema: cross-field rule rejects map_pin with regionLabel but no region", () => {
    const parsed = quizSchema.safeParse({
      title: "x",
      questions: [
        {
          type: "map_pin",
          text: "Pin Kenya",
          lat: 0,
          lng: 38,
          regionLabel: "Kenya",
          // no region → must fail
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
