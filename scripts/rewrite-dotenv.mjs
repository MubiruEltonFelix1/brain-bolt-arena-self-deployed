// Rewrite the Vercel copy's .env with the NEW project's values (from .env.migration).
// Prints only key names, never values.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = {};
for (const line of readFileSync(join(ROOT, ".env.migration"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) vars[m[1]] = m[2];
}

const URL = "https://yzjdaoelllemcvymsffp.supabase.co";
const REF = "yzjdaoelllemcvymsffp";
const anon = vars.NEW_ANON_KEY;
const srv = vars.NEW_SERVICE_ROLE_KEY;
if (!anon || !srv) { console.error("NEW_ANON_KEY / NEW_SERVICE_ROLE_KEY missing in .env.migration"); process.exit(1); }

const env = [
  `SUPABASE_PROJECT_ID="${REF}"`,
  `SUPABASE_PUBLISHABLE_KEY="${anon}"`,
  `SUPABASE_URL="${URL}"`,
  `SUPABASE_SERVICE_ROLE_KEY="${srv}"`,
  `VITE_SUPABASE_PROJECT_ID="${REF}"`,
  `VITE_SUPABASE_PUBLISHABLE_KEY="${anon}"`,
  `VITE_SUPABASE_URL="${URL}"`,
  "",
].join("\n");

writeFileSync(join(ROOT, ".env"), env, "utf8");
console.log("WROTE .env with keys:", env.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("=")[0]).join(", "));
