// Prompt registry for the Brain Bolt AI service.
//
// Prompts live HERE, not in React components. The UI sends only structured
// request parameters; the server composes them with the prompt template.
//
// Each prompt version is a frozen pair of (system, buildUser) strings. We
// bump the version suffix when the model contract changes (system prompt,
// output schema, etc.) so old prompts can be replayed / A/B-tested /
// reverted cleanly. Version is recorded in ai_usage_log.prompt_version.

import type { GenerateQuestionsRequest, RegenerateQuestionRequest } from "@/lib/ai/types";
import type { BrainBoltQuiz } from "@/lib/quiz/validate";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Output schemas — zod mirrors of the JSON the model is asked to emit */
/* ------------------------------------------------------------------ */

/**
 * The model is asked to output a JSON object with a single "questions" key
 * (array). We don't ask it to round-trip the whole quiz; the editor already
 * knows the quiz id / title / etc. Smaller output → less cost, less drift.
 */
const generatedQuestionsSchema = z.object({
  questions: z.array(z.any()).min(1).max(50),
});

const regeneratedQuestionSchema = z.object({
  question: z.any(),
});

/* ------------------------------------------------------------------ */
/* v1 — generate_questions_v1                                          */
/* ------------------------------------------------------------------ */

const SYSTEM_GENERATE_V1 = `You are the question generator for Brain Bolt — a fast, fair, live-multiplayer quiz game used in classrooms, competitions and live events.

Your job is to produce a JSON object with one key: "questions". Each entry is one Brain Bolt question. Output ONLY valid JSON — no commentary, no markdown fences, no chain-of-thought.

Strict rules — every question MUST satisfy these:
- The question prompt (text) is concrete and unambiguous.
- For MCQ / image_mcq / image_reveal / audio: exactly one correct option, 2-6 distinct non-empty options.
- For true_false: the correct boolean is well-defined.
- For number: the correctNumber lies within [min, max] and tolerance is non-negative.
- For ordering: items are unique and not empty.
- For type: acceptedAnswers has at least one non-empty entry.
- For map_pin: lat in [-90, 90], lng in [-180, 180], maxDistanceKm positive.
- Never invent media URLs — if you would need an image or audio file, output only questions whose type does NOT need media (mcq, true_false, number, type, ordering, feedback, map_pin).
- Match the requested difficulty: easy = high-school level, medium = undergraduate, hard = specialist.

Hard limits:
- Return exactly the number of questions requested. Not fewer. Not more.
- Use ONLY the question types the creator asked for. If they asked for mcq and true_false, do not produce number or ordering.
- Output JSON only. No "Here are the questions:" preamble, no trailing commentary.`;

function buildUserGenerateV1(req: GenerateQuestionsRequest): string {
  const lines: string[] = [];
  lines.push(`Topic: ${req.topic}`);
  lines.push(`Number of questions: ${req.count}`);
  lines.push(`Difficulty: ${req.difficulty}`);
  lines.push(`Question types allowed: ${req.types.join(", ")}`);
  if (req.instructions && req.instructions.trim()) {
    lines.push(`Creator note (natural-language, optional): ${req.instructions.trim()}`);
  }
  if (req.existingQuestionTexts && req.existingQuestionTexts.length > 0) {
    lines.push(
      `Existing question prompts on this quiz (do NOT duplicate): ` +
        req.existingQuestionTexts
          .slice(0, 20)
          .map((t) => `- ${t}`)
          .join("\n"),
    );
  }
  lines.push("");
  lines.push("Output schema (single JSON object):");
  lines.push(
    JSON.stringify(
      {
        questions: [
          // One example per type is enough to anchor the schema.
          req.types.includes("mcq")
            ? {
                type: "mcq",
                text: "Example?",
                options: ["A", "B", "C", "D"],
                correctIndex: 0,
                pointValue: 1000,
                timeLimitSec: 20,
              }
            : null,
          req.types.includes("true_false")
            ? { type: "true_false", text: "Example statement.", correct: true }
            : null,
          req.types.includes("number")
            ? {
                type: "number",
                text: "Example year?",
                correctNumber: 1989,
                min: 1950,
                max: 2000,
                tolerance: 2,
                format: "year",
              }
            : null,
          req.types.includes("type")
            ? {
                type: "type",
                text: "Example short answer?",
                acceptedAnswers: ["example"],
              }
            : null,
          req.types.includes("ordering")
            ? {
                type: "ordering",
                text: "Example sequence?",
                items: ["first", "second", "third"],
              }
            : null,
          req.types.includes("feedback")
            ? { type: "feedback", text: "Example feedback prompt?" }
            : null,
          req.types.includes("map_pin")
            ? {
                type: "map_pin",
                text: "Locate Paris",
                lat: 48.8566,
                lng: 2.3522,
                maxDistanceKm: 5000,
              }
            : null,
        ].filter(Boolean),
      },
      null,
      2,
    ),
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* v1 — regenerate_question_v1                                         */
/* ------------------------------------------------------------------ */

const SYSTEM_REGENERATE_V1 = `You are the question regenerator for Brain Bolt. The creator wants to replace one existing question with a better version.

Output ONLY a JSON object with one key: "question". The new question must:
- Be the SAME type as the original (do not change question type).
- Be measurably different from the original (different prompt, different correct answer, different distractors — unless the creator's note asks otherwise).
- For choice questions, swap or rewrite at least one option.
- For ordering, reorder or replace items.
- For map_pin, change lat/lng (within reason) or the prompt.
- Never invent media URLs.

Output JSON only. No commentary, no markdown fences.`;

function buildUserRegenerateV1(req: RegenerateQuestionRequest): string {
  const lines: string[] = [];
  lines.push("Original question (replace this):");
  lines.push(JSON.stringify(req.replace, null, 2));
  if (req.instructions && req.instructions.trim()) {
    lines.push("");
    lines.push(`Creator note: ${req.instructions.trim()}`);
  }
  lines.push("");
  lines.push("Output schema:");
  lines.push(JSON.stringify({ question: "<same type as original, different content>" }, null, 2));
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Strip a leading/trailing <think>...</think> block (DeepSeek R1 reasoning).
 * The model occasionally emits one even when instructed not to. Be tolerant:
 * only strip if the rest parses cleanly after removal.
 */
export function stripReasoning(text: string): string {
  // Greedy match for one or more think blocks (R1 may emit several).
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return stripped || text.trim();
}

/**
 * Extract a JSON object from a model response. Tolerates:
 *   - leading/trailing whitespace
 *   - ```json ... ``` fences
 *   - "Here's the JSON:" preambles (rare; we strip the prefix)
 * Returns null on parse failure.
 */
export function extractJsonObject(text: string): unknown | null {
  let s = stripReasoning(text);

  // Strip ```json ... ``` fences if present.
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) s = fenceMatch[1].trim();

  // Find the first '{' and last '}' (defensive: ignore surrounding prose).
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = s.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public registry                                                      */
/* ------------------------------------------------------------------ */

export const PROMPT_VERSIONS = {
  generate_questions_v1: {
    system: SYSTEM_GENERATE_V1,
    buildUser: buildUserGenerateV1,
    parse: (raw: unknown): unknown => {
      const parsed = generatedQuestionsSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    schemaVersion: 1 as const,
  },
  regenerate_question_v1: {
    system: SYSTEM_REGENERATE_V1,
    buildUser: buildUserRegenerateV1,
    parse: (raw: unknown): unknown => {
      const parsed = regeneratedQuestionSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    schemaVersion: 1 as const,
  },
} as const;

export type PromptVersion = keyof typeof PROMPT_VERSIONS;

/**
 * Compose a validated BrainBoltQuiz shell from a successful AI response.
 * Used by the service to assemble the final draft the client receives.
 */
export function emptyQuizShell(): Pick<BrainBoltQuiz, "title"> {
  return { title: "AI Draft" };
}
