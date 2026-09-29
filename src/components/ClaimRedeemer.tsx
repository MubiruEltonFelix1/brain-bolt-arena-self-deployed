import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAuthState } from "@/lib/auth-state";
import { readPendingClaim } from "@/lib/claim";
import {
  consumeClaimReturnTrip,
  redeemPendingClaim,
  setClaimState,
} from "@/lib/claim-handoff";

/**
 * Drives the guest -> account result claim.
 *
 * Redemption is automatic only on the trip the player actually started: the
 * "Save Result" button marks a return trip, and only that marker authorizes an
 * automatic claim. Signing in days later for an unrelated reason surfaces an
 * offer instead, so a result is never silently attached to an account the
 * player no longer associates with it.
 *
 * The server remains authoritative throughout - it validates ownership, expiry
 * and single use, and reports the real outcome. This component only decides
 * when to ask, and reports what the server said.
 */
export function ClaimRedeemer() {
  const { user, status, initialized } = useAuthState();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    // Never act before restoration settles, and never while the session is
    // merely unverified: a failed check is not a signed-in user.
    if (!initialized || status !== "authenticated" || !user) return;

    const pending = readPendingClaim();
    if (!pending) return;

    if (!consumeClaimReturnTrip()) {
      // Signed in, valid ticket, but not the journey we sent them on. Offer it
      // to the screen that owns this result, and to nothing else.
      setClaimState({
        phase: "available",
        detail: null,
        label: pending.label,
        scope: pending.returnTo ?? null,
      });
      return;
    }

    handled.current = true;
    void redeemPendingClaim().then((outcome) => {
      if (outcome.phase === "claimed") {
        toast.success(`Saved "${pending.label}" to your profile`);
      } else if (outcome.detail) {
        toast.error(outcome.detail);
      }
    });
  }, [user, status, initialized]);

  return null;
}
