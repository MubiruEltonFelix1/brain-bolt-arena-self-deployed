// MIRROR of mcp/src/validate.ts + mcp/src/schema.ts (LLM-facing shape).
//
// CANONICAL SOURCE: mcp/src/validate.ts and mcp/src/schema.ts. These two files
// MUST stay in sync. The drift test at src/lib/quiz/sync.test.ts loads both
// copies and asserts they agree on representative inputs.
//
// Why duplicate instead of sharing? mcp/package.json is an isolated package
// (only @supabase/supabase-js, @modelcontextprotocol/sdk, zod). It does NOT
// depend on src/. Promoting to a shared workspace package is a Phase 8G /
// Phase 17 refactor — see docs/BRAINBOLT_AI_ARCHITECTURE.md §Limitations.
//
// AI service usage: BrainBoltAiService runs validateQuiz on every model
// output before returning the draft to the client. The editor's AI panel
// ALSO runs validateQuiz on the received payload before inserting rows
// (defense-in-depth against schema drift).

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Limits (single source of truth — mirrored from the MCP package)     */
/* ------------------------------------------------------------------ */

export const QUIZ_TIME_PER_QUESTION_MIN = 5;
export const QUIZ_TIME_PER_QUESTION_MAX = 120;
export const QUESTION_TIME_MIN = 5;
export const QUESTION_TIME_MAX = 300;
export const POINT_VALUE_MIN = 0;
export const POINT_VALUE_MAX = 100000;
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 30;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MIN_ORDERING_ITEMS = 2;
export const MAX_ORDERING_ITEMS = 8;

/* ------------------------------------------------------------------ */
/* Zod schemas (LLM-facing shape — camelCase)                           */
/* ------------------------------------------------------------------ */

const commonFields = {
  text: z.string().min(1),
  timeLimitSec: z.number().int().min(QUESTION_TIME_MIN).max(QUESTION_TIME_MAX).optional(),
  pointValue: z.number().int().min(POINT_VALUE_MIN).max(POINT_VALUE_MAX).optional(),
  doublePoints: z.boolean().optional(),
  isPlayable: z.boolean().optional(),
};

const choiceFields = {
  options: z.array(z.string().min(1)).min(MIN_OPTIONS).max(MAX_OPTIONS),
  correctIndex: z.number().int().min(0),
};

const geoRegionSchema = z.object({
  type: z.enum(["Polygon", "MultiPolygon"]),
  coordinates: z.any(),
});

export const questionSchema = z.discriminatedUnion("type", [
  z.object({ ...commonFields, type: z.literal("mcq"), ...choiceFields }),
  z.object({
    ...commonFields,
    type: z.literal("image_mcq"),
    ...choiceFields,
    imageUrl: z.string().url().optional(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("true_false"),
    correct: z.boolean(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("number"),
    correctNumber: z.number(),
    min: z.number(),
    max: z.number(),
    tolerance: z.number().positive().optional(),
    format: z.enum(["general", "year", "decimal", "percentage", "currency"]).optional(),
    unit: z.string().optional(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("image_reveal"),
    ...choiceFields,
    imageUrl: z.string().url().optional(),
    revealStages: z.number().int().min(2).max(10).optional(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("audio"),
    ...choiceFields,
    audioUrl: z.string().url().optional(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("ordering"),
    items: z.array(z.string().min(1)).min(MIN_ORDERING_ITEMS).max(MAX_ORDERING_ITEMS),
  }),
  z.object({
    ...commonFields,
    type: z.literal("type"),
    acceptedAnswers: z.array(z.string().min(1)).min(1),
  }),
  z.object({ ...commonFields, type: z.literal("feedback") }),
  z.object({
    ...commonFields,
    type: z.literal("map_pin"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    maxDistanceKm: z.number().positive().optional(),
    region: geoRegionSchema.optional(),
    regionLabel: z.string().min(1).optional(),
  }),
]);

export type BrainBoltQuestion = z.infer<typeof questionSchema>;

export const quizSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    timePerQuestionSec: z
      .number()
      .int()
      .min(QUIZ_TIME_PER_QUESTION_MIN)
      .max(QUIZ_TIME_PER_QUESTION_MAX)
      .optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    questions: z.array(questionSchema).min(MIN_QUESTIONS).max(MAX_QUESTIONS),
  })
  .superRefine((quiz, ctx) => {
    quiz.questions.forEach((q, i) => {
      if (q.type === "map_pin" && q.regionLabel !== undefined && q.region === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", i, "region"],
          message: "regionLabel requires region (the accepted polygon)",
        });
      }
    });
  });

export type BrainBoltQuiz = z.infer<typeof quizSchema>;

/* ------------------------------------------------------------------ */
/* DB row mapping — what the AI panel inserts into the questions table */
/* ------------------------------------------------------------------ */

const NULL_EXTRAS = {
  correct_lat: null as number | null,
  correct_lng: null as number | null,
  max_distance_km: null as number | null,
  correct_number: null as number | null,
  number_min: null as number | null,
  number_max: null as number | null,
  number_tolerance: null as number | null,
  accepted_answers: null as string[] | null,
  audio_url: null as string | null,
  reveal_stages: null as number | null,
  geo_region: null as { type: "Polygon" | "MultiPolygon"; coordinates?: unknown } | null,
  geo_region_label: null as string | null,
};

export type QuestionDbRow = {
  text: string;
  position: number;
  time_limit_sec: number | null;
  point_value: number;
  question_type: string;
  image_url: string | null;
  double_points: boolean;
  is_playable: boolean;
  options: string[];
  correct_index: number;
} & typeof NULL_EXTRAS;

export const DEFAULT_POINT_VALUE = 1000;
export const DEFAULT_MAX_DISTANCE_KM = 5000;
export const DEFAULT_REVEAL_STAGES = 5;

/**
 * Maps a validated question to the exact row shape the `questions` table and
 * the CSV importer use (src/routes/quizzes.$id.tsx:362-458). Mirrors
 * mcp/src/schema.ts:questionToDbRow. AI panel always inserts with
 * is_playable=false; the editor's existing per-question toggle is then used
 * by the creator to enable a question.
 */
export function questionToDbRow(q: BrainBoltQuestion, position: number): QuestionDbRow {
  const base = {
    text: q.text,
    position,
    time_limit_sec: q.timeLimitSec ?? null,
    point_value: q.type === "feedback" ? 0 : (q.pointValue ?? DEFAULT_POINT_VALUE),
    image_url: "imageUrl" in q && q.imageUrl ? q.imageUrl : null,
    double_points: q.doublePoints ?? false,
    is_playable: q.isPlayable ?? true,
  };

  switch (q.type) {
    case "mcq":
    case "image_mcq":
    case "image_reveal":
    case "audio":
      return {
        ...base,
        question_type: q.type,
        options: q.options,
        correct_index: q.correctIndex,
        ...NULL_EXTRAS,
        audio_url: q.type === "audio" && q.audioUrl ? q.audioUrl : null,
        reveal_stages: q.type === "image_reveal" ? (q.revealStages ?? DEFAULT_REVEAL_STAGES) : null,
      };
    case "true_false":
      return {
        ...base,
        question_type: "true_false",
        options: ["TRUE", "FALSE"],
        correct_index: q.correct ? 0 : 1,
        ...NULL_EXTRAS,
      };
    case "number": {
      const tolerance = q.tolerance ?? Math.max((q.max - q.min) * 0.1, 1);
      return {
        ...base,
        question_type: "number",
        options: [q.format ?? "general"],
        correct_index: -1,
        ...NULL_EXTRAS,
        correct_number: q.correctNumber,
        number_min: q.min,
        number_max: q.max,
        number_tolerance: tolerance,
      };
    }
    case "map_pin":
      if (q.regionLabel && !q.region) {
        throw new Error("map_pin: regionLabel requires region (the accepted polygon)");
      }
      return {
        ...base,
        question_type: "map_pin",
        options: [],
        correct_index: -1,
        ...NULL_EXTRAS,
        correct_lat: q.lat,
        correct_lng: q.lng,
        max_distance_km: q.maxDistanceKm ?? DEFAULT_MAX_DISTANCE_KM,
        geo_region: q.region ?? null,
        geo_region_label: q.regionLabel ?? null,
      };
    case "type":
      return {
        ...base,
        question_type: "type",
        options: [],
        correct_index: -1,
        ...NULL_EXTRAS,
        accepted_answers: q.acceptedAnswers,
      };
    case "feedback":
      return {
        ...base,
        question_type: "feedback",
        options: [""],
        correct_index: -1,
        ...NULL_EXTRAS,
      };
    case "ordering":
      return {
        ...base,
        question_type: "ordering",
        options: q.items,
        correct_index: -1,
        ...NULL_EXTRAS,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Semantic validation (mirrors mcp/src/validate.ts)                    */
/* ------------------------------------------------------------------ */

const MEDIA_PLACEHOLDER_HOSTS: ReadonlySet<string> = new Set([
  "example.com",
  "example.org",
  "example.net",
]);

function isReservedPlaceholderHost(host: string): boolean {
  return [...MEDIA_PLACEHOLDER_HOSTS].some(
    (reserved) => host === reserved || host.endsWith(`.${reserved}`),
  );
}

export function mediaUrlError(url: string | undefined | null): string | null {
  if (!url || url.trim() === "") {
    return "missing media URL — the LLM cannot invent working media, so this question is not playable until a real URL is added";
  }
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    return "media URL must be https:// (http:// URLs are rejected as unverifiable)";
  }
  let host: string;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return "media URL is not parseable";
  }
  if (isReservedPlaceholderHost(host)) {
    return `media URL host "${host}" is a reserved example domain — not real media`;
  }
  return null;
}

export const MEDIA_URL_POLICY = {
  missingUrlIsError: true,
  requiresHttps: true,
  placeholderHostsRejected: [...MEDIA_PLACEHOLDER_HOSTS].sort(),
  note: "Media questions (image_mcq, image_reveal, audio) are rejected without a real https URL; there is no automatic URL generation.",
} as const;

function extractQuestionIndex(path: Array<string | number>): number | null {
  if (path[0] === "questions" && typeof path[1] === "number") return path[1];
  return null;
}

export type ValidationIssue = {
  questionIndex: number | null;
  field: string;
  message: string;
};

export type ValidationReport = {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

const CHOICE_TYPES: ReadonlySet<string> = new Set(["mcq", "image_mcq", "image_reveal", "audio"]);

type ChoiceQuestion = Extract<
  BrainBoltQuiz["questions"][number],
  { options: string[]; correctIndex: number }
>;

function isChoiceType(q: BrainBoltQuiz["questions"][number]): q is ChoiceQuestion {
  return CHOICE_TYPES.has(q.type);
}

export function validateQuiz(input: unknown): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const parsed = quizSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        questionIndex: extractQuestionIndex(issue.path),
        field: issue.path.join("."),
        message: issue.message,
      });
    }
    return { valid: false, errors, warnings };
  }

  const quiz: BrainBoltQuiz = parsed.data;

  if (
    new Set(quiz.questions.map((q) => q.text.trim().toLowerCase())).size !== quiz.questions.length
  ) {
    warnings.push({
      questionIndex: null,
      field: "questions",
      message: "Duplicate question prompts detected",
    });
  }

  quiz.questions.forEach((q, i) => {
    const at = { questionIndex: i, field: "" };

    if (isChoiceType(q)) {
      if (q.correctIndex >= q.options.length) {
        errors.push({
          ...at,
          field: "correctIndex",
          message: `correctIndex ${q.correctIndex} is out of range (options.length = ${q.options.length})`,
        });
      }
      const dupes = q.options.filter((o, j) => q.options.indexOf(o) !== j);
      if (dupes.length > 0) {
        errors.push({
          ...at,
          field: "options",
          message: `Duplicate options: ${[...new Set(dupes)].join(", ")}`,
        });
      }
      if (q.type === "image_mcq" || q.type === "image_reveal") {
        const mediaError = mediaUrlError(q.imageUrl);
        if (mediaError) {
          errors.push({ ...at, field: "imageUrl", message: mediaError });
        }
      }
      if (q.type === "audio") {
        const mediaError = mediaUrlError(q.audioUrl);
        if (mediaError) {
          errors.push({ ...at, field: "audioUrl", message: mediaError });
        }
      }
    }

    if (q.type === "ordering" && q.items.some((item) => item.includes(";"))) {
      errors.push({
        ...at,
        field: "items",
        message:
          'ordering items must not contain ";" — the CSV importer splits order_items on ";" and the round-trip would corrupt them',
      });
    }

    if (q.type === "type" && q.acceptedAnswers.some((answer) => answer.includes(";"))) {
      errors.push({
        ...at,
        field: "acceptedAnswers",
        message:
          'accepted answers must not contain ";" — the CSV importer splits accepted_answers on ";" and the round-trip would corrupt them',
      });
    }

    if (q.type === "true_false" && !q.text.trim().endsWith("?")) {
      warnings.push({
        ...at,
        field: "text",
        message: "true_false statements usually read better as questions",
      });
    }

    if (q.type === "number") {
      if (q.max <= q.min) {
        errors.push({
          ...at,
          field: "max",
          message: `max (${q.max}) must be greater than min (${q.min})`,
        });
      }
      if (q.correctNumber < q.min || q.correctNumber > q.max) {
        errors.push({
          ...at,
          field: "correctNumber",
          message: `correctNumber ${q.correctNumber} outside [${q.min}, ${q.max}]`,
        });
      }
      if (q.tolerance !== undefined && (q.tolerance < 0 || q.tolerance > q.max - q.min)) {
        errors.push({
          ...at,
          field: "tolerance",
          message: `tolerance ${q.tolerance} outside [0, ${q.max - q.min}]`,
        });
      }
    }

    if (q.type === "map_pin" && q.maxDistanceKm !== undefined && q.maxDistanceKm <= 0) {
      errors.push({ ...at, field: "maxDistanceKm", message: "must be positive" });
    }

    if (q.type === "ordering" && new Set(q.items).size !== q.items.length) {
      errors.push({ ...at, field: "items", message: "ordering items must be unique" });
    }

    if (
      q.type === "type" &&
      new Set(q.acceptedAnswers.map((a) => a.toLowerCase())).size !== q.acceptedAnswers.length
    ) {
      warnings.push({
        ...at,
        field: "acceptedAnswers",
        message: "acceptedAnswers contains near-duplicates (case-insensitive)",
      });
    }

    if (q.type !== "feedback" && q.pointValue !== undefined && q.pointValue <= 0) {
      errors.push({
        ...at,
        field: "pointValue",
        message: "scored questions need pointValue > 0 (feedback questions use 0)",
      });
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

export function formatIssues(report: ValidationReport): string {
  const parts: string[] = [];
  for (const e of report.errors) {
    parts.push(
      `- ${e.questionIndex === null ? "quiz" : `question[${e.questionIndex}]`}.${e.field}: ${e.message}`,
    );
  }
  return parts.join("\n");
}
