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
import {
  addQuestions,
  archiveQuiz,
  getQuiz,
  listQuizzes,
  removeQuestion,
  reorderQuestions,
  updateQuestion,
  updateQuiz,
} from "./lifecycle";
import { createSupabaseClient, saveQuiz } from "./supabase";
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

const ACTOR_ID = z
  .string()
  .optional()
  .describe(
    "uuid of the acting auth user (the principal performing the operation) — defaults to BRAINBOLT_DEFAULT_OWNER_ID",
  );

const IDEMPOTENCY_KEY = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Any stable string identifying this logical request. If a request with the same key and the same " +
      "payload is repeated (e.g. after a timeout/retry), the stored result is returned instead of " +
      "duplicating the write. Never reuse a key with a different payload.",
  );

const QUIZ_ID = z.string().describe("The uuid of the quiz to operate on");

/** Wraps any result as a single JSON text content block (SDK version-safe). */
function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

/** Lifecycle tools need a configured Supabase target; the gate error is shared. */
function supabaseGateError(tool: string): never {
  throw new Error(
    `${tool} is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in mcp/.env. ` +
      "get_capabilities, validate_quiz, to_csv and generate_quiz work without it.",
  );
}

export function registerTools(server: McpServer, config: AppConfig): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get Brain Bolt quiz capabilities",
      description:
        "Returns the question types Brain Bolt supports, the per-type field requirements, " +
        "the CSV template header, default values, and the lifecycle tools (list/get/update/archive, " +
        "question management) with their filters, idempotency requirements and ownership rules. " +
        "Call this first to learn the format.",
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
        lifecycle: {
          tools: [
            "list_quizzes",
            "get_quiz",
            "update_quiz",
            "archive_quiz",
            "add_questions",
            "update_question",
            "remove_question",
            "reorder_questions",
          ],
          filters: {
            owner: "list/get/update/archive scope to the acting principal (actorId or BRAINBOLT_DEFAULT_OWNER_ID)",
            search: "title substring match",
            archived: "true (archived only) | false (not archived) | omitted (both)",
            difficulty: "easy | medium | hard",
            isArena: "true | false",
            limit: "1-100, default 50",
          },
          notAvailableOnQuizzes: {
            visibility: "no column on quizzes — the app tracks visibility on competitions/leagues only",
            published: "no published state on quizzes",
            category: "no category column or categories table yet",
            branding: "branding is session/competition-scoped (branding_profiles), not quiz-scoped",
            updatedAt: "quizzes has no updated_at column; created_at is exposed",
          },
          ownership: {
            actorResolution:
              "Every lifecycle tool resolves the acting principal from actorId (or BRAINBOLT_DEFAULT_OWNER_ID) " +
              "and enforces capability through the app's own public.can(principal, action, resource) resolver " +
              "— no parallel MCP permission system.",
            actions: {
              save_quiz: "can(principal, 'quiz.create') — needs the host capability (admin, host role, or active host authorization)",
              read_update_archive_question_ops: "can(principal, 'quiz.edit', quizId) — the principal must own the quiz (principal-only since Phase 7L) and hold the host capability",
            },
            adminNote:
              "Admins hold the host capability through can(); ownership checks still apply — even an admin cannot edit a quiz they do not own.",
            changeOwnership: "not supported — owner_id/owner_principal_id are never writable through MCP tools",
          },
          idempotency: {
            mechanism:
              "Write tools accept idempotencyKey. The key is claimed in the mcp_idempotency_keys table; a repeated " +
              "request with the same key and identical payload replays the stored result instead of duplicating the " +
              "write. Reusing a key with a different payload is rejected. Keys expire after 24h.",
            tools: ["save_quiz", "update_quiz", "archive_quiz", "add_questions", "update_question", "remove_question", "reorder_questions"],
            recommendation: "Always pass idempotencyKey for writes that may be retried after a timeout.",
          },
          safety: {
            archiveBeforeDelete: "archive_quiz is the only removal tool — no hard delete is exposed; the default answer to 'delete this quiz' is archive",
            patchStyle: "update_quiz and update_question change only the supplied fields; omitted fields are preserved",
            questionTypeImmutable: "update_question cannot change a question's type — remove and re-add instead",
            lastQuestionProtected: "remove_question refuses to remove a quiz's last question",
            validation: "every question write (add/update) runs the same zod + semantic validation as quiz generation: media URLs, answer ranges, duplicate options, semicolon-free fields",
            answerKeys: "get_quiz returns answer keys only to the acting owner; includeAnswers=false strips them",
          },
        },
        ownerRequirements: {
          ownerIdRequired:
            "save_quiz requires ownerId (a uuid of an auth user) or BRAINBOLT_DEFAULT_OWNER_ID",
          ownerIdMustBeUuidOfAuthUser: true,
          ownerMustHaveUserPrincipal: true,
          ownerMustHoldHostCapability: true,
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
        "Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in mcp/.env, and an ownerId (uuid of an auth user " +
        "with the host capability) or BRAINBOLT_DEFAULT_OWNER_ID. Without those, use to_csv instead. " +
        "Accepts an optional idempotencyKey so retried calls do not create duplicate quizzes.",
      inputSchema: {
        quiz: z.unknown().describe("A quiz JSON object in Brain Bolt's camelCase format"),
        title: z.string().optional().describe("Overrides the quiz title"),
        description: z.string().optional(),
        timePerQuestionSec: QUIZ_LEVEL_TIME_LIMIT.optional(),
        ownerId: z.string().optional().describe("uuid of the auth user the quiz belongs to"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("save_quiz");
      }
      const parsed = quizSchema.safeParse(args.quiz);
      if (!parsed.success) {
        throw new Error(`quiz is not valid: ${parsed.error.issues[0]?.message ?? "unknown shape"}`);
      }
      const ownerId = args.ownerId ?? config.defaultOwnerId ?? undefined;
      // saveQuizWithClient enforces the full semantic gate (media URLs, answer
      // ranges, semicolon-free CSV fields), verifies the owner has a principal
      // and the host capability (can(principal, 'quiz.create')), and replays
      // on a repeated idempotencyKey.
      const result = await saveQuiz(config.supabase, parsed.data, {
        ownerId,
        title: args.title,
        description: args.description,
        timePerQuestionSec: args.timePerQuestionSec,
        idempotencyKey: args.idempotencyKey,
      });
      return text({
        ok: true,
        action: "save_quiz",
        id: result.quizId,
        quizId: result.quizId,
        questionCount: result.questionCount,
        changed: { created: true },
        warnings: [],
        errors: [],
        replayed: result.replayed,
        note: "Quiz saved — it appears in the app's /dashboard.",
      });
    },
  );

  /* ------------------------------------------------------------------ */
  /* Phase 8B lifecycle tools                                            */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "list_quizzes",
    {
      title: "List quizzes",
      description:
        "Lists compact metadata for quizzes owned by the acting principal (no question payloads, no answer keys). " +
        "Filters: owner (implicit via actorId), title substring search, archived/unarchived, difficulty, isArena, limit.",
      inputSchema: {
        actorId: ACTOR_ID,
        search: z.string().optional().describe("Literal substring match on the quiz title"),
        archived: z
          .boolean()
          .optional()
          .describe("true = archived only, false = not archived, omitted = both"),
        difficulty: DIFFICULTY.optional(),
        isArena: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("list_quizzes");
      }
      const client = createSupabaseClient(config.supabase);
      const { items, count } = await listQuizzes(client, {
        actorId: args.actorId ?? config.defaultOwnerId ?? "",
        search: args.search,
        archived: args.archived,
        difficulty: args.difficulty,
        isArena: args.isArena,
        limit: args.limit,
      });
      return text({ ok: true, action: "list_quizzes", count, items, warnings: [], errors: [] });
    },
  );

  server.registerTool(
    "get_quiz",
    {
      title: "Get one quiz",
      description:
        "Retrieves one quiz's metadata, configuration and questions (in position order) as the camelCase contract. " +
        "Answer keys (correctIndex, correct, correctNumber, acceptedAnswers, map lat/lng, ordering items) are " +
        "returned only when the acting principal owns the quiz. includeAnswers=false returns a redacted view " +
        "without answer keys.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: QUIZ_ID,
        includeAnswers: z
          .boolean()
          .default(true)
          .describe("false strips answer keys for a compact read-only view"),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("get_quiz");
      }
      const client = createSupabaseClient(config.supabase);
      const { quiz, questions, includeAnswers } = await getQuiz(client, {
        actorId: args.actorId ?? config.defaultOwnerId ?? "",
        quizId: args.quizId,
        includeAnswers: args.includeAnswers,
      });
      return text({
        ok: true,
        action: "get_quiz",
        id: quiz.id,
        quiz,
        questions,
        includeAnswers,
        warnings: [],
        errors: [],
      });
    },
  );

  server.registerTool(
    "update_quiz",
    {
      title: "Update a quiz (patch-style)",
      description:
        "Modifies quiz-level fields of an existing quiz owned by the acting principal. Only the supplied fields " +
        "change — everything else is preserved. Supports title, description, difficulty, timePerQuestionSec.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: QUIZ_ID,
        patch: z
          .object({
            title: z.string().min(1).describe("New title").optional(),
            description: z.string().nullable().describe("Description (null clears it)").optional(),
            difficulty: DIFFICULTY.nullable().describe("easy | medium | hard (null clears it)").optional(),
            timePerQuestionSec: QUIZ_LEVEL_TIME_LIMIT.describe("Quiz-level seconds per question (5-120)").optional(),
          })
          .refine((p) => Object.keys(p).length > 0, {
            message: "update_quiz needs at least one field to change",
          }),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("update_quiz");
      }
      const client = createSupabaseClient(config.supabase);
      return text(
        await updateQuiz(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          patch: args.patch,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "archive_quiz",
    {
      title: "Archive a quiz",
      description:
        "Soft-deletes a quiz by setting archived_at (the app's archive model). Archived quizzes disappear from the " +
        "app's quiz lists but are never destroyed. This is the ONLY removal tool — there is no hard delete. " +
        "Archiving an already-archived quiz is a harmless no-op.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: QUIZ_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("archive_quiz");
      }
      const client = createSupabaseClient(config.supabase);
      return text(
        await archiveQuiz(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "add_questions",
    {
      title: "Add questions to a quiz",
      description:
        "Appends validated questions to an existing quiz owned by the acting principal. The same validation as " +
        "quiz generation applies (media URLs, answer ranges, duplicate options, semicolon-free fields) — invalid " +
        "questions are rejected and nothing is written. Total questions per quiz is capped at 30.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: QUIZ_ID,
        questions: z
          .array(z.unknown())
          .min(1)
          .max(MAX_QUESTIONS)
          .describe("Brain Bolt question objects in camelCase format"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("add_questions");
      }
      const client = createSupabaseClient(config.supabase);
      return text(
        await addQuestions(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          questions: args.questions,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "update_question",
    {
      title: "Update one question",
      description:
        "Patches a single question inside a quiz owned by the acting principal. Only the supplied fields change. " +
        "Question types are immutable — remove and re-add to change type. The merged question is validated with " +
        "the same gate as quiz generation before anything is written. Fields that do not apply to the question's " +
        "type are ignored and reported as warnings.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: QUIZ_ID,
        questionId: z.string().describe("The uuid of the question to update"),
        patch: z
          .record(z.string(), z.unknown())
          .describe(
            "Partial camelCase question fields (e.g. text, options, correctIndex, pointValue, imageUrl, ...)",
          ),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("update_question");
      }
      const client = createSupabaseClient(config.supabase);
      return text(
        await updateQuestion(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          questionId: args.questionId,
          patch: args.patch,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "remove_question",
    {
      title: "Remove a question",
      description:
        "Removes one question from a quiz owned by the acting principal and renumbers the remaining positions. " +
        "Refuses to remove a quiz's last question. Use archive_quiz to retire a whole quiz.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: QUIZ_ID,
        questionId: z.string().describe("The uuid of the question to remove"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("remove_question");
      }
      const client = createSupabaseClient(config.supabase);
      return text(
        await removeQuestion(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          questionId: args.questionId,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "reorder_questions",
    {
      title: "Reorder questions",
      description:
        "Rewrites the 0-based positions of a quiz's questions (owned by the acting principal). Provide the FULL " +
        "set of question ids in the desired order — a partial or mismatched set is rejected.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: QUIZ_ID,
        questionIds: z
          .array(z.string())
          .min(1)
          .describe("All question ids of the quiz, in the desired order"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("reorder_questions");
      }
      const client = createSupabaseClient(config.supabase);
      return text(
        await reorderQuestions(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          questionIds: args.questionIds,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );
}
