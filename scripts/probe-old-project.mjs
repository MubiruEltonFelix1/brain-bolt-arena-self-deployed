// Probe what the OLD project exposes to the anon (publishable) key.
const URL = "https://gmtddgaupquditwokmuh.supabase.co";
const KEY = "sb_publishable_PeR5-ekgLldfhyGHKK3qQw_gO67iDgK";

const tables = [
  "profiles", "quizzes", "questions", "leagues", "league_quizzes",
  "league_standings", "competitions", "host_authorizations",
  "branding_profiles", "result_claims", "user_roles", "principals",
  "sessions", "teams", "participants", "answers",
];

for (const t of tables) {
  try {
    const r = await fetch(`${URL}/rest/v1/${t}?select=id&limit=100`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (r.status === 200) {
      const rows = await r.json();
      console.log(`${t.padEnd(20)} OK    rows(≤100): ${rows.length}`);
    } else if (r.status === 401 || r.status === 403) {
      console.log(`${t.padEnd(20)} DENIED (${r.status})`);
    } else {
      const body = (await r.text()).slice(0, 120);
      console.log(`${t.padEnd(20)} HTTP ${r.status}: ${body}`);
    }
  } catch (e) {
    console.log(`${t.padEnd(20)} ERROR: ${e.message}`);
  }
}

// Storage buckets
for (const bucket of ["quiz-images", "branding-logos"]) {
  try {
    const r = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }),
    });
    if (r.status === 200) {
      const files = await r.json();
      console.log(`bucket ${bucket.padEnd(15)} OK    files(≤100): ${files.length}`);
    } else {
      console.log(`bucket ${bucket.padEnd(15)} HTTP ${r.status}: ${(await r.text()).slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`bucket ${bucket} ERROR: ${e.message}`);
  }
}
