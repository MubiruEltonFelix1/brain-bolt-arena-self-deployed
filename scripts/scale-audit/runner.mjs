#!/usr/bin/env bun
// Phase 9D.1 extended load runner — multi-question, N bots, per-phase metrics.
//   bun runner.mjs --players 50 [--questions 3] [--burst 25]
// Uses the fixture session from fixture.json. Cleans bots at the end.
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const PLAYERS = Number(arg("players", "10"));
const QUESTIONS = Number(arg("questions", "3"));
const BURST = Number(arg("burst", "25"));
const INTRO_MS = 5200; // faithful to INTRO_DURATION_MS = 5000 client window
const HERE = import.meta.dir;
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixture.json"), "utf8"));

const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const URL = vars.SUPABASE_URL;
const ANON = vars.SUPABASE_PUBLISHABLE_KEY;
const api = createClient(URL, ANON, { auth: { persistSession: false } });
const admin = createClient(URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n) / 1000; // ms float
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const sum = (a) => ({ n: a.length, avg: a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: a.length ? Math.max(...a) : 0 });
const f = (x) => `${x.toFixed(0)}ms`;

async function runBurst(items, limit, fn) {
  const results = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { results[k] = await fn(items[k], k); } catch (e) { results[k] = { error: String(e?.message ?? e) }; } }
  }));
  return results;
}

// ---- lock watcher: samples lock waits during the heavy phase ---------------
function startLockWatch(label) {
  const conn = vars.DATABASE_URL;
  const sql = `SELECT clock_timestamp()::time(0)::text || ' lockwait=' || (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock') || ' sessions_tuple_locks=' || (SELECT count(*) FROM pg_locks WHERE locktype='tuple' AND relation='public.sessions'::regclass) || ' activeq=' || (SELECT count(*) FROM pg_stat_activity WHERE state='active' AND query NOT LIKE '%pg_sleep%') FROM generate_series(1, 120) WHERE pg_sleep(0.25) IS NULL;`;
  const child = spawn("psql", [conn, "-X", "-A", "-t", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("error", () => {});
  return { stop: () => new Promise((res) => { child.on("close", () => res(out)); try { child.kill(); } catch {} setTimeout(() => res(out), 1500); }) };
}

// ---- validate session ------------------------------------------------------
const { data: sess } = await admin.from("sessions").select("id,code,status,question_order,quiz_id").eq("id", FIXTURE.sessionId).maybeSingle();
if (!sess) { console.error("fixture session missing"); process.exit(2); }
// reset to lobby for the run
await admin.from("sessions").update({ status: "lobby", current_question_index: -1, current_question_revealed: false, current_question_started_at: null, paused_at: null, time_added_ms: 0 }).eq("id", sess.id);
const order = FIXTURE.questionIds.slice(0, QUESTIONS);
console.log(`\n=== 9D.1 runner — players=${PLAYERS} questions=${QUESTIONS} burst=${BURST} code=${sess.code} ===\n`);

const runId = Date.now().toString(36).slice(-4);
// ---- phase 1: joins ---------------------------------------------------------
const nicks = Array.from({ length: PLAYERS }, (_, i) => `L${runId}-${String(i + 1).padStart(3, "0")}`);
const joinTimes = [];
const joinResults = await runBurst(nicks, BURST, async (nick) => {
  const t0 = now();
  const { data, error } = await api.rpc("join_session", { p_code: sess.code, p_nickname: nick });
  joinTimes.push(now() - t0);
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.participant_id) throw new Error("bad join response");
  return { nick, id: row.participant_id, token: row.secret_token };
});
const bots = joinResults.filter((r) => !r?.error);
const joinFail = joinResults.length - bots.length;
console.log(`[join] ${bots.length}/${PLAYERS} joined (${joinFail} failed) — ${JSON.stringify(sum(joinTimes), (k, v) => typeof v === "number" ? Math.round(v) : v)}`);

// ---- phase 2: channels ------------------------------------------------------
const chState = [];
const chTimes = [];
await runBurst(bots, BURST, async (bot) => {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const st = { bot, participantsEvents: 0, sessionEvents: [], qEvents: 0, qEventTimes: [], qSessionEvents: [], connectedMs: 0, log: [] };
  const t0 = now();
  const ch = client.channel(`session:${sess.id}`, { config: { private: true } })
    // Phase 9D.2 P0-A: one `game:answer_row` broadcast per accepted answer
    // (authoritative, unconditional) replaces the participants WAL row. Counted
    // with the same fields so delivery percentages stay comparable with 9D.1.
    .on("broadcast", { event: "game:answer_row" },
      (msg) => { const p = msg?.payload ?? msg; st.participantsEvents++; st.qEvents++; st.qEventTimes.push(now()); st.log.push([now(), p?.participant_id ?? null]); })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sess.id}` },
      (p) => { st.sessionEvents.push({ t: now(), idx: p?.new?.current_question_index, revealed: p?.new?.current_question_revealed }); st.qSessionEvents.push({ t: now(), idx: p?.new?.current_question_index, revealed: p?.new?.current_question_revealed }); });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("subscribe timeout")), 20000);
    ch.subscribe((s) => { if (s === "SUBSCRIBED") { clearTimeout(to); res(); } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") { clearTimeout(to); rej(new Error(s)); } });
  });
  st.connectedMs = now() - t0;
  chTimes.push(st.connectedMs);
  chState.push(st);
});
console.log(`[channels] ${chState.length}/${bots.length} subscribed — ${JSON.stringify(sum(chTimes), (k, v) => typeof v === "number" ? Math.round(v) : v)}`);
await sleep(700); // let the broadcast subscription pipeline arm before q0 fires

// ---- phase 3: per-question loop --------------------------------------------
const perQuestion = [];
const lockOut = [];
for (let q = 0; q < order.length; q++) {
  const qid = order[q];
  for (const st of chState) { st.qEvents = 0; st.qEventTimes = []; st.qSessionEvents = []; }
  // (a) host advance (same UPDATE shape as advance_question_internal)
  const tAdv = now();
  const { error: advErr } = await admin.from("sessions").update({
    status: "active", current_question_index: q, current_question_started_at: new Date().toISOString(),
    current_question_revealed: false, paused_at: null, time_added_ms: 0,
  }).eq("id", sess.id);
  const advRtt = now() - tAdv;
  if (advErr) console.error(`advance update failed: ${advErr.message}`);
  await sleep(INTRO_MS * 0.35); // allow event delivery window
  const advProp = chState.map((st) => {
    const ev = st.qSessionEvents.find((e) => e.idx === q && !e.revealed);
    return ev ? ev.t - tAdv : null;
  }).filter((x) => x !== null);
  await sleep(INTRO_MS * 0.65);
  // (b) answer burst with lock watch
  const lw = startLockWatch(`q${q}`);
  const tAnswerStart = now();
  const answerTimes = []; let answerErrors = 0; const answerErrMsgs = []; const ackTimes = new Map();
  await runBurst(bots, BURST, async (bot) => {
    const t0 = now();
    const { data, error } = await api.rpc("submit_answer", {
      p_participant_id: bot.id, p_secret_token: bot.token, p_question_id: qid,
      p_selected_index: Math.floor(Math.random() * 4), p_response_ms: 1500 + Math.round(Math.random() * 6500),
    });
    const t1 = now();
    answerTimes.push(t1 - t0);
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.accepted) { answerErrors++; if (error) answerErrMsgs.push(error.message); }
    else ackTimes.set(bot.id, t1);
  });
  const lockSamples = await lw.stop();
  lockOut.push({ q, samples: lockSamples.trim().split("\n").filter(Boolean) });
  await sleep(4000); // settle: participant update events + any refetch bursts
  const eventsAfterAnswers = chState.map((st) => st.qEvents);
  const allEventLatencies = chState.flatMap((st) => st.qEventTimes.map((t) => t - tAnswerStart));
  // per-answer score-update delivery lag: event receipt time minus that participant's submit ack
  const deliveryLags = [];
  for (const st of chState) for (const [t, pid] of st.log) {
    const ack = pid ? ackTimes.get(pid) : null;
    if (ack && t >= tAnswerStart) deliveryLags.push(t - ack);
  }
  // (c) reveal
  const tRev = now();
  const { error: revErr } = await admin.from("sessions").update({ current_question_revealed: true }).eq("id", sess.id);
  const revRtt = now() - tRev;
  if (revErr) console.error(`reveal update failed: ${revErr.message}`);
  await sleep(3000);
  const revProp = chState.map((st) => {
    const ev = st.qSessionEvents.find((e) => e.revealed === true);
    return ev ? ev.t - tRev : null;
  }).filter((x) => x !== null);
  const qMetrics = {
    q, advanceRttMs: advRtt, advancePropagation: sum(advProp),
    answers: sum(answerTimes), answerErrors, answerErrMsgs: [...new Set(answerErrMsgs)].slice(0, 3),
    participantsEventsPerBot: sum(eventsAfterAnswers),
    eventArrivalLatency: sum(allEventLatencies),
    deliveryLag: sum(deliveryLags),
    revealRttMs: revRtt, revealPropagation: sum(revProp),
    revealSeenBy: revProp.length, bots: chState.length,
  };
  perQuestion.push(qMetrics);
  console.log(`[q${q}] answers ${JSON.stringify(sum(answerTimes), (k, v) => typeof v === "number" ? Math.round(v) : v)} err=${answerErrors} | advRtt=${advRtt.toFixed(0)}ms advProp=${f(sum(advProp).p50)} | events/bot=${sum(eventsAfterAnswers).avg.toFixed(1)} | evtArr p50=${f(sum(allEventLatencies).p50)} p95=${f(sum(allEventLatencies).p95)} max=${f(sum(allEventLatencies).max)} | scoreLag n=${deliveryLags.length} p50=${f(sum(deliveryLags).p50)} p95=${f(sum(deliveryLags).p95)} max=${f(sum(deliveryLags).max)} | revRtt=${revRtt.toFixed(0)}ms revProp p50=${f(sum(revProp).p50)} p95=${f(sum(revProp).p95)} max=${f(sum(revProp).max)} seen=${revProp.length}/${chState.length}`);
}

// ---- summary ----------------------------------------------------------------
const expectedEvents = bots.length * order.length; // one participants event per answer per subscriber
const out = {
  players: PLAYERS, questions: QUESTIONS, burst: BURST, code: sess.code,
  join: sum(joinTimes), joinFail, channels: sum(chTimes), channelFail: bots.length - chState.length,
  perQuestion, lockOut,
  totals: {
    participantsEventsTotal: chState.reduce((a, st) => a + st.participantsEvents, 0),
    participantsEventsExpected: expectedEvents * chState.length,
    sessionEventsTotal: chState.reduce((a, st) => a + st.sessionEvents.length, 0),
    sessionEventsExpected: chState.length * order.length * 2,
  },
  perBotEventCounts: chState.map((st) => st.participantsEvents),
  perBotLog: chState.map((st) => st.log.map(([t, pid]) => [Math.round(t - (st.log[0]?.[0] ?? t)), pid ? pid.slice(0, 8) : null])),
};
writeFileSync(join(HERE, `metrics-p${PLAYERS}-${runId}.json`), JSON.stringify(out, null, 2));
console.log(`\nWrote metrics-p${PLAYERS}-${runId}.json`);
console.log(`Totals: participants events delivered=${out.totals.participantsEventsTotal}/${out.totals.participantsEventsExpected} expected; session events=${out.totals.sessionEventsTotal}/${out.totals.sessionEventsExpected}`);
const evCounts = out.perBotEventCounts.sort((a, b) => a - b);
console.log(`Per-bot delivered events: min=${evCounts[0]} p50=${evCounts[Math.floor(evCounts.length / 2)]} max=${evCounts[evCounts.length - 1]} (expected ${order.length * bots.length})`);

// ---- cleanup bots -----------------------------------------------------------
const ids = bots.map((b) => b.id);
if (ids.length) {
  await admin.from("answers").delete().eq("session_id", sess.id).in("participant_id", ids);
  await admin.from("participant_secrets").delete().in("participant_id", ids);
  const { error } = await admin.from("participants").delete().in("id", ids);
  console.log(error ? `cleanup warn: ${error.message}` : `cleaned ${ids.length} bots`);
}
process.exit(0);
