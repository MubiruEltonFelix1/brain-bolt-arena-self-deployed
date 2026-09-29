import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuthState, retryAuthCheck, type AuthState } from "@/lib/auth-state";
import {
  authSearch,
  currentInternalPath,
  rememberReturnIntent,
  type ReturnReason,
} from "@/lib/return-intent";

export type AuthGate = {
  user: AuthState["user"];
  /** True only while restoration is unresolved. Render a loading state. */
  pending: boolean;
  /** True only when we DEFINITIVELY know there is no user. */
  guest: boolean;
  /**
   * Set when the session could not be checked. This is not a sign-out: the
   * caller should show a retry, never redirect.
   */
  error: string | null;
  retry: () => Promise<void>;
};

type Options = {
  /** Why sign-in is being requested. Selects copy only, never authorization. */
  reason: ReturnReason;
  /** Destination to return to. Defaults to the current internal path. */
  path?: string;
  /** Set false to suspend the gate (e.g. during an active game). */
  enabled?: boolean;
};

/**
 * The one guard contract used by every protected surface.
 *
 * Three states that used to be collapsed into two:
 *   - restoration unresolved  -> `pending`; never redirect
 *   - session undeterminable  -> `error`; offer a retry, never redirect
 *   - genuinely signed out    -> `guest`; redirect, carrying the destination
 *
 * Redirecting on an unresolved or undeterminable session is what produced the
 * reported "it logged me out" behaviour.
 */
export function useAuthGate({ reason, path, enabled = true }: Options): AuthGate {
  const { user, status, error, initialized } = useAuthState();
  const navigate = useNavigate();
  const redirected = useRef(false);

  const destination = path ?? currentInternalPath();
  const guest = initialized && status === "guest";

  useEffect(() => {
    if (!enabled || !guest || redirected.current) return;
    redirected.current = true;
    // Record the intent in sessionStorage first so the destination survives a
    // reload or an OAuth round-trip even if the query parameter is lost.
    // An empty destination means we could not identify where the user was, so
    // nothing is written and no `next` is sent - defaulting it to the dashboard
    // here would silently drop the journey we were asked to preserve.
    const remembered = destination ? rememberReturnIntent({ path: destination, reason }) : null;
    void navigate({
      to: "/auth",
      search: remembered
        ? authSearch(remembered, reason)
        : ({ reason } as { next?: string; reason: ReturnReason }),
      replace: true,
    });
  }, [enabled, guest, destination, reason, navigate]);

  // Allow a later journey through this same mounted gate to redirect again
  // (e.g. the user signs in, then signs out again without leaving the page).
  useEffect(() => {
    if (!guest) redirected.current = false;
  }, [guest]);

  return {
    user,
    pending: !initialized,
    guest,
    error: status === "error" ? (error ?? "Something went wrong.") : null,
    retry: retryAuthCheck,
  };
}
