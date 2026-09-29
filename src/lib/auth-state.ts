// The single authoritative source of browser authentication state.
//
// Every part of the app reads its auth state from here. Before this module
// existed each consumer ran its own `supabase.auth.getUser()` and registered
// its own `onAuthStateChange` listener, which produced three separate bugs:
//
//   1. `getUser()` is a NETWORK call. It was never caught, so a single failed
//      request (offline, blocked, 5xx) resolved `user: null` and flipped the
//      app to "signed out" — which is what made signed-in players believe they
//      had been logged out. A refresh token that could not be renewed was
//      likewise indistinguishable from a deliberate sign-out.
//   2. Eleven consumers each kept their own copy of "who is the user", so a
//      stale response landing after a fresh one clobbered the truth and sent
//      the user back to the sign-in page.
//   3. A guard could not tell "still restoring" from "restored, nobody there",
//      so it could redirect mid-bootstrap.
//
// The rules this module enforces:
//   * `guest` is only ever reached from a DEFINITIVE answer — a SIGNED_OUT
//     event, or `getSession()` completing with no session. Never from a
//     failure. A failed check becomes `error`, which is not sign-out.
//   * Bootstrap reads `getSession()`, which is served from persisted storage
//     and does not require a network round trip for a valid session. This is
//     the change that makes a returning user stay signed in.
//   * Exactly one `onAuthStateChange` listener exists, ever, and its callback
//     does no asynchronous work (awaiting inside an auth callback can deadlock
//     Supabase's own auth processing).
//   * A newer answer is never overwritten by a stale one.

import { useSyncExternalStore } from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AuthStatus = "loading" | "authenticated" | "guest" | "error";

export type AuthState = {
  status: AuthStatus;
  user: User | null;
  /** Human-readable reason, only populated when status === "error". Never a raw provider exception. */
  error: string | null;
  /** True once the outcome is settled. Guards must wait for this before redirecting. */
  initialized: boolean;
};

const INITIAL_STATE: AuthState = {
  status: "loading",
  user: null,
  error: null,
  initialized: false,
};

/** Shown when we could not determine the session. Distinct from "signed out" on purpose. */
export const SESSION_CHECK_FAILED =
  "We couldn't confirm your sign-in. Check your connection and try again.";

let state: AuthState = INITIAL_STATE;
const listeners = new Set<() => void>();

let client: SupabaseClient | null = null;
let bootstrapped = false;
let unsubscribed: (() => void) | null = null;
let bootstrapToken = 0;

function getClient(): SupabaseClient {
  if (!client) client = supabase;
  return client;
}

function set(next: AuthState) {
  state = next;
  listeners.forEach((l) => l());
}

function current(): AuthState {
  return state;
}

/**
 * A newer resolution always wins. The bootstrap is asynchronous, so a SIGNED_IN
 * can land while `getSession()` is still in flight; letting the older answer
 * overwrite it is exactly how a fresh sign-in gets "undone" a moment later.
 */
function authenticated(user: User, error: string | null = null): AuthState {
  return { status: "authenticated", user, error, initialized: true };
}
function guest(): AuthState {
  return { status: "guest", user: null, error: null, initialized: true };
}
function failure(reason: string): AuthState {
  return { status: "error", user: null, error: reason, initialized: true };
}

/**
 * Restore the session. Runs at most once per page; a retry after a failure is
 * explicit via `retryAuthCheck()`.
 */
async function bootstrap(): Promise<void> {
  const token = ++bootstrapToken;
  let session: Session | null = null;
  let failureReason: string | null = null;

  try {
    const { data, error } = await getClient().auth.getSession();
    session = data?.session ?? null;
    failureReason = error ? SESSION_CHECK_FAILED : null;
  } catch {
    failureReason = SESSION_CHECK_FAILED;
  }

  // A newer bootstrap (or an auth event) superseded this one.
  if (token !== bootstrapToken) return;

  if (session?.user) {
    // A stored session is proof enough to render as signed in. Validation
    // happens in the background and surfaces through auth events.
    set(authenticated(session.user));
    return;
  }
  if (failureReason) {
    set(failure(failureReason));
    return;
  }
  set(guest());
}

function handleAuthEvent(event: string, session: Session | null) {
  // Any delivered event is a newer answer than an in-flight bootstrap, so it
  // supersedes it. Without this, a slow `getSession()` could land after a
  // sign-in and drag the app back to "guest" - the reported "it logged me out".
  switch (event) {
    case "SIGNED_OUT":
      bootstrapToken += 1;
      // The only event that is allowed to mean "signed out".
      set(guest());
      return;
    case "SIGNED_IN":
    case "USER_UPDATED":
    case "TOKEN_REFRESHED":
    case "PASSWORD_RECOVERY":
    case "INITIAL_SESSION": {
      // Keep the known user when the event carries no user object - a refresh
      // event that omitted the session must not blank the signed-in user.
      const user = session?.user ?? state.user;
      if (user) {
        bootstrapToken += 1;
        set(authenticated(user));
      } else if (event === "SIGNED_IN") {
        bootstrapToken += 1;
        set(failure(SESSION_CHECK_FAILED));
      }
      return;
    }
    default:
      return;
  }
}

function start(): void {
  if (bootstrapped) return;
  if (typeof window === "undefined") return;
  bootstrapped = true;

  const auth = getClient().auth;

  // Register the single listener BEFORE bootstrapping so a sign-in that lands
  // during restoration is never missed.
  const { data: sub } = auth.onAuthStateChange(handleAuthEvent);
  unsubscribed = () => sub.subscription.unsubscribe();

  void bootstrap();
}

function stop(): void {
  unsubscribed?.();
  unsubscribed = null;
  bootstrapped = false;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window !== "undefined") start();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): AuthState {
  return state;
}

function getServerSnapshot(): AuthState {
  return INITIAL_STATE;
}

/** Read the authoritative auth state. Registers no listener and makes no request. */
export function useAuthState(): AuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-reactive read, for imperative code (guards, analytics, sign-out). */
export function readAuthState(): AuthState {
  if (typeof window !== "undefined") start();
  return state;
}

/** True once the outcome is definitively settled and there is no user. */
export function isDefinitelyGuest(): boolean {
  const s = readAuthState();
  return s.initialized && (s.status === "guest" || s.status === "error");
}

/**
 * True when the session question has actually been answered.
 *
 * Deliberately FALSE for `status === "error"`. A session we could not check is
 * not a session that does not exist, and a consumer that treats "resolved"
 * as "no user" will render an un-authorized, signed-out-looking surface on a
 * dropped connection. This is the single definition of "resolved"; callers
 * that only care about a definitive answer should check `status === "guest"`.
 */
export function isAuthResolved(state: AuthState = current()): boolean {
  return state.initialized && state.status !== "error";
}

/**
 * Deliberate sign-out. The SIGNED_OUT event drives the store to `guest`; this
 * exists so there is exactly one obvious call site and callers never sign out
 * as a side effect of navigation or an error path.
 */
export async function signOutUser(): Promise<void> {
  const { error } = await getClient().auth.signOut();
  if (error) throw error;
  // Supersede any in-flight restoration, so a slow bootstrap cannot resurrect
  // the session the user just ended.
  bootstrapToken += 1;
  set(guest());
}

/** Re-run restoration after a failure or an expired-session notice. */
export async function retryAuthCheck(): Promise<void> {
  await bootstrap();
}

/**
 * Test seam. Swaps the client and returns the store to its initial state so a
 * suite can drive bootstrap and auth events deterministically.
 */
export function __setAuthClientForTests(next: SupabaseClient | null): void {
  stop();
  client = next;
  bootstrapped = false;
  bootstrapToken = 0;
  state = INITIAL_STATE;
}
