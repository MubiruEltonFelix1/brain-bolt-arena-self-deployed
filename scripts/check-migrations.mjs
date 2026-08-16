// Check which migrations have actually been applied to the live Supabase
// project. READ-ONLY — no writes.
// Usage: bun scripts/check-migrations.mjs
// Reads DATABASE_URL from .env / .env.migration / process.env (like
// verify-live.mjs). Never prints credentials.
//
// Why this exists: the live project has no supabase_migrations.* ledger
// (Lovable applies migrations outside CLI bookkeeping), so "applied or not"
// is only answerable by probing schema state. Each recent migration leaves a
// detectable marker; this script probes those markers and reports the last
// applied migration.
//
// Marker map (only migrations with a detectable marker are listed):
//   20260816120000 (7K competitions)      → competitions table exists
//   20260816124500 (7L-1 authorization)   → quizzes_sync_owner_principal_trg exists
//   20260816130000 (7L-2 retire triggers) → that trigger is GONE
//   20260816131500 (7L-3 retire owner_id) → quizzes.owner_id column is GONE
//   20260817060000 (8B idempotency)       → mcp_idempotency_keys table exists
//   20260817120000 (admin timeseries)     → admin_stats_timeseries(integer) exists
//   20260817130000 (admin insights)       → admin_session_funnel() exists
// Plus a can() ownership-style probe to disambiguate "7L-1 never ran" from
// "7L-2 ran" when the trigger is missing but owner_id is still present.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(file) {
  const vars = {};
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}
const migVars = loadEnv(join(ROOT, ".env.migration"));
const appVars = loadEnv(join(ROOT, ".env"));
const CONN =
  process.env.NEW_DB_CONNECTION_STRING ||
  process.env.DATABASE_URL ||
  migVars.NEW_DB_CONNECTION_STRING ||
  migVars.DATABASE_URL ||
  appVars.DATABASE_URL ||
  "";

if (!CONN) {
  console.error("No DATABASE_URL found in .env / .env.migration / process.env.");
  process.exit(2);
}

const PSQL_CANDIDATES = [
  "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe",
  "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe",
  "psql",
];
const PSQL = PSQL_CANDIDATES.find((p) => existsSync(p) || p === "psql");
function q(sql) {
  const r = spawnSync(PSQL, [CONN, "-t", "-A", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 300)}`);
  return r.stdout.trim();
}
const yes = (sql) => q(sql) === "t";

// Migration → probe. "applied" predicate returns true when the marker exists.
const PROBES = [
  {
    file: "20260816120000_43048aa5 (7K competitions)",
    applied: () => q(`SELECT to_regclass('public.competitions') IS NOT NULL`) === "t",
    marker: "competitions table exists",
  },
  {
    file: "20260816124500_phase_7l_authorization_completion",
    // Authoritative marker that survives 7L-2: can() resolves ownership
    // principal-only. The sync trigger this migration created only exists in
    // the window between 7L-1 and 7L-2, so it is not a persistent marker.
    applied: () =>
      q(`SELECT prosrc FROM pg_proc WHERE proname = 'can' AND pronargs = 3`).includes(
        "owner_principal_id = public.principal_for_user(v_user)",
      ),
    marker: "can() resolves ownership principal-only",
  },
  {
    file: "20260816130000_phase_7l_retire_sync_triggers",
    // Only meaningful once 7L-1 is confirmed applied (otherwise the absent
    // trigger just means 7L-1 never ran).
    applied: () => {
      const canBody = q(`SELECT prosrc FROM pg_proc WHERE proname = 'can' AND pronargs = 3`);
      if (!canBody.includes("owner_principal_id = public.principal_for_user(v_user)")) return false;
      return q(`SELECT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'quizzes_sync_owner_principal_trg')`) === "t";
    },
    marker: "sync triggers absent (7L-1 can() confirmed)",
  },
  {
    file: "20260816131500_phase_7l_retire_owner_id_columns",
    applied: () =>
      yes(`SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quizzes' AND column_name = 'owner_id')`),
    marker: "quizzes.owner_id column absent",
  },
  {
    file: "20260817060000_3f7c9d21 (8B mcp idempotency)",
    applied: () => q(`SELECT to_regclass('public.mcp_idempotency_keys') IS NOT NULL`) === "t",
    marker: "mcp_idempotency_keys table exists",
  },
  {
    file: "20260817120000_admin_statistics_timeseries",
    applied: () => q(`SELECT to_regprocedure('public.admin_stats_timeseries(integer)') IS NOT NULL`) === "t",
    marker: "admin_stats_timeseries(integer) exists",
  },
  {
    file: "20260817130000_admin_statistics_insights",
    applied: () => q(`SELECT to_regprocedure('public.admin_session_funnel()') IS NOT NULL`) === "t",
    marker: "admin_session_funnel() exists",
  },
];

let failures = 0;
let latestApplied = null;
for (const p of PROBES) {
  let ok = false;
  let note = "";
  try {
    ok = p.applied();
    note = ok ? p.marker : `not applied — marker absent (${p.marker})`;
  } catch (e) {
    note = `probe failed: ${e.message}`;
  }
  if (ok) latestApplied = p.file;
  else failures++;
  console.log(`  [${ok ? "APPLIED" : "PENDING "}] ${p.file}  — ${note}`);
}

console.log("");
if (latestApplied) console.log(`Latest APPLIED migration: ${latestApplied}`);
console.log(`${PROBES.length - failures}/${PROBES.length} markers present`);
if (failures > 0) {
  console.log("PENDING migrations (markers missing on the live DB):");
  for (const p of PROBES) {
    try {
      if (!p.applied()) console.log(`  - ${p.file}`);
    } catch {}
  }
  process.exitCode = 1;
} else {
  console.log("All probed migrations are applied.");
}
