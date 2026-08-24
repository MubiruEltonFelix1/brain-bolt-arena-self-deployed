// Unit tests for the Brain Bolt MCP server's core logic.
// Run with: bun test   (from mcp/)

import { describe, expect, test } from "bun:test";
import { csvColumnCount, quizToCsv, validatedQuizToCsv } from "../src/csv";
import { countMismatchMessage, parseQuizJson } from "../src/generate";
import { extractQuestionIndex, mediaUrlError, validateQuiz } from "../src/validate";
import {
  QUIZ_TIME_PER_QUESTION_MAX,
  QUIZ_TIME_PER_QUESTION_MIN,
  dbQuestionRowToCamel,
  questionToDbRow,
  quizSchema,
  type BrainBoltQuiz,
} from "../src/schema";

const FIXTURE: BrainBoltQuiz = {
  title: "Solar System Smash",
  description: "Fixture quiz",
  timePerQuestionSec: 20,
  difficulty: "medium",
  questions: [
    {
      type: "mcq",
      text: "Which planet is known as the Red Planet?",
      options: ["Venus", "Mars", "Jupiter", "Mercury"],
      correctIndex: 1,
    },
    { type: "true_false", text: "The Earth is round.", correct: true },
    {
      type: "number",
      text: "In what year did humans first land on the Moon?",
      correctNumber: 1969,
      min: 1900,
      max: 2000,
      format: "year",
    },
    {
      type: "map_pin",
      text: "Drop a pin on Tokyo",
      lat: 35.6762,
      lng: 139.6503,
      maxDistanceKm: 400,
    },
    {
      type: "type",
      text: "Which fruit keeps the doctor away?",
      acceptedAnswers: ["apple", "an apple", "apples"],
    },
    {
      type: "ordering",
      text: "Planets from the Sun",
      items: ["Mercury", "Venus", "Earth", "Mars"],
    },
    { type: "feedback", text: "What did you enjoy most?" },
  ],
};

describe("quizSchema", () => {
  test("parses the fixture", () => {
    const parsed = quizSchema.safeParse(FIXTURE);
    expect(parsed.success).toBe(true);
  });

  test("rejects a wrong-type variant (number without correctNumber)", () => {
    const bad = { ...FIXTURE, questions: [{ type: "number", text: "x", min: 0, max: 10 }] };
    const parsed = quizSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  test("rejects mcq with a single option", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "mcq", text: "x", options: ["only"], correctIndex: 0 }],
    };
    expect(quizSchema.safeParse(bad).success).toBe(false);
  });
});

describe("validateQuiz", () => {
  test("fixture is valid", () => {
    expect(validateQuiz(FIXTURE).valid).toBe(true);
  });

  test("catches correctIndex out of range", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "mcq", text: "x", options: ["a", "b"], correctIndex: 5 }],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "correctIndex")).toBe(true);
  });

  test("catches duplicate options", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "mcq", text: "x", options: ["a", "a"], correctIndex: 0 }],
    };
    expect(validateQuiz(bad).valid).toBe(false);
  });

  test("catches number outside min..max", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "number", text: "x", correctNumber: 3000, min: 1900, max: 2000 }],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "correctNumber")).toBe(true);
  });

  test("media questions without a URL are hard errors (H1)", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "image_mcq", text: "x", options: ["a", "b"], correctIndex: 0 }],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "imageUrl")).toBe(true);
  });

  test("audio without audioUrl is a hard error (H1)", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "audio", text: "x", options: ["a", "b"], correctIndex: 0 }],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "audioUrl")).toBe(true);
  });

  test("image_reveal without imageUrl is a hard error (H1)", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "image_reveal", text: "x", options: ["a", "b"], correctIndex: 0 }],
    };
    expect(validateQuiz(bad).valid).toBe(false);
  });

  test("media questions with a real https URL are valid (H1)", () => {
    const good = {
      ...FIXTURE,
      questions: [
        {
          type: "image_mcq" as const,
          text: "x",
          options: ["a", "b"],
          correctIndex: 0,
          imageUrl: "https://cdn.example-real.com/img/1.png",
        },
      ],
    };
    const report = validateQuiz(good);
    expect(report.valid).toBe(true);
  });

  test("http media URLs are rejected (H1)", () => {
    const bad = {
      ...FIXTURE,
      questions: [
        {
          type: "image_mcq" as const,
          text: "x",
          options: ["a", "b"],
          correctIndex: 0,
          imageUrl: "http://cdn.example-real.com/img/1.png",
        },
      ],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.message.includes("https"))).toBe(true);
  });

  test("reserved example-domain media URLs are rejected (H1)", () => {
    const bad = {
      ...FIXTURE,
      questions: [
        {
          type: "image_mcq" as const,
          text: "x",
          options: ["a", "b"],
          correctIndex: 0,
          imageUrl: "https://example.com/image.png",
        },
      ],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.message.includes("example.com"))).toBe(true);
  });

  test("mediaUrlError returns null for valid https URLs", () => {
    expect(mediaUrlError("https://media.example-real.com/a.jpg")).toBeNull();
    expect(mediaUrlError("")).not.toBeNull();
    expect(mediaUrlError("http://x.com/a.jpg")).not.toBeNull();
    expect(mediaUrlError("https://example.net/a.jpg")).not.toBeNull();
  });

  test("subdomains of reserved example hosts are rejected (H1)", () => {
    // A real subdomain of the reserved domain is still the reserved domain.
    expect(mediaUrlError("https://cdn.example.com/a.jpg")).not.toBeNull();
    expect(mediaUrlError("https://sub.example.org/x")).not.toBeNull();
    // A lookalike that is NOT an IANA reserved host stays accepted: the
    // registrable domain of example.com.evil.com is evil.com, and
    // evil-example.com is its own domain — neither is example.* itself.
    expect(mediaUrlError("https://example.com.evil.com/a.jpg")).toBeNull();
    expect(mediaUrlError("https://evil-example.com/a.jpg")).toBeNull();
  });

  test("semicolons in accepted answers are errors (M5)", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "type", text: "x", acceptedAnswers: ["a; b"] }],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "acceptedAnswers")).toBe(true);
  });

  test("semicolons in ordering items are errors (M5)", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "ordering", text: "x", items: ["a; b", "c"] }],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.field === "items")).toBe(true);
  });

  test("schema errors carry the affected question index (M2)", () => {
    const bad = {
      ...FIXTURE,
      questions: [
        { type: "mcq", text: "fine", options: ["a", "b"], correctIndex: 0 },
        { type: "mcq", text: "broken", options: ["only one"], correctIndex: 0 },
      ],
    };
    const report = validateQuiz(bad);
    expect(report.valid).toBe(false);
    const indexError = report.errors.find((e) => e.questionIndex !== null);
    expect(indexError?.questionIndex).toBe(1);
  });
});

describe("questionToDbRow (storage conventions)", () => {
  test('true_false → ["TRUE","FALSE"] + index 0/1', () => {
    const row = questionToDbRow({ type: "true_false", text: "x", correct: true }, 0);
    expect(row.options).toEqual(["TRUE", "FALSE"]);
    expect(row.correct_index).toBe(0);
    const rowF = questionToDbRow({ type: "true_false", text: "x", correct: false }, 0);
    expect(rowF.correct_index).toBe(1);
  });

  test("number → format in options[0], correct_index -1, default tolerance", () => {
    const row = questionToDbRow(
      { type: "number", text: "x", correctNumber: 1969, min: 1900, max: 2000, format: "year" },
      0,
    );
    expect(row.options).toEqual(["year"]);
    expect(row.correct_index).toBe(-1);
    expect(row.correct_number).toBe(1969);
    expect(row.number_min).toBe(1900);
    expect(row.number_max).toBe(2000);
    expect(row.number_tolerance).toBe(10); // max((2000-1900)*0.1, 1)
  });

  test('feedback → point_value 0, options [""], correct_index -1', () => {
    const row = questionToDbRow({ type: "feedback", text: "x" }, 0);
    expect(row.point_value).toBe(0);
    expect(row.options).toEqual([""]);
    expect(row.correct_index).toBe(-1);
  });

  test("map_pin → correct_index -1, max_distance_km default 5000", () => {
    const row = questionToDbRow({ type: "map_pin", text: "x", lat: 35.6, lng: 139.6 }, 0);
    expect(row.correct_index).toBe(-1);
    expect(row.max_distance_km).toBe(5000);
    expect(row.correct_lat).toBe(35.6);
    expect(row.geo_region).toBeNull();
    expect(row.geo_region_label).toBeNull();
  });

  test("map_pin with region → geo_region + label mapped", () => {
    const region = {
      type: "Polygon" as const,
      coordinates: [
        [
          [33.9, -0.95],
          [41.85, 3.91],
          [39.2, -4.67],
          [33.9, -0.95],
        ],
      ],
    };
    const row = questionToDbRow(
      {
        type: "map_pin",
        text: "x",
        lat: 0.9,
        lng: 38.2,
        maxDistanceKm: 300,
        region,
        regionLabel: "Kenya",
      },
      0,
    );
    expect(row.geo_region).toEqual(region);
    expect(row.geo_region_label).toBe("Kenya");
    expect(row.max_distance_km).toBe(300);
  });

  test("map_pin regionLabel without region fails validation", () => {
    const bad = {
      title: "t",
      questions: [{ type: "map_pin", text: "x", lat: 1, lng: 2, regionLabel: "Kenya" }],
    };
    expect(quizSchema.safeParse(bad).success).toBe(false);
  });

  test("ordering → options are the items, correct_index -1", () => {
    const row = questionToDbRow({ type: "ordering", text: "x", items: ["a", "b", "c"] }, 0);
    expect(row.options).toEqual(["a", "b", "c"]);
    expect(row.correct_index).toBe(-1);
  });

  test("mcq → options + index, point_value 1000 default", () => {
    const row = questionToDbRow(
      { type: "mcq", text: "x", options: ["a", "b"], correctIndex: 1 },
      0,
    );
    expect(row.options).toEqual(["a", "b"]);
    expect(row.correct_index).toBe(1);
    expect(row.point_value).toBe(1000);
  });

  test("isPlayable false maps to is_playable false and round-trips (20260821090000)", () => {
    const row = questionToDbRow(
      { type: "mcq", text: "x", options: ["a", "b"], correctIndex: 0, isPlayable: false },
      0,
    );
    expect(row.is_playable).toBe(false);
    const camel = dbQuestionRowToCamel(row);
    expect(camel.isPlayable).toBe(false);
  });

  test("is_playable defaults to true on both sides when omitted", () => {
    const row = questionToDbRow(
      { type: "mcq", text: "x", options: ["a", "b"], correctIndex: 0 },
      0,
    );
    expect(row.is_playable).toBe(true);
    const camel = dbQuestionRowToCamel(row);
    expect(camel.isPlayable).toBe(true);
  });
});

describe("quizToCsv", () => {
  test("header is the 26-column template", () => {
    const csv = quizToCsv(FIXTURE);
    expect(csvColumnCount(csv)).toBe(26);
    expect(csv.split("\n")[0]!.startsWith("question_type,question,option_a")).toBe(true);
    expect(csv.split("\n")[0]!.endsWith(",region")).toBe(true);
  });

  test("map_pin region label lands in the region column", () => {
    const region = {
      type: "Polygon" as const,
      coordinates: [
        [
          [33.9, -0.95],
          [41.85, 3.91],
          [39.2, -4.67],
          [33.9, -0.95],
        ],
      ],
    };
    const quiz: BrainBoltQuiz = {
      title: "t",
      questions: [
        { type: "map_pin", text: "q", lat: 0.9, lng: 38.2, region, regionLabel: "Kenya" },
      ],
    };
    const csv = quizToCsv(quiz);
    expect(csv).toContain(",Kenya");
  });

  test("uses legacy type names", () => {
    const csv = quizToCsv(FIXTURE);
    const lines = csv.trim().split("\n");
    expect(lines[1]!.startsWith("multiple_choice,")).toBe(true);
    expect(lines.some((l) => l.startsWith("closest_number,"))).toBe(true);
    expect(lines.some((l) => l.startsWith("free_text,"))).toBe(true);
  });

  test("true_false row carries TRUE", () => {
    const csv = quizToCsv(FIXTURE);
    expect(csv).toContain("true_false,");
    expect(csv).toContain("TRUE");
  });

  test("row count = questions + header", () => {
    const csv = quizToCsv(FIXTURE);
    expect(csv.trim().split("\n").length).toBe(FIXTURE.questions.length + 1);
  });

  test("escapes commas in option text", () => {
    const quiz: BrainBoltQuiz = {
      title: "t",
      questions: [{ type: "mcq", text: "q", options: ["a, b", "c"], correctIndex: 0 }],
    };
    const csv = quizToCsv(quiz);
    expect(csv).toContain('"a, b"');
  });

  test("appends option_e/option_f columns for >4 options", () => {
    const quiz: BrainBoltQuiz = {
      title: "t",
      questions: [{ type: "mcq", text: "q", options: ["a", "b", "c", "d", "e"], correctIndex: 4 }],
    };
    const csv = quizToCsv(quiz);
    expect(csvColumnCount(csv)).toBe(28);
    expect(csv.split("\n")[0]!.includes("option_e,option_f")).toBe(true);
    expect(csv).toContain(",e,");
  });
});

describe("extractQuestionIndex (M2)", () => {
  test("reads the numeric index from a zod path", () => {
    expect(extractQuestionIndex(["questions", 2, "options"])).toBe(2);
    expect(extractQuestionIndex(["questions", 0, "type"])).toBe(0);
    expect(extractQuestionIndex(["questions", 12, "text"])).toBe(12);
  });

  test("returns null for non-question paths", () => {
    expect(extractQuestionIndex(["title"])).toBeNull();
    expect(extractQuestionIndex(["questions"])).toBeNull();
    expect(extractQuestionIndex([])).toBeNull();
  });
});

describe("quiz-level time limit (M4)", () => {
  const base = {
    title: "t",
    questions: [{ type: "mcq", text: "q", options: ["a", "b"], correctIndex: 0 }],
  };

  test(`quiz timePerQuestionSec up to ${QUIZ_TIME_PER_QUESTION_MAX} is accepted`, () => {
    expect(
      quizSchema.safeParse({ ...base, timePerQuestionSec: QUIZ_TIME_PER_QUESTION_MAX }).success,
    ).toBe(true);
    expect(
      quizSchema.safeParse({ ...base, timePerQuestionSec: QUIZ_TIME_PER_QUESTION_MIN }).success,
    ).toBe(true);
  });

  test("quiz timePerQuestionSec above the app editor's 120 cap is rejected", () => {
    expect(quizSchema.safeParse({ ...base, timePerQuestionSec: 121 }).success).toBe(false);
    expect(quizSchema.safeParse({ ...base, timePerQuestionSec: 300 }).success).toBe(false);
  });

  test("per-question timeLimitSec still allows up to 300 (unchanged)", () => {
    expect(
      quizSchema.safeParse({
        ...base,
        questions: [
          { type: "mcq", text: "q", options: ["a", "b"], correctIndex: 0, timeLimitSec: 300 },
        ],
      }).success,
    ).toBe(true);
    expect(
      quizSchema.safeParse({
        ...base,
        questions: [
          { type: "mcq", text: "q", options: ["a", "b"], correctIndex: 0, timeLimitSec: 301 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("validatedQuizToCsv (M3)", () => {
  test("rejects a quiz the app importer would reject (correctIndex out of range)", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "mcq", text: "q", options: ["a", "b", "c"], correctIndex: 7 }],
    };
    const result = validatedQuizToCsv(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.errors.some((e) => e.field === "correctIndex")).toBe(true);
    }
  });

  test("rejects media questions without URLs", () => {
    const bad = {
      ...FIXTURE,
      questions: [{ type: "image_mcq", text: "q", options: ["a", "b"], correctIndex: 0 }],
    };
    expect(validatedQuizToCsv(bad).ok).toBe(false);
  });

  test("emits CSV for a valid quiz", () => {
    const result = validatedQuizToCsv(FIXTURE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.csv.trim().split("\n").length).toBe(FIXTURE.questions.length + 1);
    }
  });
});

describe("parseQuizJson (M1)", () => {
  test("malformed but brace-balanced JSON becomes a structured failure, not a throw", () => {
    const result = parseQuizJson('{"a": 1,}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.errors[0]?.field).toBe("json");
      expect(result.report.valid).toBe(false);
    }
  });

  test("plain valid JSON parses to a quiz", () => {
    const raw = JSON.stringify({
      title: "T",
      questions: [{ type: "mcq", text: "q", options: ["a", "b"], correctIndex: 0 }],
    });
    const result = parseQuizJson(raw);
    expect(result.ok).toBe(true);
  });

  test("non-JSON output becomes a structured failure", () => {
    const result = parseQuizJson("I cannot generate that quiz.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.errors[0]?.field).toBe("json");
    }
  });

  test("schema-invalid quiz reports the question index (M2)", () => {
    const raw = JSON.stringify({
      title: "T",
      questions: [
        { type: "mcq", text: "ok", options: ["a", "b"], correctIndex: 0 },
        { type: "mcq", text: "bad", options: ["only"], correctIndex: 0 },
      ],
    });
    const result = parseQuizJson(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.errors.some((e) => e.questionIndex === 1)).toBe(true);
    }
  });
});

describe("countMismatchMessage (M6)", () => {
  test("returns a message when counts differ", () => {
    expect(countMismatchMessage(10, 9)).toContain("9");
    expect(countMismatchMessage(10, 11)).toContain("11");
  });

  test("returns null when counts match", () => {
    expect(countMismatchMessage(10, 10)).toBeNull();
  });
});
