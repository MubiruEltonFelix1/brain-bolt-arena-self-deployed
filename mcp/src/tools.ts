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
import {
  cancelCompetition,
  COMPETITION_MODES,
  COMPETITION_STATUSES,
  COMPETITION_VISIBILITIES,
  createCompetition,
  getCompetition,
  listCompetitions,
  scheduleCompetition,
  toErrorEnvelope,
  updateCompetition,
  type CompetitionMode,
  type CompetitionStatus,
  type CompetitionVisibility,
} from "./competition";
import { createSupabaseClient, saveQuiz } from "./supabase";
import { formatIssues, MEDIA_URL_POLICY, validateQuiz } from "./validate";
import {
  attachCompetitionToLeague,
  detachCompetitionFromLeague,
  getCompetitionResults,
  getLeague,
  getLeagueStandings,
  getPlayerLeagueHistory,
  LEAGUE_STATUSES,
  LEAGUE_VISIBILITIES,
  listLeagueCompetitions,
  listLeagues,
  toLeagueEnvelope,
  type LeagueStatus,
  type LeagueVisibility,
} from "./league";
import {
  orchestrateCompetitionWorkflow,
  toOrchestrationEnvelope,
  WORKFLOWS,
  type OrchestrationPlan,
  type WorkflowId,
} from "./orchestrate";

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
        competitions: {
          tools: [
            "list_competitions",
            "get_competition",
            "create_competition",
            "update_competition",
            "schedule_competition",
            "cancel_competition",
          ],
          modes: [...COMPETITION_MODES],
          statuses: {
            values: [...COMPETITION_STATUSES],
            mutable: ["draft", "scheduled"],
            note: "lobby_open/running/completed/cancelled are protected — no MCP tool writes them",
          },
          visibility: {
            values: [...COMPETITION_VISIBILITIES],
            note: "always explicit (create requires it, update patches it) — MCP never changes visibility implicitly",
          },
          filters: {
            owner: "list/get scope to the acting principal (owner_principal_id)",
            quizId: "uuid filter on the competition's quiz",
            leagueId: "uuid filter on the attached league",
            status: "draft | scheduled | lobby_open | running | completed | cancelled",
            mode: "hosted | arena | scheduled",
            visibility: "private | unlisted | public",
            scheduledFrom: "ISO timestamp — competitions scheduled at or after",
            scheduledTo: "ISO timestamp — competitions scheduled at or before",
            limit: "1-100, default 50",
          },
          mutableFields: {
            title: "non-empty string",
            description: "string or null (clears)",
            visibility: "private | unlisted | public (explicit)",
            scheduledStartAt: "ISO timestamp in the future",
            lobbyDurationSeconds: "integer 30-3600 (lobby opens start − duration)",
            leagueId: "uuid or null (null detaches; must be a league the actor owns)",
            brandingProfileId: "uuid or null (null detaches; must be a branding profile the actor owns)",
            maxParticipants: "positive integer or null (null clears)",
          },
          authorization: {
            create: "can(principal, 'competition.create') — host capability (admin, host role, or active host authorization)",
            manage: "can(principal, 'competition.manage', id) — the principal must own the competition (owner_principal_id) AND hold the host capability; admins do not bypass ownership",
            leagueAndBranding: "references must belong to the acting principal (league additionally not archived) — same rule as the app form",
            ownerResolution: "owner_principal_id always comes from the resolved actor — an agent can never assign an arbitrary owner",
          },
          idempotency: {
            mechanism:
              "Same mcp_idempotency_keys mechanism as the quiz tools: create/update/schedule/cancel accept idempotencyKey; a repeated request with the same key and identical payload replays the stored result. Keys expire after 24h.",
            tools: ["create_competition", "update_competition", "schedule_competition", "cancel_competition"],
            recommendation: "Always pass idempotencyKey for writes that may be retried after a timeout.",
          },
          sessionBoundary: {
            rule: "MCP never reads or writes the sessions table — no question progression, reveal timing, pause state, answers, scoring or autonomous tick internals",
            safeState: "the competition status IS the safe summarized state (draft/scheduled/lobby_open/running/completed/cancelled), maintained by the existing engine",
            cancelCleanup: "cancelling never touches sessions — the existing autonomous tick ends sessions of cancelled competitions; hosted/arena sessions are left alone, exactly like the app",
          },
          scheduling: {
            handoff: "schedule_competition sets status='scheduled' + scheduled_start_at — the existing pg_cron scheduler (run_autonomous_scheduler → run_autonomous_tick, due-competition predicate matching list_due_competitions()) opens the lobby at start − lobby_duration_seconds via prepare_competition_session_internal",
            modes: "only mode 'scheduled' competitions can be scheduled (the tick opens lobbies for mode 'scheduled' only)",
            futureTime: "scheduledStartAt must be a future ISO-8601 timestamp; invalid or past times are rejected, never coerced",
            statuses: "draft → scheduled on schedule; rescheduling a scheduled competition moves its start time",
            sessionCreation: "MCP never creates sessions — the engine does, at lobby time",
          },
          visibilityRules: {
            public: "public competitions are discoverable through the app's public surfaces per app rules",
            private: "private/unlisted competitions are only visible to their owner through MCP (owner-scoped list/get)",
            changes: "visibility changes are explicit patch operations — nothing ever flips visibility implicitly",
          },
          noDelete: {
            rule: "cancel_competition is the only retirement tool — there is no delete_competition; the app's hard delete stays app-only",
            terminal: "completed competitions cannot be cancelled; cancelling an already-cancelled competition is a no-op",
          },
          errorContract: {
            rule: "competition tools return { ok:false, action, error:{code,message} } as normal results (unlike the 8B quiz tools, which throw); league and orchestration tools use the same envelope style",
            codes: ["unauthorized", "not-found", "validation", "conflict", "unknown", "dependency-failed", "partial-failure"],
            orchestration: "orchestrate_competition_workflow adds phase:\"preflight\" on { ok:false } envelopes (nothing was mutated) and status:\"completed\"|\"partial\" on { ok:true } envelopes (per-step outcomes inside steps[]); partial-failure is the status of a workflow whose later step failed after earlier steps succeeded",
            sanitization: "messages never contain SQL, stack traces, service-role details or table names",
          },
        },
        leagues: {
          tools: [
            "list_leagues",
            "get_league",
            "get_league_standings",
            "list_league_competitions",
            "attach_competition_to_league",
            "detach_competition_from_league",
          ],
          statuses: [...LEAGUE_STATUSES],
          visibilities: [...LEAGUE_VISIBILITIES],
          filters: {
            list: "search (name substring), archived (true/false), visibility, status, ownerOnly (owned leagues only), limit",
            owner: "every league read resolves the acting principal — the base scope is owned OR public, exactly like the app's can_view_league",
          },
          authorization: {
            read: "can(principal, 'league.manage', id) OR league.visibility='public' — matches the app's can_view_league; the app's admin view-all branch is deliberately excluded (the agent never sees more than the acting principal)",
            attachDetach: "the acting principal must own the competition (can(principal,'competition.manage',id), owner AND host) AND the league (can(principal,'league.manage',league)); league must not be archived; competition must be draft or scheduled — completed competitions are locked so their results cannot retroactively enter a league's standings",
            ownerResolution: "owner_principal_id always comes from the resolved actor — an agent can never assign an arbitrary owner",
          },
          standings: {
            source: "get_league_standings delegates to the app's existing database function get_league_standings(league_id) via the service-role wrapper mcp_league_standings — no points logic is recreated in MCP, the database remains the source of truth, tie-break order is preserved",
            scope: "owners can read standings for their own private/unlisted leagues; anyone can read public-league standings",
            noStandingsTable: "no standings table is created or written — the computation is live",
          },
          attachDetach: {
            idempotent: "attaching an already-attached competition (same league) and detaching an unattached one are harmless no-ops with a warning; attach/detach accept idempotencyKey (24h replay)",
            lifecycle: "only draft/scheduled competitions can be attached or detached; lobby_open/running/completed/cancelled are protected",
          },
          noCreate: "there is no create_league tool in this phase — league creation stays app-side; MCP mutates leagues only through competition attachment",
        },
        results: {
          tools: ["get_competition_results", "get_player_league_history"],
          source: "permanent results are read from the app's competition_results store (written by the existing engine at competition end) — no second result store is created",
          rules: {
            completedOnly: "get_competition_results requires a completed competition (permanent results exist only after completion)",
            gate: "competition results are gated on can(principal,'competition.manage',competition) — the owner+host; a non-owner can never read another owner's competition results",
            history: "get_player_league_history answers 'how has this player performed in this league' from permanent results; cumulative points/rank come from the authoritative standings function; the player themselves may read their own history",
            noAnswerData: "result rows expose rank, score, accuracy, completion and context only — never answer keys or per-question data",
          },
        },
        orchestration: {
          tool: "orchestrate_competition_workflow",
          workflows: {
            create_attach_schedule: ["create_competition", "attach_competition_to_league", "schedule_competition"],
            create_schedule: ["create_competition", "schedule_competition"],
          },
          contract: {
            bounded: "the tool executes ONE explicit declarative plan supplied by the caller — no loops, no self-modifying plans, no autonomous retrying, no Session control; step sequences are fixed and validated before anything is written",
            preflight: "the complete plan is validated before any mutation (workflow shape, actor capability, quiz and league existence/ownership, future start, mode 'scheduled'); preflight failures return { ok:false, phase:\"preflight\", error } with nothing mutated",
            steps: "steps run in deterministic order using the existing competition/league tools internally; each step reports { step, tool, status, result|error }",
            failure: "the first failed step stops the workflow; the response reports exactly which steps succeeded and which failed (status:\"partial\") — nothing is auto-compensated and no business objects are deleted to hide a partial failure",
            dependencyFailed: "a step failing with not-found on a resource created by an earlier step of the same run is reported as dependency-failed",
          },
          idempotency: {
            required: "idempotencyKey is REQUIRED — the workflow must be retry-safe",
            derivedStepKeys: "each step claims a derived key (<workflowKey>#<n>:<tool>) through the same mcp_idempotency_keys mechanism as every other write tool (24h TTL)",
            retry: "a retry with the same key + identical payload replays the completed steps (same competitionId — no duplicate competitions, attachments or schedules) and re-executes only the failed step",
            payloadMismatch: "reusing a key with a different payload is rejected with code conflict — never reuse a key for a new request",
          },
          noSessions: "orchestration never reads or writes sessions — the schedule step only configures the competition business object; the existing autonomous scheduler opens the lobby",
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

  /* ------------------------------------------------------------------ */
  /* Phase 8C competition lifecycle tools                                */
  /* ------------------------------------------------------------------ */

  const COMPETITION_MODE = z.enum([...COMPETITION_MODES] as [CompetitionMode, ...CompetitionMode[]]);
  const COMPETITION_STATUS = z.enum([...COMPETITION_STATUSES] as [CompetitionStatus, ...CompetitionStatus[]]);
  const COMPETITION_VISIBILITY = z.enum([
    ...COMPETITION_VISIBILITIES,
  ] as [CompetitionVisibility, ...CompetitionVisibility[]]);

  /** Wraps a competition call so failures become structured envelopes. */
  async function competitionResult(
    action: string,
    run: () => Promise<unknown>,
  ): Promise<ReturnType<typeof text>> {
    try {
      return text(await run());
    } catch (err) {
      return text(toErrorEnvelope(action, err));
    }
  }

  server.registerTool(
    "list_competitions",
    {
      title: "List competitions",
      description:
        "Lists compact metadata for competitions owned by the acting principal (no session runtime state). " +
        "Filters: quizId, leagueId, status, mode, visibility, scheduledFrom/scheduledTo (ISO timestamps), limit.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: z.string().optional().describe("Only competitions using this quiz"),
        leagueId: z.string().optional().describe("Only competitions attached to this league"),
        status: COMPETITION_STATUS.optional(),
        mode: COMPETITION_MODE.optional(),
        visibility: COMPETITION_VISIBILITY.optional(),
        scheduledFrom: z
          .string()
          .optional()
          .describe("ISO-8601 — competitions scheduled at or after this time"),
        scheduledTo: z
          .string()
          .optional()
          .describe("ISO-8601 — competitions scheduled at or before this time"),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("list_competitions");
      }
      const client = createSupabaseClient(config.supabase);
      return competitionResult("list_competitions", async () => {
        const { items, count } = await listCompetitions(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          leagueId: args.leagueId,
          status: args.status,
          mode: args.mode,
          visibility: args.visibility,
          scheduledFrom: args.scheduledFrom,
          scheduledTo: args.scheduledTo,
          limit: args.limit,
        });
        return { ok: true, action: "list_competitions", count, items, warnings: [], errors: [] };
      });
    },
  );

  server.registerTool(
    "get_competition",
    {
      title: "Get one competition",
      description:
        "Retrieves one competition's full business state (identity, owner, quiz, mode, visibility, scheduling, " +
        "league/branding references, lifecycle status, participant limits). The status column IS the safe " +
        "summarized state (draft/scheduled/lobby_open/running/completed/cancelled) — no session runtime fields " +
        "are exposed.",
      inputSchema: {
        actorId: ACTOR_ID,
        competitionId: z.string().describe("The uuid of the competition"),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("get_competition");
      }
      const client = createSupabaseClient(config.supabase);
      return competitionResult("get_competition", async () => {
        const { competition } = await getCompetition(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          competitionId: args.competitionId,
        });
        return { ok: true, action: "get_competition", id: competition.id, competition, warnings: [], errors: [] };
      });
    },
  );

  server.registerTool(
    "create_competition",
    {
      title: "Create a competition (draft)",
      description:
        "Creates a draft competition from an existing quiz owned by the acting principal. The quiz must exist, " +
        "be owned by the actor and not be archived. Requires an explicit mode (hosted|arena|scheduled), explicit " +
        "visibility (private|unlisted|public) and a future scheduledStartAt. League and branding references are " +
        "optional and must be owned by the actor. The owner is always the acting principal — no arbitrary owner " +
        "assignment. The competition is created as status 'draft'; call schedule_competition to activate it for " +
        "the existing autonomous scheduler.",
      inputSchema: {
        actorId: ACTOR_ID,
        quizId: z.string().describe("The uuid of the quiz the competition runs"),
        title: z.string().min(1).describe("Competition title"),
        mode: COMPETITION_MODE.describe("hosted | arena | scheduled — the app's mode enum, not invented by MCP"),
        visibility: COMPETITION_VISIBILITY.describe(
          "private | unlisted | public — explicit; MCP never defaults visibility",
        ),
        scheduledStartAt: z.string().describe("ISO-8601 start time — must be in the future"),
        lobbyDurationSeconds: z
          .number()
          .int()
          .min(30)
          .max(3600)
          .optional()
          .describe("Lobby duration (30-3600s, default 300) — the lobby opens at start − duration"),
        description: z.string().nullable().optional(),
        leagueId: z.string().nullable().optional().describe("A league owned by the actor (optional)"),
        brandingProfileId: z
          .string()
          .nullable()
          .optional()
          .describe("A branding profile owned by the actor (optional)"),
        maxParticipants: z.number().int().min(1).nullable().optional(),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("create_competition");
      }
      const client = createSupabaseClient(config.supabase);
      return competitionResult("create_competition", () =>
        createCompetition(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          quizId: args.quizId,
          title: args.title,
          mode: args.mode,
          visibility: args.visibility,
          scheduledStartAt: args.scheduledStartAt,
          lobbyDurationSeconds: args.lobbyDurationSeconds,
          description: args.description,
          leagueId: args.leagueId,
          brandingProfileId: args.brandingProfileId,
          maxParticipants: args.maxParticipants,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "update_competition",
    {
      title: "Update a competition (patch-style)",
      description:
        "Patches a competition owned by the acting principal. Only the supplied fields change. Mutable only in " +
        "draft/scheduled state — lobby_open/running/completed/cancelled competitions are protected. null detaches " +
        "leagueId/brandingProfileId and clears description/maxParticipants. scheduledStartAt must stay in the future.",
      inputSchema: {
        actorId: ACTOR_ID,
        competitionId: z.string().describe("The uuid of the competition"),
        patch: z
          .object({
            title: z.string().min(1).optional(),
            description: z.string().nullable().optional(),
            visibility: COMPETITION_VISIBILITY.optional(),
            scheduledStartAt: z.string().optional().describe("ISO-8601 — must be in the future"),
            lobbyDurationSeconds: z.number().int().min(30).max(3600).optional(),
            leagueId: z.string().nullable().optional().describe("null detaches the league"),
            brandingProfileId: z.string().nullable().optional().describe("null detaches the branding profile"),
            maxParticipants: z.number().int().min(1).nullable().optional().describe("null clears the limit"),
          })
          .refine((p) => Object.keys(p).length > 0, {
            message: "update_competition needs at least one field to change",
          }),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("update_competition");
      }
      const client = createSupabaseClient(config.supabase);
      return competitionResult("update_competition", () =>
        updateCompetition(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          competitionId: args.competitionId,
          patch: args.patch,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "schedule_competition",
    {
      title: "Schedule a competition",
      description:
        "Activates a draft (or reschedules a scheduled) competition for the existing autonomous scheduler: sets " +
        "status='scheduled' with a future scheduledStartAt. Only mode 'scheduled' competitions can be scheduled — " +
        "the engine's tick opens lobbies for mode 'scheduled' only. The lobby opens automatically at " +
        "scheduledStartAt − lobbyDurationSeconds via the existing pg_cron scheduler. MCP never creates sessions.",
      inputSchema: {
        actorId: ACTOR_ID,
        competitionId: z.string().describe("The uuid of the competition"),
        scheduledStartAt: z
          .string()
          .optional()
          .describe("ISO-8601 start time (must be future) — defaults to the stored scheduled start"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("schedule_competition");
      }
      const client = createSupabaseClient(config.supabase);
      return competitionResult("schedule_competition", () =>
        scheduleCompetition(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          competitionId: args.competitionId,
          scheduledStartAt: args.scheduledStartAt,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "cancel_competition",
    {
      title: "Cancel a competition",
      description:
        "Cancels a competition using the app's exact semantics: status='cancelled' + cancelled_at. Rejects " +
        "completed competitions; cancelling an already-cancelled competition is a no-op. Sessions are never " +
        "touched — the existing autonomous tick ends sessions of cancelled competitions; hosted/arena sessions " +
        "are left alone, exactly like the app.",
      inputSchema: {
        actorId: ACTOR_ID,
        competitionId: z.string().describe("The uuid of the competition"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("cancel_competition");
      }
      const client = createSupabaseClient(config.supabase);
      return competitionResult("cancel_competition", () =>
        cancelCompetition(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          competitionId: args.competitionId,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  /* ------------------------------------------------------------------ */
  /* Phase 8D league, results & orchestration tools                      */
  /* ------------------------------------------------------------------ */

  const LEAGUE_STATUS = z.enum([...LEAGUE_STATUSES] as [LeagueStatus, ...LeagueStatus[]]);
  const LEAGUE_VISIBILITY = z.enum([
    ...LEAGUE_VISIBILITIES,
  ] as [LeagueVisibility, ...LeagueVisibility[]]);

  /** Wraps a league call so failures become structured envelopes. */
  async function leagueResult(
    action: string,
    run: () => Promise<unknown>,
  ): Promise<ReturnType<typeof text>> {
    try {
      return text(await run());
    } catch (err) {
      return text(toLeagueEnvelope(action, err));
    }
  }

  /** Wraps an orchestration call: preflight failures become structured
   * phase:"preflight" envelopes; partial/completed envelopes pass through. */
  async function orchestrateResult(
    action: string,
    run: () => Promise<unknown>,
  ): Promise<ReturnType<typeof text>> {
    try {
      return text(await run());
    } catch (err) {
      return text(toOrchestrationEnvelope(action, err));
    }
  }

  server.registerTool(
    "list_leagues",
    {
      title: "List leagues",
      description:
        "Lists compact metadata for leagues the acting principal can legitimately inspect: leagues it owns " +
        "plus public leagues (the app's can_view_league rule). Filters: name search, archived/unarchived, " +
        "visibility, status, ownerOnly (owned leagues only), limit. Compact metadata only — no standings.",
      inputSchema: {
        actorId: ACTOR_ID,
        search: z.string().optional().describe("Literal substring match on the league name"),
        archived: z
          .boolean()
          .optional()
          .describe("true = archived only, false = not archived, omitted = both"),
        visibility: LEAGUE_VISIBILITY.optional(),
        status: LEAGUE_STATUS.optional(),
        ownerOnly: z
          .boolean()
          .default(false)
          .describe("true restricts the result to leagues owned by the acting principal"),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("list_leagues");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("list_leagues", async () => {
        const { items, count } = await listLeagues(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          search: args.search,
          archived: args.archived,
          visibility: args.visibility,
          status: args.status,
          ownerOnly: args.ownerOnly,
          limit: args.limit,
        });
        return { ok: true, action: "list_leagues", count, items, warnings: [], errors: [] };
      });
    },
  );

  server.registerTool(
    "get_league",
    {
      title: "Get one league",
      description:
        "Retrieves one league's metadata, owner, visibility, archived state, scoring configuration " +
        "(points_first/second/third/participation), season state (status), and a compact overview: participant " +
        "count, total/completed/upcoming competition counts and the upcoming competitions themselves. No " +
        "standings — call get_league_standings for those.",
      inputSchema: {
        actorId: ACTOR_ID,
        leagueId: z.string().describe("The uuid of the league"),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("get_league");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("get_league", async () => {
        const { league } = await getLeague(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          leagueId: args.leagueId,
        });
        return { ok: true, action: "get_league", id: league.id, league, warnings: [], errors: [] };
      });
    },
  );

  server.registerTool(
    "get_league_standings",
    {
      title: "Get league standings",
      description:
        "Returns the league's standings exactly as the app computes them: the database function " +
        "get_league_standings(league_id) is the source of truth (via the service-role wrapper) — rank, player, " +
        "league points, competitions played, wins, podiums, cumulative score and average accuracy, in the app's " +
        "tie-break order. Standings exist for completed league competitions; an empty list means none yet. " +
        "Access: the acting principal must own the league (host capability) or the league must be public.",
      inputSchema: {
        actorId: ACTOR_ID,
        leagueId: z.string().describe("The uuid of the league"),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("get_league_standings");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("get_league_standings", async () => {
        const { standings, count } = await getLeagueStandings(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          leagueId: args.leagueId,
        });
        return { ok: true, action: "get_league_standings", count, standings, warnings: [], errors: [] };
      });
    },
  );

  server.registerTool(
    "list_league_competitions",
    {
      title: "List a league's competitions",
      description:
        "Lists the competitions attached to a league: id, title, status, mode, scheduled/completed times, " +
        "visibility and whether permanent results exist. League owners see every attached competition; " +
        "non-owners of a public league see only public competitions in the app-visible statuses. Never exposes " +
        "session runtime internals.",
      inputSchema: {
        actorId: ACTOR_ID,
        leagueId: z.string().describe("The uuid of the league"),
        status: COMPETITION_STATUS.optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("list_league_competitions");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("list_league_competitions", async () => {
        const { items, count } = await listLeagueCompetitions(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          leagueId: args.leagueId,
          status: args.status,
          limit: args.limit,
        });
        return { ok: true, action: "list_league_competitions", count, items, warnings: [], errors: [] };
      });
    },
  );

  server.registerTool(
    "get_competition_results",
    {
      title: "Get a competition's permanent results",
      description:
        "Returns the authorized permanent results of a COMPLETED competition, in final-rank order: player, rank, " +
        "score, total participants, accuracy and completion time. Results come from the app's permanent " +
        "competition_results store — never from live sessions, and never answer data. Only the competition's " +
        "owner (host capability) can read results; non-completed competitions have none.",
      inputSchema: {
        actorId: ACTOR_ID,
        competitionId: z.string().describe("The uuid of the competition (must be completed)"),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("get_competition_results");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("get_competition_results", async () => {
        const r = await getCompetitionResults(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          competitionId: args.competitionId,
        });
        return {
          ok: true,
          action: "get_competition_results",
          competitionId: r.competitionId,
          competitionTitle: r.competitionTitle,
          quizTitle: r.quizTitle,
          status: r.status,
          count: r.count,
          items: r.items,
          warnings: r.warnings,
          errors: [],
        };
      });
    },
  );

  server.registerTool(
    "get_player_league_history",
    {
      title: "Get a player's league history",
      description:
        "Answers 'how has this player performed in this league?' from permanent results: each completed " +
        "competition they entered (rank, score, accuracy, completion) plus their cumulative league points and " +
        "overall rank from the authoritative standings computation. Access: the league owner, readers of a " +
        "public league, or the player themselves (their own results only — cumulative points/rank are then " +
        "omitted for private leagues they do not own).",
      inputSchema: {
        actorId: ACTOR_ID,
        leagueId: z.string().describe("The uuid of the league"),
        profileId: z.string().describe("The uuid of the player (auth user / profile id) to look up"),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("get_player_league_history");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("get_player_league_history", async () => {
        const r = await getPlayerLeagueHistory(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          leagueId: args.leagueId,
          profileId: args.profileId,
        });
        return {
          ok: true,
          action: "get_player_league_history",
          leagueId: r.leagueId,
          profileId: r.profileId,
          displayName: r.displayName,
          competitionsEntered: r.competitionsEntered,
          leaguePoints: r.leaguePoints,
          overallRank: r.overallRank,
          items: r.items,
          warnings: [],
          errors: [],
        };
      });
    },
  );

  server.registerTool(
    "attach_competition_to_league",
    {
      title: "Attach a competition to a league",
      description:
        "Attaches a draft/scheduled competition owned by the acting principal to a league the acting principal " +
        "owns (the league must not be archived). Idempotent: attaching an already-attached competition to the " +
        "same league is a no-op with a warning. Completed/lobby_open/running competitions are protected — " +
        "attaching a completed competition would retroactively change the league's standings.",
      inputSchema: {
        actorId: ACTOR_ID,
        competitionId: z.string().describe("The uuid of the draft/scheduled competition"),
        leagueId: z.string().describe("The uuid of the league owned by the acting principal"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("attach_competition_to_league");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("attach_competition_to_league", () =>
        attachCompetitionToLeague(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          competitionId: args.competitionId,
          leagueId: args.leagueId,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "detach_competition_from_league",
    {
      title: "Detach a competition from its league",
      description:
        "Removes a draft/scheduled competition (owned by the acting principal) from its league. Idempotent: " +
        "detaching an unattached competition is a no-op with a warning. Completed/lobby_open/running " +
        "competitions are protected — detaching a completed competition would retroactively remove its results " +
        "from the league's standings.",
      inputSchema: {
        actorId: ACTOR_ID,
        competitionId: z.string().describe("The uuid of the draft/scheduled competition"),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("detach_competition_from_league");
      }
      const client = createSupabaseClient(config.supabase);
      return leagueResult("detach_competition_from_league", () =>
        detachCompetitionFromLeague(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          competitionId: args.competitionId,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );

  server.registerTool(
    "orchestrate_competition_workflow",
    {
      title: "Run a bounded competition workflow",
      description:
        "Executes ONE explicit, declarative workflow in deterministic order, using the existing competition " +
        "tools internally. Supported workflows: create_attach_schedule (create competition → attach to league → " +
        "schedule) and create_schedule (create → schedule). The complete plan is validated BEFORE any mutation " +
        "(preflight); live-state gates (archived flags, statuses) are re-checked by each step. If a step fails, " +
        "the workflow stops and reports exactly which steps succeeded (status:'partial') — nothing is " +
        "auto-compensated. idempotencyKey is REQUIRED: each step claims a derived key, so a retry with the same " +
        "key + identical payload replays completed steps (no duplicate competitions/attachments/schedules) and " +
        "re-runs only the failed step. Never touches sessions — the schedule step hands off to the existing " +
        "autonomous scheduler. This is a bounded one-shot tool — no loops, no autonomous behavior.",
      inputSchema: {
        actorId: ACTOR_ID,
        workflow: z
          .enum(Object.keys(WORKFLOWS) as [WorkflowId, ...WorkflowId[]])
          .describe("create_attach_schedule | create_schedule"),
        plan: z
          .object({
            quizId: z.string().describe("The uuid of the quiz the competition runs — must be owned by the actor"),
            title: z.string().min(1).describe("Competition title"),
            mode: COMPETITION_MODE.describe(
              "must be 'scheduled' — both supported workflows end in the schedule step, and the autonomous scheduler opens mode 'scheduled' competitions only",
            ),
            visibility: COMPETITION_VISIBILITY.describe(
              "private | unlisted | public — explicit; MCP never defaults visibility",
            ),
            scheduledStartAt: z.string().describe("ISO-8601 start time — must be in the future"),
            lobbyDurationSeconds: z
              .number()
              .int()
              .min(30)
              .max(3600)
              .optional()
              .describe("Lobby duration (30-3600s, default 300)"),
            description: z.string().nullable().optional(),
            brandingProfileId: z.string().nullable().optional(),
            maxParticipants: z.number().int().min(1).nullable().optional(),
            leagueId: z
              .string()
              .optional()
              .describe("Required when workflow is create_attach_schedule — a league owned by the actor"),
          })
          .describe("The declarative plan — all create fields, plus leagueId for attach workflows"),
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "REQUIRED — any stable string identifying this logical workflow. A retry with the same key and " +
              "identical payload replays completed steps instead of duplicating them. Never reuse a key with a " +
              "different payload.",
          ),
      },
    },
    async (args) => {
      if (!config.supabase) {
        supabaseGateError("orchestrate_competition_workflow");
      }
      const client = createSupabaseClient(config.supabase);
      return orchestrateResult("orchestrate_competition_workflow", () =>
        orchestrateCompetitionWorkflow(client, {
          actorId: args.actorId ?? config.defaultOwnerId ?? "",
          workflow: args.workflow,
          // The zod schema accepts the full mode enum so a non-'scheduled'
          // plan reaches preflight and produces the structured envelope
          // (phase:"preflight", nothing mutated) instead of a raw schema error.
          plan: args.plan as OrchestrationPlan,
          idempotencyKey: args.idempotencyKey,
        }),
      );
    },
  );
}
