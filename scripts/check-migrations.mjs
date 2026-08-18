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

import { join } from "node:path";
import { ROOT, createMarkers, createPsqlRunner, findPsql, loadEnv } from "./migration-markers.mjs";

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
const { q, yes } = createPsqlRunner(PSQL, CONN);

const markers = createMarkers({ q, yes });

const results = [];
let failures = 0;
let assumed = 0;
let latestApplied = null;
for (const p of markers) {
  let ok = false;
  let probeFailed = false;
  let note = "";
  try {
    ok = p.applied();
    note = ok ? p.marker : `not applied — marker absent (${p.marker})`;
  } catch (e) {
    probeFailed = true;
    note = `probe failed: ${e.message}`;
  }
  results.push({ p, ok, probeFailed });
  if (ok) {
    latestApplied = p.file;
  } else if (probeFailed) {
    // A probe error is never an assumption — count it as a failure.
    failures++;
  } else if (p.chain) {
    // Chain-implied: the file ran but a later migration superseded its
    // effect (e.g. the final submit_answer implies the earlier rewrites).
    assumed++;
    note = `assumed applied via chain — marker absent (${p.marker})`;
  } else {
    failures++;
  }
  const tag = ok
    ? "APPLIED"
    : !probeFailed && p.chain
      ? "ASSUMED"
      : probeFailed
        ? "PROBE ERR"
        : "PENDING ";
  console.log(`  [${tag}] ${p.file}  — ${note}`);
}

console.log("");
if (latestApplied) console.log(`Latest APPLIED migration: ${latestApplied}`);
console.log(
  `${markers.length - failures}/${markers.length} markers present` +
    (assumed > 0 ? ` · ${assumed} assumed via chain` : ""),
);
if (failures > 0) {
  console.log("PENDING / probe-failed migrations:");
  for (const { p, ok, probeFailed } of results) {
    if (!ok && !probeFailed && !p.chain) console.log(`  - ${p.file}`);
    else if (probeFailed) console.log(`  ! ${p.file} (probe error)`);
  }
  process.exitCode = 1;
} else {
  console.log("All migrations are applied.");
}
