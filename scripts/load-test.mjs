#!/usr/bin/env bun
// scripts/load-test.mjs — concurrent-player capacity test against the LIVE
// Supabase project, using the exact same RPCs and realtime channels the app
// uses (join_session → broadcast game:answer_row → submit_answer).
//
// Usage:
//   bun scripts/load-test.mjs --code <GAME_CODE> [--players 100] [--burst 25] [--questions 5] [--dry-run]
//
// How it works:
//   1. JOIN    — N fake players join your session in waves (session must be
//                in the LOBBY). Reports join latency.
//   2. START   — the script waits (max 120s) for YOU to press START on the
//                host screen so question 1 goes live.
//   3. CHANNELS— each fake player opens its own realtime channel (one
//                websocket per player, like a real phone).
//   4. ANSWER  — all players submit an answer to the current question with
//                realistic response times. Reports RPC latency.
//   5. DELIVERY— the script measures how many participants-update events each
//                channel actually received, and how fast the reveal lands.
//   6. CLEANUP — every bot participant/answer/secret is deleted via the
//                service role. Your session and real players are untouched.
//
// Env (read from .env): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
// SUPABASE_SERVICE_ROLE_KEY. Never printed.
//
// IMPORTANT: run this against a SCRATCH quiz (not the quiz you'll launch
// with). The bots appear in the lobby/leaderboard while the test runs.

import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { ROOT, loadEnv } from "./migration-markers.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const CODE = arg("code", "");
const PLAYERS = Number(arg("players", "100"));
const BURST = Number(arg("burst", "25"));
const QUESTIONS = Number(arg("questions", "1"));
const DRY_RUN = process.argv.includes("--dry-run");

if (!CODE || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: bun scripts/load-test.mjs --code <GAME_CODE> [--players 100] [--burst 25] [--questions 5] [--dry-run]\n" +
      "  Spawns N fake players against a live session (lobby state) and measures\n" +
      "  join latency, answer latency, and realtime event delivery across multiple\n" +
      "  questions. Requires the session to be in the LOBBY; you press START when the\n" +
      "  script says so.\n" +
      "  --questions N  answer N questions in sequence (default 1)\n" +
      "  --dry-run  validate the session + env without spawning anything.\n",
  );
  process.exit(0);
}
if (!Number.isFinite(PLAYERS) || PLAYERS < 1 || !Number.isFinite(BURST) || BURST < 1 || !Number.isFinite(QUESTIONS) || QUESTIONS < 1) {
  console.error("--players and --burst must be positive numbers.");
  process.exit(2);
}

// --- env --------------------------------------------------------------------
const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const URL = vars.SUPABASE_URL || "";
const ANON = vars.SUPABASE_PUBLISHABLE_KEY || "";
const SERVICE = vars.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL || !ANON || !SERVICE) {
  console.error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(2);
}
const api = createClient(URL, ANON, { auth: { persistSession: false } });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
const fmt = (ms) => `${ms.toFixed(0)}ms`;

// --- helpers ----------------------------------------------------------------
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runBurst(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(times) {
  if (!times.length) return { ok: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  return {
    ok: times.length,
    avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

// --- phase 0: validate the session -------------------------------------------
console.log(`\n=== BrainBolt load test — ${PLAYERS} players, burst ${BURST}, code ${CODE} ===\n`);
let sess = null; // module-level so the SIGINT handler can guard on it
const players = [];
const { data: sessRow, error: sessErr } = await api
  .from("sessions")
  .select("id,status,current_question_index,current_question_revealed,question_order,quiz:quizzes(title,time_per_question)")
  .eq("code", CODE)
  .maybeSingle();

if (sessErr || !sessRow) {
  console.error(`Session "${CODE}" not found. Start a scratch session and keep it in the LOBBY.`);
  process.exit(2);
}
sess = sessRow;
console.log(`Session: ${sess.quiz?.title ?? "?"} (${sess.id}) — status: ${sess.status}`);
if (sess.status !== "lobby") {
  console.error("Session must be in the LOBBY. Reset it (or start a new scratch session) and re-run.");
  process.exit(2);
}
if (DRY_RUN) {
  console.log("Dry run OK: session reachable, env present. Nothing spawned.");
  process.exit(0);
}

// --- phase 1: joins ----------------------------------------------------------
console.log(`\n[1/5] Joining ${PLAYERS} players in bursts of ${BURST}...`);
const nicknames = Array.from({ length: PLAYERS }, (_, i) => `Bot-${String(i + 1).padStart(3, "0")}`);
const joinTimes = [];
const joinWallStart = performance.now();
const joinResults = await runBurst(nicknames, BURST, async (nick) => {
  const t0 = performance.now();
  const { data, error } = await withTimeout(
    api.rpc("join_session", { p_code: CODE, p_nickname: nick }),
    15000,
    "join_session",
  );
  joinTimes.push(performance.now() - t0);
  if (error) throw new Error(`${nick}: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.participant_id || !row?.secret_token) throw new Error(`${nick}: bad join response`);
  return { nickname: nick, id: row.participant_id, token: row.secret_token };
});
for (const r of joinResults) {
  if (r.error) console.error(`  ✗ join failed: ${r.error}`);
  else players.push(r);
}
const joinSum = summarize(joinTimes);
console.log(`Joined ${players.length}/${PLAYERS} (burst wall time ${fmt(performance.now() - joinWallStart)}).`);
console.log(`  join RPC latency — avg ${fmt(joinSum.avg)} · p50 ${fmt(joinSum.p50)} · p95 ${fmt(joinSum.p95)} · max ${fmt(joinSum.max)}`);
if (players.length < PLAYERS) {
  console.warn(`  ⚠ ${PLAYERS - players.length} joins failed — continuing with ${players.length}.`);
}

// --- phase 2: wait for host to press start -----------------------------------
console.log(`\n[2/5] ▶ Press START on the host screen now (question 1 goes live).`);
console.log("       Waiting for session status → active (max 120s)...");
const deadline = Date.now() + 120_000;
let currentQ = null;
while (Date.now() < deadline) {
  const { data: s } = await api
    .from("sessions")
    .select("status,current_question_index,current_question_revealed,question_order")
    .eq("id", sess.id)
    .maybeSingle();
  if (s?.status === "active" && s.current_question_index >= 0) {
    const { data: qs } = await api.rpc("get_session_questions", { p_session_id: sess.id });
    const rows = Array.isArray(qs) ? qs : [];
    const order = Array.isArray(s.question_order) && s.question_order.length
      ? s.question_order
      : rows.slice().sort((a, b) => a.q_position - b.q_position).map((r) => r.q_id);
    const qid = order[s.current_question_index];
    const q = rows.find((r) => r.q_id === qid);
    if (q) {
      currentQ = {
        id: qid,
        type: q.q_question_type ?? "mcq",
        options: Array.isArray(q.q_options) ? q.q_options : [],
        min: q.q_number_min,
        max: q.q_number_max,
        timeLimit: q.q_time_limit_sec ?? sess.quiz?.time_per_question ?? 20,
      };
      if (s.current_question_revealed) {
        console.error("Question 1 is already revealed — advance to the next question (or reset the session) and re-run.");
        await cleanup(players, sess.id);
        process.exit(2);
      }
      break;
    }
  }
  await sleep(2000);
}
if (!currentQ) {
  console.error("Timed out waiting for the host to start. Cleanup will still run.");
  await cleanup(players, sess.id);
  process.exit(1);
}
console.log(`Question live: type=${currentQ.type} · ${currentQ.options.length} options · ${currentQ.timeLimit}s limit`);

// --- phase 3: realtime channels (one websocket per fake player) ---------------
console.log(`\n[3/5] Opening ${players.length} realtime channels (one socket per player)...`);
const channels = await runBurst(players, BURST, async (p) => {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  let count = 0;
  let revealAt = null;
  const t0 = performance.now();
  const ch = client
    // Phase 9D.2 P0-A: one `game:answer_row` broadcast per accepted answer
    // (authoritative, unconditional) on the private session topic — replaces the
    // participants WAL row this harness used to count.
    .channel(`session:${sess.id}`, { config: { private: true } })
    .on(
      "broadcast",
      { event: "game:answer_row" },
      () => { count += 1; },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sess.id}` },
      (payload) => { if (payload?.new?.current_question_revealed) revealAt = performance.now(); },
    );
  await withTimeout(
    new Promise((res, rej) => ch.subscribe((s) => (s === "SUBSCRIBED" ? res() : s === "CHANNEL_ERROR" || s === "TIMED_OUT" ? rej(new Error(s)) : undefined))),
    15000,
    "subscribe",
  );
  return { client, channel: ch, connectedMs: performance.now() - t0, count: () => count, revealAt: () => revealAt };
});
const liveChannels = channels.filter((c) => !c?.error);
if (!liveChannels.length) {
  console.error("No realtime channels subscribed. Aborting + cleanup.");
  await cleanup(players, sess.id);
  process.exit(1);
}
console.log(`  ${liveChannels.length}/${players.length} channels subscribed (avg ${fmt(channels.reduce((a, c) => a + (c?.connectedMs ?? 0), 0) / channels.length)} to connect)`);

// --- phases 4 & 5: answer QUESTIONS questions in sequence ----------------
function answerPayload(p, i) {
  const resp = 1500 + Math.round(Math.random() * 6500);
  const q = currentQ;
  switch (q.type) {
    case "number":
      return { p_participant_id: p.id, p_secret_token: p.token, p_question_id: q.id, p_value: (q.min ?? 0) + Math.random() * ((q.max ?? 100) - (q.min ?? 0)), p_response_ms: resp };
    case "map_pin":
      return { p_participant_id: p.id, p_secret_token: p.token, p_question_id: q.id, p_lat: (Math.random() - 0.5) * 100, p_lng: (Math.random() - 0.5) * 340, p_response_ms: resp };
    case "type":
    case "feedback":
      return { p_participant_id: p.id, p_secret_token: p.token, p_question_id: q.id, p_text: `load test ${i}`, p_response_ms: resp };
    case "ordering":
      return { p_participant_id: p.id, p_secret_token: p.token, p_question_id: q.id, p_order: shuffle(q.options.map((_, i2) => i2)), p_response_ms: resp };
    default: // mcq, true_false, audio, image_reveal
      return { p_participant_id: p.id, p_secret_token: p.token, p_question_id: q.id, p_selected_index: Math.floor(Math.random() * Math.max(1, q.options.length)), p_response_ms: resp };
  }
}
function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function answerRpcSuffix(type) {
  switch (type) {
    case "number": return "number_answer";
    case "map_pin": return "geo_answer";
    case "type":
    case "feedback": return "text_answer";
    case "ordering": return "ordering_answer";
    default: return "answer";
  }
}

const channelLastCount = liveChannels.map(() => 0);
const allAnswerTimes = [];
let allAnswerErrors = 0;
const allEventDeltas = [];
const allRevealLatencies = [];
let firstRevealTs = null;

let qIndex = sess.current_question_index;

for (let round = 1; round <= QUESTIONS; round++) {
  if (round > 1) {
    // Wait for the host to advance to the next question.
    process.stdout.write(`  Round ${round}/${QUESTIONS}: waiting for host to advance...`);
    const advanceDeadline = Date.now() + 120_000;
    let advanced = false;
    while (Date.now() < advanceDeadline && !advanced) {
      const { data: s } = await api
        .from("sessions")
        .select("status,current_question_index")
        .eq("id", sess.id)
        .maybeSingle();
      if (s?.current_question_index != null && s.current_question_index > qIndex) {
        qIndex = s.current_question_index;
        advanced = true;
      } else if (s?.status !== "active") {
        console.log(` session status is ${s?.status} — stopping at round ${round - 1}.`);
        break;
      }
      await sleep(2000);
    }
    if (!advanced) {
      console.log(` timed out waiting for advance — stopping at round ${round - 1}.`);
      break;
    }
    console.log(" advanced.");
    const { data: qs } = await api.rpc("get_session_questions", { p_session_id: sess.id });
    const rows = Array.isArray(qs) ? qs : [];
    const order = Array.isArray(sess.question_order) && sess.question_order.length
      ? sess.question_order
      : rows.slice().sort((a, b) => a.q_position - b.q_position).map((r) => r.q_id);
    const qid = order[qIndex];
    const qrow = rows.find((r) => r.q_id === qid);
    if (!qrow) {
      console.error(`  Could not find question at index ${qIndex}. Stopping.`);
      break;
    }
    currentQ = {
      id: qid,
      type: qrow.q_question_type ?? "mcq",
      options: Array.isArray(qrow.q_options) ? qrow.q_options : [],
      min: qrow.q_number_min,
      max: qrow.q_number_max,
      timeLimit: qrow.q_time_limit_sec ?? sess.quiz?.time_per_question ?? 20,
    };
    console.log(`  Question ${round} live: type=${currentQ.type} · ${currentQ.options.length} options · ${currentQ.timeLimit}s limit`);
  }

  // Phase 4: submit answers for the current question.
  console.log(`\n  Round ${round}/${QUESTIONS}: submitting answers (burst ${BURST}, response time 1.5–8s)...`);
  const answerTimes = [];
  let answerErrors = 0;
  await runBurst(players, BURST, async (p, i) => {
    const t0 = performance.now();
    const { error } = await withTimeout(api.rpc(`submit_${answerRpcSuffix(currentQ.type)}`, answerPayload(p, i)), 15000, "submit");
    answerTimes.push(performance.now() - t0);
    if (error) answerErrors += 1;
  });
  allAnswerTimes.push(...answerTimes);
  allAnswerErrors += answerErrors;
  const ansSum = summarize(answerTimes);
  console.log(`  Answers: ${answerTimes.length - answerErrors}/${answerTimes.length} OK · p95 ${fmt(ansSum.p95)} · ${answerErrors} errors`);

  // Phase 5: wait for reveal.
  console.log(`  Waiting for reveal (max ${currentQ.timeLimit + 15}s)...`);
  const revealDeadline = Date.now() + (currentQ.timeLimit + 15) * 1000;
  let revealed = false;
  while (Date.now() < revealDeadline && !revealed) {
    const { data: s } = await api.from("sessions").select("current_question_revealed").eq("id", sess.id).maybeSingle();
    revealed = !!s?.current_question_revealed;
    if (!revealed) await sleep(500);
  }
  await sleep(3000); // let straggler events land

  // Event deltas since last round (count() is cumulative per channel).
  const roundEventDeltas = liveChannels.map((c, idx) => {
    const now = c.count();
    const prev = channelLastCount[idx] ?? 0;
    channelLastCount[idx] = now;
    return now - prev;
  });
  allEventDeltas.push(...roundEventDeltas);
  const roundDelivered = roundEventDeltas.reduce((a, b) => a + b, 0);
  const roundExpected = liveChannels.length * answerTimes.length;

  const revealAt = performance.now();
  if (firstRevealTs === null) firstRevealTs = revealAt;
  allRevealLatencies.push(revealAt - firstRevealTs);

  console.log(`  Reveal: ${revealed ? "YES" : "NO — timeout"} · ${roundDelivered}/${roundExpected} events`);
}

// --- aggregate verdict ----------------------------------------------------
console.log("\n=== VERDICT ===");
const ansSumAll = summarize(allAnswerTimes);
const perChannelAll = summarize(allEventDeltas);
const expectedAll = QUESTIONS * liveChannels.length;
const revealSumAll = summarize(allRevealLatencies);
const roundsCompleted = Math.floor(allAnswerTimes.length / Math.max(players.length, 1));
const verdicts = [
  ["Joins", joinSum.ok === PLAYERS, `p95 ${fmt(joinSum.p95)} — all ${PLAYERS} joined`],
  ["Answers", allAnswerErrors === 0, `p95 ${fmt(ansSumAll.p95)} — ${allAnswerTimes.length - allAnswerErrors}/${allAnswerTimes.length} accepted`],
  ["Realtime delivery", perChannelAll.avg >= expectedAll * 0.9, `avg ${perChannelAll.avg.toFixed(0)}/${expectedAll} events per channel`],
  ["Rounds completed", roundsCompleted === QUESTIONS, `${roundsCompleted}/${QUESTIONS} rounds`],
  ["Reveal propagation", revealSumAll.length > 0 && revealSumAll.max < 3000, revealSumAll.length ? `max ${fmt(revealSumAll.max)}` : "no reveal observed"],
];
for (const [name, pass, detail] of verdicts) {
  console.log(`  ${pass ? "PASS" : "WARN"}  ${name.padEnd(20)} ${detail}`);
}
const allPass = verdicts.every(([, p]) => p);
console.log(allPass
  ? `\nFree tier handled ${QUESTIONS} questions x ${PLAYERS} players. Ready for launch.`
  : `\nSome checks missed — see the numbers above.`);

// --- cleanup -----------------------------------------------------------------
await cleanup(players, sess.id);
process.exit(allPass ? 0 : 1);

async function cleanup(playersToRemove, sessionId) {
  const ids = playersToRemove.map((p) => p.id);
  if (!ids.length) return;
  console.log("\nCleaning up bots (answers, secrets, participants)...");
  try {
    await admin.from("answers").delete().eq("session_id", sessionId).in("participant_id", ids);
    await admin.from("participant_secrets").delete().in("participant_id", ids);
    const { error } = await admin.from("participants").delete().in("id", ids);
    if (error) console.warn(`  ⚠ participants cleanup: ${error.message}`);
    else console.log(`  Removed ${ids.length} bot participants. Real players untouched.`);
  } catch (e) {
    console.warn(`  ⚠ cleanup failed: ${e instanceof Error ? e.message : e} — remove bots manually in the dashboard.`);
  }
}

process.on("SIGINT", async () => {
  console.log("\nInterrupted — cleaning up before exit...");
  if (sess && players.length) await cleanup(players, sess.id);
  else console.log("  (no bots joined yet — nothing to clean)");
  process.exit(130);
});
