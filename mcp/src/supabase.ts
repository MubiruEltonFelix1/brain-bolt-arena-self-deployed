// save_quiz: write a generated quiz into Supabase using the service role key.
// Service role bypasses RLS; ownership is written principal-first
// (owner_principal_id = the owner's principal id, id-identical to the auth
// user id). The Phase 7L-1 bidirectional trigger mirrors the legacy owner_id
// from it; after Phase 7L-2 the column is written directly. Requires the
// Phase 7L-1 migration to be applied — the pre-7L trigger derives the
// principal FROM owner_id and would raise on a principal-only insert.
//
// Authorization (Phase 8B): the owner is the acting principal. It must have a
// user principal AND pass the app's own capability resolver
// can(principal, 'quiz.create', NULL) — i.e. hold the host capability, the
// same gate the app enforces with its "quizzes host only write" RLS policy.
// No parallel MCP permission system.
//
// Idempotency: an optional idempotencyKey makes repeated calls with the same
// logical payload return the stored result instead of creating a duplicate
// quiz (see idempotency.ts + mcp_idempotency_keys migration).
//
// Trust boundary: service-role writes are a development/trusted-server
// feature. This server is stdio-local and its .env (containing the service
// role key) is git-ignored. Do not expose this tool over a network transport
// without adding authentication and an owner allowlist first.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { withIdempotency, requestHash } from "./idempotency";
import { isValidUuid, resolveActor } from "./lifecycle";
import { questionToDbRow, quizToDbRow, type BrainBoltQuiz } from "./schema";
import { formatIssues, validateQuiz } from "./validate";

export type SupabaseTarget = { url: string; serviceRoleKey: string };

/** The MCP's service-role client. Sessions are never persisted. */
export function createSupabaseClient(target: SupabaseTarget): SupabaseClient {
  return createClient(target.url, target.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type SaveQuizOptions = {
  ownerId?: string;
  title?: string;
  description?: string;
  timePerQuestionSec?: number;
  idempotencyKey?: string;
};

export type SaveQuizResult = {
  quizId: string;
  questionCount: number;
  /** true when the call was replayed from a previous run with the same key. */
  replayed?: boolean;
};

export { isValidUuid };

/** Builds a quiz row from options, allowing override of the generated title. */
function resolveQuizTitle(quiz: BrainBoltQuiz, title?: string): string {
  return (title ?? quiz.title).trim();
}

/**
 * save_quiz against a caller-provided client (the test seam). The ownerId /
 * uuid / semantic-validation gates run before any network use, so the unit
 * tests exercise them without credentials or a connection.
 */
export async function saveQuizWithClient(
  client: SupabaseClient,
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

  const run = async (): Promise<SaveQuizResult> => {
    // The owner is the acting principal; it must exist and hold the host
    // capability (can(principal, 'quiz.create')) — same gate as the app.
    const actor = await resolveActor(client, ownerId, "ownerId");
    const { data: allowed, error: canError } = await client.rpc("can", {
      p_principal: actor.principalId,
      p_action: "quiz.create",
      p_resource: null,
    });
    if (canError) {
      throw new Error(`Could not verify create capability: ${canError.message}`);
    }
    if (allowed !== true) {
      throw new Error(
        `ownerId "${ownerId}" cannot create quizzes — the acting principal needs the host ` +
          "capability (admin role, host role, or an active host authorization). " +
          "Nothing was written.",
      );
    }

    const quizRow = quizToDbRow(
      {
        ...quiz,
        title: resolveQuizTitle(quiz, options.title),
        description: options.description ?? quiz.description,
        timePerQuestionSec: options.timePerQuestionSec ?? quiz.timePerQuestionSec,
      },
      ownerId,
    );

    const { data: quizData, error: quizError } = await client
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

    const { error: questionsError } = await client.from("questions").insert(questionRows);

    if (questionsError) {
      // Roll the quiz back so a half-written quiz never lingers.
      try {
        await client.from("quizzes").delete().eq("id", quizData.id);
      } catch {
        // Rollback failure is best-effort; the error below is the real signal.
      }
      throw new Error(`Could not insert questions: ${questionsError.message}`);
    }

    return { quizId: quizData.id, questionCount: questionRows.length };
  };

  const idempotencyKey = options.idempotencyKey?.trim();
  if (!idempotencyKey) {
    return run();
  }

  const { replay, result } = await withIdempotency(
    client,
    {
      key: idempotencyKey,
      operation: "save_quiz",
      requestHash: requestHash({
        quiz,
        title: options.title,
        description: options.description,
        timePerQuestionSec: options.timePerQuestionSec,
        ownerId,
      }),
    },
    run,
  );
  return { ...result, replayed: replay };
}

export async function saveQuiz(
  target: SupabaseTarget,
  quiz: BrainBoltQuiz,
  options: SaveQuizOptions,
): Promise<SaveQuizResult> {
  return saveQuizWithClient(createSupabaseClient(target), quiz, options);
}
