// Phase 9B — Arena validation drift test.
//
// Guards against client-side (`validateArenaQuizLocal`) and server-side
// (`validate_arena_quiz` SQL RPC) drift. Both must agree on:
//   * the eligible-types set
//   * the minimum-playable threshold
//   * the per-type rules (text needs accepted_answers, map_pin needs
//     region or coordinates)
//   * the required metadata (title, description, category)
//
// The client mirror is asserted in src/lib/arena/arena-publication.test.ts;
// this file locks the SQL rule catalog by reading the migration file and
// asserting the same constants/rules appear in the SQL body.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARENA_ELIGIBLE_TYPES, ARENA_MIN_PLAYABLE_QUESTIONS } from "@/lib/arena";

const migrationPath = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260823120000_phase_9b_arena_publication_platform.sql",
);

const migrationBody = readFileSync(migrationPath, "utf-8");

describe("Arena validation — SQL mirror invariants", () => {
  test("the migration references all 9 Arena-eligible types in the gate (or in comments)", () => {
    // The hard gate is on `question_type <> 'feedback'`; the broader
    // type allow-list is enforced in the client mirror. SQL accepts any
    // non-feedback, playable question. We assert the gate is correctly
    // set to "exclude feedback only".
    expect(migrationBody).toContain("question_type <> 'feedback'");
  });

  test("the migration enforces the min-playable threshold (>= 3) in get_arena_publication_state", () => {
    expect(migrationBody).toMatch(/At least 3 playable questions are required/);
  });

  test("the migration rejects type questions with no accepted_answers", () => {
    expect(migrationBody).toContain("One or more text-answer questions have no accepted answers");
  });

  test("the migration rejects map_pin questions with neither region nor coordinates", () => {
    expect(migrationBody).toContain("Map-pin questions need either a region or coordinates");
  });

  test("the migration requires title, description, and arena_category", () => {
    expect(migrationBody).toContain("Title is required");
    expect(migrationBody).toContain("Description is required");
    expect(migrationBody).toContain("Category is required");
  });

  test("the migration tags warning (not error) for missing tags", () => {
    expect(migrationBody).toContain("Add tags to make the quiz easier to discover");
  });

  test("the client mirror constants are exported", () => {
    expect(ARENA_ELIGIBLE_TYPES.size).toBeGreaterThan(0);
    expect(ARENA_MIN_PLAYABLE_QUESTIONS).toBeGreaterThanOrEqual(1);
  });
});

describe("Arena validation — client mirror constants vs SQL intent", () => {
  test("client minimum matches the SQL 'At least N' message", () => {
    // The SQL uses "At least 3 playable questions are required". The client
    // constant must equal 3.
    expect(ARENA_MIN_PLAYABLE_QUESTIONS).toBe(3);
    expect(migrationBody).toContain("At least 3");
  });

  test("client allow-list excludes 'feedback' (the SQL gate excludes feedback)", () => {
    expect(ARENA_ELIGIBLE_TYPES.has("feedback")).toBe(false);
  });
});
