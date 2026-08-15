import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAuthUser } from "@/hooks/use-auth-user";
import { readPendingClaim, clearPendingClaim, redeemClaim } from "@/lib/claim";

/**
 * Watches for a pending guest claim ticket and redeems it as soon as the
 * player is authenticated. The server validates ownership, expiry and
 * single-use, so a replay of this effect is harmless.
 */
export function ClaimRedeemer() {
  const { user } = useAuthUser();
  const running = useRef(false);

  useEffect(() => {
    if (!user || running.current) return;
    const pending = readPendingClaim();
    if (!pending) return;
    running.current = true;
    redeemClaim(pending.token)
      .then(() => {
        clearPendingClaim();
        toast.success(`Saved "${pending.label}" to your profile`);
      })
      .catch((e: Error) => {
        clearPendingClaim();
        const msg = e.message ?? "";
        if (/already claimed|expired|invalid/i.test(msg)) {
          toast.error("That result could no longer be claimed.");
        }
      })
      .finally(() => {
        running.current = false;
      });
  }, [user]);

  return null;
}
