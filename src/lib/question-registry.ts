// Central question-type registry.
//
// One place that knows what a question type is called, how it looks in the
// intro screen, what shape its answer takes and the small pure helpers every
// surface (host, player, Arena, Training) needs to grade or render it.
//
// Adding a question type means adding an entry here plus its body in
// `src/components/question/QuestionBodies.tsx` — not editing three routes.

export const INTRO_DURATION_MS = 5000;

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

/** How the player's answer is expressed. Drives which body component renders. */
export type AnswerKind = "choice" | "order" | "geo" | "number" | "text";

export type QuestionTypeDef = {
  icon: string;
  name: string;
  description: string;
  accent: "volt" | "pink-shock" | "cyan-jolt" | "amber-spark";
  /** Shape of the submitted answer. */
  answerKind: AnswerKind;
  /** False only for opinion collection (no correct answer, no points). */
  scored: boolean;
  /** Extra media the body renders alongside the prompt. */
  media: "image" | "image_reveal" | "audio" | "map" | null;
};

const REGISTRY: Record<string, QuestionTypeDef> = {
  mcq: {
    icon: "🧠",
    name: "Quick Pick",
    description: "Choose the correct answer",
    accent: "volt",
    answerKind: "choice",
    scored: true,
    media: null,
  },
  image_mcq: {
    icon: "🧠",
    name: "Quick Pick",
    description: "Choose the correct answer",
    accent: "volt",
    answerKind: "choice",
    scored: true,
    media: "image",
  },
  true_false: {
    icon: "⚖️",
    name: "Fact or Fiction",
    description: "Decide what is true",
    accent: "pink-shock",
    answerKind: "choice",
    scored: true,
    media: null,
  },
  number: {
    icon: "🎯",
    name: "Closest Shot",
    description: "Get as close as possible",
    accent: "amber-spark",
    answerKind: "number",
    scored: true,
    media: null,
  },
  image_reveal: {
    icon: "👀",
    name: "Mystery Reveal",
    description: "Identify before the image appears",
    accent: "cyan-jolt",
    answerKind: "choice",
    scored: true,
    media: "image_reveal",
  },
  audio: {
    icon: "🎧",
    name: "Sound Detective",
    description: "Listen carefully",
    accent: "cyan-jolt",
    answerKind: "choice",
    scored: true,
    media: "audio",
  },
  ordering: {
    icon: "🧩",
    name: "Sequence Master",
    description: "Arrange everything correctly",
    accent: "pink-shock",
    answerKind: "order",
    scored: true,
    media: null,
  },
  type: {
    icon: "✍️",
    name: "Thought Bubble",
    description: "Share your answer",
    accent: "volt",
    answerKind: "text",
    scored: true,
    media: null,
  },
  feedback: {
    icon: "💬",
    name: "Voice of the Crowd",
    description: "Tell us what you think",
    accent: "cyan-jolt",
    answerKind: "text",
    scored: false,
    media: null,
  },
  map_pin: {
    icon: "🗺️",
    name: "Pin Drop",
    description: "Find it on the map",
    accent: "cyan-jolt",
    answerKind: "geo",
    scored: true,
    media: "map",
  },
};

export function getQuestionType(type: string): QuestionTypeDef {
  return REGISTRY[type] ?? REGISTRY.mcq;
}

export function getAnswerKind(type: string): AnswerKind {
  return getQuestionType(type).answerKind;
}

/* ------------------------------------------------------------------ */
/* Pure helpers shared by every surface                                */
/* ------------------------------------------------------------------ */

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Blur schedule for image-reveal questions on the solo surfaces
 * (Arena + Training). 24px → 0 across `stages` steps.
 */
export function soloRevealBlur(elapsedMs: number, totalMs: number, stages?: number | null) {
  const s = Math.max(2, stages ?? 5);
  const stage = Math.min(s, Math.floor((elapsedMs / Math.max(totalMs, 1)) * s));
  return { stage, stages: s, blurPx: Math.max(0, 24 - (24 / s) * stage) };
}

/**
 * Blur schedule used on the live player screen. Intentionally distinct from
 * `soloRevealBlur`: the live screen also shows "stage x of y" to the room and
 * starts from a heavier 32px blur.
 */
export function liveRevealBlur(elapsedMs: number, totalMs: number, stages?: number | null) {
  const s = Math.max(2, Math.min(10, stages ?? 5));
  const stage = Math.min(s - 1, Math.floor((elapsedMs / Math.max(totalMs, 1)) * s));
  const fraction = stage / (s - 1);
  return { stage, stages: s, blurPx: Math.max(0, Math.round((1 - fraction) * 32)) };
}

/** Partial credit for ordering: share of items in the right slot. */
export function orderingRatio(submitted: string[], correct: string[]) {
  if (!correct.length) return 0;
  const hits = submitted.reduce((acc, label, i) => acc + (label === correct[i] ? 1 : 0), 0);
  return hits / correct.length;
}

/** Partial credit for a map pin, relative to the tolerance radius. */
export function geoRatio(distanceKm: number, toleranceKm: number) {
  return Math.max(0, 1 - distanceKm / (Math.max(1, toleranceKm) * 4));
}

/** Partial credit for a numeric guess, relative to the allowed range. */
export function numberRatio(diff: number, min: number, max: number) {
  const range = Math.max(1, max - min);
  return Math.max(0, 1 - diff / (range / 2));
}
