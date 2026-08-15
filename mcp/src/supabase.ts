// save_quiz: write a generated quiz into Supabase using the service role key.
// Service role bypasses RLS; the quizzes BEFORE INSERT trigger
// (supabase/migrations/20260815135413...sql:31-38) derives owner_principal_id
// from owner_id automatically — we only need to supply a real auth user id.
//
// Trust boundary: service-role writes are a development/trusted-server feature.
// This server is stdio-local and its .env (containing the service role key) is
// git-ignored. Do not expose this tool over a network transport without adding
// authentication and an owner allowlist first.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { questionToDbRow, quizToDbRow, type BrainBoltQuiz } from "./schema";
import { formatIssues, validateQuiz } from "./validate";

export type SupabaseTarget = { url: string; serviceRoleKey: string };

export type SaveQuizOptions = {
  ownerId?: string;
  title?: string;
  description?: string;
  timePerQuestionSec?: number;
};

export type SaveQuizResult = {
  quizId: string;
  questionCount: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Builds a quiz row from options, allowing override of the generated title. */
function resolveQuizTitle(quiz: BrainBoltQuiz, title?: string): string {
  return (title ?? quiz.title).trim();
}

/**
 * Owner resolution pre-check (#9): the quizzes trigger derives
 * owner_principal_id from owner_id and raises when no user principal exists
 * (migration 20260814143826 seeds principals 1:1 with auth users; new signups
 * get one via handle_new_user). Checking first turns that DB error into a
 * precise, agent-actionable contract error.
 */
async function assertOwnerHasPrincipal(supabase: SupabaseClient, ownerId: string): Promise<void> {
  const { data, error } = await supabase
    .from("principals")
    .select("id")
    .eq("type", "user")
    .eq("user_id", ownerId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not verify owner principal: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `ownerId "${ownerId}" has no user principal in the database. ` +
        "Principals are created for users when they sign up (and were seeded for " +
        "existing users) — the owner must be the uuid of a real user in auth.users " +
        "who has logged in at least once.",
    );
  }
}

export async function saveQuiz(
  target: SupabaseTarget,
  quiz: BrainBoltQuiz,
  options: SaveQuizOptions,
): Promise<SaveQuizResult> {
  const ownerId = (options.ownerId ?? "").trim();
  if (!ownerId) {
    throw new Error(
      "save_quiz needs an owner. Pass ownerId (a uuid of an auth user) or set BRAINBOLT_DEFAULT_OWNER_ID in mcp/.env.",
    );
  }
  if (!isValidUuid(ownerId)) {
    throw new Error(
      `ownerId "${ownerId}" is not a valid uuid. Use the id of a user in auth.users.`,
    );
  }

  // Authoritative integrity gate: never persist a quiz that fails semantic
  // validation (media questions without real URLs, out-of-range answers, ...).
  const report = validateQuiz(quiz);
  if (!report.valid) {
    throw new Error(`quiz has validation errors — nothing was written:\n${formatIssues(report)}`);
  }

  const supabase = createClient(target.url, target.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await assertOwnerHasPrincipal(supabase, ownerId);

  const quizRow = quizToDbRow(
    {
      ...quiz,
      title: resolveQuizTitle(quiz, options.title),
      description: options.description ?? quiz.description,
      timePerQuestionSec: options.timePerQuestionSec ?? quiz.timePerQuestionSec,
    },
    ownerId,
  );

  const { data: quizData, error: quizError } = await supabase
    .from("quizzes")
    .insert(quizRow)
    .select("id")
    .single();

  if (quizError || !quizData) {
    throw new Error(
      `Could not insert quiz: ${quizError?.message ?? "no row returned"}` +
        (quizError?.message.includes("principal")
          ? " (the owner user may not have a principal yet)"
          : ""),
    );
  }

  const questionRows = quiz.questions.map((q, i) => ({
    quiz_id: quizData.id,
    ...questionToDbRow(q, i),
  }));

  const { error: questionsError } = await supabase.from("questions").insert(questionRows);

  if (questionsError) {
    // Roll the quiz back so a half-written quiz never lingers.
    try {
      await supabase.from("quizzes").delete().eq("id", quizData.id);
    } catch {
      // Rollback failure is best-effort; the error below is the real signal.
    }
    throw new Error(`Could not insert questions: ${questionsError.message}`);
  }

  return { quizId: quizData.id, questionCount: questionRows.length };
}
