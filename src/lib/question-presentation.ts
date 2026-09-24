// Central question-type PRESENTATION registry.
//
// THE ONLY place that decides what a question type is *called* in the UI.
// Nothing else in the app may hardcode a type name, an icon, an editor hint or
// a player-facing explanation — import from here instead. Internal enum ids
// (`mcq`, `true_false`, …) never reach the DOM; they stay in the database, the
// RPC payloads and the branching logic.
//
// `src/lib/question-registry.ts` owns the *behaviour* of a type (answer shape,
// scoring, media, accent) and imports its user-facing strings from this file.
// That keeps one-directional dependencies: registry → presentation.
//
// Adding a question type = add an entry to `PRESENTATION` here, add its
// behaviour in the registry, and add its body to `QuestionRenderer`.

import type { QuestionTypeId } from "./question-registry";

export type QuestionPresentation = {
  /** Plain, unambiguous name. Lists, pickers, badges, round headers. */
  label: string;
  /** Short game-show flavour line. Only used for the pre-question intro moment. */
  tagline: string;
  /** One line telling the player exactly what to do. */
  description: string;
  /** Glyph shown next to the label. */
  icon: string;
  /** Editor-facing guidance: what the type is for and what it needs to be valid. */
  helpText: string;
  /** What the player is about to do, in the player's own words. */
  playerHint: string;
};

/**
 * `matching` is listed even though it has no behaviour entry yet — if the id
 * ever arrives from an import or a future migration it renders a real label
 * instead of leaking the enum.
 */
const PRESENTATION: Record<string, QuestionPresentation> = {
  mcq: {
    label: "Multiple Choice",
    tagline: "Quick Pick",
    description: "Choose the correct answer",
    icon: "🧠",
    helpText: "Offer up to six options and mark one correct. The workhorse type.",
    playerHint: "Tap the answer you think is right",
  },
  image_mcq: {
    label: "Image Multiple Choice",
    tagline: "Picture Round",
    description: "Look at the image, then choose",
    icon: "🖼️",
    helpText: "Multiple choice with an image above the options. Needs an image URL.",
    playerHint: "Study the image, then tap the answer",
  },
  true_false: {
    label: "True or False",
    tagline: "Fact or Fiction",
    description: "Decide whether the statement is true",
    icon: "⚖️",
    helpText: "A statement with exactly two options. Fast to answer, hard to bluff.",
    playerHint: "Choose True or False",
  },
  number: {
    label: "Closest Number",
    tagline: "Closest Shot",
    description: "Get as close to the real number as you can",
    icon: "🎯",
    helpText:
      "A numeric guess with a minimum, a maximum and a tolerance. Partial credit applies.",
    playerHint: "Type your best guess",
  },
  image_reveal: {
    label: "Image Reveal",
    tagline: "Mystery Reveal",
    description: "Identify it as the image sharpens",
    icon: "👀",
    helpText: "The image starts blurred and sharpens over the timer. Needs an image URL.",
    playerHint: "Answer before the image fully clears",
  },
  audio: {
    label: "Listen & Answer",
    tagline: "Sound Detective",
    description: "Listen to the clip, then choose",
    icon: "🎧",
    helpText: "Plays an audio clip once. Needs an audio URL.",
    playerHint: "Listen closely, then tap the answer",
  },
  ordering: {
    label: "Put in Order",
    tagline: "Sequence Master",
    description: "Arrange the items into the right sequence",
    icon: "🧩",
    helpText: "Players drag the options into order. Partial credit for the slots they get right.",
    playerHint: "Drag the items into the correct order",
  },
  type: {
    label: "Type Your Answer",
    tagline: "Thought Bubble",
    description: "Type the answer in your own words",
    icon: "✍️",
    helpText: "Free text with accepted answers. Add every spelling you will accept.",
    playerHint: "Type your answer",
  },
  feedback: {
    label: "Written Answer",
    tagline: "Voice of the Crowd",
    description: "Share what you think — there is no wrong answer",
    icon: "💬",
    helpText:
      "Collects opinions. Not scored and not available in Arena — use it for open questions.",
    playerHint: "Type your response — everyone's answer is shown",
  },
  map_pin: {
    label: "Pin the Map",
    tagline: "Pin Drop",
    description: "Drop a pin as close as you can",
    icon: "🗺️",
    helpText:
      "Players drop a pin on the world map. Set a region or coordinates plus a tolerance radius.",
    playerHint: "Drop your pin on the map",
  },
  matching: {
    label: "Match the Pairs",
    tagline: "Match Up",
    description: "Pair each item with its match",
    icon: "🔗",
    helpText: "Players pair items from two columns. Not available yet — reserved for a future release.",
    playerHint: "Match each item to its pair",
  },
};

/** Used for an unknown or missing id, so a bad payload can never print an enum. */
export const FALLBACK_PRESENTATION: QuestionPresentation = {
  label: "Question",
  tagline: "Question",
  description: "Answer the question",
  icon: "❓",
  helpText: "This question type is not recognised. Update the app to play it.",
  playerHint: "Answer the question",
};

/** Display order for pickers and legend lists — easiest-to-hardest to author. */
export const QUESTION_TYPE_ORDER: QuestionTypeId[] = [
  "mcq",
  "true_false",
  "image_mcq",
  "number",
  "type",
  "ordering",
  "map_pin",
  "image_reveal",
  "audio",
  "feedback",
];

export function getQuestionPresentation(type?: string | null): QuestionPresentation {
  if (!type) return FALLBACK_PRESENTATION;
  return PRESENTATION[type] ?? FALLBACK_PRESENTATION;
}

/** Plain name for any surface that needs to identify a type. */
export function questionTypeLabel(type?: string | null): string {
  return getQuestionPresentation(type).label;
}

export function questionTypeDescription(type?: string | null): string {
  return getQuestionPresentation(type).description;
}

export function questionTypeIcon(type?: string | null): string {
  return getQuestionPresentation(type).icon;
}

export function questionTypeHelpText(type?: string | null): string {
  return getQuestionPresentation(type).helpText;
}

/** True when the id has a real registry entry (used to filter unknown imports). */
export function isKnownQuestionType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRESENTATION, type);
}

/** Every type as a picker-ready option, in display order. */
export function questionTypeOptions(
  ids: QuestionTypeId[] = QUESTION_TYPE_ORDER,
): Array<{ id: QuestionTypeId } & QuestionPresentation> {
  return ids.map((id) => ({ id, ...getQuestionPresentation(id) }));
}

/**
 * Turns a list of internal type ids into a readable sentence, e.g.
 * `["mcq", "true_false"]` → "Multiple Choice and True or False". Used wherever
 * the UI has to summarise which types a quiz contains.
 */
export function questionTypeListLabel(types: readonly string[]): string {
  const labels = Array.from(new Set(types)).map(questionTypeLabel);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
