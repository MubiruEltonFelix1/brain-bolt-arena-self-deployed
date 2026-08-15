// Extract all recoverable content from the OLD Supabase project using the
// anon (publishable) key. No service role key needed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://gmtddgaupquditwokmuh.supabase.co";
const KEY = "sb_publishable_PeR5-ekgLldfhyGHKK3qQw_gO67iDgK";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "migration-data");
mkdirSync(OUT, { recursive: true });

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rows(table, select = "*") {
  const r = await fetch(`${URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`, { headers: H });
  if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

async function rpc(fn, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// 1. Content tables
const out = {};
for (const t of ["quizzes", "leagues", "league_quizzes", "league_standings", "branding_profiles", "result_claims", "user_roles", "principals", "profiles"]) {
  try { out[t] = await rows(t); console.log(`${t}: ${out[t].length}`); }
  catch (e) { console.log(`${t}: SKIPPED (${e.message})`); out[t] = []; }
}

// 2. Sessions (for question + answer-key recovery)
out.sessions = await rows("sessions");
console.log(`sessions: ${out.sessions.length}`);

// 3. Questions via RPC per unique quiz, correct_index via answer key on ended sessions
const quizIds = [...new Set(out.sessions.map((s) => s.quiz_id).filter(Boolean))];
console.log(`distinct quizzes in sessions: ${quizIds.length}`);

const byQuiz = {};
const answerKey = {};
const endedSessions = out.sessions.filter((s) => s.status === "ended");

for (const quizId of quizIds) {
  const sess = out.sessions.find((s) => s.quiz_id === quizId);
  if (!sess) continue;
  try {
    byQuiz[quizId] = await rpc("get_session_questions", { p_session_id: sess.id });
  } catch (e) {
    console.log(`  questions for ${quizId}: FAILED (${e.message})`);
  }
  const ended = endedSessions.find((s) => s.quiz_id === quizId);
  if (ended) {
    try {
      for (const k of await rpc("get_session_answer_key", { p_session_id: ended.id })) {
        answerKey[k.question_id] = k.correct_index;
      }
    } catch (e) {
      console.log(`  answer key for ${quizId}: unavailable (${e.message})`);
    }
  }
}
out.questionsByQuiz = byQuiz;
out.answerKey = answerKey;
const qCount = Object.values(byQuiz).reduce((a, q) => a + q.length, 0);
console.log(`questions recovered: ${qCount}; answer-key entries: ${Object.keys(answerKey).length}`);

// 4. Storage files
async function listFiles(bucket) {
  const r = await fetch(`${URL}/storage/v1/object/list/${bucket}`, { method: "POST", headers: H, body: JSON.stringify({ prefix: "", limit: 1000, offset: 0 }) });
  if (!r.ok) { console.log(`bucket ${bucket}: HTTP ${r.status}`); return []; }
  return r.json();
}
out.storage = {};
for (const bucket of ["quiz-images", "branding-logos"]) {
  const files = await listFiles(bucket);
  out.storage[bucket] = files.map((f) => ({ name: f.name, id: f.id, size: f.metadata?.size ?? f.metadata?.size ?? 0 }));
  console.log(`bucket ${bucket}: ${files.length} files`);
  // Download each
  for (const f of files) {
    const r = await fetch(`${URL}/storage/v1/object/${bucket}/${f.name}`, { headers: H });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const dir = OUT + bucket.replace(/[^a-z0-9_-]/gi, "_") + "/";
      mkdirSync(dir, { recursive: true });
      writeFileSync(dir + f.name.replace(/\//g, "__"), buf);
      console.log(`  downloaded ${f.name} (${buf.length} bytes)`);
    } else {
      console.log(`  FAILED ${f.name}: HTTP ${r.status}`);
    }
  }
}

writeFileSync(OUT + "extract.json", JSON.stringify(out, null, 2));
console.log("DONE ->", OUT);
