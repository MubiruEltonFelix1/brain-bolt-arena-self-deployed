#!/usr/bin/env bun
// Phase 9D.1 browser profiler (puppeteer-core). Opens the REAL deployed host +
// player pages under an N-player answer burst and measures: long tasks,
// event-loop lag, WS message volume, REST request volume, heap, reveal→UI
// latency, and (with --timer-test) whether the host's own timer can still
// drive the reveal under load.
//
//   bun profile.mjs --players 50 [--questions 2] [--timer-test]
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const PLAYERS = Number(arg("players", "50"));
const QUESTIONS = Number(arg("questions", "2"));
const TIMER_TEST = process.argv.includes("--timer-test");
const RECONNECT = process.argv.includes("--reconnect");
const APP = arg("app", "http://localhost:4173");
const EXE = arg("exe", "C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe");
const HERE = import.meta.dir;
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixture.json"), "utf8"));

const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const SUPA_URL = vars.SUPABASE_URL;
const ANON = vars.SUPABASE_PUBLISHABLE_KEY;
const api = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
const admin = createClient(SUPA_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const REF = new globalThis.URL(SUPA_URL).hostname.split(".")[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const sum = (a) => ({ n: a.length, avg: a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? Math.max(...a) : 0 });

// ---- 1. persistent throwaway auth user (created once, reused across runs) ---
const AUTH_USER_FILE = join(HERE, "auth-user.json");
let authUser;
if (existsSync(AUTH_USER_FILE)) {
  authUser = JSON.parse(readFileSync(AUTH_USER_FILE, "utf8"));
} else {
  const email = `bwat-audit-${Date.now().toString(36)}@example.com`;
  const password = `Aa1!${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const { data: created, error: cuErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (cuErr) { console.error("createUser failed:", cuErr.message); process.exit(1); }
  authUser = { email, password, userId: created.user.id };
  writeFileSync(AUTH_USER_FILE, JSON.stringify(authUser, null, 2));
}
const { email, password } = authUser;
console.log(`[auth] reuse host user ${authUser.userId} (${email})`);

// ---- 2. reset session to lobby + purge any leftover bots --------------------
await admin.from("sessions").update({ status: "lobby", current_question_index: -1, current_question_revealed: false, current_question_started_at: null, paused_at: null, time_added_ms: 0 }).eq("id", FIXTURE.sessionId);
{
  const { data: stale } = await admin.from("participants").select("id").eq("session_id", FIXTURE.sessionId);
  const staleIds = (stale ?? []).map((p) => p.id);
  if (staleIds.length) {
    await admin.from("answers").delete().eq("session_id", FIXTURE.sessionId);
    await admin.from("participant_secrets").delete().in("participant_id", staleIds);
    await admin.from("participants").delete().in("id", staleIds);
    console.log(`[setup] purged ${staleIds.length} stale participants from previous runs`);
  }
}
const order = FIXTURE.questionIds.slice(0, QUESTIONS);

// ---- 3. bots join (no channels; the pages are the observers) ----------------
const runId = Date.now().toString(36).slice(-4);
const nicks = Array.from({ length: PLAYERS }, (_, i) => `P${runId}-${String(i + 1).padStart(3, "0")}`);
const bots = [];
{
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(25, PLAYERS) }, async () => {
    while (i < PLAYERS) {
      const nick = nicks[i++];
      const { data, error } = await api.rpc("join_session", { p_code: FIXTURE.code, p_nickname: nick });
      const row = Array.isArray(data) ? data[0] : data;
      if (!error && row?.participant_id) bots.push({ id: row.participant_id, token: row.secret_token });
    }
  }));
}
console.log(`[bots] ${bots.length}/${PLAYERS} joined`);
const playerNick = `WATCH-${runId}`;
const { data: pj } = await api.rpc("join_session", { p_code: FIXTURE.code, p_nickname: playerNick });
const playerRow = Array.isArray(pj) ? pj[0] : pj;
if (!playerRow?.participant_id) { console.error("player-page join failed"); process.exit(1); }

// ---- 4. browser -------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: "shell",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  userDataDir: join(HERE, "chrome-profile"), // persistent: keeps the host auth session between runs
  timeout: 60000,
});

const INIT = `
window.__bwat = {
  collecting: false, longtasks: [], lags: [], lastTick: performance.now(),
  reset() { this.collecting = true; this.longtasks = []; this.lags = []; },
  stop() { this.collecting = false; },
  snapshot() {
    const lt = this.longtasks; const lags = this.lags;
    return {
      longtaskCount: lt.length, longtaskTotalMs: lt.reduce((a, b) => a + b, 0), longtaskMaxMs: lt.length ? Math.max(...lt) : 0,
      lagMaxMs: lags.length ? Math.max(...lags) : 0, lagP95Ms: lags.length ? [...lags].sort((a, b) => a - b)[Math.floor(0.95 * (lags.length - 1))] : 0,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
  },
};
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (window.__bwat.collecting) window.__bwat.longtasks.push(e.duration);
  }).observe({ entryTypes: ["longtask"] });
} catch {}
setInterval(() => {
  const t = performance.now(); const lag = t - window.__bwat.lastTick - 100; window.__bwat.lastTick = t;
  if (window.__bwat.collecting && lag > 0) window.__bwat.lags.push(lag);
}, 100);
`;

async function trackPage(page, label) {
  const ws = { frames: 0, log: [] };
  const rest = {};
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameReceived", (e) => {
    if (e.response?.opcode === 1) {
      ws.frames++;
      if (ws.log.length < 30) ws.log.push(String(e.response.payloadData).slice(0, 4000));
    }
  });
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/rest/v1/") || u.includes("/rpc/")) {
      const path = u.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
      rest[path] = (rest[path] ?? 0) + 1;
    }
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/rest/v1/") && r.status() >= 400) console.log(`[${label} REST ${r.status()}]`, u.replace(/^https?:\/\/[^/]+/, "").slice(0, 150));
  });
  page.on("console", (m) => { if (m.type() === "error") console.log(`[${label} console]`, m.text().slice(0, 220)); });
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, String(e).slice(0, 220)));
  return { page, label, ws, rest };
}

const hostPage = await browser.newPage();
await hostPage.setViewport({ width: 1600, height: 900 });
await hostPage.evaluateOnNewDocument(INIT);
const hostTrack = await trackPage(hostPage, "host");

const playerPage = await browser.newPage();
await playerPage.setViewport({ width: 390, height: 844 });
await playerPage.evaluateOnNewDocument(INIT);
await playerPage.evaluateOnNewDocument(`window.localStorage.setItem('brainbolt:participants', ${JSON.stringify(JSON.stringify({ [FIXTURE.sessionId]: { id: playerRow.participant_id, sessionId: FIXTURE.sessionId, nickname: playerNick, secretToken: playerRow.secret_token, avatarId: null } }))});`);
const playerTrack = await trackPage(playerPage, "player");

console.log(`[pages] host login (only when no session) + loading pages from ${APP}`);
await hostPage.goto(`${APP}/auth`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await sleep(1500);
let hasSession = await hostPage.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("sb-")) && localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("sb-")))?.length > 20).catch(() => false);
for (let attempt = 1; attempt <= 3 && !hasSession; attempt++) {
  await hostPage.goto(`${APP}/auth`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(1800);
  const hasForm = await hostPage.$('input[type="email"]').then((h) => !!h).catch(() => false);
  if (!hasForm) {
    const url = await hostPage.evaluate(() => location.href).catch(() => "?");
    const body = await hostPage.evaluate(() => document.body.innerText).catch(() => "");
    console.log(`[pages] attempt ${attempt}: no login form (url=${url}) body="${String(body).slice(0, 160).replace(/\s+/g, " ")}"`);
    await sleep(2500);
    continue;
  }
  console.log(`[pages] attempt ${attempt}: submitting sign-in form…`);
  await hostPage.evaluate((e, p) => {
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      d.set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setVal(document.querySelector('input[type="email"]'), e);
    setVal(document.querySelector('input[type="password"]'), p);
    document.querySelector("form")?.requestSubmit();
  }, email, password);
  await hostPage.waitForFunction(() => !location.pathname.startsWith("/auth"), { timeout: 120000, polling: 300 }).catch(() => {});
  hasSession = await hostPage.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("sb-"))).catch(() => false);
  if (!hasSession) await sleep(3000);
}
console.log(`[pages] session present: ${hasSession}; path=${await hostPage.evaluate(() => location.pathname).catch(() => "?")}`);
await hostPage.goto(`${APP}/host/${FIXTURE.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await playerPage.goto(`${APP}/play/${FIXTURE.sessionId}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
const hostInGame = await hostPage.waitForFunction(() => document.body.textContent.includes("START GAME"), { timeout: 45000, polling: 200 }).then(() => true).catch(() => false);
const playerInGame = await playerPage.waitForFunction(() => document.body.textContent.includes("Stand by"), { timeout: 45000, polling: 200 }).then(() => true).catch(() => false);
console.log(`[pages] host lobby visible=${hostInGame}, player lobby visible=${playerInGame}`);
if (!hostInGame) console.log("[pages] host snippet:", (await hostPage.evaluate(() => document.body.innerText)).slice(0, 240).replace(/\s+/g, " "));

async function waitForText(page, markers, timeoutMs) {
  const arr = Array.isArray(markers) ? markers : [markers];
  const t0 = Date.now();
  return await page.waitForFunction(
    (m) => { const t = document.body.textContent || ""; return m.some((x) => t.includes(x)); },
    { timeout: timeoutMs, polling: 120 },
    arr,
  ).then(() => Date.now() - t0).catch(() => "TIMEOUT");
}

// ---- 5. question loop -------------------------------------------------------
const results = [];
for (let q = 0; q < order.length; q++) {
  const qid = order[q];
  const tAdv = Date.now();
  await admin.from("sessions").update({
    status: "active", current_question_index: q, current_question_started_at: new Date().toISOString(),
    current_question_revealed: false, paused_at: null, time_added_ms: 0,
  }).eq("id", FIXTURE.sessionId);
  const hostQVisible = await hostPage.waitForFunction(() => /ROUND \d+\//.test(document.body.textContent || ""), { timeout: 8000, polling: 100 }).then(() => Date.now() - tAdv).catch(() => null);
  const playerQVisible = await playerPage.waitForFunction(() => /ROUND \d+\//.test(document.body.textContent || ""), { timeout: 8000, polling: 100 }).then(() => Date.now() - tAdv).catch(() => null);
  await sleep(5500);
  await hostPage.evaluate(() => window.__bwat.reset());
  await playerPage.evaluate(() => window.__bwat.reset());
  const restHostStart = { ...hostTrack.rest }; const restPlayerStart = { ...playerTrack.rest };
  const wsHostStart = hostTrack.ws.frames; const wsPlayerStart = playerTrack.ws.frames;
  const tBurst = Date.now();
  const answerTimes = []; let errors = 0;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(50, bots.length) }, async () => {
    while (i < bots.length) {
      const bot = bots[i++];
      const t0 = Date.now();
      const { data, error } = await api.rpc("submit_answer", { p_participant_id: bot.id, p_secret_token: bot.token, p_question_id: qid, p_selected_index: Math.floor(Math.random() * 4), p_response_ms: 1500 + Math.round(Math.random() * 6500) });
      answerTimes.push(Date.now() - t0);
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.accepted) errors++;
    }
  }));
  const burstWall = Date.now() - tBurst;
  let reconnect = null;
  if (RECONNECT && q === 0) {
    const restBefore = { ...playerTrack.rest };
    const framesBefore = playerTrack.ws.frames;
    await playerPage.setOfflineMode(true);
    const tOff = Date.now();
    await sleep(5000);
    await playerPage.setOfflineMode(false);
    const tOnline = Date.now();
    let firstFrameAt = null;
    while (Date.now() - tOnline < 25000) {
      if (playerTrack.ws.frames > framesBefore) { firstFrameAt = Date.now() - tOnline; break; }
      await sleep(100);
    }
    await sleep(6000);
    reconnect = {
      offlineForMs: tOnline - tOff,
      firstWsFrameAfterMs: firstFrameAt,
      restCallsAfterReconnect: diffRest(playerTrack.rest, restBefore),
      wsFramesAfterReconnect: playerTrack.ws.frames - framesBefore,
      questionVisible: await playerPage.evaluate(() => /ROUND \d+\//.test(document.body.textContent || "")),
    };
    console.log(`     reconnect storm: offline ${reconnect.offlineForMs}ms → first WS frame after ${firstFrameAt}ms | REST=${JSON.stringify(reconnect.restCallsAfterReconnect)} | question visible again=${reconnect.questionVisible}`);
  }
  await sleep(5000); // digest window
  const hostSnap = await hostPage.evaluate(() => window.__bwat.snapshot());
  const playerSnap = await playerPage.evaluate(() => window.__bwat.snapshot());
  await hostPage.evaluate(() => window.__bwat.stop());
  await playerPage.evaluate(() => window.__bwat.stop());
  const wsHostBurst = hostTrack.ws.frames - wsHostStart;
  const wsPlayerBurst = playerTrack.ws.frames - wsPlayerStart;
  const restHostBurst = diffRest(hostTrack.rest, restHostStart);
  const restPlayerBurst = diffRest(playerTrack.rest, restPlayerStart);
  const isTimerQ = TIMER_TEST && q === order.length - 1;
  let reveal = { mode: isTimerQ ? "host-timer" : "service-role" };
  if (isTimerQ) {
    // The host page's own auto-reveal effect must fire at expiry.
    // Question started_at was set ~5.5s ago; limit is 20s → deadline ≈ 20.5s after start.
    const t0 = Date.now();
    const seen = await waitForText(hostPage, "NEXT QUESTION", 30000);
    reveal.clientLatency = seen === null ? Date.now() - t0 : seen;
    reveal.timerRevealed = await admin.from("sessions").select("current_question_revealed").eq("id", FIXTURE.sessionId).single().then(({ data }) => !!data?.current_question_revealed);
  } else {
    const tRev = Date.now();
    const wsHostBeforeRev = hostTrack.ws.frames;
    hostTrack.ws.log = [];
    await admin.from("sessions").update({ current_question_revealed: true }).eq("id", FIXTURE.sessionId);
    let hostLat = await waitForText(hostPage, "NEXT QUESTION", 10000);
    const framesAfterFirst = hostTrack.ws.frames - wsHostBeforeRev;
    if (hostLat === "TIMEOUT") {
      console.log(`     [debug] host WS frames in first ${Date.now() - tRev}ms after reveal: ${framesAfterFirst}`);
      for (const f of hostTrack.ws.log.slice(0, 6)) {
        try {
          const j = JSON.parse(f);
          const data = Array.isArray(j) ? j[4]?.data ?? j[3]?.data : null;
          if (data) console.log(`     [frame] topic=${j[2]} table=${data.table} type=${data.type} revealed=${data.record?.current_question_revealed} idx=${data.record?.current_question_index}`);
          else console.log(`     [frame raw] ${f.slice(0, 200)}`);
        } catch { console.log(`     [frame unparsed] ${f.slice(0, 200)}`); }
      }
      hostTrack.ws.log = [];
      await admin.from("sessions").update({ current_question_revealed: true, time_added_ms: 0, paused_at: null }).eq("id", FIXTURE.sessionId); // nudge
      hostLat = await waitForText(hostPage, "NEXT QUESTION", 12000);
      console.log(`     [debug] after nudge: hostLat=${hostLat}, frames delta=${hostTrack.ws.frames - wsHostBeforeRev}`);
      for (const f of hostTrack.ws.log.slice(0, 4)) console.log(`     [frame2] ${f.slice(0, 260)}`);
    }
    const playerLat = await waitForText(playerPage, ["CORRECT", "INCORRECT", "NO ANSWER", "CLOSE"], 12000);
    reveal.hostUiLatency = hostLat; reveal.playerUiLatency = playerLat; reveal.revealRtt = Date.now() - tRev;
  }
  await sleep(1500);
  const r = {
    q, burstWall, answers: sum(answerTimes), answerErrors: errors,
    hostQVisibleLatency: hostQVisible, playerQVisibleLatency: playerQVisible,
    wsFramesDuringBurst: { host: wsHostBurst, player: wsPlayerBurst },
    restCallsDuringBurst: { host: restHostBurst, player: restPlayerBurst },
    hostWindow: hostSnap, playerWindow: playerSnap, reveal, reconnect,
  };
  results.push(r);
  console.log(`[q${q}] burst=${burstWall}ms ans p95=${sum(answerTimes).p95.toFixed(0)}ms err=${errors} | WSmsg host=${wsHostBurst} player=${wsPlayerBurst} | host longtasks=${hostSnap.longtaskCount} (${hostSnap.longtaskTotalMs.toFixed(0)}ms) lagMax=${hostSnap.lagMaxMs.toFixed(0)}ms heap=${hostSnap.heapMB}MB | player longtasks=${playerSnap.longtaskCount} lagMax=${playerSnap.lagMaxMs.toFixed(0)}ms | ${isTimerQ ? `TIMER reveal=${reveal.timerRevealed} clientLatency=${reveal.clientLatency}ms` : `reveal→hostUI=${reveal.hostUiLatency} playerUI=${reveal.playerUiLatency}`}`);
  console.log(`     host REST: ${JSON.stringify(restHostBurst)}`);
  console.log(`     player REST: ${JSON.stringify(restPlayerBurst)}`);
}

function diffRest(now, before) { const out = {}; for (const [k, v] of Object.entries(now)) { const d = v - (before[k] ?? 0); if (d > 0) out[k] = d; } return out; }

const outFile = join(HERE, `browser-p${PLAYERS}${TIMER_TEST ? "-timer" : ""}-${runId}.json`);
writeFileSync(outFile, JSON.stringify({ app: APP, players: PLAYERS, timerTest: TIMER_TEST, sessionId: FIXTURE.sessionId, results }, null, 2));
console.log(`\nWrote ${outFile}`);

await browser.close();
const ids = bots.map((b) => b.id).concat([playerRow.participant_id]);
await admin.from("answers").delete().eq("session_id", FIXTURE.sessionId).in("participant_id", ids);
await admin.from("participant_secrets").delete().in("participant_id", ids);
await admin.from("participants").delete().in("id", ids);
console.log(`cleaned ${ids.length} participants (host auth user kept for reuse; remove with fixture.mjs cleanup)`);
process.exit(0);
