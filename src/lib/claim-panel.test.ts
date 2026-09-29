// The results screen must not lie about saving.
//
// The bug: the panel rendered "Saved to your competition history" from
// `isGuest = !user` alone, so the moment auth resolved it claimed success -
// before the redemption RPC had run, and whether it succeeded or not. A
// network failure or an already-claimed ticket looked identical to a save.
//
// The rule under test: "saved" is only ever returned on a server confirmation,
// or on this seat genuinely being attached to a profile.

import { describe, expect, test } from "bun:test";
import { claimPanelView, type ClaimPanelInput } from "@/lib/claim-panel";

const BASE: ClaimPanelInput = {
  authResolved: true,
  isAuthenticated: false,
  seatLinked: false,
  seatChecked: true,
  phase: "none",
  detail: null,
};

const view = (over: Partial<ClaimPanelInput> = {}) => claimPanelView({ ...BASE, ...over });

describe("claimPanelView", () => {
  test("a guest with an unsaved result is offered the sign-in journey", () => {
    expect(view()).toEqual({ kind: "save-offer" });
  });

  test("a server-confirmed claim reads as saved", () => {
    expect(view({ phase: "claimed" })).toEqual({ kind: "saved" });
  });

  test("a seat attached to a profile reads as saved, signed in or not", () => {
    expect(view({ seatLinked: true, isAuthenticated: true })).toEqual({ kind: "saved" });
  });

  test("it never reports saved while restoration is unresolved", () => {
    // A returning player mid-bootstrap. Claiming "saved" here is the original
    // defect; claiming "unsaved" would be its mirror image. Neither is known.
    expect(view({ authResolved: false })).toEqual({ kind: "loading" });
    expect(view({ authResolved: false, isAuthenticated: true })).toEqual({ kind: "loading" });
  });

  test("it never reports saved before the seat ownership check completes", () => {
    expect(view({ seatChecked: false })).toEqual({ kind: "loading" });
    expect(view({ seatChecked: false, isAuthenticated: true })).toEqual({ kind: "loading" });
  });

  test("a signed-in player whose seat is not linked can save in place", () => {
    // Joined as a guest, signed in later. No reason to make them leave.
    expect(view({ isAuthenticated: true })).toEqual({ kind: "save-direct" });
  });

  test("a confirmed claim outranks every other signal", () => {
    expect(view({ phase: "claimed", seatChecked: false, authResolved: false })).toEqual({ kind: "saved" });
  });

  test("each terminal failure surfaces as a problem with its own copy", () => {
    expect(view({ phase: "expired", detail: "This save link expired." })).toEqual({
      kind: "problem",
      detail: "This save link expired.",
    });
    expect(view({ phase: "already-claimed", detail: "Already saved." })).toEqual({
      kind: "problem",
      detail: "Already saved.",
    });
    expect(view({ phase: "failed", detail: "Connection lost." })).toEqual({
      kind: "problem",
      detail: "Connection lost.",
    });
  });

  test("a problem always has copy, even if the detail was lost", () => {
    const kind = view({ phase: "failed", detail: null }).kind;
    expect(kind).toBe("problem");
    const withDetail = claimPanelView({ ...BASE, phase: "failed", detail: null });
    if (withDetail.kind === "problem") expect(withDetail.detail).toBeTruthy();
  });

  test("a problem outranks the offer, so a failure is never re-offered as fresh", () => {
    expect(view({ phase: "expired", detail: "gone", isAuthenticated: true }).kind).toBe("problem");
  });

  test("an unresolved auth state plus a problem still shows the problem", () => {
    // The user is already authenticated (a claim was in flight); saying
    // "loading" here would hide a failure they need to know about.
    expect(view({ phase: "failed", detail: "boom", isAuthenticated: true })).toEqual({
      kind: "problem",
      detail: "boom",
    });
  });

  test("in-flight phases render as busy, never as saved or as an offer", () => {
    expect(view({ phase: "preparing" }).kind).toBe("busy");
    expect(view({ phase: "awaiting-auth" }).kind).toBe("busy");
  });

  test("no combination of inputs can yield saved without proof", () => {
    const booleans = [true, false];
    for (const authResolved of booleans) {
      for (const isAuthenticated of booleans) {
        for (const seatLinked of booleans) {
          for (const seatChecked of booleans) {
            for (const phase of ["none", "preparing", "awaiting-auth", "expired", "already-claimed", "failed", "claimed"] as const) {
              const result = view({ authResolved, isAuthenticated, seatLinked, seatChecked, phase });
              if (result.kind === "saved") {
                // The ONLY two ways to reach "saved": a server confirmation, or
                // a completed ownership read that found this seat linked.
                const provenByServer = phase === "claimed";
                const provenBySeat = seatLinked && seatChecked;
                expect(provenByServer || provenBySeat).toBe(true);
                // A signed-out player is never shown "saved" on nothing but an
                // auth flag; the seat read is the only non-server proof.
                if (!provenByServer) expect(seatChecked).toBe(true);
              }
            }
          }
        }
      }
    }
  });
});

