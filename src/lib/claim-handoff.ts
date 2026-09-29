// Result-claim handoff state.
//
// The claim itself is unchanged and stays server-authoritative: the guest
// browser mints a ticket with `create_session_claim`, and `claim_result`
// redeems it as the signed-in user, one time, server-side.
//
// What this module adds is HONESTY about what happened. Previously the results
// screen decided "Saved to your competition history" purely from whether a user
// object was present, so the moment auth resolved the panel flipped to "Saved"
// - before the redemption RPC had run, and whether it succeeded or not. This
// tracks the real outcome so the screen can only claim success on success.
//
// Ticket material deliberately does NOT live here. It stays in
// `src/lib/claim.ts` under its own storage key and is never placed in a URL.

import { useSyncExternalStore } from "react";
import { clearPendingClaim, readPendingClaim, redeemClaim } from "@/lib/claim";

export type ClaimPhase =
  | "none"
  /** A guest result is waiting, and the player has not chosen to save it. */
  | "available"
  /** Minting the ticket. */
  | "preparing"
  /** Ticket minted, player is off to sign in. */
  | "awaiting-auth"
  /** Redeemed. The result is on the profile. */
  | "claimed"
  | "expired"
  | "already-claimed"
  | "failed";

export type ClaimState = {
  phase: ClaimPhase;
  /** Short, safe, user-facing. Never a raw provider or database error. */
  detail: string | null;
  label: string | null;
  /**
   * The result this state is about (the pending ticket's `returnTo`).
   *
   * The store is a module singleton that outlives any single game, so without
   * a scope a successful Arena save would leave `phase: "claimed"` lying around
   * and the NEXT hosted game would render "Saved to your competition history"
   * for a seat that was never claimed. A panel ignores any state whose scope
   * is not its own result.
   */
  scope: string | null;
};

const INITIAL: ClaimState = { phase: "none", detail: null, label: null, scope: null };

let state: ClaimState = INITIAL;
const listeners = new Set<() => void>();

export function setClaimState(next: ClaimState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export function useClaimState(): ClaimState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-reactive read, for the reclaimer. */
export function readClaimState(): ClaimState {
  return state;
}

export function resetClaimState() {
  setClaimState(INITIAL);
}

// ---------------------------------------------------------------------------
// Return-trip marker
// ---------------------------------------------------------------------------

const RETURN_TRIP_KEY = "brainbolt:claim-return-trip";
/** A marked trip authorizes an automatic claim only for this long. */
export const RETURN_TRIP_TTL_MS = 15 * 60 * 1000;

/**
 * Mark that we are about to send the player to sign in for the express purpose
 * of claiming this result.
 *
 * This is what separates "the user just came back from the sign-in we asked
 * for" (redeem automatically) from "the user happened to be signed in for some
 * unrelated reason days later" (offer a button). Without it, a stale ticket
 * would silently attach itself to a result the player had walked away from.
 */
export function markClaimReturnTrip(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RETURN_TRIP_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    /* a blocked storage only costs us the automatic path */
  }
}

/** Consume the marker. Returns true exactly once per marked trip. */
export function consumeClaimReturnTrip(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.sessionStorage.getItem(RETURN_TRIP_KEY);
    if (!raw) return false;
    window.sessionStorage.removeItem(RETURN_TRIP_KEY);
    const { at } = JSON.parse(raw) as { at?: number };
    return typeof at === "number" && Date.now() - at <= RETURN_TRIP_TTL_MS;
  } catch {
    return false;
  }
}

/** Clear the marker without consuming it (e.g. the sign-in was abandoned). */
export function clearClaimReturnTrip(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RETURN_TRIP_KEY);
  } catch {
    /* nothing useful to do */
  }
}

/**
 * Map a redemption failure onto a phase and safe copy.
 *
 * `claim_result` raises 'Invalid claim', 'Claim expired', 'Already claimed' and
 * 'auth required'. Anything else is a transport or unexpected failure. None of
 * these are distinguishable from each other by a user, so they are described
 * rather than quoted.
 */
export function classifyClaimError(error: unknown): Omit<ClaimState, "scope"> {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (/already claimed/i.test(message)) {
    return {
      phase: "already-claimed",
      detail: "This result was already saved to an account.",
      label: null,
    };
  }
  if (/expired/i.test(message)) {
    return {
      phase: "expired",
      detail: "This save link expired. Play the quiz again to save a new result.",
      label: null,
    };
  }
  if (/invalid claim|auth required/i.test(message)) {
    return {
      phase: "expired",
      detail: "We could not verify this result. Play the quiz again to save a new one.",
      label: null,
    };
  }
  if (/fetch|network|failed to fetch|load failed/i.test(message)) {
    return {
      phase: "failed",
      detail: "We lost your connection. Your result is still here - try saving again.",
      label: null,
    };
  }
  return {
    phase: "failed",
    detail: "We could not save this result. Please try again.",
    label: null,
  };
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

/**
 * Redeem the pending ticket as the signed-in user and publish the real outcome.
 *
 * Safe to call more than once. Concurrent callers share the single in-flight
 * promise and all receive the same settled outcome, so a double click, a
 * StrictMode double-effect, or a second component racing the first cannot fire
 * two requests or leave one caller showing a stale "preparing". The ticket is
 * cleared either way, because a ticket that produced a terminal failure will
 * never become redeemable again.
 */
let inFlight: Promise<ClaimState> | null = null;

export function redeemPendingClaim(): Promise<ClaimState> {
  if (inFlight) return inFlight;

  const pending = readPendingClaim();
  if (!pending) {
    const next: ClaimState = { phase: "none", detail: null, label: null, scope: null };
    setClaimState(next);
    return Promise.resolve(next);
  }

  // The scope is the result the ticket belongs to, so a panel for a different
  // game cannot read this outcome as its own.
  const scope = pending.returnTo ?? null;
  setClaimState({ phase: "preparing", detail: null, label: pending.label, scope });

  inFlight = (async () => {
    try {
      await redeemClaim(pending.token);
      clearPendingClaim();
      const next: ClaimState = {
        phase: "claimed",
        detail: "Saved to your profile.",
        label: pending.label,
        scope,
      };
      setClaimState(next);
      return next;
    } catch (error) {
      clearPendingClaim();
      const classified = classifyClaimError(error);
      const next: ClaimState = { ...classified, label: pending.label, scope };
      setClaimState(next);
      return next;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
