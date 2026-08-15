// The generate_quiz tool: call the configured LLM, parse + validate the result,
// retry once with feedback, and always return something useful.

import { quizToCsv } from "./csv";
import { chatCompletion, stripJson } from "./llm";
import { buildRetryPrompt, buildSystemPrompt, buildUserPrompt } from "./prompts";
import { MAX_QUESTIONS, MIN_QUESTIONS, quizSchema, type BrainBoltQuiz } from "./schema";
import {
  extractQuestionIndex,
  formatIssues,
  validateQuiz,
  type ValidationReport,
} from "./validate";
import type { LlmConfig } from "./llm";
import type { QuestionTypeId } from "./question-types";

export type GenerateQuizArgs = {
  topic: string;
  title?: string;
  description?: string;
  questionCount?: number;
  questionTypes?: QuestionTypeId[];
  difficulty?: "easy" | "medium" | "hard";
  language?: string;
  timeLimitSec?: number;
  pointValue?: number;
  includeFeedback?: boolean;
};

export type GenerateQuizResult =
  | {
      ok: true;
      quiz: BrainBoltQuiz;
      csv: string;
      validation: ValidationReport;
      attempts: number;
      /** The exact count requested for generation. */
      requestedCount: number;
      /** The number of questions actually generated. */
      generatedCount: number;
      /** True when the generated question count equals the requested count. */
      exactMatch: boolean;
    }
  | {
      ok: false;
      raw?: string;
      csv: "";
      validation: ValidationReport;
      attempts: number;
      message: string;
      requestedCount: number;
      generatedCount: number;
      exactMatch: boolean;
    };

/**
 * Parses raw LLM output into a validated quiz, or a structured failure report.
 * Never throws for malformed JSON — malformed output is a retryable validation
 * failure, not an internal error (M1).
 */
export function parseQuizJson(
  raw: string,
): { ok: true; quiz: BrainBoltQuiz } | { ok: false; report: ValidationReport } {
  let jsonText: string;
  try {
    jsonText = stripJson(raw);
  } catch {
    return {
      ok: false,
      report: {
        valid: false,
        errors: [
          {
            questionIndex: null,
            field: "json",
            message: "LLM output was not valid JSON",
          },
        ],
        warnings: [],
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      ok: false,
      report: {
        valid: false,
        errors: [
          {
            questionIndex: null,
            field: "json",
            message: "LLM output contained invalid JSON",
          },
        ],
        warnings: [],
      },
    };
  }

  const schemaResult = quizSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      report: {
        valid: false,
        errors: schemaResult.error.issues.map((issue) => ({
          questionIndex: extractQuestionIndex(issue.path),
          field: issue.path.join("."),
          message: issue.message,
        })),
        warnings: [],
      },
    };
  }

  return { ok: true, quiz: schemaResult.data };
}

/**
 * M6: the warning message when the generated question count differs from the
 * requested count, or null when they match.
 */
export function countMismatchMessage(requested: number, generated: number): string | null {
  if (requested === generated) return null;
  return `Generated ${generated} question(s), but ${requested} were requested — the count is not exact.`;
}

export async function generateQuiz(
  config: LlmConfig,
  args: GenerateQuizArgs,
): Promise<GenerateQuizResult> {
  const questionCount = Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, args.questionCount ?? 10));
  const difficulty = args.difficulty ?? "medium";
  const language = args.language ?? "English";
  const includeFeedback = args.includeFeedback ?? false;

  const requestedTypes: QuestionTypeId[] =
    args.questionTypes && args.questionTypes.length > 0
      ? [...new Set(args.questionTypes)].slice(0, 10)
      : (["mcq", "true_false", "number", "ordering", "type", "map_pin"] as QuestionTypeId[]);

  const userPrompt = buildUserPrompt({
    topic: args.topic,
    title: args.title,
    description: args.description,
    questionCount,
    questionTypes: requestedTypes,
    difficulty,
    language,
    timeLimitSec: args.timeLimitSec,
    pointValue: args.pointValue,
    includeFeedback,
  });
  const systemPrompt = buildSystemPrompt();

  let attempts = 0;
  let lastRaw = "";
  // Per-call state (was a module-level variable — two concurrent generate_quiz
  // calls would clobber each other's retry report).
  let lastReport: ValidationReport = emptyReport();

  for (let pass = 0; pass < 2; pass++) {
    attempts++;
    const messages =
      pass === 0
        ? [
            { role: "system" as const, content: systemPrompt },
            { role: "user" as const, content: userPrompt },
          ]
        : [
            { role: "system" as const, content: systemPrompt },
            { role: "user" as const, content: userPrompt },
            {
              role: "user" as const,
              content: buildRetryPrompt(userPrompt, lastRaw, formatIssues(lastReport)),
            },
          ];

    let raw: string;
    try {
      raw = await chatCompletion(config, messages, { jsonMode: true, temperature: 0.7 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        csv: "",
        validation: {
          valid: false,
          errors: [{ questionIndex: null, field: "llm", message }],
          warnings: [],
        },
        attempts,
        message,
        requestedCount: questionCount,
        generatedCount: 0,
        exactMatch: false,
      };
    }
    lastRaw = raw;

    const parsed = parseQuizJson(raw);
    if (!parsed.ok) {
      lastReport = parsed.report;
      continue;
    }

    const quiz: BrainBoltQuiz = parsed.quiz;
    const validation = validateQuiz(quiz);
    if (!validation.valid) {
      lastReport = validation;
      continue;
    }

    const exactMatch = quiz.questions.length === questionCount;
    if (!exactMatch) {
      const warning = countMismatchMessage(questionCount, quiz.questions.length);
      if (warning)
        validation.warnings.push({ questionIndex: null, field: "questionCount", message: warning });
    }

    return {
      ok: true,
      quiz,
      csv: quizToCsv(quiz),
      validation,
      attempts,
      requestedCount: questionCount,
      generatedCount: quiz.questions.length,
      exactMatch,
    };
  }

  // Both passes failed to produce a valid quiz. Return the last raw output
  // plus a report so the caller can see what happened instead of a dead end.
  return {
    ok: false,
    raw: lastRaw,
    csv: "",
    validation: lastReport,
    attempts,
    message: `Could not produce a valid quiz after ${attempts} attempt(s). See validation.errors.`,
    requestedCount: questionCount,
    generatedCount: 0,
    exactMatch: false,
  };
}

function emptyReport(): ValidationReport {
  return { valid: false, errors: [], warnings: [] };
}
