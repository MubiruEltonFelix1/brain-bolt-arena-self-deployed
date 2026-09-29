#!/usr/bin/env bun
// scripts/scale-audit/private-broadcast-probe.mjs — verifies that the project's
// OWN bundled @supabase/supabase-js/realtime-js version can receive
// DATABASE-PUBLISHED broadcasts on a private session topic, and that
// postgres_changes still works on the same channel.
//
//   bun scripts/scale-audit/private-broadcast-probe.mjs
//
// Exits 0 when both paths deliver; 1 otherwise. This exists because the browser
// app uses the repo's pinned version — a version that silently drops private
// broadcasts (while newer versions work) would break the whole P0-A transport
// for real players while all bot harnesses (newer dep) stay green.
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const HERE = import.meta.dir;
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixture.json"), "utf8"));
const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };

// Instrument the WS used by the library so the join payload and the wire
// encoding (text vs binary) of received broadcasts are visible.
const wsent = [];
const wrecv = [];
if (typeof globalThis.WebSocket === "function") {
  const OrigWS = globalThis.WebSocket;
  globalThis.WebSocket = class extends OrigWS {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (e) => {
        const kind = typeof e.data === "string" ? "text" : e.data instanceof ArrayBuffer ? "binary" : typeof e.data;
        wrecv.push(`${kind}: ${typeof e.data === "string" ? e.data.slice(0, 120) : ""}`);
      });
    }
    send(data) {
      try { if (typeof data === "string" && wsent.length < 4) wsent.push(data.slice(0, 400)); } catch {}
      return super.send(data);
    }
  };
}
const anon = createClient(vars.SUPABASE_URL, vars.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const admin = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// scratch participant so we can trigger `game:answer` (score change) on demand
const nick = `PROBE-${Date.now().toString(36).slice(-4)}`;
const { data: jd, error: jErr } = await anon.rpc("join_session", { p_code: FIXTURE.code, p_nickname: nick });
const row = Array.isArray(jd) ? jd[0] : jd;
if (jErr || !row?.participant_id) { console.error("join failed:", jErr?.message); process.exit(2); }

let broadcasts = 0;
let sessionEvents = 0;
let channelErr = null;
const topic = `session:${FIXTURE.sessionId}`;
const ch = anon
  .channel(topic, { config: { private: true } })
  .on("broadcast", { event: "game:answer" }, () => { broadcasts += 1; })
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${FIXTURE.sessionId}` },
    () => { sessionEvents += 1; });
await new Promise((res) => {
  const to = setTimeout(res, 15000);
  ch.subscribe((s) => { if (s === "SUBSCRIBED") { clearTimeout(to); res(); } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") { channelErr = s; } });
});
console.log(`channel: ${channelErr ? `ERROR ${channelErr}` : "SUBSCRIBED"} (topic ${topic})`);

// trigger 1: participants score change → `game:answer` broadcast
await admin.from("participants").update({ score: 555 }).eq("id", row.participant_id);
// trigger 2: sessions update → postgres_changes
await admin.from("sessions").update({ time_added_ms: 0 }).eq("id", FIXTURE.sessionId);
await new Promise((r) => setTimeout(r, 3000));

console.log(`[anon]      broadcast game:answer received: ${broadcasts} (expected 1)`);
console.log(`[anon]      postgres_changes sessions received: ${sessionEvents} (expected >=1)`);

// ---- authenticated variant (the app's browser carries a host session) --------
let authBroadcasts = 0;
let authSessions = 0;
let authErr = null;
try {
  const au = JSON.parse(readFileSync(join(HERE, "auth-user.json"), "utf8"));
  const authed = createClient(vars.SUPABASE_URL, vars.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { data: si, error: siErr } = await authed.auth.signInWithPassword({ email: au.email, password: au.password });
  if (siErr) throw new Error(siErr.message);
  const asAuthed = createClient(vars.SUPABASE_URL, vars.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${si.session.access_token}` } },
  });
  const ch2 = asAuthed
    .channel(`session:${FIXTURE.sessionId}`, { config: { private: true } })
    .on("broadcast", { event: "game:answer" }, () => { authBroadcasts += 1; })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${FIXTURE.sessionId}` },
      () => { authSessions += 1; });
  await new Promise((res) => {
    const to = setTimeout(res, 15000);
    ch2.subscribe((s) => { if (s === "SUBSCRIBED") { clearTimeout(to); res(); } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") { authErr = s; clearTimeout(to); res(); } });
  });
  await admin.from("participants").update({ score: 556 }).eq("id", row.participant_id);
  await admin.from("sessions").update({ time_added_ms: 0 }).eq("id", FIXTURE.sessionId);
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`[authed]    broadcast game:answer received: ${authBroadcasts} (expected 1)${authErr ? ` — channel ${authErr}` : ""}`);
  console.log(`[authed]    postgres_changes sessions received: ${authSessions} (expected >=1)`);
  await asAuthed.removeChannel(ch2).catch(() => {});
} catch (e) {
  console.log("[authed]    variant failed:", e instanceof Error ? e.message : e);
}

const pass = broadcasts >= 1 && sessionEvents >= 1 && authBroadcasts >= 1 && authSessions >= 1;
console.log(pass ? "PASS — both transports deliver to anon and authenticated subscribers." : "FAIL — deliveries missing (see counts above).");
console.log(`\n[wire] sent frames: ${wsent.length}`);
for (const s of wsent) console.log("  sent:", s.replace(/\s+/g, " "));
const binaryRx = wrecv.filter((r) => r.startsWith("binary")).length;
const textRx = wrecv.filter((r) => r.startsWith("text")).length;
console.log(`[wire] received: text=${textRx} binary=${binaryRx}`);
for (const r of wrecv.slice(-6)) console.log("  recv:", r.replace(/\s+/g, " ").slice(0, 160));

await anon.removeChannel(ch).catch(() => {});
await admin.from("participant_secrets").delete().eq("participant_id", row.participant_id);
await admin.from("participants").delete().eq("id", row.participant_id);
process.exit(pass ? 0 : 1);
