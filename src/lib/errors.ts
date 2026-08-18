// Friendly error classification layer.
//
// Maps known technical failures (Supabase / Postgrest / RLS / RPC / network /
// auth) into safe, user-facing categories. The original technical error is
// never erased — every path logs it for developers (logActionError) before a
// safe message is shown to the user. This is a presentation layer only:
// authorization stays server-side (RLS / SECURITY DEFINER RPCs remain the
// authority; nothing here bypasses or weakens them).

import { toast } from "sonner";

export type ErrorKind =
  | "unauthorized" // RLS violation, insufficient privilege, permission denied
  | "auth-required" // missing / expired session
  | "host-access" // host authorization missing, expired or revoked
  | "not-found"
  | "validation" // invalid input, constraint violations
  | "temporary" // network / timeout / overload — retryable
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  retry: boolean;
}

// User-facing copy (Phase 10A §2). Never expose SQL, table names, stack
// traces, Supabase internals, RPC names or raw PostgreSQL messages.
const MESSAGES: Record<ErrorKind, string> = {
  unauthorized: "You don't have permission to perform this action.",
  "auth-required": "Please sign in to continue.",
  "host-access": "Host access is not currently available for this account.",
  "not-found": "We couldn't find that. It may have been removed or archived.",
  validation: "We couldn't save this because some information is incomplete or invalid.",
  temporary: "We couldn't complete that action right now. Please try again.",
  unknown: "Something went wrong. Please try again.",
};

/** Resource-specific not-found copy, e.g. resourceNotFoundMessage("quiz"). */
export function resourceNotFoundMessage(resource: string): string {
  return `We couldn't find that ${resource}. It may have been removed or archived.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function field(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

const VALIDATION_CODES = new Set([
  "22P02",
  "22001",
  "22003",
  "23502",
  "23503",
  "23505",
  "23514",
  "23P01",
]);

export function classifyError(error: unknown): ClassifiedError {
  if (!isRecord(error)) {
    return { kind: "unknown", message: MESSAGES.unknown, retry: false };
  }

  const message = field(error, "message") ?? "";
  const code = (field(error, "code") ?? "").toUpperCase();
  const name = field(error, "name") ?? "";
  const status = Number(field(error, "status"));
  const haystack = `${name} ${message} ${code}`.toLowerCase();

  // --- host access: DB-raised messages about hosting authorization ---
  // Anchored phrases only — never bare substrings, so table/RPC identifiers
  // like `host_authorizations` or `admin_grant_host_authorization` cannot
  // false-positive into this branch.
  if (
    /\bhosting not authorized\b|\bhost access\b|\bhost authorization\b|\bhosting access\b|\bnot authorized to host\b/i.test(
      haystack,
    )
  ) {
    return { kind: "host-access", message: MESSAGES["host-access"], retry: false };
  }

  // --- auth: missing / expired session ---
  if (
    name === "AuthSessionMissingError" ||
    /auth session missing|no user found|invalid refresh token|session has expired|jwt expired|access token.*expired/i.test(
      haystack,
    )
  ) {
    return { kind: "auth-required", message: MESSAGES["auth-required"], retry: false };
  }

  // --- auth: sign-in / sign-up failures (friendly, specific copy) ---
  if (
    name === "AuthApiError" ||
    name === "AuthError" ||
    /invalid login credentials|email not confirmed|already registered/i.test(haystack)
  ) {
    if (/invalid login credentials|invalid email|invalid password/i.test(haystack)) {
      return { kind: "validation", message: "Incorrect email or password.", retry: false };
    }
    if (/email not confirmed|email.*confirm/i.test(haystack)) {
      return {
        kind: "validation",
        message: "Please confirm your email before signing in.",
        retry: false,
      };
    }
    if (/already registered|already exists/i.test(haystack)) {
      return {
        kind: "validation",
        message: "An account with this email already exists. Try signing in instead.",
        retry: false,
      };
    }
    if (/too many|rate limit|\b429\b/i.test(haystack)) {
      return {
        kind: "temporary",
        message: "Too many attempts. Please wait a moment and try again.",
        retry: true,
      };
    }
  }

  // --- permission / RLS ---
  if (
    code === "42501" ||
    /row-level security|insufficient privilege|permission denied|not authorized|forbidden/i.test(
      haystack,
    )
  ) {
    // A 42501 can wrap a host-authorization denial (the host branch above only
    // sees the phrase when Postgrest includes it in the message) — never let
    // that degrade to a generic permission message or lose the REQUEST ACCESS
    // action.
    if (/\bhosting not authorized\b|\bhost access\b|\bhost authorization\b|\bhosting access\b|\bnot authorized to host\b/i.test(haystack)) {
      return { kind: "host-access", message: MESSAGES["host-access"], retry: false };
    }
    return { kind: "unauthorized", message: MESSAGES.unauthorized, retry: false };
  }

  // --- not found ---
  if (
    code === "PGRST116" ||
    code === "PGRST204" ||
    code === "404" ||
    /not found|could not find|no rows returned/i.test(haystack)
  ) {
    return { kind: "not-found", message: MESSAGES["not-found"], retry: false };
  }

  // --- validation / constraint violations ---
  if (
    VALIDATION_CODES.has(code) ||
    /invalid input|violates (not-null|check|unique|foreign key)|duplicate key|does not satisfy|must not be null/i.test(
      haystack,
    )
  ) {
    return { kind: "validation", message: MESSAGES.validation, retry: false };
  }

  // --- temporary / network / overload ---
  if (
    name === "AbortError" ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /failed to fetch|fetch failed|network|timeout|timed out|aborted|econnreset|socket|too many requests|overloaded|502|503|504/i.test(
      haystack,
    )
  ) {
    return { kind: "temporary", message: MESSAGES.temporary, retry: true };
  }

  return { kind: "unknown", message: MESSAGES.unknown, retry: false };
}

/** Safe user-facing message for any error. Unknowns become the generic copy. */
export function safeErrorMessage(error: unknown): string {
  return classifyError(error).message;
}

/**
 * Developer diagnostics: the original technical error (RLS message, RPC name,
 * stack trace) is preserved here — never erased by the friendly layer.
 */
export function logActionError(error: unknown, context?: string): void {
  console.error(`[brainbolt:error]${context ? ` ${context}` : ""}`, error);
}

export interface ToastErrorOptions {
  /** Label used in the developer console log. */
  context?: string;
  /** Shown instead of the generic copy when the error does not classify. */
  fallback?: string;
  /** Shown as a "TRY AGAIN" action when the failure is retryable (temporary). */
  retry?: () => void;
  /** Shown as a "REQUEST ACCESS" action when the failure is host-access. */
  onHostAccess?: () => void;
}

/**
 * One user-facing response per failed action: logs the original technical
 * error for developers, then shows a single classified toast. Callers must
 * not also render the raw message anywhere else (no duplicate surfaces).
 */
export function toastError(error: unknown, options: ToastErrorOptions = {}): void {
  const classified = classifyError(error);
  const message =
    classified.kind === "unknown" && options.fallback ? options.fallback : classified.message;
  logActionError(error, options.context);
  let action: { label: string; onClick: () => void } | undefined;
  if (classified.kind === "temporary" && options.retry) {
    action = { label: "TRY AGAIN", onClick: options.retry };
  } else if (classified.kind === "host-access" && options.onHostAccess) {
    action = { label: "REQUEST ACCESS", onClick: options.onHostAccess };
  }
  toast.error(message, action ? { action } : undefined);
}

/**
 * Client-side pre-check variant: a known UX gate (e.g. `!canHost`) denied the
 * action before any server call. Authorization itself stays server-side — this
 * only presents the same friendly host-access copy. `requestHostAccess`
 * becomes a "REQUEST ACCESS" toast action when provided.
 */
export function toastHostAccessError(
  options: { context?: string; requestHostAccess?: () => void } = {},
): void {
  logActionError(new Error("Host access not available (client pre-check)"), options.context);
  toast.error(
    MESSAGES["host-access"],
    options.requestHostAccess
      ? { action: { label: "REQUEST ACCESS", onClick: options.requestHostAccess } }
      : undefined,
  );
}
