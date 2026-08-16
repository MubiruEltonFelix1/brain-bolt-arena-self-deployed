#!/usr/bin/env bun
// scripts/migrate.mjs — connect to the live Supabase Postgres, report which
// migrations in supabase/migrations/ are applied, and apply pending ones
// automatically, each in its own transaction, in filename order.
//
// Usage:
//   bun scripts/migrate.mjs            # report + apply pending migrations
//   bun scripts/migrate.mjs --dry-run  # report only; exit 1 if anything pending
//
// Connection: reads DATABASE_URL (or NEW_DB_CONNECTION_STRING) from
// process.env, .env, then .env.migration (same chain as check-migrations.mjs).
// psql is discovered via PSQL_PATH or the usual install locations (see
// migration-markers.mjs). Credentials are never printed — only the host.
//
// Why marker-based: the live Supabase project has no supabase_migrations.*
// ledger (Lovable applies migrations outside CLI bookkeeping), so
// applied/pending is only answerable by probing schema state — see
// scripts/migration-markers.mjs, the single source of truth.
//
// Safety model:
//  - Each pending migration runs `psql <CONN> -1 -v ON_ERROR_STOP=1 -f <file>`
//    — one transaction per file; on any error psql sends ROLLBACK, so a
//    failed file leaves no changes.
//  - Every file is re-probed LIVE before applying and again to confirm after
//    (parallel Bwat sessions may apply migrations mid-run; never trust a
//    stale read).
//  - Files WITHOUT a marker entry are NEVER auto-applied (they print UNKNOWN
//    and block the run, exit 1) — add an entry to migration-markers.mjs.
//  - Migrations with an explicit `guard` (e.g. GRANT to a role that may not
//    exist in this DB) are skipped with a warning when the guard fails,
//    without aborting the chain.
//  - The run stops at the first apply failure (exit 3). 7K/7L-1/7L-2/7L-3
//    contain integrity-check DO blocks that hard-stop on drift — a failure
//    there needs human review, not an automatic retry.
//  - Known non-transactional edge: 20260804061631 (pg_cron extension +
//    cron.schedule) and 20260804063722 (cron.alter_job(1, ...) — hardcoded
//    job id 1). Cron state may outlive a rolled-back transaction and the
//    alter_job may error if job 1 does not exist. Both are already applied on
//    the live DB; if they ever show PENDING, review before applying.
//
// Exit codes: 0 = everything applied · 1 = pending/unknown (dry-run) or
// unknown blocks · 2 = no connection string / psql missing / cannot connect ·
// 3 = apply or post-apply confirmation failure.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, createMarkers, findPsql, loadEnv } from "./migration-markers.mjs";

const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const DRY_RUN = process.argv.includes("--dry-run");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: bun scripts/migrate.mjs [--dry-run]\n" +
      "  Connects to Supabase via DATABASE_URL (.env), reports applied/pending\n" +
      "  migrations, and applies pending ones automatically (each in its own\n" +
      "  transaction, in filename order, stopping on the first failure).\n" +
      "  --dry-run  report only; exit 1 if anything is pending.\n",
  );
  process.exit(0);
}

// --- connection ------------------------------------------------------------
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
const PSQL = findPsql();
if (!PSQL) {
  console.error(
    "psql not found. Install PostgreSQL or point PSQL_PATH at psql.exe.",
  );
  process.exit(2);
}
try {
  const host = new URL(CONN).host;
  console.log(`Connected to ${host} (psql: ${PSQL})`);
} catch {
  console.log(`Connected via DATABASE_URL (psql: ${PSQL})`);
}

function run(args) {
  return spawnSync(PSQL, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  });
}
function q(sql) {
  const r = run([CONN, "-t", "-A", "-c", sql]);
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 300)}`);
  return r.stdout.trim();
}
const yes = (sql) => q(sql) === "t";

// Pre-flight: prove we can actually reach the DB before touching anything.
try {
  q("SELECT version()");
} catch (e) {
  console.error(`Cannot connect to the database: ${e.message}`);
  process.exit(2);
}

// --- status ----------------------------------------------------------------
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const markers = createMarkers({ q, yes });
const byFile = new Map(markers.map((m) => [m.file, m]));

const staleEntries = markers.filter((m) => !files.includes(m.file));
for (const s of staleEntries) {
  console.warn(`[WARN] marker entry for missing file: ${s.file}`);
}

const statuses = new Map(); // file -> { state, detail }
for (const file of files) {
  const entry = byFile.get(file);
  if (!entry) {
    statuses.set(file, { state: "UNKNOWN", detail: "no marker entry in scripts/migration-markers.mjs" });
    continue;
  }
  try {
    const applied = entry.applied();
    statuses.set(file, {
      state: applied ? "APPLIED" : "PENDING",
      detail: entry.marker,
      entry,
    });
  } catch (e) {
    statuses.set(file, { state: "PROBE ERROR", detail: e.message, entry });
  }
}

let applied = 0;
let pending = 0;
let unknown = 0;
let errors = 0;
console.log("");
for (const file of files) {
  const s = statuses.get(file);
  const tag =
    s.state === "APPLIED" ? "APPLIED" : s.state === "PENDING" ? "PENDING " : s.state.padEnd(7, " ");
  console.log(`  [${tag}] ${file}  — ${s.detail}`);
  if (s.state === "APPLIED") applied++;
  else if (s.state === "PENDING") pending++;
  else if (s.state === "UNKNOWN") unknown++;
  else errors++;
}
console.log("");
console.log(`${applied}/${files.length} applied · ${pending} pending · ${unknown} unknown · ${errors} probe errors`);

const blocking = errors > 0 || unknown > 0;
if (blocking) {
  console.warn(
    "\nBlocking: some migrations have no marker entry (or a probe failed). " +
      "Add/fix entries in scripts/migration-markers.mjs — files without a marker are never auto-applied.",
  );
}
if (DRY_RUN) {
  if (pending > 0 || blocking) {
    console.log("\nPENDING migrations (dry-run — not applied):");
    for (const file of files) {
      const s = statuses.get(file);
      if (s.state === "PENDING") console.log(`  - ${file}`);
    }
    process.exit(1);
  }
  console.log("\nAll migrations are applied.");
  process.exit(0);
}
if (blocking || pending === 0) {
  process.exit(blocking ? 1 : 0);
}

// --- apply -----------------------------------------------------------------
console.log(`\nApplying ${pending} pending migration(s) in filename order...`);
let appliedNow = 0;
for (const file of files) {
  const s = statuses.get(file);
  if (s.state !== "PENDING") continue;

  // Live re-probe: another session may have applied it since the report.
  try {
    if (s.entry.applied()) {
      console.log(`  [SKIP ] ${file}  — already applied since the status report`);
      applied++;
      continue;
    }
  } catch (e) {
    console.error(`  [FAIL ] ${file}  — re-probe failed: ${e.message}`);
    process.exit(3);
  }

  if (s.entry.guard && !s.entry.guard()) {
    console.log(`  [SKIP ] ${file}  — guard: ${s.entry.guardNote}`);
    continue;
  }

  const filePath = join(MIGRATIONS_DIR, file);
  const r = run([CONN, "-1", "-v", "ON_ERROR_STOP=1", "-q", "-f", filePath]);
  if (r.status !== 0) {
    const stderr = (r.stderr || "").trim().split(/\r?\n/).slice(-15).join("\n");
    console.error(`  [FAIL ] ${file}`);
    console.error(`    psql exited ${r.status}. Last output:\n${stderr}`);
    const remaining = files.filter((f) => {
      const st = statuses.get(f);
      return st && st.state === "PENDING" && f !== file;
    });
    console.error(`\nStopped at first failure. ${remaining.length} migration(s) remain unapplied:`);
    for (const f of remaining) console.error(`  - ${f}`);
    process.exit(3);
  }

  // Confirm via the marker — exit 0 from psql should mean the marker exists.
  let confirmed = false;
  try {
    confirmed = s.entry.applied();
  } catch (e) {
    console.error(`  [FAIL ] ${file}  — post-apply probe failed: ${e.message}`);
    process.exit(3);
  }
  if (!confirmed) {
    console.error(
      `  [FAIL ] ${file}  — psql exited 0 but the marker probe is still false. ` +
        `Investigate before retrying (marker: ${s.entry.marker}).`,
    );
    process.exit(3);
  }
  appliedNow++;
  applied++;
  console.log(`  [OK   ] ${file}  — ${s.entry.marker}`);
}

console.log(`\nDone: ${appliedNow} migration(s) applied this run; ${applied}/${files.length} total applied.`);
process.exit(0);
