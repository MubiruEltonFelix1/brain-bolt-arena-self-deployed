// Return-intent handling.
//
// The bug these lock down: sign-in always returned the user to a generic
// destination (in practice `/dashboard`), so a player who started from a Game
// PIN or a host deep-link came back to the wrong page with their context gone.
//
// The security property: only allowlisted internal routes are ever followed.
// The old check was `next.startsWith("/")`, which happily accepted
// `//evil.example.com`.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  authSearch,
  buildAuthHref,
  clearReturnIntent,
  consumeReturnIntent,
  DEFAULT_RETURN_PATH,
  peekReturnIntent,
  rememberReturnIntent,
  RETURN_INTENT_TTL_MS,
  sanitizeReturnPath,
} from "@/lib/return-intent";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { sessionStorage: memoryStorage() };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("sanitizeReturnPath", () => {
  test("accepts known internal routes", () => {
    const valid = [
      "/",
      "/dashboard",
      "/profile",
      "/admin",
      "/arena",
      `/arena/${UUID}`,
      `/arena/${UUID}/play`,
      "/competitions",
      "/leagues",
      `/leagues/${UUID}`,
      `/quizzes/${UUID}`,
      "/request-hosting",
      "/training",
      "/branding",
      "/debug/map",
      "/join/351208",
      `/play/${UUID}`,
      `/host/${UUID}`,
    ];
    for (const path of valid) {
      expect(sanitizeReturnPath(path)).toBe(path);
    }
  });

  test("rejects external and protocol-relative destinations", () => {
    const hostile = [
      "https://evil.example.com",
      "http://evil.example.com",
      "//evil.example.com",
      "///evil.example.com",
      "/\\evil.example.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)//",
      "HTTPS://EVIL.EXAMPLE.COM",
      "\\\\evil.example.com",
    ];
    for (const path of hostile) {
      expect(sanitizeReturnPath(path)).toBeNull();
    }
  });

  test("rejects the sign-in page itself, which would be a redirect loop", () => {
    expect(sanitizeReturnPath("/auth")).toBeNull();
    expect(sanitizeReturnPath("/auth/")).toBeNull();
  });

  test("rejects paths that are not real routes", () => {
    expect(sanitizeReturnPath("/nope")).toBeNull();
    expect(sanitizeReturnPath("/dashboard/extra")).toBeNull();
    expect(sanitizeReturnPath("/play/not-a-uuid")).toBeNull();
    expect(sanitizeReturnPath("/join/12345")).toBeNull();
    expect(sanitizeReturnPath("/join/abcdef")).toBeNull();
    // Only `quizzes.$id` exists; there is no /quizzes index to return to.
    expect(sanitizeReturnPath("/quizzes")).toBeNull();
    expect(sanitizeReturnPath("/")).toBe("/");
  });

  test("rejects anything carrying a query or fragment", () => {
    expect(sanitizeReturnPath(`/play/${UUID}?token=abc`)).toBeNull();
    expect(sanitizeReturnPath("/dashboard#x")).toBeNull();
    // Which is what keeps claim material out of a return URL entirely.
    expect(sanitizeReturnPath("/play/x?claim_token=deadbeef")).toBeNull();
  });

  test("rejects control characters, non-strings and overlong input", () => {
    expect(sanitizeReturnPath("/dashboard\u0000")).toBeNull();
    expect(sanitizeReturnPath("/dashboard\n")).toBeNull();
    expect(sanitizeReturnPath("/dash\u007fboard")).toBeNull();
    expect(sanitizeReturnPath(null)).toBeNull();
    expect(sanitizeReturnPath(undefined)).toBeNull();
    expect(sanitizeReturnPath(42)).toBeNull();
    expect(sanitizeReturnPath({ path: "/dashboard" })).toBeNull();
    expect(sanitizeReturnPath(`/${"a".repeat(500)}`)).toBeNull();
    expect(sanitizeReturnPath("")).toBeNull();
  });
});

describe("intent storage", () => {
  test("remembers a valid destination and reads it back", () => {
    expect(rememberReturnIntent({ path: "/join/351208", reason: "sign-in" })).toBe("/join/351208");
    const intent = peekReturnIntent();
    expect(intent?.path).toBe("/join/351208");
    expect(intent?.reason).toBe("sign-in");
  });

  test("a Game PIN survives the round trip", () => {
    rememberReturnIntent({ path: "/join/351208", reason: "sign-in" });
    const intent = consumeReturnIntent();
    expect(intent?.path).toBe("/join/351208");
  });

  test("an intent is one-shot: it cannot become a stale redirect", () => {
    rememberReturnIntent({ path: "/join/351208", reason: "sign-in" });
    expect(consumeReturnIntent()?.path).toBe("/join/351208");
    // The workflow completed. A later visit must not be dragged back.
    expect(consumeReturnIntent()).toBeNull();
    expect(peekReturnIntent()).toBeNull();
  });

  test("an invalid destination is not written at all", () => {
    expect(rememberReturnIntent({ path: "https://evil.example.com", reason: "host" })).toBeNull();
    expect(peekReturnIntent()).toBeNull();
  });

  test("an expired intent is discarded rather than followed", () => {
    rememberReturnIntent({ path: "/join/351208", reason: "sign-in" });
    // Backdate past the TTL.
    const key = "brainbolt:return-intent";
    const stored = JSON.parse((globalThis as never as { window: { sessionStorage: Storage } }).window.sessionStorage.getItem(key)!);
    stored.createdAt = Date.now() - RETURN_INTENT_TTL_MS - 1000;
    (globalThis as never as { window: { sessionStorage: Storage } }).window.sessionStorage.setItem(key, JSON.stringify(stored));

    expect(peekReturnIntent()).toBeNull();
    expect(consumeReturnIntent()).toBeNull();
  });

  test("a tampered intent is re-validated on read, not trusted", () => {
    // sessionStorage is writable by any script on the origin, and a value
    // written by an older build may no longer match today's route table.
    (globalThis as never as { window: { sessionStorage: Storage } }).window.sessionStorage.setItem(
      "brainbolt:return-intent",
      JSON.stringify({ path: "https://evil.example.com", reason: "host", createdAt: Date.now(), id: "x" }),
    );
    expect(peekReturnIntent()).toBeNull();

    (globalThis as never as { window: { sessionStorage: Storage } }).window.sessionStorage.setItem(
      "brainbolt:return-intent",
      JSON.stringify({ path: "/auth", reason: "host", createdAt: Date.now(), id: "x" }),
    );
    expect(peekReturnIntent()).toBeNull();
  });

  test("malformed storage does not throw", () => {
    const { window } = globalThis as never as { window: { sessionStorage: Storage } };
    window.sessionStorage.setItem("brainbolt:return-intent", "{{{not json");
    expect(peekReturnIntent()).toBeNull();
    clearReturnIntent();
    expect(peekReturnIntent()).toBeNull();
  });
});

describe("auth destinations", () => {
  test("a valid path is carried into the sign-in URL", () => {
    const search = authSearch("/join/351208", "host");
    expect(search.next).toBe("/join/351208");
    expect(search.reason).toBe("host");

    const href = buildAuthHref(`/play/${UUID}`, "save-result");
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("next")).toBe(`/play/${UUID}`);
    expect(params.get("reason")).toBe("save-result");
  });

  test("a hostile destination collapses to the default, never a redirect off-site", () => {
    for (const hostile of ["https://evil.example.com", "//evil.example.com", "/auth", "nonsense"]) {
      const search = authSearch(hostile, "host");
      expect(search.next).toBe(DEFAULT_RETURN_PATH);
      const href = buildAuthHref(hostile, "host");
      const next = new URLSearchParams(href.split("?")[1]).get("next")!;
      expect(next).toBe(DEFAULT_RETURN_PATH);
      expect(next.startsWith("/")).toBe(true);
      expect(next.startsWith("//")).toBe(false);
    }
  });

  test("reason is a UX hint only and never affects the destination", () => {
    const a = buildAuthHref("/dashboard", "host");
    const b = buildAuthHref("/dashboard", "save-result");
    const c = buildAuthHref("/dashboard", "sign-in");
    const nextOf = (h: string) => new URLSearchParams(h.split("?")[1]).get("next");
    expect(nextOf(a)).toBe(nextOf(b));
    expect(nextOf(b)).toBe(nextOf(c));
  });
});
