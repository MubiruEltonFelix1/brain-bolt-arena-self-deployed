// save_quiz gate tests (H1, #9). All of these throw BEFORE any network call,
// so they run with a dummy Supabase target — no credentials, no connection.

import { describe, expect, test } from "bun:test";
import { isValidUuid, saveQuiz } from "../src/supabase";
import type { BrainBoltQuiz } from "../src/schema";

const TARGET = { url: "https://example.supabase.co", serviceRoleKey: "test-key" };
const VALID_UUID = "00000000-0000-0000-0000-000000000000";

const QUIZ: BrainBoltQuiz = {
  title: "t",
  questions: [{ type: "mcq", text: "q", options: ["a", "b"], correctIndex: 0 }],
};

describe("isValidUuid", () => {
  test("accepts a canonical uuid", () => {
    expect(isValidUuid(VALID_UUID)).toBe(true);
  });

  test("rejects non-uuids", () => {
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("")).toBe(false);
    expect(isValidUuid("00000000-0000-0000-0000-00000000000")).toBe(false); // 35 chars
  });
});

describe("saveQuiz owner contract (#9)", () => {
  test("missing ownerId throws a clear error before any network", async () => {
    await expect(saveQuiz(TARGET, QUIZ, {})).rejects.toThrow("owner");
  });

  test("invalid ownerId uuid throws before any network", async () => {
    await expect(saveQuiz(TARGET, QUIZ, { ownerId: "abc" })).rejects.toThrow("uuid");
  });
});

describe("saveQuiz integrity gate (H1)", () => {
  test("rejects a quiz with a media question lacking a URL — nothing is written", async () => {
    const bad: BrainBoltQuiz = {
      title: "t",
      questions: [{ type: "image_mcq", text: "q", options: ["a", "b"], correctIndex: 0 }],
    };
    await expect(saveQuiz(TARGET, bad, { ownerId: VALID_UUID })).rejects.toThrow(
      "validation errors",
    );
  });

  test("rejects a quiz with out-of-range correctIndex", async () => {
    const bad: BrainBoltQuiz = {
      title: "t",
      questions: [{ type: "mcq", text: "q", options: ["a", "b", "c"], correctIndex: 9 }],
    };
    await expect(saveQuiz(TARGET, bad, { ownerId: VALID_UUID })).rejects.toThrow(
      "validation errors",
    );
  });
});
