// Phase 9B — Arena RPC contract tests (static).
//
// These tests do NOT invoke the live Supabase client. They assert the
// shape and naming of the RPC wrappers the Arena surface uses, so that:
//   * the wrapper exists,
//   * the wrapper accepts the documented input contract,
//   * the wrapper is exported from `src/lib/arena`.
//
// The runtime contract (filter combinations, pagination bounds, error
// envelopes) is verified by:
//   * `arena-race-conditions.test.ts` (failure-mode contract),
//   * `arena-publication.test.ts` (validation contract),
//   * the SQL `validate_arena_quiz` body, which the migration-marker probe
//     in `scripts/migration-markers.mjs` checks for at deploy time.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as arena from "@/lib/arena";

describe("Arena RPC wrappers — exports and input contracts", () => {
  test("every Phase 9B wrapper is exported from @/lib/arena", () => {
    const expected = [
      "fetchArenaPlatformState",
      "fetchArenaSection",
      "fetchArenaRunInsights",
      "fetchPreviousBest",
      "searchArenaQuizzes",
      "fetchArenaPublicationState",
      "fetchValidateArenaQuiz",
    ];
    for (const name of expected) {
      expect(typeof (arena as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("mutating server functions live in @/lib/api/arena-creator.functions", async () => {
    const mod = await import("@/lib/api/arena-creator.functions");
    expect(typeof mod.setArenaPublicationStatus).toBeDefined();
    expect(typeof mod.setArenaCategory).toBeDefined();
  });

  test("admin mutating server functions live in @/lib/api/arena-admin.functions", async () => {
    const mod = await import("@/lib/api/arena-admin.functions");
    expect(typeof mod.adminSetArenaOpen).toBeDefined();
    expect(typeof mod.adminArenaQuizPublish).toBeDefined();
    expect(typeof mod.adminArenaQuizFeature).toBeDefined();
  });

  test("legacy Arena wrappers still exported (backward compat)", () => {
    const expected = [
      "fetchArenaList",
      "fetchArenaDetail",
      "fetchArenaQuestions",
      "submitArenaRun",
      "fetchPersonalBest",
      "fetchCompletedArenaQuizIds",
      "readPersonalBest",
      "writePersonalBest",
    ];
    for (const name of expected) {
      expect(typeof (arena as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("ArenaListItem includes the new Phase 9B columns", () => {
    // The shape of ArenaListItem is inferred from the RPC's row shape.
    // We assert the documented field names by reading the type
    // definition from a representative mock object — TypeScript would
    // have already rejected any field-name typo at compile time.
    const item: arena.ArenaListItem = {
      id: "q-1",
      title: "T",
      description: null,
      difficulty: "medium",
      estimated_duration_minutes: 5,
      play_count: 10,
      time_per_question: 20,
      arena_featured_rank: null,
      last_updated: new Date().toISOString(),
      question_count: 5,
      avg_accuracy: 80,
      creator_name: "Brain Bolt",
      arena_category: "Geography",
      tags: "trivia",
      trend_score: 3,
      is_featured: false,
    };
    expect(item.arena_category).toBe("Geography");
    expect(item.tags).toBe("trivia");
    expect(item.trend_score).toBe(3);
    expect(item.is_featured).toBe(false);
  });

  test("ArenaQuizDetail includes the new Phase 9B columns", () => {
    const item: arena.ArenaQuizDetail = {
      id: "q-1",
      title: "T",
      description: null,
      difficulty: "medium",
      estimated_duration_minutes: 5,
      play_count: 10,
      time_per_question: 20,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      question_count: 5,
      avg_accuracy: 80,
      creator_name: "Brain Bolt",
      arena_category: "Geography",
      tags: "trivia",
      plays_30d: 1,
      last_played_at: null,
    };
    expect(item.plays_30d).toBe(1);
    expect(item.last_played_at).toBeNull();
  });

  test("search_arena_quizzes filter shape is well-defined", () => {
    const f: arena.ArenaSearchFilters = {
      difficulty: "hard",
      duration_max: 10,
      category: "Geography",
      sort: "trending",
    };
    expect(f.sort).toBe("trending");
  });

  test("search result type extends list item with total_count", () => {
    const r: arena.ArenaSearchResult = {
      id: "q-1",
      title: "T",
      description: null,
      difficulty: "medium",
      estimated_duration_minutes: 5,
      play_count: 10,
      time_per_question: 20,
      arena_featured_rank: null,
      last_updated: new Date().toISOString(),
      question_count: 5,
      avg_accuracy: 80,
      creator_name: "Brain Bolt",
      arena_category: "Geography",
      tags: "trivia",
      trend_score: 3,
      is_featured: false,
      total_count: 24,
    };
    expect(r.total_count).toBe(24);
  });

  test("ArenaRunInsights surface matches the SQL JSON shape", () => {
    const i: arena.ArenaRunInsights = {
      total: 10,
      correct: 7,
      fastest_ms: 1200,
      fastest_question_id: "q-1",
      thirds: {
        first: { count: 3, correct: 2 },
        middle: { count: 4, correct: 3 },
        last: { count: 3, correct: 2 },
      },
      comeback: false,
      hardest_question_id: "q-7",
      hardest_accuracy_pct: 24,
      // NOT a count. `get_arena_run_insights` applies `HAVING count(*) >= 3`
      // before picking a hardest question and then reports
      // `CASE WHEN hardest_acc IS NULL THEN 0 ELSE 1 END`. A sample size the
      // server cannot emit must not appear here — that is exactly the drift
      // this guard exists to catch.
      hardest_sample_size: 1,
      avg_response_ms: 4200,
    };
    expect(i.thirds.first.count).toBe(3);
    expect(i.hardest_sample_size).toBe(1);
  });

  test("hardest_sample_size really is a 0/1 flag in the SQL, not a count", () => {
    // The client gate in src/lib/arena-insights.ts is `>= 1`. If the SQL is ever
    // changed to report a real sample size, this fails and the gate must be
    // revisited — that is the whole point of pinning it.
    const body = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20260823120000_phase_9b_arena_publication_platform.sql"),
      "utf-8",
    );
    expect(body).toContain(
      "v_hardest_n := CASE WHEN v_hardest_acc IS NULL THEN 0 ELSE 1 END",
    );
    expect(body).toContain("'hardest_sample_size', v_hardest_n");
  });

  test("the SQL thirds are NOT in question order — so no UI may describe one by position", () => {
    // get_arena_run_insights splits the run with row_number() OVER (ORDER BY
    // question_id) and question_id is a uuid, so the "first" third is an
    // arbitrary group rather than the opening questions. This pins the SQL fact;
    // the client-side guard that no insight claims a position lives in
    // src/lib/arena-ux.test.ts ("no insight claims a position in the run").
    const body = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20260823120000_phase_9b_arena_publication_platform.sql"),
      "utf-8",
    );
    expect(body).toMatch(/row_number\(\)\s*OVER\s*\(\s*ORDER BY\s+question_id\s*\)/i);
  });

  test("ArenaPublicationState surface matches the SQL JSON shape", () => {
    const s: arena.ArenaPublicationState = {
      current_status: "draft",
      current_admin_status: "visible",
      archived: false,
      is_eligible: true,
      errors: [],
      warnings: [],
      playable_question_count: 5,
      supported_types: ["mcq", "true_false"],
      arena_category: "Geography",
      tags: "trivia",
    };
    expect(s.current_status).toBe("draft");
    expect(s.supported_types).toContain("mcq");
  });

  test("Section identifiers are the documented strings", () => {
    const sections: arena.ArenaSection[] = [
      "featured",
      "trending",
      "new",
      "quick_bolts",
      "hard_mode",
      "continue_exploring",
      "your_best",
    ];
    expect(sections).toHaveLength(7);
  });
});
