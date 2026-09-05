// Phase 21 — Multiplayer Question Timeout Reliability.
//
// Static-analysis tests for the migration that broadens the autonomous tick
// to hosted sessions and adds stale-state protection to host RPCs.
//
// These tests do NOT spin up Postgres. They read the migration source and
// confirm the SQL is wired correctly: the WHERE clause was widened, the new
// parameter exists, and the typed exception is raised from the expected
// branch. Runtime behaviour is exercised separately by the load test
// (bun scripts/load-test.mjs --players 50).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "supabase",
    "migrations",
    "20260823090000_phase_21_hosted_session_expiration.sql",
  ),
  "utf8",
);

describe("Phase 21 migration — autonomous tick widening", () => {
  test("redefines run_autonomous_tick", () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.run_autonomous_tick\(\)/);
  });

  test("progression block matches hosted sessions via host_id", () => {
    // The widening: hosted sessions (autonomous=false AND host_id NOT NULL)
    // are now in scope for the progression block. Without this WHERE clause,
    // a hosted session never gets a server-side timeout fallback — which is
    // the production incident this phase addresses.
    expect(MIGRATION).toMatch(/NOT s\.autonomous AND s\.host_id IS NOT NULL/);
  });

  test("preserves the autonomous-competition sub-filter", () => {
    // The existing autonomous path must remain intact — Phase 21 widens,
    // it does not replace. Confirm the three autonomous guards still apply.
    expect(MIGRATION).toMatch(/c\.mode = 'scheduled'/);
    expect(MIGRATION).toMatch(/COALESCE\(c\.autonomous, false\)/);
    expect(MIGRATION).toMatch(/c\.status IN \('lobby_open', 'running'\)/);
  });

  test("uses LEFT JOIN so hosted sessions without a competition still match", () => {
    expect(MIGRATION).toMatch(/LEFT JOIN public\.competitions c ON c\.session_id = s\.id/);
  });

  test("still uses FOR UPDATE OF s SKIP LOCKED on the progression block", () => {
    // Serialization across concurrent ticks + in-flight host RPCs.
    expect(MIGRATION).toMatch(/FOR UPDATE OF s SKIP LOCKED/);
  });

  test("reveal branch UPDATE is still gated on current_question_revealed = false", () => {
    // Idempotency: a second tick firing the same reveal matches 0 rows.
    expect(MIGRATION).toMatch(
      /SET current_question_revealed = true\s+WHERE id = r\.id AND status = 'active' AND current_question_revealed = false/,
    );
  });

  test("re-grants service_role on the function", () => {
    // Defense-in-depth: prior definitions had REVOKE + GRANT EXECUTE TO
    // service_role. Phase 21 retains the same wiring.
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.run_autonomous_tick\(\) FROM PUBLIC, anon, authenticated/,
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.run_autonomous_tick\(\) TO service_role/,
    );
  });

  test("DECLARE block includes the FOR-loop row variable `r record`", () => {
    // Regression guard: dropping `r record` from DECLARE caused Postgres
    // "loop variable of loop over rows must be a record variable" at apply
    // time on the first try. The function uses `FOR r IN SELECT ...` four
    // times; the loop variable must be declared.
    const declBlock = MIGRATION.slice(
      MIGRATION.indexOf("DECLARE"),
      MIGRATION.indexOf("BEGIN", MIGRATION.indexOf("DECLARE")),
    );
    expect(declBlock).toMatch(/r\s+record\b/);
  });

  test("preserves the (a0) cancelled-competitions cleanup block", () => {
    // Dropping this block (a regression caught by adversarial review)
    // would let orphaned sessions from cancelled competitions linger.
    // Block must remain BEFORE the (a) lobby-opening loop.
    const a0Idx = MIGRATION.indexOf("-- (a0) Cancelled competitions");
    const aIdx = MIGRATION.indexOf("-- (a) Lobby opening");
    expect(a0Idx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(a0Idx);
    expect(MIGRATION).toMatch(/c\.status = 'cancelled'/);
    expect(MIGRATION).toMatch(
      /SET status = 'ended', current_question_revealed = true,\s+paused_at = NULL, time_added_ms = 0/,
    );
    expect(MIGRATION).toMatch(/action := 'cancelled'/);
  });
});

describe("Phase 21 migration — reveal_current_question stale protection", () => {
  test("accepts optional p_expected_started_at parameter", () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reveal_current_question\(\s*p_session_id uuid,\s*p_expected_started_at timestamptz DEFAULT NULL\s*\)/,
    );
  });

  test("raises phase21.stale_started_at with P0001 errcode on mismatch", () => {
    // The typed exception the host-route client pattern-matches to resync.
    expect(MIGRATION).toMatch(/phase21\.stale_started_at:session=% expected=% actual=%/);
    expect(MIGRATION).toMatch(/USING ERRCODE = 'P0001'/);
  });

  test("UPDATE branches on parameter: NULL keeps original behavior", () => {
    // Backward-compat: when p_expected_started_at IS NULL, the UPDATE
    // exactly matches the pre-Phase-21 definition (no revealed=false gate).
    // When supplied, it requires both revealed=false AND started_at match.
    expect(MIGRATION).toMatch(/IF p_expected_started_at IS NULL THEN/);
    expect(MIGRATION).toMatch(
      /SET current_question_revealed = true\s+WHERE id = p_session_id AND status = 'active';/,
    );
    expect(MIGRATION).toMatch(
      /AND current_question_revealed = false\s+AND current_question_started_at = p_expected_started_at/s,
    );
  });
});

describe("Phase 21 migration — end_question_early stale protection", () => {
  test("accepts optional p_expected_started_at parameter", () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.end_question_early\(\s*p_session_id uuid,\s*p_expected_started_at timestamptz DEFAULT NULL\s*\)/,
    );
  });

  test("silently no-ops on stale (does NOT raise)", () => {
    // End-Early is the host's recovery hammer; a stale tab hammering it
    // must NOT be blocked. The UPDATE matches 0 rows; no exception.
    // We assert the body does NOT contain a RAISE for stale detection.
    const block = MIGRATION.slice(
      MIGRATION.indexOf("CREATE OR REPLACE FUNCTION public.end_question_early"),
    );
    expect(block).not.toMatch(/RAISE EXCEPTION.*stale_started_at/);
    expect(block).toMatch(
      /p_expected_started_at IS NULL\s+OR current_question_started_at = p_expected_started_at/s,
    );
  });
});
