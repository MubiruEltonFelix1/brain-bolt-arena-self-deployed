// Brain Bolt question-type reference for the MCP server.
//
// MIRROR of the app's registry (source of truth):
//   - src/lib/question-registry.ts      (type ids, answerKind, scored, accent)
//   - src/routes/quizzes.$id.tsx        (CSV template + per-type storage columns)
// Keep this file in sync when question types change in the app.

export type QuestionTypeId =
  | "mcq"
  | "image_mcq"
  | "true_false"
  | "number"
  | "image_reveal"
  | "audio"
  | "ordering"
  | "type"
  | "feedback"
  | "map_pin";

export type Accent = "volt" | "pink-shock" | "cyan-jolt" | "amber-spark";

export const QUESTION_TYPES: QuestionTypeId[] = [
  "mcq",
  "image_mcq",
  "true_false",
  "number",
  "image_reveal",
  "audio",
  "ordering",
  "type",
  "feedback",
  "map_pin",
];

export type QuestionTypeMeta = {
  name: string;
  description: string;
  accent: Accent;
  /** False only for opinion collection (no correct answer, no points). */
  scored: boolean;
  /** Whether the question needs an external media URL to be playable. */
  needsMedia: boolean;
  /** The columns the CSV importer / DB row expects for this type. */
  csvColumns: string;
};

export const QUESTION_TYPE_META: Record<QuestionTypeId, QuestionTypeMeta> = {
  mcq: {
    name: "Quick Pick",
    description: "Choose the correct answer",
    accent: "volt",
    scored: true,
    needsMedia: false,
    csvColumns: "option_a..option_f + correct_answer (letter or option text)",
  },
  image_mcq: {
    name: "Quick Pick (image)",
    description: "Choose the correct answer with an image",
    accent: "volt",
    scored: true,
    needsMedia: true,
    csvColumns: "option_a..option_f + correct_answer + image_url",
  },
  true_false: {
    name: "Fact or Fiction",
    description: "Decide what is true",
    accent: "pink-shock",
    scored: true,
    needsMedia: false,
    csvColumns: "correct_answer = TRUE or FALSE",
  },
  number: {
    name: "Closest Shot",
    description: "Get as close as possible",
    accent: "amber-spark",
    scored: true,
    needsMedia: false,
    csvColumns: "numeric_answer, tolerance, slider_min, slider_max, answer_format",
  },
  image_reveal: {
    name: "Mystery Reveal",
    description: "Identify before the image appears",
    accent: "cyan-jolt",
    scored: true,
    needsMedia: true,
    csvColumns: "option_a..option_f + correct_answer + image_url + reveal_duration",
  },
  audio: {
    name: "Sound Detective",
    description: "Listen carefully",
    accent: "cyan-jolt",
    scored: true,
    needsMedia: true,
    csvColumns: "option_a..option_f + correct_answer + audio_url",
  },
  ordering: {
    name: "Sequence Master",
    description: "Arrange everything correctly",
    accent: "pink-shock",
    scored: true,
    needsMedia: false,
    csvColumns: "order_items (semicolon-separated, correct order)",
  },
  type: {
    name: "Thought Bubble",
    description: "Share your answer",
    accent: "volt",
    scored: true,
    needsMedia: false,
    csvColumns: "accepted_answers (semicolon-separated)",
  },
  feedback: {
    name: "Voice of the Crowd",
    description: "Tell us what you think",
    accent: "cyan-jolt",
    scored: false,
    needsMedia: false,
    csvColumns: "none — no correct answer, 0 points",
  },
  map_pin: {
    name: "Pin Drop",
    description: "Find it on the map",
    accent: "cyan-jolt",
    scored: true,
    needsMedia: false,
    csvColumns: "map_latitude, map_longitude, tolerance (km radius, default 5000)",
  },
};

/**
 * CSV type names as emitted by the quiz editor's template
 * (src/routes/quizzes.$id.tsx:44-54). The importer maps these back to the
 * canonical ids. "matching" is intentionally absent — not supported in gameplay.
 */
export function legacyCsvType(type: QuestionTypeId): string {
  switch (type) {
    case "mcq":
      return "multiple_choice";
    case "number":
      return "closest_number";
    case "type":
      return "text";
    case "feedback":
      return "free_text";
    default:
      return type;
  }
}

/**
 * The quiz editor's universal CSV template header — 25 columns
 * (src/routes/quizzes.$id.tsx:43). `option_e`/`option_f` are appended
 * dynamically by the serializer when a choice question has > 4 options
 * (the importer resolves them by header name, src/routes/quizzes.$id.tsx:281).
 */
export const CSV_HEADER =
  "question_type,question,option_a,option_b,option_c,option_d,correct_answer,explanation,time_limit,points,image_url,audio_url,map_latitude,map_longitude,map_zoom,numeric_answer,tolerance,answer_format,slider_min,slider_max,accepted_answers,reveal_duration,order_items,match_pairs,double_points";

export const CSV_EXTRA_OPTIONS_HEADER = ",option_e,option_f";
