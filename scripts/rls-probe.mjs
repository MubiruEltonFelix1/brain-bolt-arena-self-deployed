#!/usr/bin/env bun
// scripts/rls-probe.mjs — RLS regression probe for live-game session access.
//
// Verifies the Phase 9D.2 P0-C fix and guards against future regressions.
// Matrix (each check runs with the *right* identity for what it asserts):
//
//   1 GUEST            (anon)                       → reads a session by code
//   2 PLAYER           (authed, no role/grant)      → reads a session by code        ← the P0-C fix
//   3 PLAYER           (authed, no role/grant)      → session+quiz embed resolves    ← the P0-C fix
//   4 PLAYER           (authed, no role/grant)      → CANNOT mutate a session        ← write gate intact
//   5 HOST             (authorized user)            → reads its own session
//   6 HOST             (authorized user)            → mutates its own session
//
// Creates its own throwaway user + two scratch sessions and removes everything
// afterwards. Run against the live project:
//
//   bun scripts/rls-probe.mjs
//
// Exit code 0 = all checks pass, 1 = regression, 2 = setup error.
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { ROOT, loadEnv } from "./migration-markers.mjs";

const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const URL = vars.SUPABASE_URL;
const ANON = vars.SUPABASE_PUBLISHABLE_KEY;
const SERVICE = vars.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(2);
}
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false } });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};
const stamp = Date.now().toString(36);
const email = `bwat-rls-probe-${stamp}@example.com`;
const password = `Aa1!${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
let userId = null;
let quizA = null; // quiz attached to the admin-hosted session
let sessionA = null; // admin-hosted session (used for GUEST/PLAYER checks)
let sessionB = null; // user-owned session (used for HOST checks)

try {
  // ---- setup -----------------------------------------------------------------
  const { data: created, error: cuErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (cuErr) throw new Error(`createUser: ${cuErr.message}`);
  userId = created.user.id;

  // An existing admin hosts the first session (the trigger accepts admins).
  const { data: admins } = await admin.from("user_roles").select("user_id").eq("role", "admin").limit(1);
  const adminId = admins?.[0]?.user_id;
  if (!adminId) throw new Error("no admin user found to host the probe session");

  const { data: quiz, error: qErr } = await admin
    .from("quizzes")
    .insert({ owner_principal_id: (await admin.from("principals").select("id").eq("user_id", adminId).maybeSingle()).data?.id ?? adminId, title: `ZZZ RLS PROBE ${stamp}`, time_per_question: 20 })
    .select("id")
    .single();
  if (qErr) throw new Error(`quiz insert: ${qErr.message}`);
  quizA = quiz.id;
  const { data: sA, error: sAErr } = await admin
    .from("sessions")
    .insert({ quiz_id: quizA, host_id: adminId, code: String(100000 + Math.floor(Math.random() * 900000)), status: "lobby", team_mode: false, question_order: [] })
    .select("id,code")
    .single();
  if (sAErr) throw new Error(`session insert: ${sAErr.message}`);
  sessionA = sA;

  // ---- 1. GUEST --------------------------------------------------------------
  const g = await anon.from("sessions").select("id,code,status").eq("code", sessionA.code).maybeSingle();
  check("1 GUEST can read a session by code", !!g.data && !g.error, g.error ? g.error.message : g.data ? `row ${g.data.code}` : "null");

  // ---- 2-4. PLAYER (authenticated, no role, no grant) ------------------------
  const player = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: siErr } = await player.auth.signInWithPassword({ email, password });
  if (siErr) throw new Error(`signIn: ${siErr.message}`);
  const asPlayer = createClient(URL, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });

  const p = await asPlayer.from("sessions").select("id,code,status").eq("code", sessionA.code).maybeSingle();
  check("2 PLAYER (non-host) reads session by code", !!p.data && !p.error, p.error ? p.error.message : p.data ? `row ${p.data.code}` : "null  <- P0-C REGRESSION");

  const pEmbed = await asPlayer
    .from("sessions")
    .select("id,code,status,quiz:quizzes(title,time_per_question)")
    .eq("code", sessionA.code)
    .maybeSingle();
  check("3 PLAYER sees session+quiz embed (join page)", !!pEmbed.data?.quiz, pEmbed.error ? pEmbed.error.message : String(pEmbed.data?.quiz?.title ?? "null  <- P0-C REGRESSION"));

  const w = await asPlayer.from("sessions").update({ time_added_ms: 0 }).eq("id", sessionA.id).select("id");
  check("4 PLAYER cannot mutate a session", (w.data ?? []).length === 0, w.error ? `error: ${w.error.message}` : `${(w.data ?? []).length} rows updated (expected 0)`);

  // ---- 5-6. HOST (authorized user, own session) ------------------------------
  await admin.from("user_roles").insert({ user_id: userId, role: "host" });
  await admin.from("host_authorizations").insert({
    profile_id: userId,
    authorization_type: "time",
    status: "active",
    starts_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    notes: "temporary grant — scripts/rls-probe.mjs",
  });
  const { data: sB, error: sBErr } = await admin
    .from("sessions")
    .insert({ quiz_id: quizA, host_id: userId, code: String(100000 + Math.floor(Math.random() * 900000)), status: "lobby", team_mode: false, question_order: [] })
    .select("id,code")
    .single();
  if (sBErr) throw new Error(`host session insert: ${sBErr.message}`);
  sessionB = sB;

  const h = await asPlayer.from("sessions").select("id,code,status").eq("id", sessionB.id).maybeSingle();
  check("5 HOST reads its own session", !!h.data && !h.error, h.error ? h.error.message : "row");

  const hw = await asPlayer.from("sessions").update({ time_added_ms: 0 }).eq("id", sessionB.id).select("id");
  check("6 HOST mutates its own session", (hw.data ?? []).length === 1, hw.error ? `error: ${hw.error.message}` : `${(hw.data ?? []).length} rows updated (expected 1)`);

  // ---- 7. SPOOFING (brief §33): clients must not be able to publish to the
  //         private session topic. A subscriber listens while both an anon and
  //         an authenticated client attempt to forge a `game:answer` event.
  // ---------------------------------------------------------------------------
  const topic = `session:${sessionA.id}`;
  const listener = createClient(URL, ANON, { auth: { persistSession: false } });
  let received = 0;
  const listenCh = listener
    .channel(topic, { config: { private: true } })
    .on("broadcast", { event: "game:answer" }, () => { received += 1; });
  const subscribed = await new Promise((res) => {
    const to = setTimeout(() => res(false), 15000);
    listenCh.subscribe((s) => { if (s === "SUBSCRIBED") { clearTimeout(to); res(true); } });
  });
  if (!subscribed) throw new Error("listener could not subscribe to the private topic");

  const forged = { participant_id: "00000000-0000-0000-0000-000000000000", score: 999999, streak: 99 };
  // anon publish attempt
  const anonPublish = createClient(URL, ANON, { auth: { persistSession: false } });
  const anonCh = anonPublish.channel(topic, { config: { private: true } });
  await new Promise((res) => anonCh.subscribe((s) => (s === "SUBSCRIBED" ? res() : s === "CHANNEL_ERROR" ? res() : undefined)));
  await anonCh.send({ type: "broadcast", event: "game:answer", payload: forged }).catch(() => {});
  // authenticated (non-host, non-member) publish attempt
  const playerCh = asPlayer.channel(topic, { config: { private: true } });
  await new Promise((res) => playerCh.subscribe((s) => (s === "SUBSCRIBED" ? res() : s === "CHANNEL_ERROR" ? res() : undefined)));
  await playerCh.send({ type: "broadcast", event: "game:answer", payload: forged }).catch(() => {});
  // direct PostgREST reach at realtime.send (should not be exposed/authorized)
  const rpcAttempt = await asPlayer.schema("realtime").rpc("send", {
    payload: forged, event: "game:answer", topic, private: true,
  }).then(() => "reached").catch(() => "blocked");

  await new Promise((r) => setTimeout(r, 1800));
  check("7 clients cannot forge gameplay broadcasts", received === 0, `spoofed events received by subscriber: ${received}; realtime.send via RPC: ${rpcAttempt}`);
  await listener.removeChannel(listenCh).catch(() => {});
  await anonPublish.removeChannel(anonCh).catch(() => {});
  await asPlayer.removeChannel(playerCh).catch(() => {});

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("probe error:", e instanceof Error ? e.message : e);
  process.exitCode = 2;
} finally {
  for (const s of [sessionA, sessionB]) if (s) await admin.from("sessions").delete().eq("id", s.id);
  if (quizA) {
    await admin.from("questions").delete().eq("quiz_id", quizA);
    await admin.from("quizzes").delete().eq("id", quizA);
  }
  if (userId) {
    await admin.from("host_authorizations").delete().eq("profile_id", userId);
    await admin.from("user_roles").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
  console.log("cleanup done");
}
