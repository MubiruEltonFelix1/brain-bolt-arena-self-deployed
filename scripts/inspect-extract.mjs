// Inspect extracted data quality before building the load script.
import { readFileSync } from "node:fs";

const d = JSON.parse(readFileSync("C:/Users/Administrator/Desktop/brain-bolt-arena-vercel/migration-data/extract.json", "utf8"));

// Question type distribution
const byType = {};
const quizzesById = Object.fromEntries(d.quizzes.map((q) => [q.id, q]));
const qRows = Object.values(d.questionsByQuiz).flat();

for (const q of qRows) byType[q.q_question_type ?? "?"] = (byType[q.q_question_type ?? "?"] || 0) + 1;
console.log("=== QUESTION TYPES ===");
console.log(JSON.stringify(byType, null, 1));

console.log("\n=== SAMPLE QUIZ (first) ===");
console.log(JSON.stringify(d.quizzes[0], null, 1));

// Sample one question of each type
const seen = new Set();
console.log("\n=== QUESTION SAMPLES (one per type) ===");
for (const q of qRows) {
  const t = q.q_question_type ?? "?";
  if (seen.has(t)) continue;
  seen.add(t);
  console.log(`--- ${t} (correct_index=${d.answerKey[q.q_id] ?? "MISSING"})`);
  console.log(JSON.stringify(q, null, 1).slice(0, 800));
}

// Check coverage: quizzes with no recovered questions
console.log("\n=== QUIZ COVERAGE ===");
for (const qz of d.quizzes) {
  const n = (d.questionsByQuiz[qz.id] || []).length;
  console.log(`${n} questions | ${qz.title}`);
}

// Check options keys across all questions
const optKeys = new Set();
for (const q of qRows) if (q.q_options && typeof q.q_options === "object") Object.keys(q.q_options).forEach((k) => optKeys.add(k));
console.log("\n=== OPTIONS JSONB KEYS ===", [...optKeys].join(", "));

// Leagues + standings + branding samples
console.log("\n=== LEAGUES ===");
console.log(JSON.stringify(d.leagues, null, 1).slice(0, 600));
console.log("\n=== STANDINGS ===");
console.log(JSON.stringify(d.league_standings, null, 1).slice(0, 600));
console.log("\n=== BRANDING ===");
console.log(JSON.stringify(d.branding_profiles, null, 1).slice(0, 600));
