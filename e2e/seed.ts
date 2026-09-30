import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The Playwright runner is a bare node/bun process and does not get Vite's
// automatic .env loading, so the fixture reads it explicitly. `.env` stays
// untracked; nothing here prints the values.
config({ path: process.env.E2E_ENV_FILE ?? ".env", quiet: true });

/**
 * Fixtures for the guest result-claim journey.
 *
 * WHY THIS USES THE SERVICE ROLE
 * `competition_results` has a single SELECT policy (`auth.uid() = profile_id`)
 * and `result_claims` has no policies at all, so neither table can be written
 * by an anon client. Seeding has to go through the service role, the same
 * pattern `scripts/migration-markers.mjs` uses.
 *
 * WHY IT INSERTS RAW ROWS RATHER THAN CALLING `join_session`
 * The journey under test starts from a FINISHED game. Producing one through
 * the live host flow would mean driving the entire session engine - reveal,
 * advance, end - for a fixture that only needs to exist in a terminal state.
 * Raw inserts are explicit about what the test depends on: a session with
 * `status = 'ended'`, a guest seat with `profile_id IS NULL`, and answers that
 * make accuracy and streak computable. That last part is the point of a test
 * fixture: the result screen must derive its stats from stored answers, so the
 * fixture has to store real ones.
 *
 * EVERY ROW IS CLEANED UP. `cleanup()` removes the session, which cascades to
 * participants, participant_secrets and answers, then the questions and the
 * quiz, then the test user.
 */

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const SEED_TAG = "e2e";
/**
 * Marker on every account this suite creates. `.invalid` is reserved by
 * RFC 2606, so a test account can never collide with a real one, and the
 * combination is what makes a leaked fixture identifiable in any admin UI.
 */
export const SEED_EMAIL_PREFIX = "e2e+";

function admin(): SupabaseClient {
  if (!URL || !SERVICE_KEY) {
    throw new Error(
      "E2E needs VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. These are server credentials - never expose them to the browser or commit them.",
    );
  }
  // auth.persistSession off: this is a script, not a signed-in client.
  return createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export type Seed = {
  sessionId: string;
  quizId: string;
  /** The guest seat the browser will hold. Has NO profile_id. */
  meParticipantId: string;
  meSecret: string;
  nickname: string;
  email: string;
  password: string;
  userId: string;
  cleanup: () => Promise<void>;
};

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Auth users are registered the moment they are created, so a seed that throws
 * halfway through still leaves nothing behind. A leaked `e2e+...@example.invalid`
 * account is the single hardest artefact to notice later, and it would also
 * still hold a `host` role grant.
 */
const createdUsers: string[] = [];

export async function cleanupLeakedTestUsers(): Promise<void> {
  if (!URL || !SERVICE_KEY) return;
  const db = admin();

  // First, anything this process created.
  for (const id of createdUsers.splice(0)) {
    await db.from("user_roles").delete().eq("user_id", id);
    await db.auth.admin.deleteUser(id);
  }

  // Then, by prefix, anything an EARLIER run left behind - a run that was
  // killed mid-seed never reaches its own teardown, and a process-local list
  // cannot reach across processes. The `e2e+` prefix and the `.invalid` TLD are
  // the marker; the TLD is reserved by RFC 2606 and can never be a real user.
  // Bounded so this cannot page through a large project indefinitely.
  const PAGES = 5;
  for (let page = 1; page <= PAGES; page += 1) {
    let users: { id: string }[];
    try {
      const res = await db.auth.admin.listUsers({ page, perPage: 200 });
      users = res.data?.users ?? [];
    } catch {
      return; // Admin API unavailable; the tagged rows remain identifiable.
    }
    if (users.length === 0) return;
    for (const u of users) {
      const email = (u as { email?: string }).email ?? "";
      if (!email.startsWith(SEED_EMAIL_PREFIX) || !email.endsWith("@example.invalid")) continue;
      await db.from("user_roles").delete().eq("user_id", u.id);
      await db.auth.admin.deleteUser(u.id);
    }
    if (users.length < 200) return;
  }
}

/**
 * A confirmed test account, so the sign-in step does not need an inbox.
 *
 * Retried because the Supabase admin API sits behind a public edge and
 * transiently answers `fetch failed` under load. A flaky fixture turns into a
 * spurious product failure, which is worse than a slow one.
 */
export async function createTestUser(db: SupabaseClient): Promise<{ id: string; email: string; password: string }> {
  const email = `${SEED_EMAIL_PREFIX}${uniq()}@example.invalid`;
  const password = `E2e-${uniq()}-Aa1!`;
  let last = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { data, error } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: "E2E Player" },
      });
      if (!error && data?.user) {
        createdUsers.push(data.user.id);
        return { id: data.user.id, email, password };
      }
      last = error?.message ?? "no user returned";
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw new Error(`could not create the test user after 3 attempts: ${last}`);
}

/**
 * A finished hosted game: three guests, a completed answer log for the one the
 * browser will hold, and a session already in `ended`.
 */
export async function seedFinishedGame(): Promise<Seed> {
  const db = admin();
  const user = await createTestUser(db);
  const tag = `${SEED_TAG} ${uniq()}`;

  const quizId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const meParticipantId = crypto.randomUUID();
  const meSecret = `e2e-secret-${uniq()}`;

  /**
   * Teardown, defined before anything is created so that a seed which throws
   * halfway can still call it. This is not theoretical: every schema mistake
   * discovered while building this fixture (a missing host grant, a column that
   * does not exist, an id without a default) left real rows behind in the live
   * database, including a stray `host` role grant on a throwaway account.
   *
   * Deliberately ignores its own errors. A cleanup failure must not mask the
   * original seeding error, and the rows are tagged `e2e` so anything missed is
   * identifiable rather than invisible.
   */
  const cleanup = async () => {
    await db.from("answers").delete().eq("session_id", sessionId);
    await db.from("participant_secrets").delete().eq("participant_id", meParticipantId);
    await db.from("participants").delete().eq("session_id", sessionId);
    await db.from("sessions").delete().eq("id", sessionId);
    await db.from("competition_results").delete().eq("session_id", sessionId);
    await db.from("result_claims").delete().eq("participant_id", meParticipantId);
    await db.from("questions").delete().eq("quiz_id", quizId);
    await db.from("quizzes").delete().eq("id", quizId);
    // Cascades with the user, but named explicitly so a failed user delete
    // cannot silently leave a `host` grant behind.
    await db.from("user_roles").delete().eq("user_id", user.id);
    await db.auth.admin.deleteUser(user.id);
  };

  try {
    const { error: quizErr } = await db.from("quizzes").insert({
      id: quizId,
      title: `${tag} quiz`,
      description: "End-to-end fixture. Safe to delete.",
      difficulty: "medium",
      is_arena: false,
      time_per_question: 20,
    });
    if (quizErr) throw new Error(`quiz insert failed: ${quizErr.message}`);

    // Two scored questions plus one feedback question. The feedback question is
    // the trap: it must NOT drag accuracy down, and the fixture exists to prove
    // the screen honours that.
    const q1 = crypto.randomUUID();
    const q2 = crypto.randomUUID();
    const fb = crypto.randomUUID();
    const { error: qErr } = await db.from("questions").insert([
      { id: q1, quiz_id: quizId, text: "E2E question one", options: ["A", "B", "C", "D"], correct_index: 0, position: 0, question_type: "mcq", is_playable: true, time_limit_sec: 20, point_value: 1000 },
      { id: q2, quiz_id: quizId, text: "E2E question two", options: ["A", "B", "C", "D"], correct_index: 1, position: 1, question_type: "mcq", is_playable: true, time_limit_sec: 20, point_value: 1000 },
      { id: fb, quiz_id: quizId, text: "E2E feedback slide", options: [], correct_index: 0, position: 2, question_type: "feedback", is_playable: true, time_limit_sec: 20, point_value: 0 },
    ]);
    if (qErr) throw new Error(`questions insert failed: ${qErr.message}`);

    const code = String(Math.floor(100000 + Math.random() * 900000));

    // A BEFORE INSERT trigger (`enforce_host_authorization`) gates session
    // creation, and triggers fire regardless of RLS - so the service role hits
    // it too. It accepts either a `user_roles` grant or an active
    // `host_authorizations` row; the role grant is the narrower, disposable
    // option because it is deleted wholesale with the test user.
    const { error: roleErr } = await db
      .from("user_roles")
      .insert({ user_id: user.id, role: "host", granted_by: user.id });
    if (roleErr) throw new Error(`host role grant failed: ${roleErr.message}`);

    const { error: sErr } = await db.from("sessions").insert({
      id: sessionId,
      quiz_id: quizId,
      host_id: user.id,
      code,
      status: "ended",
      current_question_index: 3,
      question_order: [q1, q2, fb],
      team_mode: false,
    });
    if (sErr) throw new Error(`session insert failed: ${sErr.message}`);

    const now = Date.now();

    // `participants` has no secret column. The proof-of-ownership token lives
    // only in `participant_secrets`, which is exactly what `create_session_claim`
    // checks, so writing it anywhere else would be theatre.
    const { error: pErr } = await db.from("participants").insert([
      // The browser's seat: still a guest, which is the entire precondition.
      { id: meParticipantId, session_id: sessionId, nickname: "E2E Guest", score: 1500, streak: 2, joined_at: new Date(now - 30000).toISOString() },
      { id: crypto.randomUUID(), session_id: sessionId, nickname: "Runner Up", score: 2200, streak: 1, joined_at: new Date(now - 20000).toISOString() },
      { id: crypto.randomUUID(), session_id: sessionId, nickname: "Third Place", score: 800, streak: 0, joined_at: new Date(now - 10000).toISOString() },
    ]);
    if (pErr) throw new Error(`participants insert failed: ${pErr.message}`);

    const { error: s2Err } = await db.from("participant_secrets").insert({ participant_id: meParticipantId, secret_token: meSecret });
    if (s2Err) throw new Error(`participant_secrets insert failed: ${s2Err.message}`);

    // The seat scores 1500, so the answer log must add up to that for the
    // displayed score to match the stored one.
    const { error: aErr } = await db.from("answers").insert([
      { session_id: sessionId, participant_id: meParticipantId, question_id: q1, selected_index: 0, is_correct: true, response_ms: 3000, points: 1000 },
      { session_id: sessionId, participant_id: meParticipantId, question_id: q2, selected_index: 0, is_correct: false, response_ms: 5000, points: 500 },
      { session_id: sessionId, participant_id: meParticipantId, question_id: fb, selected_index: -1, is_correct: false, response_ms: 2000, points: 0 },
    ]);
    if (aErr) throw new Error(`answers insert failed: ${aErr.message}`);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return {
    sessionId,
    quizId,
    meParticipantId,
    meSecret,
    nickname: "E2E Guest",
    email: user.email,
    password: user.password,
    userId: user.id,
    cleanup,
  };
}

export function adminClient(): SupabaseClient {
  return admin();
}
