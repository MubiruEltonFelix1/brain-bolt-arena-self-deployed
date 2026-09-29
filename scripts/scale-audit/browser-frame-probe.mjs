// Phase 9D.2b §2/§4/§5 — real-browser Broadcast decode diagnostic.
//
// Answers, with measurements (no inference):
//   * the raw WebSocket frames the real /play page receives
//   * the first bytes of every binary frame (kind byte + header)
//   * whether the realtime-js decoder is ENTERED for those frames
//     (DataView is constructed for every frame it decodes; ArrayBuffer#slice
//     is only called on the kind-4 user-broadcast path)
//   * whether the Brain Bolt broadcast handler ultimately runs
//
// No tokens, cookies or secrets are printed: the access token lives in the
// socket URL, which is never logged, and only the first 16 bytes of frames are
// captured (frame header, not payload).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const HERE = import.meta.dir;
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixture.json"), "utf8"));
const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const PORT = 3000;
const PROFILE_NICK = "9d2b-probe-player";

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
  throw new Error("no chromium found under " + base);
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
  if (await ping()) return null;
  const child = spawn("bun", [join(HERE, "serve.mjs")], { stdio: "ignore", shell: true });
  for (let i = 0; i < 40 && !(await ping()); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await ping())) throw new Error("serve.mjs did not come up on " + PORT);
  return child;
}

const server = await ensureServer();
const admin = createClient(vars.VITE_SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// A real participant seat (via the same RPC the join page uses) so /play has an
// identity to subscribe with. Nicknames are unique per session, so a leftover
// seat from an aborted run is cleared first (keeps the probe re-runnable).
await admin
  .from("participants")
  .delete()
  .eq("session_id", FIXTURE.sessionId)
  .eq("nickname", PROFILE_NICK);
const { data: joinRows, error: joinErr } = await admin.rpc("join_session", {
  p_code: FIXTURE.code,
  p_nickname: PROFILE_NICK,
});
if (joinErr) throw new Error("join_session failed: " + joinErr.message);
const seat = Array.isArray(joinRows) ? joinRows[0] : joinRows;
const p = { id: seat.participant_id, secretToken: seat.secret_token };
if (!p.id || !p.secretToken) throw new Error("join_session returned no seat");

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));

// --- instrumentation (lives only in this page instance) ---------------------
await page.evaluateOnNewDocument((sessId, identity) => {
  localStorage.setItem(
    "brainbolt:participants",
    JSON.stringify({ [sessId]: identity }),
  );

  const frames = [];
  const decoder = { dataViews: 0, sliceCalls: [] };
  window.__probe = { frames, decoder };

  const hex = (b, n) =>
    [...new Uint8Array(b).slice(0, n)].map((x) => x.toString(16).padStart(2, "0")).join(" ");

  const record = (data) => {
    try {
      if (data instanceof ArrayBuffer) {
        frames.push({ type: "arraybuffer", len: data.byteLength, head: hex(data, 16) });
      } else if (typeof data === "string") {
        frames.push({ type: "text", len: data.length, head: data.slice(0, 120) });
      } else {
        frames.push({ type: typeof data, len: -1, head: String(data).slice(0, 80) });
      }
    } catch (e) {
      frames.push({ type: "probe-error", len: -1, head: String(e).slice(0, 120) });
    }
  };

  const OrigWS = window.WebSocket;
  const proto = OrigWS.prototype;
  const onmessageDesc = Object.getOwnPropertyDescriptor(proto, "onmessage");
  const wrap = (h) =>
    function (ev) {
      record(ev.data);
      return h && h.call(this, ev);
    };

  function PatchedWebSocket(url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    Object.defineProperty(ws, "onmessage", {
      configurable: true,
      get: () => ws.__wrappedOnMessage,
      set: (h) => {
        ws.__wrappedOnMessage = h;
        onmessageDesc.set.call(ws, wrap(h));
      },
    });
    const add = ws.addEventListener.bind(ws);
    ws.addEventListener = (t, h, o) => add(t, t === "message" ? wrap(h) : h, o);
    return ws;
  }
  PatchedWebSocket.prototype = proto;
  Object.assign(PatchedWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = PatchedWebSocket;

  // realtime-js's Serializer.decode() constructs a DataView for EVERY binary
  // frame, then only touches the payload via ArrayBuffer#slice on the
  // kind-4 (userBroadcast) path. Counting both tells us exactly how far a
  // frame gets.
  const OrigDataView = window.DataView;
  function PatchedDataView(buf, ...rest) {
    if (buf instanceof ArrayBuffer) decoder.dataViews++;
    return new OrigDataView(buf, ...rest);
  }
  PatchedDataView.prototype = OrigDataView.prototype;
  window.DataView = PatchedDataView;

  const origSlice = ArrayBuffer.prototype.slice;
  ArrayBuffer.prototype.slice = function (...args) {
    if (args[0] === 0 && decoder.sliceCalls.length < 12) decoder.sliceCalls.push(this.byteLength);
    return origSlice.apply(this, args);
  };
}, FIXTURE.sessionId, {
  id: p.id,
  sessionId: FIXTURE.sessionId,
  nickname: PROFILE_NICK,
  secretToken: p.secretToken,
});

await page.goto(`http://127.0.0.1:${PORT}/play/${FIXTURE.sessionId}`, {
  waitUntil: "domcontentloaded",
});
await new Promise((r) => setTimeout(r, 7000));

const before = await page.evaluate(() => window.__probe.frames.length);

// Trigger: a score change fires game:answer + game:answer_row from the DB
// trigger; a sessions update fires the postgres_changes path (control group).
const upd = await admin.from("participants").update({ score: 4242 }).eq("id", p.id).select();
if (upd.error) throw new Error("score update failed: " + upd.error.message);
if (!upd.data?.length) throw new Error("score update matched 0 rows (id " + p.id + ")");
await new Promise((r) => setTimeout(r, 1500));
await admin.from("sessions").update({ time_added_ms: 0 }).eq("id", FIXTURE.sessionId);
await new Promise((r) => setTimeout(r, 5000));

const out = await page.evaluate((n) => {
  const all = window.__probe.frames;
  return { total: all.length, first: all.slice(0, 10), fresh: all.slice(n), decoder: window.__probe.decoder };
}, before);

const counterText = await page
  .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400))
  .catch(() => "");

console.log(`=== total frames on the page: ${out.total} ===`);
console.log("=== frames during connect (first 10) ===");
for (const f of out.first) console.log(` [${f.type}] len=${f.len} head=${f.head}`);
console.log("=== frames received after the triggers ===");
for (const f of out.fresh) console.log(` [${f.type}] len=${f.len} head=${f.head}`);
console.log(`=== decoder: DataView constructions=${out.decoder.dataViews} slice calls=${out.decoder.sliceCalls.join(",") || "none"} ===`);
console.log(`=== page errors: ${pageErrors.length ? pageErrors.join(" | ") : "none"} ===`);
console.log(`=== /play text: ${counterText} ===`);

await browser.close();
if (server) server.kill();
await admin.from("participants").delete().eq("id", p.id);
