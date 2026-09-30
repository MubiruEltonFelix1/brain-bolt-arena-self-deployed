// What the results screen is allowed to say about saving a result.
//
// Lives in `lib/` rather than the component so the truthfulness rule is
// testable on its own, and so the component file exports only a component.
//
// The bug this replaces: the panel rendered "Saved to your competition
// history" from `isGuest = !user` alone, so the moment auth resolved it
// claimed success - before the redemption RPC had run, and whether it
// succeeded or not. A network failure or an already-claimed ticket looked
// identical to a successful save.
//
// The rule: "saved" requires proof. Either the server confirmed the claim, or
// a completed ownership read found this seat attached to a profile. Nothing
// else.

import type { ClaimPhase } from "@/lib/claim-handoff";

export type ClaimPanelView =
  /** Still deciding. Never claim a result is saved or unsaved before we know. */
  | { kind: "loading" }
  /** Ticket minting or redeeming. */
  | { kind: "busy" }
  /** Guest with an unsaved result: offer the sign-in journey. */
  | { kind: "save-offer" }
  /** Signed in but this seat is not linked yet: save without leaving the page. */
  | { kind: "save-direct" }
  /** Confirmed on the server, or the seat is already attached to a profile. */
  | { kind: "saved" }
  /**
   * The result is already linked to SOME account, and the server deliberately
   * does not say whose. Distinct from both `saved` (which asserts this is on
   * the current player's profile) and `problem` (which asserts a failure). See
   * the note in `classifyClaimError`.
   */
  | { kind: "already-saved" }
  /** A terminal failure. Detail is safe, user-facing copy. */
  | { kind: "problem"; detail: string };

export type ClaimPanelInput = {
  /** False while the session restoration is still unresolved. */
  authResolved: boolean;
  /**
   * True when the session check ran and FAILED. Distinct from `!authResolved`,
   * which also covers "not checked yet": one is a known outage we can offer to
   * retry, the other is genuinely undecided.
   */
  authFailed: boolean;
  /** A signed-in user exists. Says nothing about whether THIS seat is saved. */
  isAuthenticated: boolean;
  /** This seat is attached to a profile, so the result is in history. */
  seatLinked: boolean;
  /** The seat ownership check has completed, so a null link is meaningful. */
  seatChecked: boolean;
  phase: ClaimPhase;
  detail: string | null;
};

const GENERIC_FAILURE = "We could not save this result. Please try again.";

const AUTH_UNAVAILABLE =
  "We could not check your sign-in right now. Your result is safe — try again in a moment.";

export function claimPanelView(input: ClaimPanelInput): ClaimPanelView {
  const { authResolved, authFailed, isAuthenticated, seatLinked, seatChecked, phase, detail } = input;

  // A server-confirmed claim wins outright.
  if (phase === "claimed") return { kind: "saved" };
  if (phase === "preparing") return { kind: "busy" };

  // A failed session check is a known, recoverable condition, but it is NOT
  // allowed to outrank evidence. Reporting it as "still loading" forever would
  // strand the player with no way forward.
  const authUnavailable = authFailed;

  // Never conclude anything while restoration is unresolved AND nothing has
  // failed outright - that is "we do not know yet".
  if (!authResolved && !authUnavailable) return { kind: "loading" };

  // The seat itself is the strongest evidence: if this participant row is
  // attached to a profile, the result is in that profile's history. This read
  // needs no authentication, so it holds even when the sign-in check failed -
  // and it outranks a stale ticket, which says less about where the result
  // actually landed.
  if (seatChecked && seatLinked) return { kind: "saved" };

  // Already linked to an account. Deliberately NOT "saved": we cannot prove it
  // is the CURRENT player's profile, and asserting that would be a lie. Equally
  // deliberately not an error — nothing went wrong and the result is not lost.
  if (phase === "already-claimed") return { kind: "already-saved" };

  if (authUnavailable) return { kind: "problem", detail: detail ?? AUTH_UNAVAILABLE };

  // A terminal failure outranks everything below it, including a pending
  // ownership check: the player needs to know it did not save.
  if (phase === "expired" || phase === "failed") {
    return { kind: "problem", detail: detail ?? GENERIC_FAILURE };
  }

  // The ownership read has not landed. Offering "save" now would invite a
  // second attempt at a result that may already be saved.
  if (!seatChecked) return { kind: "loading" };

  // Signed out and not saved -> the sign-in journey.
  if (!isAuthenticated) return { kind: "save-offer" };
  // Signed in but the seat is not linked (joined as a guest, signed in later).
  return { kind: "save-direct" };
}
