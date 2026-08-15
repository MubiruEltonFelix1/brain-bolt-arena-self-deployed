// Rebuild media URLs correctly: reconstruct from extract.json (which holds the
// original old-project URLs per question), sign fresh against the NEW project,
// and update rows by id. Fixes the previous "supabase.coundefined" corruption.
import { readFileSync } from "node:fs";
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

function q(sql) {
  const r = spawnSync(PSQL, [CONN, "-t", "-A", "-c", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("psql failed: " + r.stderr.slice(0, 500));
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

// 1. Rebuild questionId -> old URL map from the extract
const extract = JSON.parse(readFileSync(join(ROOT, "migration-data", "extract.json"), "utf8"));
const refs = []; // { table, id, col, bucket, path }
for (const q of Object.values(extract.questionsByQuiz).flat()) {
  for (const col of ["q_image_url", "q_audio_url"]) {
    const old = q[col];
    if (!old || typeof old !== "string") continue;
    const m = old.match(/\/object\/sign\/([^/]+)\/([^?]+)/);
    if (!m) { console.log(`SKIP unparseable (${q.q_id}): ${old.slice(0, 90)}`); continue; }
    refs.push({ table: "questions", id: q.q_id, col: col === "q_image_url" ? "image_url" : "audio_url", bucket: m[1], path: m[2] });
  }
}
for (const b of extract.branding_profiles || []) {
  if (!b.logo_url) continue;
  const m = b.logo_url.match(/\/object\/sign\/([^/]+)\/([^?]+)/);
  if (m) refs.push({ table: "branding_profiles", id: b.id, col: "logo_url", bucket: m[1], path: m[2] });
}
console.log(`refs to rebuild: ${refs.length}`);

// 2. Sign fresh and update
const seen = new Map();
let updated = 0;
for (const r of refs) {
  let newUrl = seen.get(r.bucket + "/" + r.path);
  if (!newUrl) {
    const resp = await fetch(`${NEW_URL}/storage/v1/object/sign/${r.bucket}/${r.path}`, {
      method: "POST",
      headers: { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 315360000 }),
    });
    if (!resp.ok) { console.log(`SIGN FAILED ${r.bucket}/${r.path}: HTTP ${resp.status}`); continue; }
    const { signedURL } = await resp.json();
    if (!signedURL) { console.log(`SIGN RESPONSE MISSING signedURL for ${r.bucket}/${r.path}`); continue; }
    newUrl = NEW_URL + "/storage/v1" + signedURL;
    seen.set(r.bucket + "/" + r.path, newUrl);
  }
  q(`UPDATE public.${r.table} SET ${r.col} = '${newUrl.replace(/'/g, "''")}' WHERE id = '${r.id}'`);
  updated++;
  console.log(`ok ${r.table}.${r.col} ${r.id.slice(0, 8)} -> ${r.path}`);
}
console.log(`\nUPDATED ${updated} rows (${seen.size} unique files)`);

// 3. Final verification
const broken = q(`SELECT count(*) FROM public.questions WHERE image_url LIKE '%coundefined%' OR audio_url LIKE '%coundefined%'`);
const good = q(`SELECT count(*) FROM public.questions WHERE (image_url LIKE '%/storage/v1/object/sign/%' OR audio_url LIKE '%/storage/v1/object/sign/%')`);
console.log(`broken urls remaining: ${broken[0]}`);
console.log(`correct signed urls: ${good[0]}`);
