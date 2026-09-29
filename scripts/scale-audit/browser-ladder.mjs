// Phase 9D.2b §17/§18/§20 — real-browser Broadcast ladder + multi-question soak.
//
// Real Chromium pages play: every page is a real seat (join_session), loads the
// real /play route, and subscribes to the real private session channel. Answers
// are submitted through the authoritative RPC, so the events under test are the
// real ones the database triggers publish.
//
// Per page we record three independent layers, because "a frame arrived" is not
// proof of delivery:
//   1. socket layer   — binary ArrayBuffer frames seen on the page's WebSocket
//                       (only Broadcast uses the binary serializer; sessions /
//                       participants WAL traffic is JSON text)
//   2. decoder layer  — DataView constructions, i.e. realtime-js's decoder was
//                       actually entered for those frames
//   3. app layer      — DOM text: own score, joined count, answered counter
//
// Usage: bun browser-ladder.mjs --players 50 --rounds 3 [--mobile]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const HERE = import.meta.dir;
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}`));
  if (!hit) return d;
  const v = hit.split("=")[1];
  return v === undefined ? true : Number.isNaN(Number(v)) ? v : Number(v);
};
const PLAYERS = arg("players", 10);
const ROUNDS = arg("rounds", 3);
const MOBILE = !!arg("mobile", false);
const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const PORT = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromePath() {
  const base = join(process.env.LOCALAPPDATA || "", "ms-playwright");
  for (const dir of readdirSync(base)) {
    for (const rel of [
      "chrome-headless-shell-win64/chrome-headless-shell.exe",
      "chrome-win/chrome.exe",
    ]) {
      const p = join(base, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no chromium under " + base);
}

async function ensureServer() {
  const ping = async () => {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * A live server is not necessarily a usable one. `bun run build` replaces the
   * hashed asset filenames, and a preview server started before the build keeps
   * serving HTML that references the OLD hash — the client bundle then 404s,
   * the app never hydrates, and every page reports zero frames. That reads
   * exactly like a transport failure, so it is checked explicitly: pull the
   * entry asset out of the served HTML and require it to resolve.
   */
  const assetsResolve = async () => {
    try {
      const html = await (
        await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(4000) })
      ).text();
      const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
      if (!m) return true; // nothing to verify against; don't second-guess it
      const r = await fetch(`http://127.0.0.1:${PORT}${m[0]}`, { signal: AbortSignal.timeout(4000) });
      return r.ok;
    } catch {
      return false;
    }
  };

  const { spawn } = await import("node:child_process");
  const start = () =>
    spawn("bun", [join(HERE, "serve.mjs")], { stdio: "ignore", shell: true, detached: false });

  if (await ping()) {
    if (await assetsResolve()) return null;
    console.log(
      `[ladder] server on :${PORT} is serving a stale build (its entry asset 404s) — replacing it`,
    );
    await killListener(PORT);
  }
  const proc = start();
  for (let i = 0; i < 40 && !(await ping()); i++) await sleep(500);
  if (!(await ping())) throw new Error("serve.mjs did not start");
  if (!(await assetsResolve()))
    throw new Error(
      `serve.mjs is up on :${PORT} but its entry asset does not resolve — run \`bun run build\` first`,
    );
  return proc;
}

/** Best-effort: kill whatever is listening on `port`, so we can start our own. */
async function killListener(port) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("netstat", ["-ano"]);
      // The local-endpoint field is compared as a whole, and its port is
      // anchored to the end of that field. A substring test on ":3000" would
      // also match ":30000"..":30099" and, because /T /F kills the process
      // tree, take down an unrelated listener. This does intentionally kill
      // whatever is on :PORT — that is the point, we are replacing a server we
      // did not start.
      const pids = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const fields = line.trim().split(/\s+/);
        const m = /:(\d+)$/.exec(fields[1] ?? "");
        if (m && m[1] === String(port)) pids.add(fields[fields.length - 1]);
      }
      for (const pid of pids) await run("taskkill", ["/PID", pid, "/T", "/F"]).catch(() => {});
    } else {
      const { stdout } = await run("lsof", ["-ti", `tcp:${port}`]).catch(() => ({ stdout: "" }));
      for (const pid of stdout.split(/\s+/).filter(Boolean))
        await run("kill", ["-9", pid]).catch(() => {});
    }
  } catch {
    // best effort only — ensureServer() reports the real problem either way
  }
  await sleep(1000);
}

// --- fixture -----------------------------------------------------------------
spawnSync("bun", [join(HERE, "fixture.mjs")], { stdio: "ignore", shell: true });
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixture.json"), "utf8"));
const server = await ensureServer();
const admin = createClient(vars.VITE_SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: session } = await admin
  .from("sessions")
  .select("id, quiz_id, question_order")
  .eq("id", FIXTURE.sessionId)
  .single();
const { data: questions } = await admin
  .from("questions")
  .select("id")
  .eq("quiz_id", session.quiz_id)
  .order("position");
if (!questions?.length) throw new Error("fixture quiz has no questions");
const questionIds = questions.map((q) => q.id);
// current_question_index indexes the session's play order, so that is what a
// player is actually looking at — answer THAT question, not a position-ordered
// one. Falls back to position order when the session has no shuffle.
const playedQuestionId = (i) => session.question_order?.[i] ?? questionIds[i % questionIds.length];
// Rounds walk distinct questions: a repeated question id is de-duplicated by
// submit_answer, so a soak of N rounds needs N distinct questions.
const playedCount = Math.max(
  1,
  Math.min(questionIds.length, session.question_order?.length ?? questionIds.length),
);

// --- seats -------------------------------------------------------------------
const NICK = (i) => `9d2b-l${PLAYERS}-${i}`;
await admin
  .from("participants")
  .delete()
  .eq("session_id", FIXTURE.sessionId)
  .like("nickname", `9d2b-l${PLAYERS}-%`);
const seats = [];
for (let i = 0; i < PLAYERS; i++) {
  const { data, error } = await admin.rpc("join_session", {
    p_code: FIXTURE.code,
    p_nickname: NICK(i),
  });
  if (error) throw new Error("join_session: " + error.message);
  const row = Array.isArray(data) ? data[0] : data;
  seats.push({ id: row.participant_id, token: row.secret_token });
}
console.log(`[ladder] ${PLAYERS} seats joined (${MOBILE ? "mobile" : "desktop"} emulation)`);

// Only now activate the game, so the page renders a real question with a live
// answered counter (join_session refuses joins on an active session).
await admin
  .from("sessions")
  .update({
    status: "active",
    current_question_index: 0,
    current_question_started_at: new Date().toISOString(),
  })
  .eq("id", FIXTURE.sessionId);

// --- browser ----------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=512"],
});

// Installed as a source STRING on every new document (see the note at the call
// site). Sets window.__bd = { gen, frames, binary, kinds, dataViews }.
//   gen       — performance.timeOrigin, unique per document, so the harness can
//               tell whether it is reading the counters of the live document
//   binary    — ArrayBuffer messages seen by the socket
//   kinds     — first byte of each binary frame, hex ("0x04" = userBroadcast)
//   dataViews — DataView constructions = realtime-js decoder entries
const PROBE_SOURCE = `(() => {
  try {
    localStorage.setItem("brainbolt:participants", JSON.stringify(__IDENTITY__));
    var st = { gen: Math.round(performance.timeOrigin), frames: 0, binary: 0, kinds: {}, dataViews: 0 };
    window.__bd = st;
    var record = function (d) {
      st.frames++;
      if (d instanceof ArrayBuffer) {
        st.binary++;
        var kind = "0x" + new Uint8Array(d)[0].toString(16).padStart(2, "0");
        st.kinds[kind] = (st.kinds[kind] || 0) + 1;
      }
    };
    var OWS = window.WebSocket;
    var proto = OWS.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "onmessage");
    var wrap = function (h) { return function (ev) { record(ev.data); return h && h.call(this, ev); }; };
    var W = function (url, protocols) {
      var ws = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
      Object.defineProperty(ws, "onmessage", {
        configurable: true,
        get: function () { return ws.__h; },
        set: function (h) { ws.__h = h; desc.set.call(ws, wrap(h)); },
      });
      var add = ws.addEventListener.bind(ws);
      ws.addEventListener = function (t, h, o) { return add(t, t === "message" ? wrap(h) : h, o); };
      return ws;
    };
    W.prototype = proto;
    Object.assign(W, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = W;
    var ODV = window.DataView;
    var DV = function (b) {
      if (b instanceof ArrayBuffer) window.__bd.dataViews++;
      return arguments.length > 1 ? new ODV(b, arguments[1]) : new ODV(b);
    };
    DV.prototype = ODV.prototype;
    window.DataView = DV;
  } catch (e) { window.__bdError = String(e); }
})();`;

// Per-seat identity the /play page reads out of localStorage.
const identityOf = (k) => ({
  id: seats[k].id,
  sessionId: FIXTURE.sessionId,
  nickname: NICK(k),
  secretToken: seats[k].token,
});

// Parsed in Node from the retried innerText read, so the app layer has exactly
// the same retry semantics as the probe layer.
const dom = async (p) => {
  const t = await textOf(p);
  const m = t.match(/Score:\s*([\d,]+)/);
  const j = t.match(/(\d+)\s+PLAYERS? JOINED/);
  const c =
    t.match(/(\d+)\s*\/\s*(\d+)\s+ANSWERED/i) || t.match(/ANSWERED[^0-9]*(\d+)\s*\/\s*(\d+)/i);
  // The round indicator the player actually sees. Two headers exist depending
  // on where the round is: "ROUND 1/12" once the question is live, and
  // "QUESTION 1 OF 12" during the 5s intro overlay. Either counts as "the
  // player is on round N". With the WAL diet applied, `sessions` is the only
  // postgres_changes binding left, so this is the end-to-end proof that an
  // anonymous player still learns about transitions — a server-side round
  // counter would not prove it.
  const r = t.match(/ROUND\s+(\d+)\s*\//i) || t.match(/QUESTION\s+(\d+)\s+OF/i);
  const qt = t.match(/Scale-audit question\s+(\d+)/i);
  return {
    score: m ? m[1] : null,
    joined: j ? Number(j[1]) : null,
    answered: c ? Number(c[1]) : null,
    round: r ? Number(r[1]) : null,
    questionText: qt ? Number(qt[1]) : null,
  };
};

const pages = [];
const CONCURRENCY = 10;
for (let i = 0; i < PLAYERS; i += CONCURRENCY) {
  const batch = [];
  for (let k = i; k < Math.min(i + CONCURRENCY, PLAYERS); k++) {
    const page = await browser.newPage();
    page.on("pageerror", (e) =>
      console.log(`[pageerror k=${k}] ${String(e.message).slice(0, 160)}`),
    );
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame())
        console.log(`[docreq k=${k}] ${r.method()} ${r.url()}`);
    });
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) console.log(`[nav k=${k}] ${f.url()}`);
    });
    if (MOBILE) {
      await page.setViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });
      await page.setUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      );
    }
    // Instrumentation is installed as a STRING via evaluateOnNewDocument so it
    // is (a) immune to puppeteer's function-serialization edge cases and
    // (b) re-installed on EVERY document, so a mid-run navigation cannot
    // silently disarm the measurement (that was the original harness defect:
    // the page reloaded after load and wiped a post-load-installed probe).
    // The identity OBJECT is inlined and JSON.stringify'd INSIDE the page:
    // handing setItem() a raw object stores the literal string
    // "[object Object]", the app then fails to parse it, renders the
    // "You're not in a game" gate and never opens a channel at all.
    await page.evaluateOnNewDocument(
      PROBE_SOURCE.replace(
        "__IDENTITY__",
        `{${JSON.stringify(FIXTURE.sessionId)}:${JSON.stringify(identityOf(k))}}`,
      ),
    );
    batch.push(
      page.goto(`http://127.0.0.1:${PORT}/play/${FIXTURE.sessionId}`, {
        waitUntil: "domcontentloaded",
      }),
    );
    pages.push(page);
  }
  await Promise.all(batch);
  console.log(`[ladder] ${pages.length}/${PLAYERS} pages loaded`);
}

// Diagnostic: what does the page actually hold after load? (harness §3)
const diag0 = await pages[0]
  .evaluate(() => ({
    url: location.href,
    bd: typeof window.__bd,
    hasIdentity: !!localStorage.getItem("brainbolt:participants"),
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 220),
  }))
  .catch((e) => ({ error: String(e).slice(0, 80) }));
console.log(`[diag page0] ${JSON.stringify(diag0)}`);

// A page counts as IN-GAME when the real play UI is mounted (score + question
// header). The old check looked for a "PIN 000000" string that the /play UI
// does not render, so it reported 0/10 on healthy pages. Each read is retried:
// an evaluate that lands in the navigation window throws, and a silent "" would
// otherwise be counted as "not in game".
const textOf = async (p) => {
  for (let a = 0; a < 5; a++) {
    try {
      return await p.evaluate(() => document.body.innerText);
    } catch {
      if (a === 4) return "";
      await sleep(400);
    }
  }
};
const countInGame = async () => {
  let n = 0;
  for (const p of pages) {
    const txt = await textOf(p);
    // "Score: 889" is the live answered/score header of the real play UI; the
    // question counter is not rendered in every state (e.g. between rounds), so
    // the score header is the stable "app mounted and in a game" signal.
    if (txt && /Score:\s*[\d,]+/i.test(txt)) n++;
  }
  return n;
};
const sampleText = async () =>
  pages[0]
    .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 160))
    .catch((e) => `unreadable: ${String(e).slice(0, 60)}`);
let inGame = 0;
for (let t = 0; t < 60 && inGame < pages.length; t++) {
  inGame = await countInGame();
  if (inGame < pages.length) await sleep(1000);
}
// Even once the UI is mounted the socket still has to finish its subscribe
// handshake; without this settle, round 0 measures the join, not the transport.
if (inGame === pages.length) await sleep(3000);
console.log(`[ladder] in-game: ${inGame}/${pages.length}`);
if (inGame < pages.length) console.log(`[ladder] page0 text: ${await sampleText()}`);

// Per-page readback, with retries: a client-side navigation (TanStack Router
// pushState) destroys the execution context for a few hundred ms, and
// puppeteer rejects the evaluate during that window. Retrying keeps a torn-down
// context from being misreported as a missing probe; a page that STILL cannot
// be read is TEST INVALID (reported as -1), never "0 events".
const readOne = async (p) => {
  for (let a = 0; a < 5; a++) {
    try {
      return await p.evaluate(() => {
        const b = window.__bd;
        if (!b)
          return {
            binary: -1,
            dataViews: -1,
            kinds: null,
            gen: -1,
            error: window.__bdError || "probe-missing",
          };
        return {
          binary: b.binary,
          dataViews: b.dataViews,
          kinds: b.kinds,
          gen: b.gen,
          frames: b.frames,
        };
      });
    } catch (e) {
      if (a === 4)
        return {
          binary: -1,
          dataViews: -1,
          kinds: null,
          gen: -1,
          error: String(e.message || e).slice(0, 70),
        };
      await sleep(400);
    }
  }
};
const snapshot = () => Promise.all(pages.map(readOne));

// --- rounds ------------------------------------------------------------------
const perRound = [];
for (let r = 0; r < ROUNDS; r++) {
  const idx = r % playedCount;
  const questionId = playedQuestionId(idx);
  await admin
    .from("sessions")
    .update({ current_question_index: idx, current_question_started_at: new Date().toISOString() })
    .eq("id", FIXTURE.sessionId);
  await sleep(1200);
  // Authoritative answer RPC — the DB trigger publishes game:answer_row +
  // game:answer from it. Submitted in parallel chunks: real players answer
  // within a couple of seconds of each other, and a serial loop pushes the last
  // seats past the response window (which is why a 50-seat run rejected them).
  const t0 = Date.now();
  let accepted = 0;
  const CHUNK = 10;
  for (let c = 0; c < seats.length; c += CHUNK) {
    const results = await Promise.all(
      seats.slice(c, c + CHUNK).map((s, j) =>
        admin
          .rpc("submit_answer", {
            p_participant_id: s.id,
            p_secret_token: s.token,
            p_question_id: questionId,
            p_selected_index: 0,
            p_response_ms: 900 + ((c * 7 + j * 13) % 4000),
          })
          .then(({ data }) => {
            const row = Array.isArray(data) ? data[0] : data;
            return row?.accepted ? 1 : 0;
          })
          .catch(() => 0),
      ),
    );
    accepted += results.reduce((a, b) => a + b, 0);
  }
  await sleep(3500);
  const snaps = await snapshot();
  const doms = await Promise.all(pages.map((p) => dom(p).catch(() => ({}))));
  const per = snaps.map((s) => ({
    binary: Number(s?.binary ?? -1),
    kinds: s?.kinds ?? null,
    dataViews: Number(s?.dataViews ?? -1),
  }));
  perRound.push({
    round: r,
    questionIndex: idx,
    accepted,
    answerRms: Date.now() - t0,
    binaryMin: Math.min(...per.map((x) => x.binary)),
    binaryMax: Math.max(...per.map((x) => x.binary)),
    binaryTotal: per.reduce((a, x) => a + x.binary, 0),
    dataViewMin: Math.min(...per.map((x) => x.dataViews)),
    kindsSample: per[0]?.kinds,
    probeError: per.find((x) => x.binary < 0)?.error ?? null,
    domScore: doms.filter((d) => d.score).length,
    domJoined: doms[0]?.joined,
    domAnswered:
      doms
        .map((d) => d.answered)
        .filter((x) => x !== null)
        .sort((a, b) => b - a)[0] ?? null,
    // Server round index (0-based) vs what the player is actually shown (1-based).
    questionShown: doms[0]?.round ?? null,
    questionText: doms[0]?.questionText ?? null,
    questionAdvanced: (doms[0]?.round ?? null) === idx + 1,
  });
  console.log(
    `[round ${r}] q=${idx} accepted=${accepted} binaryFrames=${perRound.at(-1).binaryTotal} (per page ${perRound.at(-1).binaryMin}-${perRound.at(-1).binaryMax}) decoderEntries=${perRound.at(-1).dataViewMin} kinds=${JSON.stringify(perRound.at(-1).kindsSample)} probeErr=${perRound.at(-1).probeError} domScoreVisible=${perRound.at(-1).domScore}/${pages.length} qShown=${perRound.at(-1).questionShown} qAdvanced=${perRound.at(-1).questionAdvanced} domJoined=${perRound.at(-1).domJoined} domAnsweredMax=${perRound.at(-1).domAnswered}`,
  );
  if (r === 0) {
    const live = await pages[0]
      .evaluate(() => ({
        bd: typeof window.__bd,
        bdErr: window.__bdError || null,
        gen: window.__bd ? window.__bd.gen : null,
        text: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
        ls: (localStorage.getItem("brainbolt:participants") || "").slice(0, 300),
        want: document.location.pathname.split("/").pop(),
      }))
      .catch((e) => ({ evaluateError: String(e).slice(0, 120) }));
    console.log(`[round0 live] ${JSON.stringify(live)}`);
  }
}

// --- verdict -----------------------------------------------------------------
// Re-read only as a report field: the gate uses the post-settle measurement
// above, because after the last round the UI can move on to the results screen
// and would no longer look like the in-game view.
const inGameFinal = await countInGame();
const final = perRound.at(-1);
const finalSnaps = await snapshot();
// A page whose probe cannot be read is TEST INVALID: it is excluded from every
// rate and never counted as "0 events received".
const invalidPages = finalSnaps.filter((s) => s.binary < 0 || s.gen < 0);
const validPages = finalSnaps.length - invalidPages.length;
const badKinds = [
  ...new Set(finalSnaps.flatMap((s) => Object.keys(s.kinds ?? {})).filter((k) => k !== "0x04")),
];
const out = {
  players: PLAYERS,
  rounds: ROUNDS,
  mobile: MOBILE,
  inGame,
  inGameFinal,
  validPages,
  invalidPages: invalidPages.map((s) => s.error),
  broadcastEventsPerPageLastRound: finalSnaps.map((s) => s.binary).sort((a, b) => a - b),
  nonUserBroadcastKinds: badKinds,
  rounds_detail: perRound,
  pass:
    invalidPages.length === 0 &&
    validPages === PLAYERS &&
    inGame === PLAYERS &&
    badKinds.length === 0 &&
    perRound.every(
      (r) =>
        r.accepted === PLAYERS && r.binaryMin >= 1 && r.domScore === PLAYERS && r.questionAdvanced,
    ),
};
const stamp = `browser-p${PLAYERS}${MOBILE ? "-mobile" : ""}`;
console.log(`\n=== ${JSON.stringify(out, null, 2)}`);
console.log(`${stamp}: ${out.pass ? "PASS" : "FAIL"}`);

await browser.close();
if (server) server.kill();
// The ladder created the whole fixture (quiz + questions + session) a few lines
// up, so it owns all of it: leaving the quiz behind would accumulate
// "ZZZ SCALE AUDIT — DELETE ME" rows on the live project on every run. Each
// delete is independent and reports its own failure — a single rejected delete
// used to abort the rest and strand a live session on the live project.
const wipe = async (label, query) => {
  try {
    const { error } = await query;
    if (error) console.error(`[teardown] ${label}: ${error.message}`);
  } catch (e) {
    console.error(`[teardown] ${label} threw: ${String(e).slice(0, 120)}`);
  }
};
await wipe("answers", admin.from("answers").delete().eq("session_id", FIXTURE.sessionId));
await wipe("teams", admin.from("teams").delete().eq("session_id", FIXTURE.sessionId));
await wipe("participants", admin.from("participants").delete().eq("session_id", FIXTURE.sessionId));
await wipe("sessions", admin.from("sessions").delete().eq("id", FIXTURE.sessionId));
await wipe("questions", admin.from("questions").delete().eq("quiz_id", session.quiz_id));
await wipe("quizzes", admin.from("quizzes").delete().eq("id", session.quiz_id));
