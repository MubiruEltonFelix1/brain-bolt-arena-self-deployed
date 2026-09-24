// Phase 9B — Arena publication / validation unit tests.
//
// Pure, no-DB, no-network. Verifies:
//   * ARENA_ELIGIBLE_TYPES membership
//   * ARENA_MIN_PLAYABLE_QUESTIONS constant
//   * validateArenaQuizLocal — the client-side mirror of `validate_arena_quiz`
//   * arenaCategoryAccent — stable hash of free-text category → brand accent
//   * arenaShareDataFromRun — solo-run → ShareResultData adapter
//
// These tests guard the rules that drive the Quiz Editor's Arena Publishing
// card. The SQL mirror is validated by `arena-validation-drift.test.ts`.
//
// Mirrors the static-analysis style of src/lib/ai/service.test.ts.

import { describe, expect, test } from "bun:test";
import {
  ARENA_ELIGIBLE_TYPES,
  ARENA_MIN_PLAYABLE_QUESTIONS,
  arenaShareDataFromRun,
  validateArenaQuizLocal,
  type ArenaQuizForValidation,
} from "@/lib/arena";
import { arenaCategoryAccent } from "@/lib/arena-visuals";

const baseQuiz: ArenaQuizForValidation = {
  title: "World Capitals",
  description: "Name the capital of every country in the world.",
  arena_category: "Geography",
  tags: "trivia; capitals; maps",
  questions: [
    {
      is_playable: true,
      question_type: "mcq",
      accepted_answers: null,
      geo_region: null,
      correct_lat: null,
      correct_lng: null,
    },
    {
      is_playable: true,
      question_type: "true_false",
      accepted_answers: null,
      geo_region: null,
      correct_lat: null,
      correct_lng: null,
    },
    {
      is_playable: true,
      question_type: "number",
      accepted_answers: null,
      geo_region: null,
      correct_lat: null,
      correct_lng: null,
    },
    {
      is_playable: true,
      question_type: "type",
      accepted_answers: ["Nairobi"],
      geo_region: null,
      correct_lat: null,
      correct_lng: null,
    },
  ],
};

describe("Arena publication — constants", () => {
  test("ARENA_ELIGIBLE_TYPES includes all 9 scored types", () => {
    expect(ARENA_ELIGIBLE_TYPES.size).toBe(9);
    expect(ARENA_ELIGIBLE_TYPES.has("mcq")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("image_mcq")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("true_false")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("number")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("image_reveal")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("audio")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("ordering")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("type")).toBe(true);
    expect(ARENA_ELIGIBLE_TYPES.has("map_pin")).toBe(true);
  });

  test("ARENA_ELIGIBLE_TYPES excludes feedback", () => {
    expect(ARENA_ELIGIBLE_TYPES.has("feedback")).toBe(false);
  });

  test("ARENA_MIN_PLAYABLE_QUESTIONS is 3", () => {
    expect(ARENA_MIN_PLAYABLE_QUESTIONS).toBe(3);
  });
});

describe("validateArenaQuizLocal", () => {
  test("eligible quiz passes with all 4 questions playable", () => {
    const r = validateArenaQuizLocal(baseQuiz);
    expect(r.is_eligible).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.playable_question_count).toBe(4);
    expect(r.supported_types).toEqual(["mcq", "number", "true_false", "type"]);
  });

  test("missing title → error", () => {
    const r = validateArenaQuizLocal({ ...baseQuiz, title: "" });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "title")).toBeTruthy();
  });

  test("missing description → error", () => {
    const r = validateArenaQuizLocal({ ...baseQuiz, description: null });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "description")).toBeTruthy();
  });

  test("missing category → error", () => {
    const r = validateArenaQuizLocal({ ...baseQuiz, arena_category: null });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "arena_category")).toBeTruthy();
  });

  test("zero playable questions → error and zero count", () => {
    const r = validateArenaQuizLocal({
      ...baseQuiz,
      questions: [
        {
          is_playable: false,
          question_type: "mcq",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "feedback",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
      ],
    });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "playable_questions")).toBeTruthy();
    expect(r.playable_question_count).toBe(0);
  });

  test("two playable questions → still error (need 3)", () => {
    const r = validateArenaQuizLocal({
      ...baseQuiz,
      questions: baseQuiz.questions.slice(0, 2),
    });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "playable_questions")).toBeTruthy();
  });

  test("type question with empty accepted_answers → error", () => {
    const r = validateArenaQuizLocal({
      ...baseQuiz,
      questions: [
        {
          is_playable: true,
          question_type: "mcq",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "true_false",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "type",
          accepted_answers: [],
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
      ],
    });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "type_questions")).toBeTruthy();
  });

  test("type question with null accepted_answers → error", () => {
    const r = validateArenaQuizLocal({
      ...baseQuiz,
      questions: [
        {
          is_playable: true,
          question_type: "mcq",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "true_false",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "type",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
      ],
    });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "type_questions")).toBeTruthy();
  });

  test("map_pin without region and without lat/lng → error", () => {
    const r = validateArenaQuizLocal({
      ...baseQuiz,
      questions: [
        {
          is_playable: true,
          question_type: "mcq",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "true_false",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "map_pin",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
      ],
    });
    expect(r.is_eligible).toBe(false);
    expect(r.errors.find((e) => e.field === "map_pin_questions")).toBeTruthy();
  });

  test("map_pin with region passes even without lat/lng", () => {
    const r = validateArenaQuizLocal({
      ...baseQuiz,
      questions: [
        {
          is_playable: true,
          question_type: "mcq",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "true_false",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "map_pin",
          accepted_answers: null,
          geo_region: { type: "Polygon", coordinates: [[[0, 0]]] },
          correct_lat: null,
          correct_lng: null,
        },
      ],
    });
    expect(r.is_eligible).toBe(true);
  });

  test("map_pin with lat/lng passes even without region", () => {
    const r = validateArenaQuizLocal({
      ...baseQuiz,
      questions: [
        {
          is_playable: true,
          question_type: "mcq",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "true_false",
          accepted_answers: null,
          geo_region: null,
          correct_lat: null,
          correct_lng: null,
        },
        {
          is_playable: true,
          question_type: "map_pin",
          accepted_answers: null,
          geo_region: null,
          correct_lat: 0,
          correct_lng: 0,
        },
      ],
    });
    expect(r.is_eligible).toBe(true);
  });

  test("missing tags → warning, not error (still eligible)", () => {
    const r = validateArenaQuizLocal({ ...baseQuiz, tags: "" });
    expect(r.is_eligible).toBe(true);
    expect(r.warnings.find((w) => w.field === "tags")).toBeTruthy();
  });

  test("null quiz → eligible=false with all three required errors", () => {
    const r = validateArenaQuizLocal(null);
    expect(r.is_eligible).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("arenaCategoryAccent", () => {
  test("returns a valid brand accent", () => {
    const accent = arenaCategoryAccent("Geography");
    expect(["volt", "pink-shock", "cyan-jolt", "amber-spark"]).toContain(accent);
  });

  test("null category returns volt (default)", () => {
    expect(arenaCategoryAccent(null)).toBe("volt");
  });

  test("undefined category returns volt (default)", () => {
    expect(arenaCategoryAccent(undefined)).toBe("volt");
  });

  test("empty string returns volt (default)", () => {
    expect(arenaCategoryAccent("")).toBe("volt");
  });

  test("same input always returns the same accent (stable hash)", () => {
    const a = arenaCategoryAccent("World History");
    const b = arenaCategoryAccent("World History");
    const c = arenaCategoryAccent("world history"); // case-insensitive
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("different inputs are not always the same accent (cycle over 4)", () => {
    // The hash is hash-stable; over a small set of distinct categories we
    // expect at least 2 different accents to appear across the brand palette.
    const categories = [
      "Geography",
      "History",
      "Pop Culture",
      "Science",
      "Sports",
      "Literature",
      "Mathematics",
      "Music",
    ];
    const seen = new Set(categories.map((c) => arenaCategoryAccent(c)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("arenaShareDataFromRun", () => {
  test("maps solo run to a single-player share card", () => {
    const data = arenaShareDataFromRun({
      quizTitle: "World Capitals",
      identityName: "Alice",
      score: 12345,
      correct: 9,
      totalQuestions: 10,
      longestStreak: 7,
    });
    expect(data.nickname).toBe("Alice");
    expect(data.rank).toBe(1);
    expect(data.totalPlayers).toBe(1);
    expect(data.score).toBe(12345);
    expect(data.correct).toBe(9);
    expect(data.totalQuestions).toBe(10);
    expect(data.longestStreak).toBe(7);
    expect(data.quizTitle).toBe("World Capitals");
    expect(data.leagueName).toBe(null);
    expect(data.achievement).toBe(null);
  });

  test("falls back to 'Arena player' when identity name is empty", () => {
    const data = arenaShareDataFromRun({
      quizTitle: "Q",
      identityName: "",
      score: 0,
      correct: 0,
      totalQuestions: 0,
    });
    expect(data.nickname).toBe("Arena player");
  });

  test("defaults longestStreak to 0 when null", () => {
    const data = arenaShareDataFromRun({
      quizTitle: "Q",
      identityName: "B",
      score: 100,
      correct: 5,
      totalQuestions: 10,
      longestStreak: null,
    });
    expect(data.longestStreak).toBe(0);
  });
});
