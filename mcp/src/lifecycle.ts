// Quiz lifecycle operations for the MCP server (Phase 8B).
//
// Every operation resolves the acting Principal (an auth user id — user
// principals are id-identical) and enforces capability through the app's
// existing `public.can(principal, action, resource)` resolver (service-role
// RPC), NOT a parallel MCP permission system. Ownership is principal-only
// (Phase 7L): owner_principal_id is authoritative and never NULL for rows
// this server can see.
//
// Writes accept an optional idempotencyKey; a repeated request with the same
// key replays the stored result (see idempotency.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { requestHash, withIdempotency } from "./idempotency";
import {
  dbQuestionRowToCamel,
  MAX_QUESTIONS,
  questionSchema,
  questionToDbRow,
  QUESTION_TYPE_FIELDS,
  type BrainBoltQuestion,
  type QuestionDbRowLike,
} from "./schema";
import { formatIssues, validateQuiz } from "./validate";

/* ------------------------------------------------------------------ */
/* Shared shapes                                                        */
/* ------------------------------------------------------------------ */

export type LifecycleEnvelope = {
  ok: true;
  action: string;
  id?: string;
  quizId?: string;
  changed?: Record<string, unknown>;
  warnings: string[];
  errors: never[];
  /** Present only when the request was replayed via an idempotency key. */
  replayed?: boolean;
};

export type Actor = {
  /** The auth user id acting (from the tool's actorId or the default owner). */
  actorId: string;
  /** The resolved user principal id (id-identical for user principals). */
  principalId: string;
};

export type QuizSummary = {
  id: string;
  title: string;
  description: string | null;
  ownerId: string;
  ownerPrincipalId: string | null;
  archived: boolean;
  archivedAt: string | null;
  isArena: boolean;
  difficulty: string | null;
  playCount: number;
  featuredRank: number | null;
  estimatedDurationMinutes: number | null;
  timePerQuestionSec: number;
  createdAt: string;
  questionCount: number;
};

const QUIZ_COLUMNS =
  "id,title,description,time_per_question,difficulty,estimated_duration_minutes," +
  "is_arena,archived_at,created_at,play_count,featured_rank,owner_principal_id";

const QUESTION_COLUMNS =
  "id,quiz_id,position,text,options,correct_index,time_limit_sec,point_value," +
  "question_type,image_url,double_points,correct_lat,correct_lng,max_distance_km," +
  "correct_number,number_min,number_max,number_tolerance,accepted_answers,audio_url,reveal_stages";

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/* ------------------------------------------------------------------ */
/* Principal resolution + capability enforcement                        */
/* ------------------------------------------------------------------ */

/** Resolves the acting auth user to its user principal (Phase 7 model).
 * `label` names the argument in error messages ("actorId" or "ownerId"). */
export async function resolveActor(
  client: SupabaseClient,
  actorId: string,
  label = "actorId",
): Promise<Actor> {
  const id = actorId.trim();
  if (!id) {
    throw new Error(
      `No acting principal: pass ${label} (a uuid of an auth user) or set BRAINBOLT_DEFAULT_OWNER_ID in mcp/.env.`,
    );
  }
  if (!isValidUuid(id)) {
    throw new Error(`${label} "${id}" is not a valid uuid. Use the id of a user in auth.users.`);
  }

  const { data, error } = await client
    .from("principals")
    .select("id")
    .eq("type", "user")
    .eq("user_id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not resolve the acting principal: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `${label} "${id}" has no user principal in the database. Principals are created for users ` +
        "when they sign up (and were seeded for existing users) — the actor must be the uuid of " +
        "a real user in auth.users who has logged in at least once.",
    );
  }
  return { actorId: id, principalId: data.id };
}

type QuizRow = {
  id: string;
  title: string;
  description: string | null;
  time_per_question: number;
  difficulty: string | null;
  estimated_duration_minutes: number | null;
  is_arena: boolean;
  archived_at: string | null;
  created_at: string;
  play_count: number;
  featured_rank: number | null;
  owner_principal_id: string | null;
};

async function fetchQuizRow(
  client: SupabaseClient,
  quizId: string,
): Promise<QuizRow | null> {
  if (!isValidUuid(quizId)) {
    throw new Error(`quizId "${quizId}" is not a valid uuid.`);
  }
  const { data, error } = await client
    .from("quizzes")
    .select(QUIZ_COLUMNS)
    .eq("id", quizId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read quiz "${quizId}": ${error.message}`);
  }
  return (data as unknown as QuizRow | null) ?? null;
}

/**
 * Capability gate: the acting principal must pass the app's own
 * `can(principal, action, resource)` resolver. Fetches the quiz first so the
 * failure mode is "quiz does not exist" rather than a generic denial.
 */
export async function assertCan(
  client: SupabaseClient,
  actor: Actor,
  quizId: string,
  action: "quiz.edit" | "quiz.delete",
  verb: string,
): Promise<QuizRow> {
  const row = await fetchQuizRow(client, quizId);
  if (!row) {
    throw new Error(`quiz "${quizId}" does not exist — nothing was changed.`);
  }

  const { data, error } = await client.rpc("can", {
    p_principal: actor.principalId,
    p_action: action,
    p_resource: quizId,
  });
  if (error) {
    throw new Error(`Capability check failed for quiz "${quizId}": ${error.message}`);
  }
  if (data !== true) {
    throw new Error(
      `actor "${actor.actorId}" is not authorized to ${verb} quiz "${quizId}" ` +
        `("${row.title}") — the acting principal must own the quiz and hold the host capability.`,
    );
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* list_quizzes                                                         */
/* ------------------------------------------------------------------ */

export type ListQuizzesOptions = {
  actorId: string;
  /** Literal substring match on the title. */
  search?: string;
  /** true = archived only, false = not archived, undefined = both. */
  archived?: boolean;
  difficulty?: "easy" | "medium" | "hard";
  isArena?: boolean;
  limit?: number;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function listQuizzes(
  client: SupabaseClient,
  options: ListQuizzesOptions,
): Promise<{ items: QuizSummary[]; count: number }> {
  const actor = await resolveActor(client, options.actorId);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  let query = client
    .from("quizzes")
    .select(QUIZ_COLUMNS)
    .eq("owner_principal_id", actor.principalId);

  if (options.archived === true) {
    query = query.not("archived_at", "is", null);
  } else if (options.archived === false) {
    query = query.is("archived_at", null);
  }
  if (options.search && options.search.trim()) {
    query = query.ilike("title", `%${escapeLike(options.search.trim())}%`);
  }
  if (options.difficulty) {
    query = query.eq("difficulty", options.difficulty);
  }
  if (options.isArena !== undefined) {
    query = query.eq("is_arena", options.isArena);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) {
    throw new Error(`Could not list quizzes: ${error.message}`);
  }
  const rows = (data as unknown as QuizRow[] | null) ?? [];
  if (rows.length === 0) {
    return { items: [], count: 0 };
  }

  const ids = rows.map((r) => r.id);
  const { data: countRows, error: countError } = await client
    .from("questions")
    .select("quiz_id")
    .in("quiz_id", ids);
  if (countError) {
    throw new Error(`Could not count questions: ${countError.message}`);
  }
  const counts = new Map<string, number>();
  for (const row of (countRows ?? []) as unknown as Array<{ quiz_id: string }>) {
    counts.set(row.quiz_id, (counts.get(row.quiz_id) ?? 0) + 1);
  }

  const items: QuizSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    // User principals are id-identical to auth users; the legacy owner_id
    // column was retired in Phase 7L. NULL only for non-user-owned rows,
    // which this server never sees (resolveActor enforces a user principal).
    ownerId: r.owner_principal_id ?? "",
    ownerPrincipalId: r.owner_principal_id,
    archived: r.archived_at !== null,
    archivedAt: r.archived_at,
    isArena: r.is_arena,
    difficulty: r.difficulty,
    playCount: r.play_count,
    featuredRank: r.featured_rank,
    estimatedDurationMinutes: r.estimated_duration_minutes,
    timePerQuestionSec: r.time_per_question,
    createdAt: r.created_at,
    questionCount: counts.get(r.id) ?? 0,
  }));

  return { items, count: items.length };
}

/* ------------------------------------------------------------------ */
/* get_quiz                                                             */
/* ------------------------------------------------------------------ */

export type GetQuizOptions = {
  actorId: string;
  quizId: string;
  /** false strips answer keys (correctIndex, correct, acceptedAnswers, ...). */
  includeAnswers?: boolean;
};

/** A question view with answer keys removed — valid for display only. */
export type QuestionView = { type: string; text: string } & Record<string, unknown>;

export function redactAnswers(q: BrainBoltQuestion): QuestionView {
  const { text, timeLimitSec, pointValue, doublePoints } = q;
  const view: QuestionView = { type: q.type, text, timeLimitSec, pointValue, doublePoints };
  switch (q.type) {
    case "mcq":
    case "image_mcq":
    case "image_reveal":
    case "audio":
      return {
        ...view,
        options: q.options,
        imageUrl: "imageUrl" in q ? q.imageUrl : undefined,
        audioUrl: q.type === "audio" ? q.audioUrl : undefined,
        revealStages: q.type === "image_reveal" ? q.revealStages : undefined,
      };
    case "number":
      return { ...view, min: q.min, max: q.max, format: q.format, unit: q.unit };
    case "map_pin":
      return { ...view, maxDistanceKm: q.maxDistanceKm };
    case "type":
      return view;
    case "ordering":
      return view;
    case "feedback":
    case "true_false":
      return view;
  }
}

export async function getQuiz(
  client: SupabaseClient,
  options: GetQuizOptions,
): Promise<{
  quiz: QuizSummary;
  questions: Array<BrainBoltQuestion | QuestionView>;
  includeAnswers: boolean;
}> {
  const actor = await resolveActor(client, options.actorId);
  const row = await assertCan(client, actor, options.quizId, "quiz.edit", "read");

  const { data: questionRows, error } = await client
    .from("questions")
    .select(QUESTION_COLUMNS)
    .eq("quiz_id", options.quizId)
    .order("position");
  if (error) {
    throw new Error(`Could not read questions for quiz "${options.quizId}": ${error.message}`);
  }

  const includeAnswers = options.includeAnswers !== false;
  const questions: Array<BrainBoltQuestion | QuestionView> = (
    (questionRows ?? []) as unknown as QuestionDbRowLike[]
  )
    .map((r) => dbQuestionRowToCamel(r))
    .map((q) => (includeAnswers ? q : redactAnswers(q)));

  const quiz: QuizSummary = {
    id: row.id,
    title: row.title,
    description: row.description,
    ownerId: row.owner_principal_id ?? "",
    ownerPrincipalId: row.owner_principal_id,
    archived: row.archived_at !== null,
    archivedAt: row.archived_at,
    isArena: row.is_arena,
    difficulty: row.difficulty,
    playCount: row.play_count,
    featuredRank: row.featured_rank,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    timePerQuestionSec: row.time_per_question,
    createdAt: row.created_at,
    questionCount: questions.length,
  };

  return { quiz, questions, includeAnswers };
}

/* ------------------------------------------------------------------ */
/* update_quiz (patch-style)                                            */
/* ------------------------------------------------------------------ */

export type QuizPatch = {
  title?: string;
  description?: string | null;
  difficulty?: "easy" | "medium" | "hard" | null;
  timePerQuestionSec?: number;
};

export type UpdateQuizOptions = {
  actorId: string;
  quizId: string;
  patch: QuizPatch;
  idempotencyKey?: string;
};

export async function updateQuiz(
  client: SupabaseClient,
  options: UpdateQuizOptions,
): Promise<LifecycleEnvelope> {
  const run = async (): Promise<LifecycleEnvelope> => {
    const actor = await resolveActor(client, options.actorId);
    const row = await assertCan(client, actor, options.quizId, "quiz.edit", "update");

    const patch = options.patch ?? {};
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new Error("update_quiz needs at least one field to change (title, description, difficulty, timePerQuestionSec).");
    }

    const update: Record<string, unknown> = {};
    const changed: Record<string, boolean> = {};

    if ("title" in patch) {
      const title = (patch.title ?? "").trim();
      if (!title) throw new Error("update_quiz: title must be a non-empty string.");
      update.title = title;
      changed.title = title !== row.title;
    }
    if ("description" in patch) {
      const description = patch.description ?? null;
      update.description = description;
      changed.description = description !== row.description;
    }
    if ("difficulty" in patch) {
      const difficulty = patch.difficulty ?? null;
      if (difficulty !== null && !["easy", "medium", "hard"].includes(difficulty)) {
        throw new Error(`update_quiz: difficulty must be easy, medium or hard (got "${difficulty}").`);
      }
      update.difficulty = difficulty;
      changed.difficulty = difficulty !== row.difficulty;
    }
    if ("timePerQuestionSec" in patch) {
      const time = patch.timePerQuestionSec;
      if (typeof time !== "number" || !Number.isInteger(time) || time < 5 || time > 120) {
        throw new Error("update_quiz: timePerQuestionSec must be an integer between 5 and 120.");
      }
      update.time_per_question = time;
      changed.timePerQuestionSec = time !== row.time_per_question;
    }

    const applied = Object.values(changed).some(Boolean);
    if (applied) {
      const { error } = await client
        .from("quizzes")
        .update(update)
        .eq("id", options.quizId);
      if (error) {
        throw new Error(`Could not update quiz "${options.quizId}": ${error.message}`);
      }
    }

    const warnings: string[] = [];
    if (!applied) {
      warnings.push("The supplied values match the current quiz — nothing changed.");
    }

    return { ok: true, action: "update_quiz", id: options.quizId, changed, warnings, errors: [] };
  };

  return wrapIdempotent(client, "update_quiz", options.idempotencyKey, {
    actor: options.actorId,
    quizId: options.quizId,
    patch: options.patch,
  }, run);
}

/* ------------------------------------------------------------------ */
/* archive_quiz                                                         */
/* ------------------------------------------------------------------ */

export type ArchiveQuizOptions = {
  actorId: string;
  quizId: string;
  idempotencyKey?: string;
};

export async function archiveQuiz(
  client: SupabaseClient,
  options: ArchiveQuizOptions,
): Promise<LifecycleEnvelope> {
  const run = async (): Promise<LifecycleEnvelope> => {
    const actor = await resolveActor(client, options.actorId);
    const row = await assertCan(client, actor, options.quizId, "quiz.edit", "archive");

    if (row.archived_at !== null) {
      return {
        ok: true,
        action: "archive_quiz",
        id: options.quizId,
        changed: { archived: false },
        warnings: [`quiz "${options.quizId}" was already archived on ${row.archived_at}.`],
        errors: [],
      };
    }

    const archivedAt = new Date().toISOString();
    const { error } = await client
      .from("quizzes")
      .update({ archived_at: archivedAt })
      .eq("id", options.quizId);
    if (error) {
      throw new Error(`Could not archive quiz "${options.quizId}": ${error.message}`);
    }

    return {
      ok: true,
      action: "archive_quiz",
      id: options.quizId,
      changed: { archived: true, archivedAt },
      warnings: [],
      errors: [],
    };
  };

  return wrapIdempotent(client, "archive_quiz", options.idempotencyKey, {
    actor: options.actorId,
    quizId: options.quizId,
  }, run);
}

/* ------------------------------------------------------------------ */
/* Question management                                                  */
/* ------------------------------------------------------------------ */

/** Validates a batch of questions exactly like quiz generation does:
 * zod shape first, then the full semantic gate (media URLs, answer ranges,
 * duplicates, semicolon-free fields). */
export function validateQuestionBatch(questions: unknown[]): {
  parsed: BrainBoltQuestion[];
  warnings: string[];
} {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("questions must be a non-empty array of Brain Bolt question objects.");
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`A single add_questions call can add at most ${MAX_QUESTIONS} questions.`);
  }

  const parsed: BrainBoltQuestion[] = [];
  const issues: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const result = questionSchema.safeParse(questions[i]);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push(`questions[${i}].${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      parsed.push(result.data);
    }
  }
  if (issues.length > 0) {
    throw new Error(`Invalid question data — nothing was written:\n${issues.join("\n")}`);
  }

  // The same semantic gate save_quiz applies (media URLs, ranges, dupes, ...).
  const report = validateQuiz({ title: "validation", questions: parsed });
  if (!report.valid) {
    throw new Error(`Invalid question data — nothing was written:\n${formatIssues(report)}`);
  }
  return { parsed, warnings: report.warnings.map((w) => `question[${w.questionIndex}].${w.field}: ${w.message}`) };
}

export type AddQuestionsOptions = {
  actorId: string;
  quizId: string;
  questions: unknown[];
  idempotencyKey?: string;
};

export async function addQuestions(
  client: SupabaseClient,
  options: AddQuestionsOptions,
): Promise<LifecycleEnvelope> {
  const run = async (): Promise<LifecycleEnvelope> => {
    const actor = await resolveActor(client, options.actorId);
    await assertCan(client, actor, options.quizId, "quiz.edit", "modify");
    const { parsed, warnings } = validateQuestionBatch(options.questions);

    const { data: existing, error: existingError } = await client
      .from("questions")
      .select("position")
      .eq("quiz_id", options.quizId)
      .order("position");
    if (existingError) {
      throw new Error(`Could not read questions of quiz "${options.quizId}": ${existingError.message}`);
    }
    const rows = (existing ?? []) as unknown as Array<{ position: number }>;
    if (rows.length + parsed.length > MAX_QUESTIONS) {
      throw new Error(
        `Quiz "${options.quizId}" already has ${rows.length} questions — adding ${parsed.length} ` +
          `would exceed the ${MAX_QUESTIONS} cap. Remove questions first.`,
      );
    }

    const start = rows.reduce((max, r) => Math.max(max, r.position + 1), rows.length);
    const payload = parsed.map((q, i) => ({
      quiz_id: options.quizId,
      ...questionToDbRow(q, start + i),
    }));

    const { data: inserted, error } = await client
      .from("questions")
      .insert(payload)
      .select("id");
    if (error) {
      throw new Error(`Could not insert questions into quiz "${options.quizId}": ${error.message}`);
    }

    return {
      ok: true,
      action: "add_questions",
      id: options.quizId,
      changed: { added: parsed.length, questionCount: rows.length + parsed.length },
      warnings,
      errors: [],
    };
  };

  return wrapIdempotent(client, "add_questions", options.idempotencyKey, {
    actor: options.actorId,
    quizId: options.quizId,
    questions: options.questions,
  }, run);
}

export type UpdateQuestionOptions = {
  actorId: string;
  quizId: string;
  questionId: string;
  patch: Record<string, unknown>;
  idempotencyKey?: string;
};

export async function updateQuestion(
  client: SupabaseClient,
  options: UpdateQuestionOptions,
): Promise<LifecycleEnvelope> {
  const run = async (): Promise<LifecycleEnvelope> => {
    const actor = await resolveActor(client, options.actorId);
    await assertCan(client, actor, options.quizId, "quiz.edit", "modify");

    if (!isValidUuid(options.questionId)) {
      throw new Error(`questionId "${options.questionId}" is not a valid uuid.`);
    }
    const patch = { ...(options.patch ?? {}) };
    const patchKeys = Object.keys(patch);
    if (patchKeys.length === 0) {
      throw new Error("update_question needs at least one field to change.");
    }

    const { data: row, error } = await client
      .from("questions")
      .select(QUESTION_COLUMNS)
      .eq("id", options.questionId)
      .maybeSingle();
    if (error) {
      throw new Error(`Could not read question "${options.questionId}": ${error.message}`);
    }
    if (!row) {
      throw new Error(`question "${options.questionId}" does not exist.`);
    }
    const question = row as unknown as QuestionDbRowLike & { quiz_id: string; position: number };
    if (question.quiz_id !== options.quizId) {
      throw new Error(
        `question "${options.questionId}" belongs to quiz "${question.quiz_id}", not "${options.quizId}" — ` +
          "refusing to touch it.",
      );
    }

    if ("type" in patch) {
      if (patch.type !== question.question_type) {
        throw new Error(
          `Cannot change question "${options.questionId}" from type "${question.question_type}" to ` +
            `"${patch.type}" — question types are immutable. Remove the question and add a new one instead.`,
        );
      }
      delete patch.type; // same-type no-op
    }

    const allowed = QUESTION_TYPE_FIELDS[question.question_type as keyof typeof QUESTION_TYPE_FIELDS] ?? [];
    const warnings: string[] = [];
    const appliedPatch: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      if (allowed.includes(key)) {
        appliedPatch[key] = patch[key];
      } else {
        warnings.push(
          `field "${key}" does not apply to a ${question.question_type} question and was ignored.`,
        );
      }
    }
    if (Object.keys(appliedPatch).length === 0) {
      throw new Error(
        `update_question: none of the supplied fields apply to a ${question.question_type} question. ` +
          `Supported fields: ${allowed.join(", ")}.`,
      );
    }

    // Validate the MERGED question — the same gate quiz generation applies.
    const current = dbQuestionRowToCamel(question);
    const merged = { ...current, ...appliedPatch };
    const report = validateQuiz({ title: "validation", questions: [merged] });
    if (!report.valid) {
      throw new Error(
        `The updated question would be invalid — nothing was written:\n${formatIssues(report)}`,
      );
    }

    const changed: Record<string, boolean> = {};
    for (const key of Object.keys(appliedPatch)) {
      const before = (current as Record<string, unknown>)[key];
      const after = (merged as Record<string, unknown>)[key];
      changed[key] = JSON.stringify(before) !== JSON.stringify(after);
    }
    if (!Object.values(changed).some(Boolean)) {
      warnings.push("The supplied values match the current question — nothing changed.");
    } else {
      const dbRow = questionToDbRow(merged, question.position);
      const { error: updateError } = await client
        .from("questions")
        .update(dbRow)
        .eq("id", options.questionId);
      if (updateError) {
        throw new Error(`Could not update question "${options.questionId}": ${updateError.message}`);
      }
    }

    return {
      ok: true,
      action: "update_question",
      id: options.questionId,
      quizId: options.quizId,
      changed,
      warnings,
      errors: [],
    };
  };

  return wrapIdempotent(client, "update_question", options.idempotencyKey, {
    actor: options.actorId,
    quizId: options.quizId,
    questionId: options.questionId,
    patch: options.patch,
  }, run);
}

export type RemoveQuestionOptions = {
  actorId: string;
  quizId: string;
  questionId: string;
  idempotencyKey?: string;
};

export async function removeQuestion(
  client: SupabaseClient,
  options: RemoveQuestionOptions,
): Promise<LifecycleEnvelope> {
  const run = async (): Promise<LifecycleEnvelope> => {
    const actor = await resolveActor(client, options.actorId);
    await assertCan(client, actor, options.quizId, "quiz.edit", "modify");

    if (!isValidUuid(options.questionId)) {
      throw new Error(`questionId "${options.questionId}" is not a valid uuid.`);
    }
    const { data: row, error } = await client
      .from("questions")
      .select("id,quiz_id")
      .eq("id", options.questionId)
      .maybeSingle();
    if (error) {
      throw new Error(`Could not read question "${options.questionId}": ${error.message}`);
    }
    if (!row) {
      throw new Error(`question "${options.questionId}" does not exist.`);
    }
    const question = row as unknown as { id: string; quiz_id: string };
    if (question.quiz_id !== options.quizId) {
      throw new Error(
        `question "${options.questionId}" belongs to quiz "${question.quiz_id}", not "${options.quizId}" — refusing to remove it.`,
      );
    }

    const { data: all, error: allError } = await client
      .from("questions")
      .select("id")
      .eq("quiz_id", options.quizId)
      .order("position");
    if (allError) {
      throw new Error(`Could not read questions of quiz "${options.quizId}": ${allError.message}`);
    }
    const ids = ((all ?? []) as unknown as Array<{ id: string }>).map((r) => r.id);
    if (ids.length <= 1) {
      throw new Error(
        `Refusing to remove the last question of quiz "${options.quizId}" — a quiz must keep at least one question.`,
      );
    }

    const { error: deleteError } = await client
      .from("questions")
      .delete()
      .eq("id", options.questionId);
    if (deleteError) {
      throw new Error(`Could not remove question "${options.questionId}": ${deleteError.message}`);
    }

    // Keep positions contiguous, exactly like the app editor does.
    const remaining = ids.filter((id) => id !== options.questionId);
    for (let i = 0; i < remaining.length; i++) {
      const { error: posError } = await client
        .from("questions")
        .update({ position: i })
        .eq("id", remaining[i]!);
      if (posError) {
        throw new Error(
          `Question removed but position renumbering failed for "${remaining[i]}": ${posError.message} — ` +
            "run reorder_questions to repair positions.",
        );
      }
    }

    return {
      ok: true,
      action: "remove_question",
      id: options.questionId,
      quizId: options.quizId,
      changed: { removed: true, questionCount: remaining.length },
      warnings: [],
      errors: [],
    };
  };

  return wrapIdempotent(client, "remove_question", options.idempotencyKey, {
    actor: options.actorId,
    quizId: options.quizId,
    questionId: options.questionId,
  }, run);
}

export type ReorderQuestionsOptions = {
  actorId: string;
  quizId: string;
  /** The full set of question ids in the desired order (0-based positions). */
  questionIds: string[];
  idempotencyKey?: string;
};

export async function reorderQuestions(
  client: SupabaseClient,
  options: ReorderQuestionsOptions,
): Promise<LifecycleEnvelope> {
  const run = async (): Promise<LifecycleEnvelope> => {
    const actor = await resolveActor(client, options.actorId);
    await assertCan(client, actor, options.quizId, "quiz.edit", "reorder");

    const ids = options.questionIds ?? [];
    if (ids.length === 0) {
      throw new Error("reorder_questions needs a non-empty questionIds array.");
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error("reorder_questions: questionIds contains duplicates — each id must appear exactly once.");
    }

    const { data: all, error: allError } = await client
      .from("questions")
      .select("id")
      .eq("quiz_id", options.quizId)
      .order("position");
    if (allError) {
      throw new Error(`Could not read questions of quiz "${options.quizId}": ${allError.message}`);
    }
    const existing = ((all ?? []) as unknown as Array<{ id: string }>).map((r) => r.id);

    if (ids.length !== existing.length) {
      throw new Error(
        `reorder_questions expects exactly ${existing.length} question ids (the quiz has ${existing.length} ` +
          `questions) but received ${ids.length} — provide a complete ordering.`,
      );
    }
    const missing = existing.filter((id) => !ids.includes(id));
    const unexpected = ids.filter((id) => !existing.includes(id));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `reorder_questions: the id set does not match the quiz's questions. ` +
          `${missing.length > 0 ? `Missing: ${missing.join(", ")}. ` : ""}` +
          `${unexpected.length > 0 ? `Not in quiz: ${unexpected.join(", ")}.` : ""}`,
      );
    }

    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      if (existing[i] === ids[i]) continue;
      changed = true;
      const { error: posError } = await client
        .from("questions")
        .update({ position: i })
        .eq("id", ids[i]!);
      if (posError) {
        throw new Error(`Could not set position ${i} on question "${ids[i]}": ${posError.message}`);
      }
    }

    const warnings = changed ? [] : ["The given order matches the current order — nothing changed."];
    return {
      ok: true,
      action: "reorder_questions",
      id: options.quizId,
      changed: { order: ids, changed },
      warnings,
      errors: [],
    };
  };

  return wrapIdempotent(client, "reorder_questions", options.idempotencyKey, {
    actor: options.actorId,
    quizId: options.quizId,
    questionIds: options.questionIds,
  }, run);
}

/* ------------------------------------------------------------------ */
/* Idempotency wrapper                                                  */
/* ------------------------------------------------------------------ */

export function wrapIdempotent<T extends LifecycleEnvelope>(
  client: SupabaseClient,
  operation: string,
  idempotencyKey: string | undefined,
  payload: unknown,
  run: () => Promise<T>,
): Promise<T> {
  if (!idempotencyKey || !idempotencyKey.trim()) {
    return run();
  }
  return withIdempotency(
    client,
    { key: idempotencyKey.trim(), operation, requestHash: requestHash(payload) },
    run,
  ).then(({ replay, result }) => ({ ...result, replayed: replay }) as T);
}
