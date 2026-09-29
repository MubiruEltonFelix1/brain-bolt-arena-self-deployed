#!/usr/bin/env bun
// scripts/scale-audit/create-auth-user.mjs — throwaway host user for the browser
// profiler (profile.mjs). Creates a confirmed auth user with the same
// combination a real host has — `host` role + an active `time`
// host_authorization grant — and writes auth-user.json next to this script.
//
//   bun scripts/scale-audit/create-auth-user.mjs
//
// Remove it later (it is also deleted by `fixture.mjs cleanup`).
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const HERE = import.meta.dir;
const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const admin = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const email = `bwat-audit-${Date.now().toString(36)}@example.com`;
const password = `Aa1!${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) {
  console.error("createUser failed:", error.message);
  process.exit(1);
}
const userId = created.user.id;
await admin.from("user_roles").insert({ user_id: userId, role: "host" });
await admin.from("host_authorizations").insert({
  profile_id: userId,
  authorization_type: "time",
  status: "active",
  starts_at: new Date(Date.now() - 60_000).toISOString(),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  notes: "temporary grant — scripts/scale-audit (browser profiler)",
});

// The profiler logs in through the UI; the app needs the quiz to be READABLE by
// this user, so the fixture quiz must be owned by it. If fixture.json exists,
// re-own the fixture quiz + host the fixture session as this user.
try {
  const fixture = JSON.parse(await Bun.file(join(HERE, "fixture.json")).text());
  const { data: principal } = await admin.from("principals").select("id").eq("user_id", userId).maybeSingle();
  const owner = principal?.id ?? userId;
  await admin.from("quizzes").update({ owner_principal_id: owner }).eq("id", fixture.quizId);
  await admin.from("sessions").update({ host_id: userId }).eq("id", fixture.sessionId);
  console.log(`Re-owned fixture quiz ${fixture.quizId} and re-hosted session ${fixture.sessionId}.`);
} catch {
  console.log("(no fixture.json yet — run fixture.mjs create first for the quiz-ownership step)");
}

writeFileSync(join(HERE, "auth-user.json"), JSON.stringify({ email, password, userId }, null, 2));
console.log(`Wrote auth-user.json for ${userId} (${email}).`);
