// Canonical Brain Bolt quiz contract for the MCP server.
//
// The LLM-facing shape is camelCase and deliberately LLM-friendly (boolean
// `correct` for true_false, `items` for ordering, etc.). `toDbRows()` maps it
// to the exact column objects the app's CSV importer and the Supabase
// `questions` table expect (src/routes/quizzes.$id.tsx:362-458).

import { z } from "zod";
import { CSV_HEADER, legacyCsvType, type QuestionTypeId } from "./question-types";

/* ------------------------------------------------------------------ */
/* Limits (single source of truth — mirrored from the app editor)       */
/* ------------------------------------------------------------------ */

/** Quiz-level seconds per question — the app editor caps this at 120 (quizzes.$id.tsx). */
export const QUIZ_TIME_PER_QUESTION_MIN = 5;
export const QUIZ_TIME_PER_QUESTION_MAX = 120;
/** Per-question override — the CSV importer accepts 5-300. */
export const QUESTION_TIME_MIN = 5;
export const QUESTION_TIME_MAX = 300;
/** Points per question — the CSV importer accepts 0-100000 (0 = feedback). */
export const POINT_VALUE_MIN = 0;
export const POINT_VALUE_MAX = 100000;
/** Quiz size — a deliberate cap for one generation/save call. */
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 30;
/** Choice questions — the app editor and importer enforce 2-6 options. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
/** Ordering — the app editor and importer enforce 2-8 items. */
export const MIN_ORDERING_ITEMS = 2;
export const MAX_ORDERING_ITEMS = 8;

/* ------------------------------------------------------------------ */
/* Zod schemas                                                          */
/* ------------------------------------------------------------------ */

const commonFields = {
  /** The prompt shown to players. */
  text: z.string().min(1),
  /** Seconds allowed (5-300). Omit to inherit the quiz default (20s). */
  timeLimitSec: z.number().int().min(QUESTION_TIME_MIN).max(QUESTION_TIME_MAX).optional(),
  /** Points awarded (0-100000, 0 for feedback). Default 1000. */
  pointValue: z.number().int().min(POINT_VALUE_MIN).max(POINT_VALUE_MAX).optional(),
  /** Doubles the score for this round. Default false. */
  doublePoints: z.boolean().optional(),
  /** Whether players can be served this question. Default true. */
  isPlayable: z.boolean().optional(),
};

const choiceFields = {
  options: z.array(z.string().min(1)).min(MIN_OPTIONS).max(MAX_OPTIONS),
  /** 0-based index of the correct option. */
  correctIndex: z.number().int().min(0),
};

/** GeoJSON geometry for region-based map_pin questions (coords are [lng, lat]). */
const geoRegionSchema = z.object({
  type: z.enum(["Polygon", "MultiPolygon"]),
  coordinates: z.any(),
});

export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    ...commonFields,
    type: z.literal("mcq"),
    ...choiceFields,
  }),
  z.object({
    ...commonFields,
    type: z.literal("image_mcq"),
    ...choiceFields,
    imageUrl: z.string().url().optional(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("true_false"),
    /** true = statement is TRUE, false = statement is FALSE. */
    correct: z.boolean(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("number"),
    /** The exact target number. Must lie within min..max. */
    correctNumber: z.number(),
    min: z.number(),
    max: z.number(),
    /** Accepted deviation; defaults to max((max-min)*0.1, 1). */
    tolerance: z.number().positive().optional(),
    format: z.enum(["general", "year", "decimal", "percentage", "currency"]).optional(),
    unit: z.string().optional(),
  }),
  z.object({
    ...commonFields,
    type: z.literal("image_reveal"),
    ...choiceFields,
    imageUrl: z.string().url().optional(),
    /** Number of reveal stages; defaults to 5. */
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
    /** Items in CORRECT order (first = position 1). */
    items: z.array(z.string().min(1)).min(MIN_ORDERING_ITEMS).max(MAX_ORDERING_ITEMS),
  }),
  z.object({
    ...commonFields,
    type: z.literal("type"),
    /** All accepted phrasings of the answer. */
    acceptedAnswers: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    ...commonFields,
    type: z.literal("feedback"),
  }),
  z.object({
    ...commonFields,
    type: z.literal("map_pin"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    /** Tolerance radius in km; defaults to 5000. */
    maxDistanceKm: z.number().positive().optional(),
    /** Accepted region polygon — any click inside scores full marks. */
    region: geoRegionSchema.optional(),
    /** Display label for the region (e.g. "Kenya"). */
    regionLabel: z.string().min(1).optional(),
  }),
]);

export type BrainBoltQuestion = z.infer<typeof questionSchema>;

export const quizSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    /** Quiz-wide per-question time in seconds; default 20. App editor caps at 120. */
    timePerQuestionSec: z
      .number()
      .int()
      .min(QUIZ_TIME_PER_QUESTION_MIN)
      .max(QUIZ_TIME_PER_QUESTION_MAX)
      .optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    questions: z.array(questionSchema).min(MIN_QUESTIONS).max(MAX_QUESTIONS),
  })
  // Cross-field rule that cannot live inside the discriminated union (a
  // refined member would break z.discriminatedUnion in zod v3).
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
/* DB row mapping                                                       */
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
  geo_region: null as unknown as { type: "Polygon" | "MultiPolygon"; coordinates?: unknown } | null,
  geo_region_label: null as string | null,
};

export type QuestionDbRow = {
  text: string;
  position: number;
  time_limit_sec: number | null;
  point_value: number;
  question_type: QuestionTypeId;
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
 * the CSV importer use (src/routes/quizzes.$id.tsx:362-458):
 *   mcq/image_mcq/image_reveal/audio → options[] + correct_index
 *   true_false                      → ["TRUE","FALSE"] + correct_index 0|1
 *   number                          → options [format] + correct_index -1
 *   map_pin                         → options [] + correct_index -1 + lat/lng
 *   type                            → options [] + correct_index -1 + accepted_answers
 *   feedback                        → options [""] + correct_index -1 + point_value 0
 *   ordering                        → options items + correct_index -1
 * `correct_index` and `options` are NOT NULL in the DB — always emitted.
 */
export function questionToDbRow(q: BrainBoltQuestion, position: number): QuestionDbRow {
  const base = {
    text: q.text,
    position,
    time_limit_sec: q.timeLimitSec ?? null,
    point_value: q.type === "feedback" ? 0 : (q.pointValue ?? DEFAULT_POINT_VALUE),
    image_url: "imageUrl" in q && q.imageUrl ? q.imageUrl : null,
    double_points: q.doublePoints ?? false,
    // Mirrors the DB column default (questions.is_playable DEFAULT TRUE).
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

/**
 * The canonical field set per question type (camelCase, as accepted by
 * questionSchema). Used by update_question to report fields that do not
 * apply to a question's type as warnings instead of silently dropping them.
 */
export const QUESTION_TYPE_FIELDS: Record<QuestionTypeId, readonly string[]> = {
  mcq: [
    "text",
    "timeLimitSec",
    "pointValue",
    "doublePoints",
    "isPlayable",
    "options",
    "correctIndex",
  ],
  image_mcq: [
    "text",
    "timeLimitSec",
    "pointValue",
    "doublePoints",
    "isPlayable",
    "options",
    "correctIndex",
    "imageUrl",
  ],
  true_false: ["text", "timeLimitSec", "pointValue", "doublePoints", "isPlayable", "correct"],
  number: [
    "text",
    "timeLimitSec",
    "pointValue",
    "doublePoints",
    "isPlayable",
    "correctNumber",
    "min",
    "max",
    "tolerance",
    "format",
  ],
  image_reveal: [
    "text",
    "timeLimitSec",
    "pointValue",
    "doublePoints",
    "isPlayable",
    "options",
    "correctIndex",
    "imageUrl",
    "revealStages",
  ],
  audio: [
    "text",
    "timeLimitSec",
    "pointValue",
    "doublePoints",
    "isPlayable",
    "options",
    "correctIndex",
    "audioUrl",
  ],
  ordering: ["text", "timeLimitSec", "pointValue", "doublePoints", "isPlayable", "items"],
  type: ["text", "timeLimitSec", "pointValue", "doublePoints", "isPlayable", "acceptedAnswers"],
  feedback: ["text", "timeLimitSec", "pointValue", "doublePoints", "isPlayable"],
  map_pin: [
    "text",
    "timeLimitSec",
    "pointValue",
    "doublePoints",
    "isPlayable",
    "lat",
    "lng",
    "maxDistanceKm",
    "region",
    "regionLabel",
  ],
};

/** A `questions` row as read back from the database (snake_case). */
export type QuestionDbRowLike = {
  id?: string;
  question_type: string;
  text: string;
  options: unknown;
  correct_index: number;
  time_limit_sec: number | null;
  point_value: number;
  image_url: string | null;
  double_points: boolean;
  is_playable: boolean;
  correct_lat: number | null;
  correct_lng: number | null;
  max_distance_km: number | null;
  correct_number: number | null;
  number_min: number | null;
  number_max: number | null;
  number_tolerance: number | null;
  accepted_answers: string[] | null;
  audio_url: string | null;
  reveal_stages: number | null;
  geo_region: { type: "Polygon" | "MultiPolygon"; coordinates?: unknown } | null;
  geo_region_label: string | null;
};

const NUMBER_FORMATS = ["general", "year", "decimal", "percentage", "currency"] as const;

/**
 * Inverse of questionToDbRow: maps a `questions` table row back to the
 * camelCase Brain Bolt question contract. This is what get_quiz returns so
 * the round-trip (get → edit → save/validate) is lossless.
 */
export function dbQuestionRowToCamel(row: QuestionDbRowLike): BrainBoltQuestion {
  const base = {
    text: row.text,
    timeLimitSec: row.time_limit_sec ?? undefined,
    pointValue: row.point_value,
    doublePoints: row.double_points || undefined,
    isPlayable: row.is_playable ?? true,
  };
  const options = Array.isArray(row.options) ? (row.options as string[]) : [];

  switch (row.question_type) {
    case "mcq":
    case "image_mcq":
    case "image_reveal":
    case "audio":
      return {
        ...base,
        type: row.question_type,
        options,
        correctIndex: row.correct_index,
        imageUrl: row.image_url ? row.image_url : undefined,
        audioUrl: row.question_type === "audio" && row.audio_url ? row.audio_url : undefined,
        revealStages:
          row.question_type === "image_reveal" && row.reveal_stages != null
            ? row.reveal_stages
            : undefined,
      };
    case "true_false":
      return { ...base, type: "true_false", correct: row.correct_index === 0 };
    case "number": {
      const format = options[0] as (typeof NUMBER_FORMATS)[number] | undefined;
      return {
        ...base,
        type: "number",
        correctNumber: row.correct_number ?? 0,
        min: row.number_min ?? 0,
        max: row.number_max ?? 0,
        tolerance: row.number_tolerance ?? undefined,
        format: format && NUMBER_FORMATS.includes(format) ? format : undefined,
      };
    }
    case "map_pin":
      return {
        ...base,
        type: "map_pin",
        lat: row.correct_lat ?? 0,
        lng: row.correct_lng ?? 0,
        maxDistanceKm: row.max_distance_km ?? undefined,
        region: row.geo_region ?? undefined,
        regionLabel: row.geo_region_label ?? undefined,
      };
    case "type":
      return { ...base, type: "type", acceptedAnswers: row.accepted_answers ?? [] };
    case "feedback":
      return { ...base, type: "feedback" };
    case "ordering":
      return { ...base, type: "ordering", items: options };
    default:
      throw new Error(
        `questions row has unsupported question_type "${row.question_type}" — ` +
          "this quiz may have been written by a newer app version",
      );
  }
}

/** The quizzes-table row for save_quiz. */
export type QuizDbRow = {
  title: string;
  description: string | null;
  time_per_question: number;
  owner_principal_id: string;
  difficulty: "easy" | "medium" | "hard" | null;
  estimated_duration_minutes: number | null;
};

export function quizToDbRow(quiz: BrainBoltQuiz, ownerId: string): QuizDbRow {
  return {
    title: quiz.title,
    description: quiz.description ?? null,
    time_per_question: quiz.timePerQuestionSec ?? 20,
    owner_principal_id: ownerId,
    difficulty: quiz.difficulty ?? null,
    estimated_duration_minutes: Math.max(1, Math.round(quiz.questions.length * 0.5)),
  };
}

export { CSV_HEADER, legacyCsvType };
