// Rewrite stored media URLs from OLD project storage to NEW project storage.
// Old URLs look like: https://gmtddgaupquditwokmuh.supabase.co/storage/v1/object/sign/<bucket>/<path>?token=...
// New URLs are freshly signed (10-year) against the NEW project.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = {};
for (const line of readFileSync(join(ROOT, ".env.migration"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) vars[m[1]] = m[2];
}
const PSQL = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const CONN = vars.NEW_DB_CONNECTION_STRING;
const NEW_URL = vars.NEW_SUPABASE_URL;
const SR_KEY = vars.NEW_SERVICE_ROLE_KEY;
const OLD = "gmtddgaupquditwokmuh";

function q(sql) {
  const r = spawnSync(PSQL, [CONN, "-t", "-A", "-c", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("psql failed: " + r.stderr.slice(0, 500));
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

// Collect old URLs per table/column
const targets = [
  { table: "questions", col: "image_url", id: "id" },
  { table: "questions", col: "audio_url", id: "id" },
  { table: "branding_profiles", col: "logo_url", id: "id" },
  { table: "quizzes", col: "cover_image_url", id: "id" },
];

const seen = new Map(); // oldUrl -> newUrl
const updates = [];

for (const t of targets) {
  const colExists = q(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='${t.table}' AND column_name='${t.col}'`);
  if (colExists[0] === "0") { console.log(`SKIP ${t.table}.${t.col} (column does not exist)`); continue; }
  const rows = q(`SELECT ${t.id} || '|' || ${t.col} FROM public.${t.table} WHERE ${t.col} LIKE '%${OLD}%'`);
  for (const row of rows) {
    const idx = row.indexOf("|");
    const id = row.slice(0, idx);
    const oldUrl = row.slice(idx + 1);
    // extract bucket/path from /object/sign/<bucket>/<path>?token=...
    const m = oldUrl.match(/\/object\/sign\/([^/]+)\/([^?]+)/);
    if (!m) { console.log(`SKIP unparseable: ${oldUrl.slice(0, 80)}`); continue; }
    const bucket = m[1], path = m[2];
    let newUrl = seen.get(oldUrl);
    if (!newUrl) {
      const r = await fetch(`${NEW_URL}/storage/v1/object/sign/${bucket}/${path}`, {
        method: "POST",
        headers: { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 315360000 }), // 10 years
      });
      if (!r.ok) { console.log(`SIGN FAILED ${bucket}/${path}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
      const { signedUrl } = await r.json();
      newUrl = NEW_URL + signedUrl;
      seen.set(oldUrl, newUrl);
    }
    updates.push({ table: t.table, col: t.col, id, newUrl });
    console.log(`${t.table}.${t.col} ${id.slice(0, 8)}: ${path}`);
  }
}

// Apply updates
for (const u of updates) {
  q(`UPDATE public.${u.table} SET ${u.col} = '${u.newUrl.replace(/'/g, "''")}' WHERE id = '${u.id}'`);
}
console.log(`\nUPDATED ${updates.length} media references (${seen.size} unique files)`);

// Verify remaining old references
for (const t of targets) {
  const n = q(`SELECT count(*) FROM public.${t.table} WHERE ${t.col} LIKE '%${OLD}%'`);
  if (n.length && n[0] !== "0") console.log(`REMAINING OLD REFS in ${t.table}.${t.col}: ${n[0]}`);
}
console.log("DONE");
