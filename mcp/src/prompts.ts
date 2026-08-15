// Prompt templates for quiz generation.

import type { QuestionTypeId } from "./question-types";

export type GeneratePromptArgs = {
  topic: string;
  questionCount: number;
  questionTypes: QuestionTypeId[];
  difficulty: "easy" | "medium" | "hard";
  language: string;
  title?: string;
  description?: string;
  timeLimitSec?: number;
  pointValue?: number;
  includeFeedback: boolean;
};

const TYPE_REFERENCE = `TYPE REFERENCE (exact JSON field requirements):
- mcq  — "options": [2-6 strings], "correctIndex": 0-based index of the correct option.
- true_false — "correct": true|false (true = statement is TRUE).
- number — "correctNumber" (the exact target, MUST be within min..max),
           "min", "max", optionally "tolerance" (default max((max-min)*0.1, 1)),
           optionally "format" ("general"|"year"|"decimal"|"percentage"|"currency"),
           optionally "unit".
- map_pin — "lat" (-90..90), "lng" (-180..180), optionally "maxDistanceKm" (default 5000).
- type — "acceptedAnswers": [>= 1 accepted phrasings].
- feedback — NO answer fields at all; an opinion question with no correct answer.
- ordering — "items": [2-8 strings in CORRECT order, first = position 1].
- image_mcq / image_reveal — like mcq, plus "imageUrl" (a real, stable https URL when you have one; otherwise OMIT this type).
- audio — like mcq, plus "audioUrl" (a real, stable https URL when you have one; otherwise OMIT this type).

Optional on every question: "timeLimitSec" (5-300), "pointValue" (1-100000, 0 for feedback),
"doublePoints" (true|false).`;

const QUALITY_RULES = `QUALITY RULES:
- Factually correct and unambiguous. The correct answer must be clearly the best answer.
- Distractors: plausible but definitely wrong. Never duplicate or nearly-identical options.
- "correctIndex" counts from 0 and MUST point at the correct option string.
- number: correctNumber must be inside [min, max]; make min/max a sensible range for the answer.
- ordering: items in the correct order only; the player rearranges them.
- type: acceptedAnswers should cover reasonable spellings/casings (e.g. "apple", "an apple").
- true_false statements must be genuinely true or false (no opinions).
- Write in the requested language. Keep prompts concise and game-show style.`;

const FEW_SHOT = `EXAMPLE (correct output shape):
{
  "title": "Space Smash",
  "description": "Quick-fire questions about our solar system",
  "timePerQuestionSec": 20,
  "difficulty": "medium",
  "questions": [
    { "type": "mcq", "text": "Which planet is known as the Red Planet?", "options": ["Venus", "Mars", "Jupiter", "Mercury"], "correctIndex": 1 },
    { "type": "true_false", "text": "The Great Wall of China is visible from space with the naked eye.", "correct": false },
    { "type": "number", "text": "In what year did humans first land on the Moon?", "correctNumber": 1969, "min": 1900, "max": 2000, "format": "year" },
    { "type": "ordering", "text": "Arrange these planets from closest to the Sun to farthest", "items": ["Mercury", "Venus", "Earth", "Mars"] },
    { "type": "type", "text": "Which fruit keeps the doctor away?", "acceptedAnswers": ["apple", "an apple", "apples"] },
    { "type": "map_pin", "text": "Drop a pin on Tokyo, Japan", "lat": 35.6762, "lng": 139.6503, "maxDistanceKm": 400 },
    { "type": "feedback", "text": "What did you enjoy most about this quiz?" }
  ]
}`;

export function buildSystemPrompt(): string {
  return `You are Brain Bolt's quiz author. You write competitive, esports-grade quiz questions for the Brain Bolt Arena game.

You reply with ONE JSON object and nothing else — no markdown fences, no prose, no commentary.

OUTPUT CONTRACT:
{
  "title": string (required, catchy quiz title),
  "description": string (optional, one line),
  "timePerQuestionSec": number (optional, 5-120, default 20 — the app editor caps the quiz-level time at 120),
  "difficulty": "easy" | "medium" | "hard" (optional),
  "questions": [ {question objects described below} ]
}

${TYPE_REFERENCE}

${QUALITY_RULES}

${FEW_SHOT}`;
}

export function buildUserPrompt(args: GeneratePromptArgs): string {
  const types = args.questionTypes.join(", ");
  const parts = [
    `Topic: ${args.topic}`,
    `Number of questions: ${args.questionCount}`,
    `Allowed question types: ${types}`,
    `Difficulty: ${args.difficulty}`,
    `Language: ${args.language}`,
  ];
  if (args.title) parts.push(`Title: ${args.title}`);
  if (args.description) parts.push(`Description: ${args.description}`);
  if (args.timeLimitSec)
    parts.push(`Default time limit per question (seconds): ${args.timeLimitSec}`);
  if (args.pointValue) parts.push(`Default points per question: ${args.pointValue}`);
  if (!args.includeFeedback)
    parts.push("Do NOT include feedback questions (they carry no points).");
  parts.push(
    `Generate exactly ${args.questionCount} questions covering the topic. Mix the question types sensibly. Respond with ONLY the JSON quiz object.`,
  );
  return parts.join("\n");
}

/** Second pass: re-prompt with concrete zod issues so the model can fix them. */
export function buildRetryPrompt(original: string, raw: string, issues: string): string {
  return `${original}

Your previous reply was not valid. Problems:
${issues}

Previous (invalid) reply:
${raw.slice(0, 2000)}

Return ONLY a corrected JSON quiz object that satisfies every requirement.`;
}
