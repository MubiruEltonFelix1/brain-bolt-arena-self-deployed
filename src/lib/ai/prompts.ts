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

Your job is to produce a JSON object with one key: "questions". Each entry is one Brain Bolt question. Output ONLY valid JSON — no commentary, no markdown fences, no chain-of-thought, no trailing conversation.

CRITICAL OUTPUT SCHEMA — use these exact field names:
- "question" (string): the question prompt shown to players. NOT "text" — use "question".
- "type" (string): one of mcq, true_false, number, type, ordering, feedback, map_pin
- "options" (string array, 2-6 items, required for mcq): the choices
- "correct_answer" (string): for MCQ, the EXACT text of the correct option. NOT an index — the text itself. The server resolves to an index.
- "correct" (boolean, required for true_false): true if the statement is true, false if false
- "correct_number" (number, required for "number" type): the target number
- "min" (number, required for "number" type): low end of acceptable range
- "max" (number, required for "number" type): high end of acceptable range
- "tolerance" (number, optional for "number" type): acceptable deviation
- "format" (string, optional for "number" type): one of "general", "year", "decimal", "percentage", "currency"
- "accepted_answers" (string array, required for "type" questions): accepted phrasings
- "items" (string array, required for "ordering" questions): in correct order
- "lat" (number, required for "map_pin" type): latitude in [-90, 90]
- "lng" (number, required for "map_pin" type): longitude in [-180, 180]
- "max_distance_km" (number, optional for "map_pin" type): tolerance radius; default 5000

Strict rules:
- For MCQ: "options" must be 2-6 distinct non-empty strings; "correct_answer" must be the EXACT TEXT of one of the options (not an index).
- For true_false: "correct" is true or false.
- For number: correct_number must be in [min, max].
- For ordering: items must be unique.
- For type: accepted_answers must have at least one non-empty entry.
- For map_pin: lat in [-90, 90], lng in [-180, 180].
- Never invent media URLs — output only questions whose type does NOT need media.
- Match the requested difficulty: easy = high-school level, medium = undergraduate, hard = specialist.

Hard limits:
- Return exactly the number of questions requested. Not fewer. Not more.
- Use ONLY the question types the creator asked for.
- Output JSON only. No preamble, no trailing commentary, no follow-up conversation.`;

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
  lines.push("");
  lines.push("Output schema (use these exact field names):");
  lines.push(
    JSON.stringify(
      {
        questions: [
          req.types.includes("mcq")
            ? {
                type: "mcq",
                question: "Example?",
                options: ["A", "B", "C", "D"],
                correct_answer: "A",
              }
            : null,
          req.types.includes("true_false")
            ? { type: "true_false", question: "Example statement.", correct: true }
            : null,
          req.types.includes("number")
            ? {
                type: "number",
                question: "Example year?",
                correct_number: 1989,
                min: 1950,
                max: 2000,
                tolerance: 2,
                format: "year",
              }
            : null,
          req.types.includes("type")
            ? {
                type: "type",
                question: "Example short answer?",
                accepted_answers: ["example"],
              }
            : null,
          req.types.includes("ordering")
            ? {
                type: "ordering",
                question: "Example sequence?",
                items: ["first", "second", "third"],
              }
            : null,
          req.types.includes("feedback")
            ? { type: "feedback", question: "Example feedback prompt?" }
            : null,
          req.types.includes("map_pin")
            ? {
                type: "map_pin",
                question: "Locate Paris",
                lat: 48.8566,
                lng: 2.3522,
                max_distance_km: 5000,
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

CRITICAL OUTPUT SCHEMA — use these exact field names:
- "question" (string): the prompt text
- "type" (string): SAME type as the original
- For mcq: "options" (string array), "correct_answer" (EXACT TEXT of correct option, NOT an index)
- For true_false: "correct" (boolean)
- For number: "correct_number", "min", "max", optional "tolerance" and "format"
- For type: "accepted_answers" (string array)
- For ordering: "items" (string array)
- For map_pin: "lat" (number), "lng" (number), optional "max_distance_km"

Output JSON only. No commentary, no markdown fences, no trailing conversation.`;

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
  // Use bracket-balancing rather than the last '}' to avoid swallowing
  // JSON from a follow-up "Assistant:" turn (the model occasionally
  // emits a second response that gets concatenated).
  const firstBrace = s.indexOf("{");
  if (firstBrace === -1) return null;
  let depth = 0;
  let endIdx = -1;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null;
  const candidate = s.slice(firstBrace, endIdx + 1);
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
