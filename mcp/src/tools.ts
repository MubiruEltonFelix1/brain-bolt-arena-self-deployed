// MCP tool registrations for the Brain Bolt server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config";
import { validatedQuizToCsv } from "./csv";
import { generateQuiz } from "./generate";
import {
  CSV_HEADER,
  QUESTION_TYPE_META,
  QUESTION_TYPES,
  type QuestionTypeId,
} from "./question-types";
import {
  MAX_ORDERING_ITEMS,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_ORDERING_ITEMS,
  MIN_OPTIONS,
  MIN_QUESTIONS,
  POINT_VALUE_MAX,
  POINT_VALUE_MIN,
  QUESTION_TIME_MAX,
  QUESTION_TIME_MIN,
  QUIZ_TIME_PER_QUESTION_MAX,
  QUIZ_TIME_PER_QUESTION_MIN,
  quizSchema,
} from "./schema";
import { saveQuiz } from "./supabase";
import { formatIssues, MEDIA_URL_POLICY, validateQuiz } from "./validate";

const QUESTION_TYPE_TUPLE = QUESTION_TYPES as [QuestionTypeId, ...QuestionTypeId[]];

const DIFFICULTY = z.enum(["easy", "medium", "hard"]);
/** Quiz-level seconds per question — the app editor supports 5-120 (M4). */
const QUIZ_LEVEL_TIME_LIMIT = z
  .number()
  .int()
  .min(QUIZ_TIME_PER_QUESTION_MIN)
  .max(QUIZ_TIME_PER_QUESTION_MAX);
const POINTS = z.number().int().min(POINT_VALUE_MIN).max(POINT_VALUE_MAX);

/** Wraps any result as a single JSON text content block (SDK version-safe). */
function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export function registerTools(server: McpServer, config: AppConfig): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get Brain Bolt quiz capabilities",
      description:
        "Returns the question types Brain Bolt supports, the per-type field requirements, " +
        "the CSV template header, and default values. Call this first to learn the format.",
    },
    async () => {
      return text({
        questionTypes: QUESTION_TYPES.map((t) => ({ type: t, ...QUESTION_TYPE_META[t] })),
        mediaPolicy: MEDIA_URL_POLICY,
        limits: {
          questionCount: { min: MIN_QUESTIONS, max: MAX_QUESTIONS },
          optionsPerChoice: { min: MIN_OPTIONS, max: MAX_OPTIONS },
          orderingItems: { min: MIN_ORDERING_ITEMS, max: MAX_ORDERING_ITEMS },
          quizTimePerQuestionSec: {
            min: QUIZ_TIME_PER_QUESTION_MIN,
            max: QUIZ_TIME_PER_QUESTION_MAX,
          },
          perQuestionTimeLimitSec: { min: QUESTION_TIME_MIN, max: QUESTION_TIME_MAX },
          pointValue: { min: POINT_VALUE_MIN, max: POINT_VALUE_MAX },
        },
        csvTemplateHeader: CSV_HEADER,
        defaults: {
          pointValue: 1000,
          timePerQuestionSec: 20,
          maxDistanceKm: 5000,
          revealStages: 5,
          tolerance: "max((max-min)*0.1, 1)",
        },
        ownerRequirements: {
          ownerIdRequired:
            "save_quiz requires ownerId (a uuid of an auth user) or BRAINBOLT_DEFAULT_OWNER_ID",
          ownerIdMustBeUuidOfAuthUser: true,
          ownerMustHaveUserPrincipal: true,
          principalNote:
            "principals are created 1:1 with auth users at signup — an owner uuid without a principal is rejected with a clear error before anything is written",
          securityBoundary:
            "MCP is a trusted development/server-side integration at this stage: local stdio transport only, service-role writes, no remote authentication",
        },
      });
    },
  );

  server.registerTool(
    "generate_quiz",
    {
      title: "Generate a quiz",
      description:
        "Asks the configured LLM (mcp/.env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) to write a complete quiz " +
        "on a topic. Returns the quiz as JSON plus a ready-to-import CSV matching Brain Bolt's editor template. " +
        "The result is validated; on failure the LLM is re-prompted once with the specific errors. " +
        "The result also reports requestedCount/generatedCount/exactMatch so count drift is visible.",
      inputSchema: {
        topic: z.string().min(1).describe("The subject the quiz should cover"),
        title: z
          .string()
          .optional()
          .describe("Quiz title (defaults to one generated from the topic)"),
        description: z.string().optional(),
        questionCount: z.number().int().min(MIN_QUESTIONS).max(MAX_QUESTIONS).default(10),
        questionTypes: z
          .array(z.enum(QUESTION_TYPE_TUPLE))
          .optional()
          .describe(
            "Types to mix in; defaults to mcq, true_false, number, ordering, type, map_pin. " +
              "Media types (image_mcq, image_reveal, audio) need a real https URL — the LLM cannot invent one, " +
              "so requesting them usually fails validation.",
          ),
        difficulty: DIFFICULTY.optional(),
        language: z.string().min(1).default("English"),
        timeLimitSec: QUIZ_LEVEL_TIME_LIMIT.optional().describe(
          "Quiz-level default seconds per question (5-120, matching the app editor)",
        ),
        pointValue: POINTS.optional(),
        includeFeedback: z
          .boolean()
          .default(false)
          .describe("Include an opinion question (0 points)"),
      },
    },
    async (args) => {
      if (!config.llm) {
        throw new Error(
          "generate_quiz is not configured: set LLM_BASE_URL and LLM_MODEL in mcp/.env (copy .env.example). " +
            "validate_quiz, to_csv and get_capabilities work without it.",
        );
      }
      const result = await generateQuiz(config.llm, args);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return text({
        quiz: result.quiz,
        csv: result.csv,
        validation: result.validation,
        attempts: result.attempts,
      });
    },
  );

  server.registerTool(
    "validate_quiz",
    {
      title: "Validate a quiz",
      description:
        "Checks a quiz JSON object against Brain Bolt's format. Returns a report with per-question errors " +
        "and warnings (option counts, correctIndex range, number ranges, duplicate options, missing media URLs, ...).",
      inputSchema: {
        quiz: z.unknown().describe("A quiz JSON object in Brain Bolt's camelCase format"),
      },
    },
    async ({ quiz }) => {
      return text(validateQuiz(quiz));
    },
  );

  server.registerTool(
    "to_csv",
    {
      title: "Convert a quiz to CSV",
      description:
        "Serializes a quiz JSON object to Brain Bolt's CSV import template so it can be pasted into the " +
        "quiz editor (Import CSV) without any database access. Runs the same full semantic validation " +
        "as save_quiz — invalid quizzes are rejected with a structured report and no CSV is emitted.",
      inputSchema: {
        quiz: z.unknown().describe("A quiz JSON object in Brain Bolt's camelCase format"),
      },
    },
    async ({ quiz }) => {
      const result = validatedQuizToCsv(quiz);
      if (!result.ok) {
        throw new Error(
          `quiz has validation errors — no CSV emitted:\n${formatIssues(result.report)}`,
        );
      }
      return text({ csv: result.csv });
    },
  );

  server.registerTool(
    "save_quiz",
    {
      title: "Save a quiz to Brain Bolt",
      description:
        "Inserts the quiz (and its questions) into the app's Supabase database using the service role key. " +
        "Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in mcp/.env, and an ownerId (uuid of an auth user) " +
        "or BRAINBOLT_DEFAULT_OWNER_ID. Without those, use to_csv instead.",
      inputSchema: {
        quiz: z.unknown().describe("A quiz JSON object in Brain Bolt's camelCase format"),
        title: z.string().optional().describe("Overrides the quiz title"),
        description: z.string().optional(),
        timePerQuestionSec: QUIZ_LEVEL_TIME_LIMIT.optional(),
        ownerId: z.string().optional().describe("uuid of the auth user the quiz belongs to"),
      },
    },
    async (args) => {
      if (!config.supabase) {
        throw new Error(
          "save_quiz is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in mcp/.env. Use to_csv otherwise.",
        );
      }
      const parsed = quizSchema.safeParse(args.quiz);
      if (!parsed.success) {
        throw new Error(`quiz is not valid: ${parsed.error.issues[0]?.message ?? "unknown shape"}`);
      }
      const ownerId = args.ownerId ?? config.defaultOwnerId ?? undefined;
      // saveQuiz enforces the full semantic gate (media URLs, answer ranges,
      // semicolon-free CSV fields) and verifies the owner has a principal
      // before writing anything.
      const result = await saveQuiz(config.supabase, parsed.data, {
        ownerId,
        title: args.title,
        description: args.description,
        timePerQuestionSec: args.timePerQuestionSec,
      });
      return text({
        quizId: result.quizId,
        questionCount: result.questionCount,
        note: "Quiz saved — it appears in the app's /dashboard.",
      });
    },
  );
}
