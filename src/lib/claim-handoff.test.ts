// Result-claim handoff.
//
// Two things are being defended here:
//   1. The results screen must never claim a result was saved without proof.
//      (Covered in SaveResultPanel.test.ts against the view model.)
//   2. Redemption must be automatic only on the trip the player started. A
//      player who signs in for an unrelated reason days later must be offered
//      the choice, not have a result silently attached to their account.
//
// The server remains the authority on ownership, expiry and single use; these
// tests cover the client-side handoff, not the SQL.

import { describe, expect, test, beforeEach, mock } from "bun:test";

// Stand in for the network-facing claim module so redemption can be driven
// deterministically.
let pending: { token: string; label: string; returnTo: string } | null = null;
let redeemImpl: (token: string) => Promise<unknown> = async () => ({});
let clearCount = 0;

mock.module("@/lib/claim", () => ({
  readPendingClaim: () => pending,
  clearPendingClaim: () => {
    clearCount += 1;
    pending = null;
  },
  redeemClaim: (token: string) => redeemImpl(token),
}));

const handoff = await import("@/lib/claim-handoff");
const { classifyClaimError, clearClaimReturnTrip, consumeClaimReturnTrip, markClaimReturnTrip,
  readClaimState, redeemPendingClaim, resetClaimState, RETURN_TRIP_TTL_MS } = handoff;

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage;
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { sessionStorage: storage() };
  pending = null;
  clearCount = 0;
  redeemImpl = async () => ({});
  resetClaimState();
  clearClaimReturnTrip();
});

describe("return-trip marker", () => {
  test("a marked trip is consumed exactly once", () => {
    markClaimReturnTrip();
    expect(consumeClaimReturnTrip()).toBe(true);
    // A second sign-in must not inherit the first trip's permission.
    expect(consumeClaimReturnTrip()).toBe(false);
  });

  test("no marker means no automatic claim", () => {
    expect(consumeClaimReturnTrip()).toBe(false);
  });

  test("an abandoned trip does not authorize a claim much later", () => {
    markClaimReturnTrip();
    const key = "brainbolt:claim-return-trip";
    const { window } = globalThis as never as { window: { sessionStorage: Storage } };
    const stored = JSON.parse(window.sessionStorage.getItem(key)!);
    stored.at = Date.now() - RETURN_TRIP_TTL_MS - 1000;
    window.sessionStorage.setItem(key, JSON.stringify(stored));

    expect(consumeClaimReturnTrip()).toBe(false);
  });
});

describe("classifyClaimError", () => {
  test("maps every server failure onto safe copy", () => {
    expect(classifyClaimError(new Error("Already claimed")).phase).toBe("already-claimed");
    expect(classifyClaimError(new Error("Claim expired")).phase).toBe("expired");
    expect(classifyClaimError(new Error("Invalid claim")).phase).toBe("expired");
    expect(classifyClaimError(new Error("auth required")).phase).toBe("expired");
    expect(classifyClaimError(new Error("Failed to fetch")).phase).toBe("failed");
    expect(classifyClaimError(new Error("relation does not exist")).phase).toBe("failed");
    expect(classifyClaimError("something odd").phase).toBe("failed");
  });

  test("never echoes a raw provider or database message", () => {
    const hostile = [
      "Failed to fetch",
      "duplicate key value violates unique constraint \"result_claims_pkey\"",
      "JWT expired",
      new Error("postgres: permission denied for table result_claims").message,
    ];
    for (const message of hostile) {
      const { detail } = classifyClaimError(new Error(message));
      expect(detail).toBeTruthy();
      expect(detail).not.toContain("duplicate key");
      expect(detail).not.toContain("JWT");
      expect(detail).not.toContain("permission denied");
      expect(detail).not.toContain("result_claims");
    }
  });
});

describe("redeemPendingClaim", () => {
  test("with nothing pending it does nothing", async () => {
    const outcome = await redeemPendingClaim();
    expect(outcome.phase).toBe("none");
    expect(clearCount).toBe(0);
  });

  test("a valid authenticated return resumes the existing claim flow", async () => {
    pending = { token: "tok-1", label: "Quiz Match", returnTo: "/play/abc" };
    let seen = "";
    redeemImpl = async (t) => {
      seen = t;
      return { kind: "session" };
    };

    const outcome = await redeemPendingClaim();

    expect(seen).toBe("tok-1");
    expect(outcome.phase).toBe("claimed");
    expect(readClaimState().phase).toBe("claimed");
    // Consumed, so a reload cannot replay it.
    expect(clearCount).toBe(1);
  });

  test("a duplicate claim is reported, not silently retried", async () => {
    pending = { token: "tok-1", label: "Quiz Match", returnTo: "/play/abc" };
    redeemImpl = async () => {
      throw new Error("Already claimed");
    };

    const outcome = await redeemPendingClaim();

    expect(outcome.phase).toBe("already-claimed");
    // The ticket is dropped: a terminal failure will never become redeemable,
    // so keeping it would leave a permanently failing retry.
    expect(clearCount).toBe(1);
    expect(readClaimState().phase).toBe("already-claimed");
  });

  test("an expired or invalid ticket is reported clearly", async () => {
    for (const message of ["Claim expired", "Invalid claim"]) {
      pending = { token: "tok-1", label: "Quiz Match", returnTo: "/play/abc" };
      clearCount = 0;
      redeemImpl = async () => {
        throw new Error(message);
      };
      const outcome = await redeemPendingClaim();
      expect(outcome.phase).toBe("expired");
      expect(outcome.detail).toBeTruthy();
      expect(clearCount).toBe(1);
    }
  });

  test("a network failure is distinguished and does not lose the result silently", async () => {
    pending = { token: "tok-1", label: "Quiz Match", returnTo: "/play/abc" };
    redeemImpl = async () => {
      throw new Error("Failed to fetch");
    };

    const outcome = await redeemPendingClaim();
    expect(outcome.phase).toBe("failed");
    expect(outcome.detail).toMatch(/connection/i);
  });

  test("the outcome carries the label so the confirmation names the result", async () => {
    pending = { token: "tok-1", label: "Flags of the World", returnTo: "/play/abc" };
    const outcome = await redeemPendingClaim();
    expect(outcome.label).toBe("Flags of the World");
  });

  test("the outcome is scoped to the result the ticket belongs to", async () => {
    pending = { token: "tok-1", label: "Quiz Match", returnTo: "/play/abc" };
    const outcome = await redeemPendingClaim();
    // The panel for a DIFFERENT result must ignore this outcome, otherwise a
    // save from an earlier game would mark the next seat as saved.
    expect(outcome.scope).toBe("/play/abc");
    expect(readClaimState().scope).toBe("/play/abc");
  });

  test("a saved Arena run does not mark an unrelated hosted seat as saved", async () => {
    // Simulate: an Arena ticket is redeemed, then a hosted game is viewed.
    pending = { token: "arena-1", label: "Arena Run", returnTo: "/arena/quiz-1" };
    await redeemPendingClaim();
    expect(readClaimState().phase).toBe("claimed");
    expect(readClaimState().scope).toBe("/arena/quiz-1");
    // A panel at /play/<other> compares scope and must not read this as its own.
    expect(readClaimState().scope === "/play/other").toBe(false);
  });

  test("concurrent calls issue a single redemption", async () => {
    pending = { token: "tok-1", label: "Quiz Match", returnTo: "/play/abc" };
    let calls = 0;
    redeemImpl = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { kind: "session" };
    };

    await Promise.all([redeemPendingClaim(), redeemPendingClaim(), redeemPendingClaim()]);
    expect(calls).toBe(1);
  });

  test("concurrent callers all receive the settled outcome, not a stale phase", async () => {
    pending = { token: "tok-1", label: "Quiz Match", returnTo: "/play/abc" };
    redeemImpl = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { kind: "session" };
    };

    const results = await Promise.all([redeemPendingClaim(), redeemPendingClaim()]);
    // Every caller gets the real answer, so none of them silently renders
    // nothing while the request is in flight.
    for (const r of results) {
      expect(r.phase).toBe("claimed");
      expect(r.detail).toBeTruthy();
    }
  });
});
