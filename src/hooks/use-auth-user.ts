import {
  useAuthState,
  retryAuthCheck,
  type AuthState,
  type AuthStatus,
} from "@/lib/auth-state";

/**
 * Backwards-compatible view over the single auth store.
 *
 * This hook used to run its own `getUser()` + `onAuthStateChange` per consumer,
 * which is what let a failed network call masquerade as a sign-out. It now adds
 * no listener and makes no request — it only reads the shared store.
 *
 * `loading` is true ONLY while the outcome is unresolved. It is deliberately
 * false for `status === "error"`: a session we could not check is not the same
 * as a session that does not exist, and guards must not redirect on it.
 * Read `status` when the difference matters.
 */
export function useAuthUser(): {
  user: AuthState["user"];
  loading: boolean;
  status: AuthStatus;
  error: string | null;
  retry: () => Promise<void>;
} {
  const { user, status, error, initialized } = useAuthState();
  return { user, loading: !initialized, status, error, retry: retryAuthCheck };
}
