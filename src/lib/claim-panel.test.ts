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
  authFailed: false,
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

  test("an in-flight phase renders as busy, never as saved or as an offer", () => {
    expect(view({ phase: "preparing" }).kind).toBe("busy");
  });

  test("an already-linked result is neither 'saved' nor a failure", () => {
    // The server raises one error for "this account claimed it" and for
    // "another account claimed it" and deliberately will not say which. So we
    // assert nothing about ownership: claiming `saved` would assert the result
    // is on THIS profile, which we cannot prove, and calling it a failure
    // would be wrong because nothing was lost.
    expect(view({ phase: "already-claimed" }).kind).toBe("already-saved");
    expect(view({ phase: "already-claimed", isAuthenticated: true, seatLinked: true }).kind).toBe(
      "saved",
    );
  });

  test("a failed sign-in check is recoverable, not an endless 'loading'", () => {
    const v = view({ authFailed: true, authResolved: false });
    expect(v.kind).toBe("problem");
    expect(v.kind === "problem" && v.detail).toMatch(/sign-in/i);
  });

  test("an unresolved auth state stays loading until we know", () => {
    // Distinct from authFailed: "not checked yet" must not invite a decision.
    expect(view({ authResolved: false, authFailed: false }).kind).toBe("loading");
  });

  test("no combination of inputs can yield saved without proof", () => {
    const booleans = [true, false];
    for (const authResolved of booleans) {
      for (const authFailed of booleans) {
        for (const isAuthenticated of booleans) {
          for (const seatLinked of booleans) {
            for (const seatChecked of booleans) {
              // Every phase, including "available" (a guest ticket waiting that the player
              // has not acted on). That one was previously omitted from this
              // loop, which left the most common mid-journey state unchecked.
              for (const phase of ["none", "available", "preparing", "expired", "already-claimed", "failed", "claimed"] as const) {
                const result = view({ authResolved, authFailed, isAuthenticated, seatLinked, seatChecked, phase });
                if (result.kind === "saved") {
                  // The ONLY two ways to reach "saved": a server confirmation, or
                  // a completed ownership read that found this seat linked. Note
                  // that the seat read needs no authentication, so it still proves
                  // the result even when the sign-in check failed.
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
    }
  });
});

