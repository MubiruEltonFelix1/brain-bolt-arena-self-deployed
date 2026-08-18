// scripts/migration-markers.mjs
//
// Single source of truth for "is this migration applied on the live DB?"
//
// The live Supabase project has no supabase_migrations.* ledger (Lovable
// applies migrations outside CLI bookkeeping), so "applied or not" is only
// answerable by probing schema state. Each migration leaves a detectable
// marker; createMarkers() maps every file in supabase/migrations/ to a probe
// predicate that returns true iff the marker exists on the live DB.
//
// Convention: EVERY new migration gets an entry here. scripts/migrate.mjs
// never auto-applies a file that has no entry.
//
// Entry shape:
//   { file, marker, applied, guard?, guardNote? }
//     file     — exact filename in supabase/migrations/ (keyed against disk)
//     marker   — human description of the schema state that proves it ran
//     applied  — () => boolean, live SQL probe; true when the marker exists
//     guard    — optional () => boolean; when false, migrate.mjs SKIPS the
//                file with a warning instead of applying (e.g. GRANT to a
//                role that may not exist in the target DB)
//     guardNote— why the guard exists, printed when the guard blocks
//
// Chain-implied entries: migrations whose effect was later overwritten
// (submit_answer rewrites M5/M7/M8) probe the FINAL state instead. Because
// migrations apply strictly in filename order, the final version existing
// implies every earlier rewrite in the chain ran.
//
// Shared env/psql plumbing (loadEnv, findPsql) also lives here so
// scripts/check-migrations.mjs and scripts/migrate.mjs behave identically.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads KEY=VALUE lines from a .env-style file; missing file → {}.
 *  Surrounding double or single quotes on values are stripped
 *  (e.g. DATABASE_URL="postgresql://..." — psql cannot parse quoted URIs). */
export function loadEnv(file) {
  const vars = {};
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

/**
 * Resolves psql: PSQL_PATH env override first, then the known local
 * PostgreSQL installs, then PATH. Returns null when not found.
 */
export function findPsql() {
  if (process.env.PSQL_PATH) return process.env.PSQL_PATH;
  const candidates = [
    "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe",
    "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe",
    "psql",
  ];
  return candidates.find((p) => p === "psql" || existsSync(p)) ?? null;
}

function sleepSync(ms) {
  if (typeof Bun !== "undefined") {
    Bun.sleepSync(ms);
  } else {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

/** True for psql failures that are transient connection drops (pooler blips). */
function isTransientConnectionError(r) {
  const err = `${r.stderr || ""} ${r.error?.message || ""}`;
  return /closed the connection|terminated abnormally|connection reset|broken pipe|ECONNRESET|ETIMEDOUT|EPIPE/i.test(
    err,
  );
}

/**
 * Shared psql runner: `run(args, opts)` spawns psql (64MB buffer, UTF-8).
 * Read probes (q/yes) retry transient connection failures with backoff (up to
 * 3 retries after the first attempt) — the Supabase pooler occasionally drops
 * a session mid-burst. Callers that MUST NOT auto-retry (the migration apply
 * path — atomic per file) pass `{ retry: false }`.
 */
export function createPsqlRunner(psql, conn) {
  const run = (args, { retry = true } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = spawnSync(psql, args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      });
      if (r.status === 0 || !retry || attempt >= 3 || !isTransientConnectionError(r)) return r;
      sleepSync(500 * (attempt + 1));
    }
  };
  const q = (sql) => {
    const r = run([conn, "-t", "-A", "-c", sql]);
    const err = (r.stderr || "").trim();
    // Without ON_ERROR_STOP psql still exits 0 on a plain SQL error — surface
    // those as probe failures instead of a silent "marker absent".
    if (r.status !== 0 || /(^|\n)ERROR:|psql: error:/.test(err)) {
      throw new Error(`psql failed: ${err.slice(0, 300)}`);
    }
    return r.stdout.trim();
  };
  const yes = (sql) => q(sql) === "t";
  return { run, q, yes };
}

/**
 * Builds the marker list. `q(sql)` runs a query and returns trimmed stdout;
 * `yes(sql)` returns q(sql) === "t". Both are provided by the caller so the
 * same markers work in every script (and in tests, against a fake runner).
 */
export function createMarkers({ q, yes }) {
  const colExists = (table, column) =>
    yes(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}')`,
    );
  const tableExists = (table) => yes(`SELECT to_regclass('public.${table}') IS NOT NULL`);
  const fnExists = (name) =>
    yes(
      `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${name}')`,
    );
  const fnBody = (name) =>
    q(
      `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${name}' LIMIT 1`,
    );
  const fnBodyLike = (name, needle) => fnBody(name).includes(needle);
  const constraintLike = (conname, needle) =>
    yes(
      `SELECT (pg_get_constraintdef(oid) LIKE '%${needle}%') FROM pg_constraint WHERE conname = '${conname}'`,
    );
  // pg_policies is a view: qual/with_check are the policy expressions as text.
  const policyLike = (table, policy, needle) =>
    yes(
      `SELECT (qual LIKE '%${needle}%') FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' AND policyname = '${policy}'`,
    );
  const indexExists = (table, index) =>
    yes(
      `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${table}' AND indexname = '${index}')`,
    );
  const roleExists = (role) => yes(`SELECT to_regrole('${role}') IS NOT NULL`);
  // The final submit_answer (M9) returns TABLE(accepted boolean, new_streak int).
  // The superseded M5-era rewrites returned 5 columns. Its presence implies
  // the whole M5→M8 rewrite chain ran (filename order).
  const finalSubmitAnswer = () =>
    yes(
      `SELECT to_regprocedure('public.submit_answer(uuid,text,uuid,integer,integer)') IS NOT NULL AND pg_get_function_result('public.submit_answer(uuid,text,uuid,integer,integer)'::regprocedure) NOT LIKE '%correct_index integer%'`,
    );
  // Phase 7L-1 gate: can(uuid,text,uuid) resolves ownership principal-only.
  // 7K's body still carries the legacy `owner_id = v_user` fallback; 7L-1
  // removed it — so the fallback's ABSENCE is the distinctive 7L-1 marker
  // (the presence of principal_for_user alone is true from 7K onward).
  const canPrincipalOnly = () => {
    const body = q(`SELECT prosrc FROM pg_proc WHERE proname = 'can' AND pronargs = 3`);
    return body.includes("principal_for_user") && !body.includes("owner_id = v_user");
  };

  return [
    {
      file: "20260616133205_349cfb2b-f443-4ccf-a540-fda47f2bd793.sql",
      marker: "initial schema (answers table exists)",
      applied: () => tableExists("answers"),
    },
    {
      file: "20260616133217_1983c462-9eff-42f6-a24c-a7ed95420491.sql",
      marker: "anon cannot EXECUTE handle_new_user (REVOKE incl. PUBLIC — effective)",
      applied: () =>
        yes(`SELECT NOT has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')`),
    },
    {
      file: "20260617071325_9ad4f034-ca23-409b-a0d7-d0b18967afcd.sql",
      marker: "questions.point_value column exists",
      applied: () => colExists("questions", "point_value"),
    },
    {
      file: "20260618084857_05d788f9-7d99-4c13-9f0b-075c0641e56e.sql",
      marker: "participant_secrets table exists",
      applied: () => tableExists("participant_secrets"),
    },
    {
      file: "20260618091140_447bbbe6-267a-4a27-a400-c1108ce4e9b3.sql",
      marker: "submit_answer rewritten (superseded — final 2-col version present)",
      chain: true,
      applied: finalSubmitAnswer,
    },
    {
      file: "20260619203013_28ec30ed-f4cd-4f21-9aca-f1f18cdd7a82.sql",
      marker: "submit_answer body locks participants FOR UPDATE",
      applied: () => fnBodyLike("submit_answer", "FOR UPDATE"),
    },
    {
      file: "20260619203510_eef5bce1-385d-400b-b280-2a820624b32a.sql",
      marker: "submit_answer rewritten (superseded — final 2-col version present)",
      chain: true,
      applied: finalSubmitAnswer,
    },
    {
      file: "20260619203734_950e0edd-937d-4a1e-913e-d5e9028b347c.sql",
      marker: "submit_answer rewritten (superseded — final 2-col version present)",
      chain: true,
      applied: finalSubmitAnswer,
    },
    {
      file: "20260620134533_619582e5-bead-4e30-9bfd-18ab33a04403.sql",
      marker: "sessions.current_question_revealed column exists",
      applied: () => colExists("sessions", "current_question_revealed"),
    },
    {
      file: "20260701080655_78dbe8a7-8172-4093-9cb1-779e47f499c4.sql",
      marker: "questions.correct_lat column exists (geo answers)",
      applied: () => colExists("questions", "correct_lat"),
    },
    {
      file: "20260702065946_6aa4fc9b-7e40-40d1-b9aa-790ea6293824.sql",
      marker: "questions_question_type_check includes 'map_pin'",
      applied: () => constraintLike("questions_question_type_check", "map_pin"),
    },
    {
      file: "20260705140001_e175c25d-a848-42a6-85ce-562c150af465.sql",
      marker: "questions.accepted_answers column exists (text answers)",
      applied: () => colExists("questions", "accepted_answers"),
    },
    {
      file: "20260706052338_d9b272ac-b1a0-4915-9132-aa53f5512cc8.sql",
      marker: "quizzes.archived_at column exists",
      applied: () => colExists("quizzes", "archived_at"),
    },
    {
      file: "20260710144931_8a0ffaaa-9cb8-4be9-a003-cbf09eac74a5.sql",
      marker: "questions_question_type_check includes 'feedback'",
      applied: () => constraintLike("questions_question_type_check", "feedback"),
    },
    {
      file: "20260711170815_b5cedefd-e34e-4ed5-8630-99548277fc77.sql",
      marker: "is_authorized_host() exists",
      applied: () => fnExists("is_authorized_host"),
    },
    {
      file: "20260711191622_3d9acc14-fb8a-45ca-abb3-ac65c80ac611.sql",
      marker: "get_session_questions returns q_reveal_stages",
      applied: () => fnBodyLike("get_session_questions", "q_reveal_stages"),
    },
    {
      file: "20260711192108_a890fb62-2e54-4e27-a6d2-8aacd70142d8.sql",
      marker: "questions.audio_url column exists",
      applied: () => colExists("questions", "audio_url"),
    },
    {
      file: "20260711192436_4cfa9289-e1cd-44b0-a744-c5b0104ad6f7.sql",
      marker: "questions.reveal_stages column exists",
      applied: () => colExists("questions", "reveal_stages"),
    },
    {
      file: "20260712000930_947ff1a5-a3af-4e02-a04b-0210f492e762.sql",
      marker: "submit_ordering_answer exists",
      applied: () => fnExists("submit_ordering_answer"),
    },
    {
      file: "20260713073617_b76c7757-4253-44ba-95d6-f1837e6983f9.sql",
      marker: "get_server_time exists",
      applied: () => fnExists("get_server_time"),
    },
    {
      file: "20260717123221_4abecd53-b56d-4971-9ad9-2c1a2c9dd6f5.sql",
      marker: "host_authorizations table exists",
      applied: () => tableExists("host_authorizations"),
    },
    {
      file: "20260717132937_310af4c8-ce63-4880-8ef2-0b75dcd94332.sql",
      marker: "host_requests table exists",
      applied: () => tableExists("host_requests"),
    },
    {
      file: "20260717231622_092cc9cc-7ef3-443d-a8bb-a63b25d507ad.sql",
      marker: "branding_profiles table exists",
      applied: () => tableExists("branding_profiles"),
    },
    {
      file: "20260718000327_470639c2-421a-4385-afd1-7c0b3abad4d3.sql",
      marker: "'quizzes host only write' policy uses has_active_host_authorization",
      applied: () =>
        policyLike("quizzes", "quizzes host only write", "has_active_host_authorization"),
    },
    {
      file: "20260719074454_1e2dac64-043c-4dc1-b67f-3030bdf8da01.sql",
      marker: "league_quizzes table exists (league engine)",
      applied: () => tableExists("league_quizzes"),
    },
    {
      file: "20260721062436_83390109-801c-4898-914b-e4ab89dd5622.sql",
      marker: "profiles_username_lower_key index exists",
      applied: () => indexExists("profiles", "profiles_username_lower_key"),
    },
    {
      file: "20260722065824_3498ca47-9758-4c3d-8c7c-b369a2e5d24d.sql",
      marker: "competition_results table exists",
      applied: () => tableExists("competition_results"),
    },
    {
      file: "20260723061840_db66b11d-6690-4138-a182-34cf2c7f67f4.sql",
      marker: "quizzes.is_arena column exists",
      applied: () => colExists("quizzes", "is_arena"),
    },
    {
      file: "20260724054750_c26f061d-2cff-444a-a088-72899710ae75.sql",
      marker: "competitions table exists",
      applied: () => tableExists("competitions"),
    },
    {
      file: "20260725055144_e5318870-7452-42f3-a4ca-6e5aa6361984.sql",
      marker: "sessions.paused_at column exists",
      applied: () => colExists("sessions", "paused_at"),
    },
    {
      file: "20260726074837_486021a1-2643-4d6a-bace-131af70da4b3.sql",
      marker: "record_competition_results ranks by joined_at ASC",
      applied: () => fnBodyLike("record_competition_results", "joined_at ASC"),
    },
    {
      file: "20260728075045_6aa58530-c3f0-4e16-b42c-609331385d08.sql",
      marker: "participants.avatar_id column exists",
      applied: () => colExists("participants", "avatar_id"),
    },
    {
      file: "20260731050859_f0d1db9e-aac2-4374-8915-a35ade9e5661.sql",
      marker: "get_arena_questions exists",
      applied: () => fnExists("get_arena_questions"),
    },
    {
      file: "20260801001013_6ad49913-7581-4876-b195-0270aaf5ec19.sql",
      marker: "competition_results.session_id is nullable",
      applied: () =>
        yes(
          `SELECT (is_nullable = 'YES') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'competition_results' AND column_name = 'session_id'`,
        ),
    },
    {
      file: "20260803053004_70fe8b5d-77ad-439e-b2c3-116915c1599a.sql",
      marker: "competitions_session_id_key index exists",
      applied: () => indexExists("competitions", "competitions_session_id_key"),
    },
    {
      file: "20260804061631_5e70d437-a10f-46dc-bac7-d6b6764325a8.sql",
      marker: "sessions.autonomous column exists (pg_cron scheduler)",
      applied: () => colExists("sessions", "autonomous"),
    },
    {
      file: "20260804063722_d9ca50ca-6978-4543-8846-1717ad8cf7d7.sql",
      marker: "run_autonomous_tick handles scheduled-mode competitions",
      applied: () => fnBodyLike("run_autonomous_tick", "c.mode = 'scheduled'"),
    },
    {
      file: "20260805054014_05c6b7d6-00ee-4d06-86a6-de2cd2ece634.sql",
      marker: "prepare_competition_session_internal exists",
      applied: () => fnExists("prepare_competition_session_internal"),
    },
    {
      file: "20260805055746_783cfc6f-d791-4c24-877e-0fb6372ee0ca.sql",
      marker: "sessions_autonomous_live_idx index exists",
      applied: () => indexExists("sessions", "sessions_autonomous_live_idx"),
    },
    {
      file: "20260806054006_29e59c2b-898f-4c37-aa90-fe4a90c2f3de.sql",
      marker: "leagues.points_first column exists (standings v1)",
      applied: () => colExists("leagues", "points_first"),
    },
    {
      file: "20260807070037_bf982bb8-b6ca-4104-a5cf-678249dbcc2b.sql",
      marker: "result_claims table exists",
      applied: () => tableExists("result_claims"),
    },
    {
      file: "20260808062957_937c1550-67a4-4f23-a3da-fd5540e23753.sql",
      marker: "user_roles table exists (central role system)",
      applied: () => tableExists("user_roles"),
    },
    {
      file: "20260808063348_ff6ee7c2-a1cb-4d2c-a1d8-e70f4f1ee8f0.sql",
      marker: "user_roles has at least one RLS policy",
      applied: () =>
        yes(
          `SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_roles')`,
        ),
    },
    {
      file: "20260808063412_bbb901a5-2bc4-4a27-b28c-e4f91f427076.sql",
      // The file REVOKEs FROM anon only — it does NOT revoke the default
      // PUBLIC grant, so anon's effective EXECUTE survives (via PUBLIC).
      // The verifiable effect is the direct grant's removal (proacl), and
      // that is what the marker tracks.
      marker:
        "anon direct EXECUTE grant on is_session_host removed (proacl; PUBLIC grant may remain)",
      applied: () =>
        yes(
          `SELECT (proacl::text NOT LIKE '%anon=X%') FROM pg_proc WHERE proname = 'is_session_host'`,
        ),
    },
    {
      file: "20260810193537_f38379d7-afb4-4c0e-bfc4-06693f6e665a.sql",
      marker: "lookup_game_code exists",
      applied: () => fnExists("lookup_game_code"),
    },
    {
      file: "20260812153611_1a313580-b6e4-449d-9704-67614c75459e.sql",
      marker: "'Admin can view all competitions' policy uses is_admin()",
      applied: () => policyLike("competitions", "Admin can view all competitions", "is_admin()"),
    },
    {
      file: "20260812153755_ff44b989-74a4-4dd8-82a9-22d470177d06.sql",
      marker: "admin_grant_host_authorization gated by is_admin()",
      applied: () => fnBodyLike("admin_grant_host_authorization", "is_admin()"),
    },
    {
      file: "20260812154432_d2b3420b-1786-4295-9eeb-727cf903b7f8.sql",
      marker: "can(text,uuid) overload exists",
      applied: () => yes(`SELECT to_regprocedure('public.can(text,uuid)') IS NOT NULL`),
    },
    {
      file: "20260812154453_c7029788-5833-4f10-b62f-a85766ea5798.sql",
      marker: "authenticated cannot EXECUTE can(uuid,text,uuid) (REVOKE)",
      applied: () =>
        yes(
          `SELECT NOT has_function_privilege('authenticated', 'public.can(uuid,text,uuid)', 'EXECUTE')`,
        ),
    },
    {
      file: "20260812154514_64d7f7c8-86cc-4308-8c7d-d6421ac9aebc.sql",
      marker:
        "GRANT can() to supabase_read_only_user — superseded by the M51 REVOKE; assumed applied via chain",
      chain: true,
      applied: () =>
        yes(
          `SELECT COALESCE(has_function_privilege('supabase_read_only_user', 'public.can(uuid,text,uuid)', 'EXECUTE'), false)`,
        ),
    },
    {
      file: "20260812154527_5af190a4-7214-402c-a475-aaf83538fd8e.sql",
      marker: "supabase_read_only_user cannot EXECUTE can(uuid,text,uuid) (REVOKE)",
      applied: () =>
        yes(
          `SELECT COALESCE(NOT has_function_privilege('supabase_read_only_user', 'public.can(uuid,text,uuid)', 'EXECUTE'), false)`,
        ),
      guard: () => roleExists("supabase_read_only_user"),
      guardNote:
        "the supabase_read_only_user role does not exist in this DB — nothing to revoke from. Skipped.",
    },
    {
      file: "20260814143826_24668753-686e-49cb-b007-4829713bd3ac.sql",
      marker: "principals table exists (principal abstraction)",
      applied: () => tableExists("principals"),
    },
    {
      file: "20260815084838_fc767187-cb07-413b-8d73-e4d418de99a3.sql",
      marker: "branding_profiles.owner_principal_id column exists",
      applied: () => colExists("branding_profiles", "owner_principal_id"),
    },
    {
      file: "20260815085505_b67e4814-0275-48ee-bb38-5e114f3f6a1b.sql",
      marker: "leagues.owner_principal_id column exists",
      applied: () => colExists("leagues", "owner_principal_id"),
    },
    {
      file: "20260815135413_261d048d-ebd6-43af-8491-c165654982ca.sql",
      marker: "quizzes.owner_principal_id column exists",
      applied: () => colExists("quizzes", "owner_principal_id"),
    },
    {
      file: "20260816120000_43048aa5-07b8-466b-9e73-487a0e56280c.sql",
      marker: "competitions.owner_principal_id column exists (Phase 7K)",
      applied: () => colExists("competitions", "owner_principal_id"),
    },
    {
      file: "20260816124500_phase_7l_authorization_completion.sql",
      marker: "can() resolves ownership principal-only (no owner_id fallback) (Phase 7L-1)",
      applied: canPrincipalOnly,
    },
    {
      file: "20260816130000_phase_7l_retire_sync_triggers.sql",
      marker: "quizzes_sync_owner_principal_trg absent (Phase 7L-2, 7L-1 confirmed)",
      applied: () => {
        if (!canPrincipalOnly()) return false;
        return yes(
          `SELECT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'quizzes_sync_owner_principal_trg')`,
        );
      },
    },
    {
      file: "20260816131500_phase_7l_retire_owner_id_columns.sql",
      marker: "owner_id column absent on all 4 ownership tables (Phase 7L-3)",
      applied: () =>
        yes(
          `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('branding_profiles','leagues','quizzes','competitions') AND column_name = 'owner_id')`,
        ),
    },
    {
      file: "20260817060000_3f7c9d21-8e4b-4a5c-9d3e-2b1a0f6c8d4e.sql",
      marker: "mcp_idempotency_keys table exists (Phase 8B)",
      applied: () => tableExists("mcp_idempotency_keys"),
    },
    {
      file: "20260817120000_admin_statistics_timeseries.sql",
      marker: "admin_stats_timeseries exists",
      applied: () => fnExists("admin_stats_timeseries"),
    },
    {
      file: "20260817130000_admin_statistics_insights.sql",
      marker: "admin_session_funnel exists",
      applied: () => fnExists("admin_session_funnel"),
    },
  ];
}
