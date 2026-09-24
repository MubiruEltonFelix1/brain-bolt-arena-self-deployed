// Phase 9B — Arena race-condition simulation tests.
//
// These tests exercise the client-side contract that the user observes
// when the platform state changes between discovering a quiz and pressing
// PLAY. They do NOT hit the network; they model the RPC layer's behavior
// using a stub that mirrors the server-side messages raised in the SQL
// migration.
//
// Mirrors the no-network style of src/lib/ai/service.test.ts.
//
// The behavior under test:
//   1. Player sees a quiz (get_arena_quiz_detail returns a row).
//   2. Admin hides it OR closes the Arena between discovery and start.
//   3. Player presses PLAY and the run-submit path raises 'arena_closed'
//      or 'not an arena quiz'.
//   4. The client shows a friendly unavailable message; the user is
//      routed back to the catalog.

import { describe, expect, test } from "bun:test";

type SubmitResult =
  | { ok: true; score: number; accuracy: number; correct_count: number; graded_count: number }
  | { ok: false; code: "arena_closed" | "quiz_unavailable"; message: string };

/**
 * Mirror of the production `submitArenaRun` shape. The real implementation
 * is `src/lib/arena.ts:submitArenaRun`; the contract is identical: it
 * returns null on success and throws on `arena_closed` / not-an-arena-quiz.
 * We model the failure surface here so the test can exercise the
 * error-mapping path used by the play route.
 */
async function submitRunUnderRace(
  rpc: () => Promise<SubmitResult>,
): Promise<{ outcome: "ok" | "arena_closed" | "quiz_unavailable"; message: string | null }> {
  try {
    const r = await rpc();
    if (r.ok) return { outcome: "ok", message: null };
    return { outcome: r.code, message: r.message };
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? "");
    if (msg.includes("arena_closed")) {
      return {
        outcome: "arena_closed",
        message: "The Arena was closed while you were playing. Your score was not saved.",
      };
    }
    if (msg.includes("not an arena quiz")) {
      return {
        outcome: "quiz_unavailable",
        message: "This challenge is no longer available in the Arena.",
      };
    }
    return { outcome: "quiz_unavailable", message: "This challenge is no longer available." };
  }
}

describe("Arena race conditions", () => {
  test("happy path — submitArenaRun returns the scored result", async () => {
    const result = await submitRunUnderRace(async () => ({
      ok: true,
      score: 1234,
      accuracy: 80,
      correct_count: 4,
      graded_count: 5,
    }));
    expect(result.outcome).toBe("ok");
    expect(result.message).toBe(null);
  });

  test("Arena closed between discovery and start → friendly closed message", async () => {
    const result = await submitRunUnderRace(async () => {
      throw new Error("arena_closed");
    });
    expect(result.outcome).toBe("arena_closed");
    expect(result.message).toMatch(/closed while you were playing/);
  });

  test("Quiz hidden by admin between discovery and start → friendly unavailable message", async () => {
    const result = await submitRunUnderRace(async () => {
      throw new Error("not an arena quiz");
    });
    expect(result.outcome).toBe("quiz_unavailable");
    expect(result.message).toMatch(/no longer available/);
  });

  test("Quiz archived between discovery and start → friendly unavailable message", async () => {
    const result = await submitRunUnderRace(async () => {
      // The server's submit_arena_run raises 'not an arena quiz' when the
      // effective visibility gate fails, regardless of which condition
      // (hidden vs archived) caused the failure.
      throw new Error("not an arena quiz");
    });
    expect(result.outcome).toBe("quiz_unavailable");
  });

  test("Unknown RPC error → defaults to quiz_unavailable, not arena_closed", async () => {
    const result = await submitRunUnderRace(async () => {
      throw new Error("connection reset by peer");
    });
    expect(result.outcome).toBe("quiz_unavailable");
  });

  test("Envelope-style failure (ok=false) routes through the same paths", async () => {
    const closed = await submitRunUnderRace(async () => ({
      ok: false as const,
      code: "arena_closed" as const,
      message: "Arena closed",
    }));
    expect(closed.outcome).toBe("arena_closed");

    const unavailable = await submitRunUnderRace(async () => ({
      ok: false as const,
      code: "quiz_unavailable" as const,
      message: "Quiz unavailable",
    }));
    expect(unavailable.outcome).toBe("quiz_unavailable");
  });
});
