// Serializes a Brain Bolt quiz to the editor's universal CSV format
// (header + row conventions: src/routes/quizzes.$id.tsx:43-55, 362-458).

import { CSV_EXTRA_OPTIONS_HEADER, CSV_HEADER, legacyCsvType } from "./question-types";
import { quizSchema, questionToDbRow, type BrainBoltQuiz } from "./schema";
import { validateQuiz, extractQuestionIndex, type ValidationReport } from "./validate";

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];

/**
 * Builds one CSV row for a question. Uses the same per-type conventions as the
 * importer's row mapping (quizzes.$id.tsx:362-458), but with the editor's
 * legacy type names (multiple_choice, closest_number, text, free_text).
 */
function questionToCsvRow(quiz: BrainBoltQuiz, questionIndex: number): Record<string, string> {
  const q = quiz.questions[questionIndex];
  if (!q) throw new Error(`questionToCsvRow: no question at index ${questionIndex}`);

  const row: Record<string, string> = {
    question_type: legacyCsvType(q.type),
    question: q.text,
    explanation: "",
    time_limit: q.timeLimitSec ? String(q.timeLimitSec) : "",
    points: String(q.type === "feedback" ? 0 : (q.pointValue ?? 1000)),
    image_url: "imageUrl" in q && q.imageUrl ? q.imageUrl : "",
    audio_url: "audioUrl" in q && q.audioUrl ? q.audioUrl : "",
    double_points: q.doublePoints ? "true" : "false",
    match_pairs: "",
  };

  switch (q.type) {
    case "mcq":
    case "image_mcq":
    case "image_reveal":
    case "audio":
      q.options.forEach((opt, i) => {
        row[`option_${OPTION_LETTERS[i]!.toLowerCase()}`] = opt;
      });
      row.correct_answer = OPTION_LETTERS[q.correctIndex] ?? String(q.correctIndex + 1);
      if (q.type === "image_reveal") row.reveal_duration = String(q.revealStages ?? 5);
      break;
    case "true_false":
      row.correct_answer = q.correct ? "TRUE" : "FALSE";
      break;
    case "number":
      row.numeric_answer = String(q.correctNumber);
      row.tolerance = String(q.tolerance ?? Math.max((q.max - q.min) * 0.1, 1));
      row.answer_format = q.format ?? "general";
      row.slider_min = String(q.min);
      row.slider_max = String(q.max);
      break;
    case "map_pin":
      row.map_latitude = String(q.lat);
      row.map_longitude = String(q.lng);
      row.tolerance = String(q.maxDistanceKm ?? 5000);
      break;
    case "type":
      row.accepted_answers = q.acceptedAnswers.join(";");
      break;
    case "feedback":
      break; // no correct answer
    case "ordering":
      row.order_items = q.items.join(";");
      break;
  }

  return row;
}

/**
 * Serializes a quiz to the editor's CSV template. Emits the canonical 25-column
 * header; if any choice question has more than 4 options, `option_e,option_f`
 * columns are appended to the header and every row (the importer resolves
 * options by header name — quizzes.$id.tsx:281 — so this round-trips fine).
 */
export function quizToCsv(quiz: BrainBoltQuiz): string {
  const needsExtraOptions = quiz.questions.some(
    (q) =>
      (q.type === "mcq" ||
        q.type === "image_mcq" ||
        q.type === "image_reveal" ||
        q.type === "audio") &&
      q.options.length > 4,
  );

  const header = CSV_HEADER + (needsExtraOptions ? CSV_EXTRA_OPTIONS_HEADER : "");
  const columns = header.split(",");

  const rows = quiz.questions.map((_, i) => {
    const row = questionToCsvRow(quiz, i);
    return columns.map((col) => csvCell(row[col] ?? "")).join(",");
  });

  return [header, ...rows].join("\n") + "\n";
}

/**
 * M3: the CSV export gate. Serializes only after full semantic validation, so
 * "MCP exported it" implies "the app importer accepts it". Never emits
 * misleading CSV for an invalid quiz.
 */
export function validatedQuizToCsv(
  input: unknown,
): { ok: true; csv: string } | { ok: false; report: ValidationReport } {
  const report = validateQuiz(input);
  if (!report.valid) return { ok: false, report };
  const parsed = quizSchema.safeParse(input);
  // validateQuiz already proved the shape — this only succeeds.
  if (!parsed.success) {
    return {
      ok: false,
      report: {
        valid: false,
        errors: parsed.error.issues.map((issue) => ({
          questionIndex: extractQuestionIndex(issue.path),
          field: issue.path.join("."),
          message: issue.message,
        })),
        warnings: [],
      },
    };
  }
  return { ok: true, csv: quizToCsv(parsed.data) };
}

/** Header helper exposed for tests / the smoke script. */
export function csvColumnCount(csv: string): number {
  return csv.split("\n")[0]!.split(",").length;
}

// Re-export so callers that also need the DB row shape have one import point.
export { questionToDbRow };
