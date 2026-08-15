// Restore the backup dump into the NEW Supabase project.
// Sequence: auth users+identities (data-only) -> public schema+data -> realtime publication fix.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(ROOT, ".env.migration");
const vars = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) vars[m[1]] = m[2];
}
const CONN = vars.NEW_DB_CONNECTION_STRING;
if (!CONN) { console.error("NEW_DB_CONNECTION_STRING missing"); process.exit(1); }

const PGRESTORE = "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe";
const PSQL = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const DUMP = "C:\\Users\\Administrator\\Desktop\\brain_bolt_arena\\brain-bolt-arena_260815.backup\\brain-bolt-arena_260815.backup";

function run(label, args, opts = {}) {
  console.log(`\n===== ${label} =====`);
  const r = spawnSync(args[0], args.slice(1), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.stdout) console.log(r.stdout.slice(0, 8000));
  if (r.stderr) console.log("STDERR:", r.stderr.slice(0, 8000));
  console.log(`exit: ${r.status}${r.error ? " (" + r.error.message + ")" : ""}`);
  return r.status;
}

const step = process.argv[2] ?? "all";

if (step === "auth" || step === "all") {
  run("RESTORE auth.users + auth.identities (data-only)", [
    PGRESTORE,
    "--data-only", "--no-owner",
    "--table=auth.users", "--table=auth.identities",
    "-d", CONN, DUMP,
  ]);
}

if (step === "public" || step === "all") {
  run("RESTORE public schema + data", [
    PGRESTORE,
    "--schema=public", "--no-owner",
    "-d", CONN, DUMP,
  ]);
}

if (step === "realtime" || step === "all") {
  run("REALTIME publication membership", [
    PSQL, CONN, "-c",
    `ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions, public.participants, public.answers, public.teams, public.league_standings, public.quizzes, public.questions, public.leagues, public.branding_profiles, public.competitions;`,
  ]);
}

console.log("\nALL DONE");
