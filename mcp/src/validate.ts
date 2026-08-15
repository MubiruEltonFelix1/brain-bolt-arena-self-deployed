// Semantic validation of a quiz beyond the zod shape checks.
// Used both for the validate_quiz tool and to grade generate_quiz output.

import { quizSchema, type BrainBoltQuiz } from "./schema";

/**
 * Media URL policy (H1): media questions are only accepted with a real, usable
 * URL. LLMs invent http:// links and IANA example hosts routinely — treat both
 * as invalid. There is no automatic URL generation; a media question without a
 * valid URL is a hard validation error on every surface (validate_quiz,
 * generate_quiz, to_csv, save_quiz).
 */
const MEDIA_PLACEHOLDER_HOSTS: ReadonlySet<string> = new Set([
  "example.com",
  "example.org",
  "example.net",
]);

/**
 * Suffix-aware check: rejects the bare host AND any subdomain of it
 * (example.com.evil.com must not slip through). Only genuine example.* hosts
 * are reserved — evil-example.com is not IANA-reserved and stays accepted.
 */
function isReservedPlaceholderHost(host: string): boolean {
  return [...MEDIA_PLACEHOLDER_HOSTS].some(
    (reserved) => host === reserved || host.endsWith(`.${reserved}`),
  );
}

/** Returns a rejection reason when the URL cannot be trusted as real media, or null when OK. */
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

/** Exposed for get_capabilities — the media URL policy an agent must satisfy. */
export const MEDIA_URL_POLICY = {
  missingUrlIsError: true,
  requiresHttps: true,
  placeholderHostsRejected: [...MEDIA_PLACEHOLDER_HOSTS].sort(),
  note: "Media questions (image_mcq, image_reveal, audio) are rejected without a real https URL; there is no automatic URL generation.",
} as const;

/**
 * Extracts the affected question index from a zod issue path.
 * Zod paths are arrays: questions[2].options → ["questions", 2, "options"].
 */
export function extractQuestionIndex(path: Array<string | number>): number | null {
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
      // Not an error — just style guidance.
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
