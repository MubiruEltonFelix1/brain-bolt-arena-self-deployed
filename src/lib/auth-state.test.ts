// Auth bootstrap and session continuity.
//
// The failures these lock down are the ones users actually reported: being
// signed out mid-session, bounced to the wrong page, or asked to sign in again
// immediately after signing in.
//
// The central invariant: a session we could not CHECK is never rendered as a
// session that does not EXIST. `guest` is reachable only from a SIGNED_OUT
// event or a completed `getSession()` with no session.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  __setAuthClientForTests,
  isAuthResolved,
  readAuthState,
  retryAuthCheck,
  signOutUser,
} from "@/lib/auth-state";

type SessionLike = { user: { id: string; email: string } } | null;

type FakeOptions = {
  getSession?: () => Promise<{ data: { session: SessionLike }; error: unknown }>;
};

function fakeClient(options: FakeOptions = {}) {
  let listener: ((event: string, session: SessionLike) => void) | null = null;
  const calls = { onAuthStateChange: 0, getSession: 0, signOut: 0 };

  const client = {
    auth: {
      async getSession() {
        calls.getSession += 1;
        if (options.getSession) return (await options.getSession()) as never;
        return { data: { session: null }, error: null } as never;
      },
      onAuthStateChange(cb: (event: string, session: SessionLike) => void) {
        calls.onAuthStateChange += 1;
        listener = cb;
        return { data: { subscription: { unsubscribe: () => { listener = null; } } } };
      },
      async signOut() {
        calls.signOut += 1;
        listener?.("SIGNED_OUT", null);
        return { error: null } as never;
      },
    },
  } as unknown as SupabaseClient;

  return {
    client,
    calls,
    emit: (event: string, session: SessionLike) => listener?.(event, session),
  };
}

const USER = { id: "user-1", email: "player@example.com" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // The store only bootstraps in a browser context.
  (globalThis as { window?: unknown }).window = {};
});

afterEach(() => {
  __setAuthClientForTests(null);
  delete (globalThis as { window?: unknown }).window;
});

describe("bootstrap", () => {
  test("an existing session restores as authenticated", async () => {
    const fake = fakeClient({ getSession: async () => ({ data: { session: { user: USER } }, error: null }) });
    __setAuthClientForTests(fake.client);

    readAuthState(); // triggers start()
    await flush();

    const state = readAuthState();
    expect(state.status).toBe("authenticated");
    expect(state.user?.id).toBe("user-1");
    expect(state.initialized).toBe(true);
  });

  test("restoration is never reported as guest while it is still in flight", async () => {
    let release!: (v: { data: { session: SessionLike }; error: unknown }) => void;
    const fake = fakeClient({
      getSession: () => new Promise((r) => { release = r; }),
    });
    __setAuthClientForTests(fake.client);

    readAuthState();
    const during = readAuthState();
    // The decisive assertion: a guard reading this must not redirect.
    expect(during.status).toBe("loading");
    expect(during.initialized).toBe(false);

    release({ data: { session: { user: USER } }, error: null });
    await flush();
    expect(readAuthState().status).toBe("authenticated");
  });

  test("a failed check is an error, never a sign-out", async () => {
    const fake = fakeClient({
      getSession: async () => ({ data: { session: null }, error: { message: "network down" } }),
    });
    __setAuthClientForTests(fake.client);

    readAuthState();
    await flush();

    const state = readAuthState();
    expect(state.status).toBe("error");
    // This is the whole point: not "guest".
    expect(state.status).not.toBe("guest");
    expect(state.initialized).toBe(true);
    expect(state.error).toBeTruthy();
  });

  test("signed-out is established only after restoration completes", async () => {
    const fake = fakeClient();
    __setAuthClientForTests(fake.client);

    readAuthState();
    expect(readAuthState().status).toBe("loading");
    await flush();
    expect(readAuthState().status).toBe("guest");
  });

  test("a retry after a failure can resolve the session", async () => {
    let attempt = 0;
    const fake = fakeClient({
      getSession: async () => {
        attempt += 1;
        return attempt === 1
          ? { data: { session: null }, error: { message: "offline" } }
          : { data: { session: { user: USER } }, error: null };
      },
    });
    __setAuthClientForTests(fake.client);

    readAuthState();
    await flush();
    expect(readAuthState().status).toBe("error");

    await retryAuthCheck();
    expect(readAuthState().status).toBe("authenticated");
  });
});

describe("session continuity", () => {
  test("a token refresh with no session payload does not log the user out", async () => {
    const fake = fakeClient({ getSession: async () => ({ data: { session: { user: USER } }, error: null }) });
    __setAuthClientForTests(fake.client);
    readAuthState();
    await flush();
    expect(readAuthState().status).toBe("authenticated");

    // The event shape that used to blank the user and trigger a redirect.
    fake.emit("TOKEN_REFRESHED", null);
    await flush();

    const state = readAuthState();
    expect(state.status).toBe("authenticated");
    expect(state.user?.id).toBe("user-1");
  });

  test("sign-in after an error flips to authenticated", async () => {
    const fake = fakeClient({
      getSession: async () => ({ data: { session: null }, error: { message: "offline" } }),
    });
    __setAuthClientForTests(fake.client);
    readAuthState();
    await flush();
    expect(readAuthState().status).toBe("error");

    fake.emit("SIGNED_IN", { user: { id: "user-2", email: "new@example.com" } });
    await flush();
    expect(readAuthState().status).toBe("authenticated");
    expect(readAuthState().user?.id).toBe("user-2");
  });

  test("a newer answer is not overwritten by a stale one", async () => {
    let releaseSlow!: (v: { data: { session: SessionLike }; error: unknown }) => void;
    const fake = fakeClient({
      getSession: () => new Promise((r) => { releaseSlow = r; }),
    });
    __setAuthClientForTests(fake.client);
    readAuthState();

    // A sign-in lands while the slow bootstrap is still in flight.
    fake.emit("SIGNED_IN", { user: USER });
    await flush();
    expect(readAuthState().status).toBe("authenticated");

    // The stale bootstrap finally answers with nothing. It must not win.
    releaseSlow({ data: { session: null }, error: null });
    await flush();
    expect(readAuthState().status).toBe("authenticated");
    expect(readAuthState().user?.id).toBe("user-1");
  });

  test("explicit sign-out ends the session and is distinguishable from a failure", async () => {
    const fake = fakeClient({ getSession: async () => ({ data: { session: { user: USER } }, error: null }) });
    __setAuthClientForTests(fake.client);
    readAuthState();
    await flush();

    await signOutUser();

    expect(fake.calls.signOut).toBe(1);
    expect(readAuthState().status).toBe("guest");
    expect(readAuthState().user).toBeNull();
  });
});

describe("isAuthResolved", () => {
  const state = (over: Partial<Parameters<typeof isAuthResolved>[0]>) => ({
    status: "guest" as const,
    user: null,
    error: null,
    initialized: true,
    ...over,
  });

  test("a pending bootstrap is not resolved", () => {
    expect(isAuthResolved(state({ status: "loading", initialized: false }))).toBe(false);
  });

  test("a failed check is NOT resolved - this is the regression guard", () => {
    // A consumer that treats this as resolved concludes "no user" and renders
    // an un-authorized, signed-out-looking surface on a dropped connection.
    expect(isAuthResolved(state({ status: "error", error: "offline" }))).toBe(false);
  });

  test("a definitive guest is resolved", () => {
    expect(isAuthResolved(state({ status: "guest" }))).toBe(true);
  });

  test("an authenticated session is resolved", () => {
    expect(isAuthResolved(state({ status: "authenticated", user: USER as never }))).toBe(true);
  });
});

describe("listener lifecycle", () => {
  test("exactly one auth listener is registered no matter how often state is read", async () => {
    const fake = fakeClient({ getSession: async () => ({ data: { session: { user: USER } }, error: null }) });
    __setAuthClientForTests(fake.client);

    for (let i = 0; i < 25; i += 1) readAuthState();
    await flush();
    for (let i = 0; i < 25; i += 1) readAuthState();
    await flush();

    expect(fake.calls.onAuthStateChange).toBe(1);
  });

  test("state is read from storage, not refetched per consumer", async () => {
    const fake = fakeClient({ getSession: async () => ({ data: { session: { user: USER } }, error: null }) });
    __setAuthClientForTests(fake.client);

    readAuthState();
    await flush();
    for (let i = 0; i < 25; i += 1) readAuthState();
    await flush();

    // One restoration, not one per consumer. This is the duplicate-network-call
    // fix: the old hook ran a getUser() per mounted component.
    expect(fake.calls.getSession).toBe(1);
  });

  test("nothing bootstraps without a browser context", () => {
    delete (globalThis as { window?: unknown }).window;
    const fake = fakeClient();
    __setAuthClientForTests(fake.client);

    readAuthState();

    expect(fake.calls.onAuthStateChange).toBe(0);
    expect(readAuthState().status).toBe("loading");
  });
});
