#!/usr/bin/env bun
// Phase 9D.1 audit fixture: creates a SCRATCH quiz + questions + lobby session
// on the live project, prints the session code + ids, and can fully clean up.
//
//   bun fixture.mjs create
//   bun fixture.mjs cleanup
//
// Safety: only touches rows whose ids it created (stored in fixture.json).
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const HERE = import.meta.dir;
const FIXTURE_FILE = join(HERE, "fixture.json");

const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const URL = vars.SUPABASE_URL;
const admin = createClient(URL, vars.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
console.log("Backend project ref:", URL.replace(/^https:\/\//, "").split(".")[0]);
console.log(
  "Vite-client ref:    ",
  (vars.VITE_SUPABASE_URL || "").replace(/^https:\/\//, "").split(".")[0],
);
if (
  URL.replace(/^https:\/\//, "").split(".")[0] !==
  (vars.VITE_SUPABASE_URL || "").replace(/^https:\/\//, "").split(".")[0]
) {
  console.log("!! WARNING: deployment client points at a DIFFERENT project than the service URL");
}

const mode = process.argv[2] ?? "create";

if (mode === "cleanup") {
  if (!existsSync(FIXTURE_FILE)) {
    console.error("No fixture.json — nothing to clean.");
    process.exit(1);
  }
  const f = JSON.parse(readFileSync(FIXTURE_FILE, "utf8"));
  // remove the throwaway host auth user used by the profiler, if present
  const authFile = join(HERE, "auth-user.json");
  if (existsSync(authFile)) {
    const au = JSON.parse(readFileSync(authFile, "utf8"));
    await admin.from("host_authorizations").delete().eq("profile_id", au.userId);
    await admin.from("user_roles").delete().eq("user_id", au.userId);
    await admin.auth.admin
      .deleteUser(au.userId)
      .catch((e) => console.warn(`auth user delete: ${e.message}`));
    console.log(`Deleted throwaway auth user ${au.userId} (+ grant + role)`);
  }
  // answers of any participants in this session (bots are cleaned by the runner)
  await admin.from("answers").delete().eq("session_id", f.sessionId);
  const { data: parts } = await admin
    .from("participants")
    .select("id")
    .eq("session_id", f.sessionId);
  const pids = (parts ?? []).map((p) => p.id);
  if (pids.length) {
    await admin.from("participant_secrets").delete().in("participant_id", pids);
    await admin.from("participants").delete().in("id", pids);
  }
  await admin.from("teams").delete().eq("session_id", f.sessionId);
  await admin.from("sessions").delete().eq("id", f.sessionId);
  await admin.from("questions").delete().eq("quiz_id", f.quizId);
  await admin.from("quizzes").delete().eq("id", f.quizId);
  console.log(
    `Cleaned: session ${f.sessionId}, quiz ${f.quizId}, ${pids.length} leftover participants.`,
  );
  process.exit(0);
}

// ---- create -----------------------------------------------------------------
// 1. Pick a host user who will pass the enforce_host_authorization trigger.
const { data: roles } = await admin
  .from("user_roles")
  .select("user_id,role")
  .in("role", ["admin", "host"])
  .limit(5);
if (!roles?.length) {
  console.error("No admin/host user found to own the scratch session.");
  process.exit(1);
}
const hostUser = roles[0].user_id;
console.log(`Using host user ${hostUser} (role ${roles[0].role})`);

// principal for quiz ownership (user-kind principal id == user_id, but look it up)
const { data: principal } = await admin
  .from("principals")
  .select("id")
  .eq("user_id", hostUser)
  .maybeSingle();
const ownerPrincipalId = principal?.id ?? hostUser;

// 2. Scratch quiz
const { data: quiz, error: qErr } = await admin
  .from("quizzes")
  .insert({
    owner_principal_id: ownerPrincipalId,
    title: "ZZZ SCALE AUDIT — DELETE ME (phase 9D.1)",
    description: "Scratch fixture for the live-engine scalability audit. Safe to delete.",
    time_per_question: 20,
  })
  .select("id,title,time_per_question")
  .single();
if (qErr) {
  console.error("quiz insert failed:", qErr.message);
  process.exit(1);
}
console.log(`Quiz ${quiz.id}`);

// 3. MCQ questions. 12 by default, so a 10+ question soak at 50+ players has a
// distinct question per round: submit_answer de-duplicates per participant +
// question, so a repeated question id is rejected rather than re-answered.
const QUESTION_COUNT = Number(process.env.QUESTION_COUNT ?? 12);
const questionRows = Array.from({ length: QUESTION_COUNT }, (_, i) => ({
  quiz_id: quiz.id,
  position: i,
  text: `Scale-audit question ${i + 1}: pick option A`,
  options: ["Alpha", "Bravo", "Charlie", "Delta"],
  correct_index: 0,
  question_type: "mcq",
  time_limit_sec: 20,
  point_value: 1000,
  is_playable: true,
}));
const { data: questions, error: qqErr } = await admin
  .from("questions")
  .insert(questionRows)
  .select("id,position");
if (qqErr) {
  console.error("questions insert failed:", qqErr.message);
  process.exit(1);
}
const order = questions.sort((a, b) => a.position - b.position).map((q) => q.id);
console.log(`Questions ${questions.length}`);

// 4. Lobby session with a free code
let code = null;
for (let attempt = 0; attempt < 20 && !code; attempt++) {
  const candidate = String(Math.floor(100000 + Math.random() * 900000));
  const { data: clash } = await admin
    .from("sessions")
    .select("id")
    .eq("code", candidate)
    .maybeSingle();
  if (!clash) code = candidate;
}
if (!code) {
  console.error("could not allocate a free code");
  process.exit(1);
}

const { data: sess, error: sErr } = await admin
  .from("sessions")
  .insert({
    quiz_id: quiz.id,
    host_id: hostUser,
    code,
    status: "lobby",
    team_mode: false,
    question_order: order,
    current_question_index: -1,
    current_question_revealed: false,
  })
  .select("id,code,status")
  .single();
if (sErr) {
  console.error("session insert failed:", sErr.message);
  process.exit(1);
}

writeFileSync(
  FIXTURE_FILE,
  JSON.stringify(
    { sessionId: sess.id, code: sess.code, quizId: quiz.id, questionIds: order, hostUser },
    null,
    2,
  ),
);
console.log(`Session ${sess.id} code ${sess.code} (lobby)`);
console.log(`Fixture written to ${FIXTURE_FILE}`);
