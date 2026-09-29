#!/usr/bin/env bun
// Independent replication: run the repo's OWN scripts/load-test.mjs against the
// fixture session, driving host state (start + reveal) via service role.
//   bun run-official-lt.mjs --players 100 [--burst 100]
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ROOT, loadEnv } from "../migration-markers.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const PLAYERS = arg("players", "100");
const BURST = arg("burst", PLAYERS);
const HERE = import.meta.dir;
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixture.json"), "utf8"));
const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const admin = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// purge leftover participants + reset to lobby
{
  const { data: stale } = await admin.from("participants").select("id").eq("session_id", FIXTURE.sessionId);
  const ids = (stale ?? []).map((p) => p.id);
  if (ids.length) {
    await admin.from("answers").delete().eq("session_id", FIXTURE.sessionId);
    await admin.from("participant_secrets").delete().in("participant_id", ids);
    await admin.from("participants").delete().in("id", ids);
  }
  await admin.from("sessions").update({ status: "lobby", current_question_index: -1, current_question_revealed: false, current_question_started_at: null, paused_at: null, time_added_ms: 0 }).eq("id", FIXTURE.sessionId);
}
console.log(`[orchestrator] starting official load-test: players=${PLAYERS} burst=${BURST} code=${FIXTURE.code}`);

const child = spawn("bun", [join(ROOT, "scripts", "load-test.mjs"), "--code", FIXTURE.code, "--players", String(PLAYERS), "--burst", String(BURST)], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
let flipped = false;
let revealed = false;
let qStart = 0;
child.stdout.on("data", async (d) => {
  out += d.toString();
  process.stdout.write(d);
  if (!flipped && out.includes("Waiting for session status")) {
    flipped = true;
    qStart = Date.now();
    console.log(`[orchestrator] flipping session to active (q0)`);
    await admin.from("sessions").update({
      status: "active", current_question_index: 0, current_question_started_at: new Date().toISOString(),
      current_question_revealed: false, paused_at: null, time_added_ms: 0,
    }).eq("id", FIXTURE.sessionId);
  }
  if (flipped && !revealed && out.includes("Submitting answers")) {
    // reveal ~9s after answers start (so the answers phase finishes first)
    setTimeout(async () => {
      if (revealed) return;
      revealed = true;
      console.log(`[orchestrator] flipping reveal (t+~9s)`);
      await admin.from("sessions").update({ current_question_revealed: true }).eq("id", FIXTURE.sessionId);
    }, 9000);
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));
child.on("exit", (code) => {
  console.log(`[orchestrator] load-test exited with code ${code}`);
  process.exit(code ?? 0);
});
