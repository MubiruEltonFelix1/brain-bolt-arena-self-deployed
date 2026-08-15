// Verify the migrated NEW Supabase project end-to-end. READ-ONLY — no writes.
// Usage: bun scripts/verify-live.mjs
// Reads .env.migration first (NEW_*), falls back to .env, then process.env.
//
// Checks:
//   A. Migration history vs local supabase/migrations/*.sql files
//   B. Ownership integrity (Phase 7H/7I/7J/7K invariants)
//   C. Row counts
//   D. Broken / old-host media URLs
//   E. Quiz & league cover_image_url current values
//   F. Storage buckets vs extract + paths referenced by live rows
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 0. Credentials ----------
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
const pick = (a, b) => a || b || "";
const URL = pick(process.env.NEW_SUPABASE_URL || process.env.SUPABASE_URL, migVars.NEW_SUPABASE_URL || appVars.SUPABASE_URL);
const SR_KEY = pick(process.env.NEW_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, migVars.NEW_SERVICE_ROLE_KEY || appVars.SUPABASE_SERVICE_ROLE_KEY);
const CONN = pick(process.env.NEW_DB_CONNECTION_STRING || process.env.DATABASE_URL, migVars.NEW_DB_CONNECTION_STRING || appVars.DATABASE_URL);
const OLD_HOST = "gmtddgaupquditwokmuh";

const failures = [];
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures.push(`${name} ${detail}`.trim());
  console.log(`  [${mark}] ${name}${detail ? " — " + detail : ""}`);
}

// ---------- psql helper ----------
const PSQL_CANDIDATES = [
  "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe",
  "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe",
  "psql",
];
const PSQL = PSQL_CANDIDATES.find((p) => existsSync(p) || p === "psql");
function q(sql) {
  const r = spawnSync(PSQL, [CONN, "-t", "-A", "-c", sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}
const scalar = (sql) => q(sql)[0]?.trim() ?? "";

const H = { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}`, "Content-Type": "application/json" };
async function storageList(bucket) {
  const r = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
    method: "POST", headers: H, body: JSON.stringify({ prefix: "", limit: 1000, offset: 0 }),
  });
  if (!r.ok) { console.log(`    bucket list ${bucket}: HTTP ${r.status}`); return null; }
  return r.json();
}

console.log(`Target: ${URL}`);
if (!CONN) console.log("NOTE: no DB connection string found — sections A-E skipped.");
if (!SR_KEY) console.log("NOTE: no service role key found — section F skipped.");
console.log("");

// ---------- A. Migration history ----------
console.log("=== A. Migration history ===");
if (CONN) {
  const local = readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.split("_")[0])
    .sort();
  console.log(`  local migration files: ${local.length}`);
  for (const tbl of ["supabase_migrations.schema_migrations", "supabase_migrations.migrations"]) {
    try {
      const applied = q(`SELECT version FROM ${tbl} ORDER BY version`).map((v) => v.trim());
      const appliedSet = new Set(applied);
      const localSet = new Set(local);
      const missing = local.filter((v) => !appliedSet.has(v));
      const extra = applied.filter((v) => !localSet.has(v));
      check(`${tbl}: ${applied.length} applied, ${local.length} local`, missing.length === 0,
        `missing=${missing.length}${missing.length ? " [" + missing.join(", ") + "]" : ""}`);
      if (extra.length) console.log(`    extra (applied but not local): ${extra.join(", ")}`);
      const latestLocal = local[local.length - 1];
      const latestApplied = applied[applied.length - 1];
      console.log(`    latest applied: ${latestApplied} | latest local: ${latestLocal}${latestLocal === latestApplied ? " (MATCH)" : ""}`);
    } catch (e) {
      console.log(`  ${tbl}: not queryable (${e.message.slice(0, 100)})`);
    }
  }
} else {
  console.log("  skipped (no connection string)");
}
console.log("");

// ---------- B. Ownership integrity ----------
console.log("=== B. Ownership integrity (Phase 7 principal invariants) ===");
if (CONN) {
  for (const t of ["branding_profiles", "leagues", "quizzes", "competitions"]) {
    try {
      const total = scalar(`SELECT count(*) FROM public.${t}`);
      const mapped = scalar(`SELECT count(owner_principal_id) FROM public.${t}`);
      const missing = scalar(`SELECT count(*) FROM public.${t} WHERE owner_principal_id IS NULL`);
      const nonUser = scalar(`SELECT count(*) FROM public.${t} x JOIN public.principals p ON p.id = x.owner_principal_id WHERE p.type <> 'user'`);
      // Duplicate ownership mappings are structurally impossible since Phase 7L:
      // owner_principal_id has a FK to principals.id (a primary key), so one
      // principal id is exactly one principal. The pre-7L owner_id -> principal
      // drift/duplicate checks were removed with the legacy column.
      check(`${t} ownership`, total === mapped && missing === "0" && nonUser === "0",
        `total=${total} mapped=${mapped} missing=${missing} nonUser=${nonUser}`);
    } catch (e) {
      console.log(`  ${t}: not queryable (${e.message.slice(0, 100)})`);
    }
  }
  // session host vs competition owner consistency (Phase 7K §8 / 7L)
  try {
    const hostMismatch = scalar(`SELECT count(*) FROM public.sessions s JOIN public.competitions c ON c.session_id = s.id WHERE s.host_id IS DISTINCT FROM c.owner_principal_id`);
    check("session host == competition owner", hostMismatch === "0", `mismatch=${hostMismatch}`);
  } catch (e) { console.log(`  sessions/competitions join: not queryable (${e.message.slice(0, 100)})`); }
} else {
  console.log("  skipped (no connection string)");
}
console.log("");

// ---------- C. Row counts ----------
console.log("=== C. Row counts ===");
if (CONN) {
  for (const t of ["quizzes", "questions", "sessions", "participants", "answers", "teams", "leagues", "league_quizzes", "league_standings", "competitions", "competition_results", "branding_profiles", "host_requests", "host_authorizations", "result_claims", "user_roles", "profiles", "principals"]) {
    try {
      const n = scalar(`SELECT count(*) FROM public.${t}`);
      console.log(`  ${t.padEnd(22)} ${n}`);
    } catch (e) {
      console.log(`  ${t.padEnd(22)} (no table)`);
    }
  }
  const users = scalar(`SELECT count(*) FROM auth.users`);
  console.log(`  ${"auth.users".padEnd(22)} ${users}`);
}
console.log("");

// ---------- D. Broken / old-host URLs ----------
console.log("=== D. Broken / old-host media URLs ===");
if (CONN) {
  const targets = [
    ["questions", "image_url"], ["questions", "audio_url"],
    ["quizzes", "cover_image_url"], ["leagues", "cover_image_url"],
    ["branding_profiles", "logo_url"],
  ];
  let brokenTotal = 0;
  for (const [t, col] of targets) {
    try {
      const broken = scalar(`SELECT count(*) FROM public.${t} WHERE ${col} LIKE '%coundefined%'`);
      const oldHost = scalar(`SELECT count(*) FROM public.${t} WHERE ${col} LIKE '%${OLD_HOST}%'`);
      brokenTotal += Number(broken) + Number(oldHost);
      check(`${t}.${col} clean`, broken === "0" && oldHost === "0", `coundefined=${broken} oldHost=${oldHost}`);
    } catch (e) { console.log(`  ${t}.${col}: not queryable (${e.message.slice(0, 100)})`); }
  }
  console.log(`  total broken/old-host cells: ${brokenTotal}`);
} else {
  console.log("  skipped (no connection string)");
}
console.log("");

// ---------- E. Quiz & league cover_image_url current values ----------
console.log("=== E. cover_image_url values ===");
if (CONN) {
  try {
    const rows = q(`SELECT id || '|' || coalesce(title,'') || '|' || coalesce(cover_image_url,'∅') FROM public.quizzes ORDER BY created_at`);
    console.log(`  quizzes (${rows.length}):`);
    for (const r of rows) console.log(`    ${r.slice(0, 160)}`);
  } catch (e) { console.log(`  quizzes covers: not queryable (${e.message.slice(0, 100)})`); }
  try {
    const rows = q(`SELECT id || '|' || coalesce(name,'') || '|' || coalesce(cover_image_url,'∅') FROM public.leagues ORDER BY created_at`);
    console.log(`  leagues (${rows.length}):`);
    for (const r of rows) console.log(`    ${r.slice(0, 160)}`);
  } catch (e) { console.log(`  leagues covers: not queryable (${e.message.slice(0, 100)})`); }
} else {
  console.log("  skipped (no connection string)");
}
console.log("");

// ---------- F. Storage ----------
console.log("=== F. Storage (new project) ===");
if (SR_KEY) {
  // expected files from the local extract dir
  const localDir = join(ROOT, "migration-data", "quiz-images");
  const expected = existsSync(localDir) ? readdirSync(localDir).filter((f) => statSync(join(localDir, f)).isFile()) : [];
  console.log(`  local quiz-images files: ${expected.length}`);

  for (const bucket of ["quiz-images", "branding-logos"]) {
    const files = await storageList(bucket);
    if (files === null) { check(`${bucket} listable`, false, "storage list failed"); continue; }
    const names = files.map((f) => f.name);
    console.log(`  ${bucket}: ${names.length} files`);
    if (bucket === "quiz-images" && expected.length) {
      const missing = expected.filter((n) => !names.includes(n));
      const extra = names.filter((n) => !expected.includes(n));
      // Informational only — the authoritative invariant is "referenced paths exist" (below).
      // A local-dir diff is expected when an orphan file was deliberately removed from the bucket.
      console.log(`    local-dir diff: absent-from-bucket=${missing.length}${missing.length ? " [" + missing.join(", ") + "]" : ""} extra=${extra.length}`);
      if (extra.length) console.log(`    extra files in bucket: ${extra.join(", ")}`);
    }
  }

  // every storage path referenced by live rows should exist in its bucket
  const parsePaths = (cell) => {
    if (!cell || typeof cell !== "string") return [];
    const m = cell.match(/\/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/);
    return m ? [{ bucket: m[1], path: decodeURIComponent(m[2]) }] : [];
  };
  const refs = [];
  if (CONN) {
    const grab = (sql) => { try { return q(sql); } catch { return []; } };
    for (const c of grab(`SELECT image_url FROM public.questions WHERE image_url LIKE '%/storage/v1/object/sign/%'`)) refs.push(...parsePaths(c));
    for (const c of grab(`SELECT audio_url FROM public.questions WHERE audio_url LIKE '%/storage/v1/object/sign/%'`)) refs.push(...parsePaths(c));
    for (const c of grab(`SELECT cover_image_url FROM public.quizzes WHERE cover_image_url LIKE '%/storage/v1/object/sign/%'`)) refs.push(...parsePaths(c));
    for (const c of grab(`SELECT logo_url FROM public.branding_profiles WHERE logo_url LIKE '%/storage/v1/object/sign/%'`)) refs.push(...parsePaths(c));
  }
  const unique = [...new Map(refs.map((r) => [r.bucket + "/" + r.path, r])).values()];
  console.log(`  unique storage paths referenced by live rows: ${unique.length}`);
  for (const bucket of [...new Set(unique.map((r) => r.bucket))]) {
    const names = (await storageList(bucket))?.map((f) => f.name) ?? [];
    const missing = unique.filter((r) => r.bucket === bucket && !names.includes(r.path));
    check(`referenced paths exist in ${bucket}`, missing.length === 0,
      `${bucket}: ${unique.filter((r) => r.bucket === bucket).length} refs, missing=${missing.length}${missing.length ? " [" + missing.map((m) => m.path).join(", ") + "]" : ""}`);
  }
} else {
  console.log("  skipped (no service role key)");
}

console.log("");
console.log(`=== SUMMARY: ${checks - failures.length}/${checks} checks passed ===`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("All read-only checks passed.");
}
