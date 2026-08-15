// Quantify answer-recovery gaps for number / map_pin / type questions.
import { readFileSync } from "node:fs";

const d = JSON.parse(readFileSync("C:/Users/Administrator/Desktop/brain-bolt-arena-vercel/migration-data/extract.json", "utf8"));
const qRows = Object.values(d.questionsByQuiz).flat();

const interesting = qRows.filter((q) => ["number", "map_pin", "type", "ordering"].includes(q.q_question_type));
console.log("=== number / map_pin / type / ordering questions (full dump) ===");
for (const q of interesting) {
  const opts = Array.isArray(q.q_options) ? JSON.stringify(q.q_options) : JSON.stringify(q.q_options);
  console.log(`[${q.q_question_type}] "${q.q_text.slice(0, 60)}"`);
  console.log(`   options=${opts.slice(0, 200)} min=${q.q_number_min} max=${q.q_number_max} dist=${q.q_max_distance_km}`);
}
