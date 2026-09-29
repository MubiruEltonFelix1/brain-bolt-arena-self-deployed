#!/usr/bin/env bun
// scripts/scale-audit/tick-expiry-test.mjs — Phase 9D.2 §29: question expiry must
// be finalized by the SERVER TICK with no host/browser action at all.
//
//   bun scripts/scale-audit/tick-expiry-test.mjs [--players 50]
//
// Flow: join N bots → start question 0 (service role) → DO NOTHING → poll until
// the database itself flips `current_question_revealed` and advances the index.
// Reports how long after the computed deadline/threshold each server transition
// landed (bounded by the one-tick-per-minute cadence).
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const PLAYERS = Number(arg("players", "50"));
const HERE = import.meta.dir;
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixture.json"), "utf8"));
const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const api = createClient(vars.SUPABASE_URL, vars.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const admin = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTRO_MS = 5000, HOLD_MS = 8000;

// reset + join bots
await admin.from("sessions").update({ status: "lobby", current_question_index: -1, current_question_revealed: false, current_question_started_at: null, paused_at: null, time_added_ms: 0 }).eq("id", FIXTURE.sessionId);
{
  const { data: stale } = await admin.from("participants").select("id").eq("session_id", FIXTURE.sessionId);
  const ids = (stale ?? []).map((p) => p.id);
  if (ids.length) {
    await admin.from("answers").delete().eq("session_id", FIXTURE.sessionId);
    await admin.from("participant_secrets").delete().in("participant_id", ids);
    await admin.from("participants").delete().in("id", ids);
  }
}
const nick = () => `T${Date.now().toString(36).slice(-4)}-${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
const bots = [];
let i = 0;
await Promise.all(Array.from({ length: Math.min(25, PLAYERS) }, async () => {
  while (i < PLAYERS) {
    const n = nick(); i++;
    const { data, error } = await api.rpc("join_session", { p_code: FIXTURE.code, p_nickname: n });
    const row = Array.isArray(data) ? data[0] : data;
    if (!error && row?.participant_id) bots.push({ id: row.participant_id });
  }
}));
console.log(`[setup] ${bots.length} bots joined; starting question 0 with NO host action afterwards.`);

const { data: q } = await admin.from("questions").select("time_limit_sec").eq("id", FIXTURE.questionIds[0]).maybeSingle();
const limitMs = (q?.time_limit_sec ?? 20) * 1000;
const t0 = Date.now();
await admin.from("sessions").update({
  status: "active", current_question_index: 0, current_question_started_at: new Date(t0).toISOString(),
  current_question_revealed: false, paused_at: null, time_added_ms: 0,
}).eq("id", FIXTURE.sessionId);
const deadlineMs = t0 + INTRO_MS + limitMs;
const thresholdMs = deadlineMs + HOLD_MS;
console.log(`[setup] deadline +${(deadlineMs - t0) / 1000}s, advance threshold +${(thresholdMs - t0) / 1000}s from now.`);

let revealedAt = null;
let advancedAt = null;
const budgetMs = 3 * 60_000;
while (Date.now() - t0 < budgetMs) {
  // 500 ms polls: a same-tick reveal+advance (the common dead-host case) keeps
  // `revealed = true` only inside one tick transaction, so sample fast enough
  // to observe it when possible; the advance signal is the durable one.
  await sleep(500);
  const { data: s } = await admin.from("sessions").select("current_question_revealed,current_question_index,status").eq("id", FIXTURE.sessionId).maybeSingle();
  if (!s) break;
  if (revealedAt === null && s.current_question_revealed) revealedAt = Date.now();
  if (advancedAt === null && (s.current_question_index > 0 || s.status === "ended")) advancedAt = Date.now();
  if (revealedAt !== null && advancedAt !== null) break;
}

const fmt = (v) => (v === null ? "not sampled (transient)" : `${((v - t0) / 1000).toFixed(1)}s after start`);
const revealDelta = revealedAt === null ? null : revealedAt - deadlineMs;
const advanceDelta = advancedAt === null ? null : advancedAt - thresholdMs;
console.log(`[result] server reveal: ${fmt(revealedAt)}${revealDelta !== null ? ` (deadline +${(revealDelta / 1000).toFixed(1)}s)` : ""}`);
console.log(`[result] server advance: ${fmt(advancedAt)}${advanceDelta !== null ? ` (threshold +${(advanceDelta / 1000).toFixed(1)}s)` : ""}`);
// PASS: the server finalized the expired question with no host action. The
// reveal may be transient (revealed+advanced inside one tick) — the durable
// advance signal plus the <65 s bound proves the authority is server-side.
const pass =
  advancedAt !== null &&
  advanceDelta <= 65_000 &&
  (revealedAt === null || revealDelta <= 65_000);
console.log(pass
  ? `PASS — the server finalized the expired question with no host action${revealedAt === null ? " (reveal+advance completed inside a single tick transaction)" : ""}.`
  : `FAIL — the server did not finalize within the cadence budget.`);

// cleanup bots
const ids = bots.map((b) => b.id);
if (ids.length) {
  await admin.from("answers").delete().eq("session_id", FIXTURE.sessionId).in("participant_id", ids);
  await admin.from("participant_secrets").delete().in("participant_id", ids);
  await admin.from("participants").delete().in("id", ids);
  console.log(`[cleanup] removed ${ids.length} bots`);
}
process.exit(pass ? 0 : 1);
