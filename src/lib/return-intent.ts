// Preserving where the user was going across an authentication flow.
//
// The bug this replaces: every sign-in redirect passed a bare `next` string
// that defaulted to `/dashboard`. The homepage nav links, the host shell and
// the profile page all dropped the destination entirely, so a player who
// clicked "Host" while looking at a Game PIN came back to the dashboard  - 
// the wrong page, with the session deep-link gone.
//
// Design rules:
//   * Only KNOWN internal Brain Bolt routes are accepted. This is an allowlist
//     of shapes, not a "starts with /" check, which is what made the old code
//     willing to follow `//evil.example.com`.
//   * Storage is sessionStorage, not localStorage. An intent is meaningful for
//     the length of one auth flow: it must survive a reload and the OAuth
//     round-trip in the same tab, and must NOT survive the tab. A stale
//     redirect that follows the user around days later is the failure mode we
//     are avoiding.
//   * One-shot. Reading an intent consumes it.
//   * Claim material is never stored here. Result claim tokens live in
//     `src/lib/claim.ts` under their own key and never enter a URL.

const KEY = "brainbolt:return-intent";

/** An intent is only useful while the auth flow is happening. */
export const RETURN_INTENT_TTL_MS = 15 * 60 * 1000;

export type ReturnReason = "host" | "save-result" | "sign-in";

export type ReturnIntent = {
  /** Sanitized internal path. Already validated against ALLOWED_DESTINATIONS. */
  path: string;
  reason: ReturnReason;
  createdAt: number;
  /** Changes on every write, so a consumed intent is never resurrected. */
  id: string;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PIN = "\\d{6}";

/**
 * C0 controls plus DEL. Built from a string rather than a literal so the
 * control characters never appear in this file as raw bytes.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");

/**
 * Every destination a return intent may point at, mirroring the file-based
 * routes in `src/routes/`. `/auth` is deliberately absent: bouncing a user back
 * to the sign-in page they just completed is the redirect loop we are fixing.
 */
const ALLOWED_DESTINATIONS: readonly RegExp[] = [
  /^\/$/,
  /^\/admin$/,
  /^\/arena$/,
  new RegExp(`^/arena/${UUID}$`),
  new RegExp(`^/arena/${UUID}/play$`),
  /^\/branding$/,
  /^\/competitions$/,
  /^\/dashboard$/,
  /^\/debug\/map$/,
  new RegExp(`^/host/${UUID}$`),
  new RegExp(`^/join/${PIN}$`),
  new RegExp(`^/leagues/${UUID}$`),
  /^\/leagues$/,
  new RegExp(`^/play/${UUID}$`),
  /^\/profile$/,
  new RegExp(`^/quizzes/${UUID}$`),
  /^\/request-hosting$/,
  /^\/training$/,
];

/**
 * Validate a candidate destination.
 *
 * Returns the path only when it is a known internal route, otherwise `null`
 * so the caller can fall back to its own default. Rejects: non-strings,
 * control characters, protocol-relative and scheme-absolute URLs, backslash
 * separators, and anything carrying a query or fragment (no current flow
 * needs one, and it removes a whole class of injection).
 */
export function sanitizeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > 200) return null;
  if (CONTROL_CHARS.test(raw)) return null;
  if (!raw.startsWith("/")) return null;
  // `//host` is protocol-relative and `/\host` is normalized to `//host` by
  // several browsers. Neither is an internal route.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.includes("?") || raw.includes("#")) return null;
  if (!ALLOWED_DESTINATIONS.some((re) => re.test(raw))) return null;
  return raw;
}

/** Internal path of the current location, or "" when unavailable. */
export function currentInternalPath(): string {
  if (typeof window === "undefined") return "";
  return sanitizeReturnPath(window.location.pathname) ?? "";
}

/** Where to send a user who has no usable intent. */
export const DEFAULT_RETURN_PATH = "/dashboard";

function write(intent: ReturnIntent) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // A blocked or full storage must never break the auth flow itself; the
    // destination still travels in the `next` query parameter.
  }
}

function readRaw(): ReturnIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReturnIntent;
    if (typeof parsed?.path !== "string" || typeof parsed?.createdAt !== "number") return null;
    if (Date.now() - parsed.createdAt > RETURN_INTENT_TTL_MS) return null;
    // Re-validate on read: sessionStorage is attacker-writable from any script
    // on the origin, and an intent written by an older build may not match
    // today's route table.
    if (sanitizeReturnPath(parsed.path) !== parsed.path) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearReturnIntent() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing useful to do */
  }
}

export type RememberArgs = {
  /** Candidate destination; sanitized before it is stored. */
  path: string;
  reason: ReturnReason;
};

/**
 * Record where the user was heading. Returns the sanitized path actually
 * stored, or null when the candidate was not a valid destination (in which
 * case the caller should use its own default and nothing is written).
 */
export function rememberReturnIntent({ path, reason }: RememberArgs): string | null {
  const safe = sanitizeReturnPath(path);
  if (!safe) return null;
  write({
    path: safe,
    reason,
    createdAt: Date.now(),
    // `randomUUID` needs a secure context. It is absent on a plain-HTTP LAN
    // origin, and a throw here would take down the click handler that called
    // us, so fall back rather than fail the sign-in flow.
    id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  });
  return safe;
}

/** Read without consuming. */
export function peekReturnIntent(): ReturnIntent | null {
  return readRaw();
}

/** Read and clear. This is what makes an intent one-shot. */
export function consumeReturnIntent(): ReturnIntent | null {
  const intent = readRaw();
  if (intent) clearReturnIntent();
  return intent;
}

/**
 * The search object for a sign-in navigation. Prefer this over
 * `buildAuthHref` when navigating with the router, so the destination travels
 * as structured data rather than a string.
 */
export function authSearch(
  path: string,
  reason: ReturnReason = "sign-in",
): { next: string; reason: ReturnReason } {
  return { next: sanitizeReturnPath(path) ?? DEFAULT_RETURN_PATH, reason };
}

/**
 * Build the sign-in URL for a gated action. The `next` parameter is the
 * sanitized path, and `reason` only selects copy, never authorization.
 */
export function buildAuthHref(path: string, reason: ReturnReason = "sign-in"): string {
  return `/auth?${new URLSearchParams(authSearch(path, reason)).toString()}`;
}
