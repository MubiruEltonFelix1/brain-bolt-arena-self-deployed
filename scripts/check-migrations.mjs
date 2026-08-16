// Check which migrations have actually been applied to the live Supabase
// project. READ-ONLY — no writes.
// Usage: bun scripts/check-migrations.mjs
// Reads DATABASE_URL from .env / .env.migration / process.env (like
// migrate.mjs and verify-live.mjs). Never prints credentials.
//
// Why this exists: the live project has no supabase_migrations.* ledger
// (Lovable applies migrations outside CLI bookkeeping), so "applied or not"
// is only answerable by probing schema state. Each migration leaves a
// detectable marker; the marker map lives in scripts/migration-markers.mjs
// (the single source of truth — shared with scripts/migrate.mjs).
//
// Output: one [APPLIED]/[PENDING ] line per migration in supabase/migrations/,
// then the latest applied migration and a pending list. Exit code 1 when
// anything is pending / unprobeable. Previously this script probed only the
// 7 most recent migrations; it now reports all of them (superset — same
// format).

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, createMarkers, findPsql, loadEnv } from "./migration-markers.mjs";

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
  console.error("psql not found. Install PostgreSQL or point PSQL_PATH at psql.exe.");
  process.exit(2);
}
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

const markers = createMarkers({ q, yes });

let failures = 0;
let latestApplied = null;
for (const p of markers) {
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
console.log(`${markers.length - failures}/${markers.length} markers present`);
if (failures > 0) {
  console.log("PENDING migrations (markers missing on the live DB):");
  for (const p of markers) {
    try {
      if (!p.applied()) console.log(`  - ${p.file}`);
    } catch {}
  }
  process.exitCode = 1;
} else {
  console.log("All migrations are applied.");
}
