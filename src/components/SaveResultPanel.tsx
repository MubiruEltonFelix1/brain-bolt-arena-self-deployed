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
import { markClaimReturnTrip, redeemPendingClaim, useClaimState, type ClaimState } from "@/lib/claim-handoff";
import { claimPanelView } from "@/lib/claim-panel";
import { authSearch, rememberReturnIntent } from "@/lib/return-intent";
import { trackResultEvent } from "@/lib/result-analytics";
import { toastError } from "@/lib/errors";

type Props = {
  identity: { id: string; secretToken: string };
  quizTitle: string;
  authResolved: boolean;
  /** The session check ran and failed, as opposed to not having run yet. */
  authFailed: boolean;
  isAuthenticated: boolean;
  seatLinked: boolean;
  seatChecked: boolean;
  returnPath: string;
};

export function SaveResultPanel({
  identity,
  quizTitle,
  authResolved,
  authFailed,
  isAuthenticated,
  seatLinked,
  seatChecked,
  returnPath,
}: Props) {
  const navigate = useNavigate();
  const claim = useClaimState();
  const [minting, setMinting] = useState(false);
  // "Not now" is a real, honoured answer. It hides the invitation only — it
  // never changes what the result screen is allowed to show, and the score and
  // podium stay exactly where they were above it.
  const [declined, setDeclined] = useState(false);

  // The claim store is a tab-wide singleton. Only a state that belongs to THIS
  // result may inform this panel, otherwise a save from an earlier game (or an
  // Arena run) would leave "claimed" lying around and this seat would claim to
  // be saved when it never was.
  const mine = claim.scope === returnPath ? claim : { phase: "none" as const, detail: null };

  const view = claimPanelView({
    authResolved,
    authFailed,
    isAuthenticated,
    seatLinked,
    seatChecked,
    phase: mine.phase,
    detail: mine.detail,
  });

  async function save() {
    if (minting) return;
    trackResultEvent("save_result_clicked", { mode: "hosted" });

    // Redeem an existing ticket only when it belongs to THIS result. A ticket
    // left behind by a different game must not be redeemed here and then
    // reported under this quiz's name.
    const pending = readPendingClaim();
    if (pending && pending.kind === "session" && pending.returnTo === returnPath) {
      trackResultEvent("result_claim_started", { mode: "hosted" });
      const outcome = await redeemPendingClaim();
      report(outcome);
      return;
    }

    setMinting(true);
    try {
      const token = await createSessionClaim(identity.id, identity.secretToken);
      savePendingClaim({ token, kind: "session", label: quizTitle, returnTo: returnPath, createdAt: Date.now() });

      if (isAuthenticated) {
        // Already signed in: no reason to make the player leave the results.
        trackResultEvent("result_claim_started", { mode: "hosted" });
        const outcome = await redeemPendingClaim();
        report(outcome);
        return;
      }

      // Guest: record where to come back to, mark this as the trip we asked
      // for, then navigate. The claim token itself never enters the URL.
      trackResultEvent("sign_in_started_from_result", { mode: "hosted" });
      rememberReturnIntent({ path: returnPath, reason: "save-result" });
      markClaimReturnTrip();
      await navigate({ to: "/auth", search: authSearch(returnPath, "save-result") });
    } catch (e) {
      toastError(e, { context: "prepare result", fallback: "Could not prepare this result" });
    } finally {
      setMinting(false);
    }
  }

  /** Turn a real redemption outcome into a toast and a funnel event. */
  function report(outcome: ClaimState) {
    if (outcome.phase === "claimed") {
      trackResultEvent("result_claim_succeeded", { mode: "hosted" });
      toast.success(`Saved "${quizTitle}" to your profile`);
    } else if (outcome.detail) {
      trackResultEvent("result_claim_failed", { mode: "hosted" });
      toast.error(outcome.detail);
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

  if (view.kind === "already-saved") {
    // Neutral on purpose: the server will not say whether this account is the
    // one that claimed it, so we neither claim it is ours nor call it a
    // failure. Retrying would only earn the same answer.
    return (
      <div className="border border-border bg-card px-4 py-2 flex items-center gap-2" role="status">
        <span className="size-1.5 bg-cyan-jolt rounded-full" />
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
          Already linked to an account
        </p>
      </div>
    );
  }

  if (view.kind === "problem") {
    return (
      <div className="border border-pink-shock/30 bg-pink-shock/10 p-4 text-left" role="status">
        <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">Result not saved</p>
        <p className="text-sm text-foreground/75 mt-1">{view.detail}</p>
        <button
          type="button"
          onClick={() => void save()}
          disabled={minting}
          aria-busy={minting}
          className="mt-3 font-mono text-[10px] uppercase tracking-widest text-volt hover:underline disabled:opacity-50"
        >
          {minting ? "Trying…" : "Try again →"}
        </button>
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

  const isOffer = view.kind === "save-offer";

  if (declined) {
    // The player said not now. The result above is untouched and complete;
    // this only removes the invitation, and leaves a quiet way back.
    return (
      <button
        type="button"
        onClick={() => setDeclined(false)}
        className="font-mono text-[10px] uppercase tracking-widest text-foreground/50 hover:text-volt transition-colors"
      >
        Save this result later →
      </button>
    );
  }

  return (
    <div className="border border-volt/30 bg-volt/5 p-4 text-left">
      <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
        {isOffer ? "Keep your result" : "Result not saved yet"}
      </p>
      <p className="text-sm text-foreground/75 mt-1">
        {isOffer
          ? "Your game is complete! Sign in or create a Brain Bolt account to save this score, track your progress, and revisit your results."
          : "You're signed in. Save this score to your profile."}
      </p>
      <button
        type="button"
        disabled={minting}
        aria-busy={minting}
        onClick={() => void save()}
        className="mt-3 w-full bg-volt text-background font-display text-lg uppercase italic py-3 skew-cta disabled:opacity-60"
      >
        {minting ? "Preparing…" : isOffer ? "Sign in & save result" : "Save this result"}
      </button>
      {isOffer && (
        <button
          type="button"
          onClick={() => setDeclined(true)}
          className="mt-2 w-full font-mono text-[10px] uppercase tracking-widest text-foreground/50 hover:text-foreground transition-colors py-2"
        >
          Not now
        </button>
      )}
    </div>
  );
}
