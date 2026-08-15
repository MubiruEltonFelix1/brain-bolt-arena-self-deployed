// Create the storage buckets in the NEW project and upload the recovered files.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env.migration
const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.migration");
const vars = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) vars[m[1]] = m[2];
}
const URL = vars.NEW_SUPABASE_URL;
const SR_KEY = vars.NEW_SERVICE_ROLE_KEY;
if (!URL || !SR_KEY) { console.error("missing NEW_SUPABASE_URL or NEW_SERVICE_ROLE_KEY in .env.migration"); process.exit(1); }

const H = { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}`, "Content-Type": "application/json" };

async function createBucket(name) {
  const r = await fetch(`${URL}/storage/v1/bucket`, { method: "POST", headers: H, body: JSON.stringify({ name, public: false }) });
  if (r.ok) { console.log(`bucket ${name}: created (private)`); return; }
  const body = await r.text();
  if (r.status === 400 && /already exists|duplicate/i.test(body)) { console.log(`bucket ${name}: already exists (ok)`); return; }
  console.log(`bucket ${name}: HTTP ${r.status} ${body.slice(0, 150)}`);
}

async function uploadFile(bucket, filePath, remoteName) {
  const data = readFileSync(filePath);
  const r = await fetch(`${URL}/storage/v1/object/${bucket}/${remoteName}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/octet-stream" },
    body: data,
  });
  if (r.ok) { console.log(`  uploaded ${remoteName} (${data.length} bytes)`); return true; }
  const body = await r.text();
  if (r.status === 400 && /duplicate/i.test(body)) { console.log(`  ${remoteName}: already exists (ok)`); return true; }
  console.log(`  FAILED ${remoteName}: HTTP ${r.status} ${body.slice(0, 150)}`);
  return false;
}

await createBucket("quiz-images");
await createBucket("branding-logos");

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migration-data", "quiz-images");
const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
console.log(`files to upload: ${files.length}`);
for (const f of files) await uploadFile("quiz-images", join(dir, f), f);
console.log("DONE");
