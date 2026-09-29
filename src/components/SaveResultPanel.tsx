// The "Save Result" affordance on the finished-game screen.
//
// Two defects this replaces:
//   1. Starting the flow did `window.location.href = "/auth?..."`, a full
//      document reload that threw away every bit of the results view the
//      player was looking at. It is now a client-side navigation.
//   2. The panel reported "Saved to your competition history" purely from
//      whether a user object existed, so it claimed success before the
//      redemption RPC had run - and regardless of whether it succeeded. The
//      view model below only ever reports "saved" on a server confirmation or
//      on this seat genuinely being attached to a profile.

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { createSessionClaim, readPendingClaim, savePendingClaim } from "@/lib/claim";
import { markClaimReturnTrip, redeemPendingClaim, useClaimState } from "@/lib/claim-handoff";
import { claimPanelView } from "@/lib/claim-panel";
import { authSearch, rememberReturnIntent } from "@/lib/return-intent";
import { toastError } from "@/lib/errors";

type Props = {
  identity: { id: string; secretToken: string };
  quizTitle: string;
  authResolved: boolean;
  isAuthenticated: boolean;
  seatLinked: boolean;
  seatChecked: boolean;
  returnPath: string;
};

export function SaveResultPanel({
  identity,
  quizTitle,
  authResolved,
  isAuthenticated,
  seatLinked,
  seatChecked,
  returnPath,
}: Props) {
  const navigate = useNavigate();
  const claim = useClaimState();
  const [minting, setMinting] = useState(false);

  // The claim store is a tab-wide singleton. Only a state that belongs to THIS
  // result may inform this panel, otherwise a save from an earlier game (or an
  // Arena run) would leave "claimed" lying around and this seat would claim to
  // be saved when it never was.
  const mine = claim.scope === returnPath ? claim : { phase: "none" as const, detail: null };

  const view = claimPanelView({
    authResolved,
    isAuthenticated,
    seatLinked,
    seatChecked,
    phase: mine.phase,
    detail: mine.detail,
  });

  async function save() {
    if (minting) return;

    // Redeem an existing ticket only when it belongs to THIS result. A ticket
    // left behind by a different game must not be redeemed here and then
    // reported under this quiz's name.
    const pending = readPendingClaim();
    if (pending && pending.kind === "session" && pending.returnTo === returnPath) {
      const outcome = await redeemPendingClaim();
      if (outcome.phase === "claimed") {
        toast.success(`Saved "${quizTitle}" to your profile`);
      } else if (outcome.detail) {
        toast.error(outcome.detail);
      }
      return;
    }

    setMinting(true);
    try {
      const token = await createSessionClaim(identity.id, identity.secretToken);
      savePendingClaim({ token, kind: "session", label: quizTitle, returnTo: returnPath, createdAt: Date.now() });

      if (isAuthenticated) {
        // Already signed in: no reason to make the player leave the results.
        const outcome = await redeemPendingClaim();
        if (outcome.phase === "claimed") {
          toast.success(`Saved "${quizTitle}" to your profile`);
        } else if (outcome.detail) {
          toast.error(outcome.detail);
        }
        return;
      }

      // Guest: record where to come back to, mark this as the trip we asked
      // for, then navigate. The claim token itself never enters the URL.
      rememberReturnIntent({ path: returnPath, reason: "save-result" });
      markClaimReturnTrip();
      await navigate({ to: "/auth", search: authSearch(returnPath, "save-result") });
    } catch (e) {
      toastError(e, { context: "prepare result", fallback: "Could not prepare this result" });
    } finally {
      setMinting(false);
    }
  }

  if (view.kind === "loading") {
    return (
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40" role="status" aria-busy="true">
        Checking your result…
      </p>
    );
  }

  if (view.kind === "saved") {
    return (
      <div className="border border-border bg-card px-4 py-2 flex items-center gap-2">
        <span className="size-1.5 bg-volt rounded-full" />
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
          Saved to your competition history
        </p>
      </div>
    );
  }

  if (view.kind === "problem") {
    return (
      <div className="border border-pink-shock/30 bg-pink-shock/10 p-4 text-left" role="status">
        <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">Result not saved</p>
        <p className="text-sm text-foreground/75 mt-1">{view.detail}</p>
      </div>
    );
  }

  if (view.kind === "busy") {
    return (
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50" role="status" aria-busy="true">
        Saving your result…
      </p>
    );
  }

  return (
    <button
      type="button"
      disabled={minting}
      aria-busy={minting}
      onClick={() => void save()}
      className="block w-full border border-volt/30 bg-volt/5 hover:bg-volt/10 transition-colors p-4 text-left disabled:opacity-60"
    >
      <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
        {view.kind === "save-offer" ? "Playing as guest" : "Result not saved yet"}
      </p>
      <p className="font-display text-lg italic mt-1 leading-tight">
        {minting ? "Preparing…" : view.kind === "save-offer" ? "Keep your result →" : "Save this result →"}
      </p>
      <p className="font-mono text-[10px] text-foreground/50 mt-1">
        {view.kind === "save-offer"
          ? "Sign in or create an account to save your score and track your progress."
          : "You're signed in. Save this score to your profile."}
      </p>
    </button>
  );
}
