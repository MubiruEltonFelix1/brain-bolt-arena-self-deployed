// Idempotency for MCP write operations (Phase 8B).
//
// Mechanism: a unique claim row in `mcp_idempotency_keys` (see
// supabase/migrations/20260817060000_...sql). A repeated request with the
// same key + request_hash replays the stored response instead of duplicating
// the write. The claim lives in Postgres, so it survives MCP server restarts
// — the exact timeout/retry scenario this protects against. Failed runs free
// the key so a retry can succeed. Keys older than 24h are treated as stale
// and overwritten.
//
// No distributed transaction machinery: one unique INSERT, one UPDATE on
// success, one DELETE on failure.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export type IdempotencyHandle = {
  key: string;
  operation: string;
  requestHash: string;
};

export type WithIdempotencyResult<T> = {
  /** true when the request was replayed from a previous run of the same key. */
  replay: boolean;
  result: T;
};

/** Deterministic JSON serialization (object keys sorted recursively) so two
 * logically identical requests hash identically regardless of key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function requestHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

const UNIQUE_VIOLATION = "23505";
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLAIM_ATTEMPTS = 3;

type IdempotencyRow = {
  key: string;
  operation: string;
  request_hash: string;
  status: "pending" | "completed";
  response: unknown;
  created_at: string;
};

function isStale(row: IdempotencyRow): boolean {
  const created = Date.parse(row.created_at);
  if (Number.isNaN(created)) return false;
  return Date.now() - created > KEY_TTL_MS;
}

function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === UNIQUE_VIOLATION;
}

/** Best-effort cleanup that never throws (supabase builders lack typed .catch). */
async function ignoreError(promise: PromiseLike<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // cleanup is best-effort
  }
}

/**
 * Runs `run()` exactly once per logical request. When the same idempotency
 * key is presented again (with the same request hash) the stored response is
 * returned without re-running. Throws a precise error when the key is reused
 * with a different request, or when another request is still in flight.
 */
export async function withIdempotency<T>(
  client: SupabaseClient,
  handle: IdempotencyHandle,
  run: () => Promise<T>,
): Promise<WithIdempotencyResult<T>> {
  const { key, operation, requestHash: hash } = handle;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const { error: claimError } = await client
      .from("mcp_idempotency_keys")
      .insert({ key, operation, request_hash: hash, status: "pending" });

    if (!claimError) {
      // We own the claim — run the operation, then persist the response.
      try {
        const result = await run();
        const { error: completeError } = await client
          .from("mcp_idempotency_keys")
          .update({
            status: "completed",
            response: result,
            completed_at: new Date().toISOString(),
          })
          .eq("key", key);
        if (completeError) {
          // Response not persisted — the write DID happen. Do not free the
          // key: a retry would duplicate it. Surface the persistence failure.
          throw new Error(
            `operation "${operation}" succeeded but its idempotency record could not be stored ` +
              `(${completeError.message}). The idempotency key "${key}" is NOT safe to reuse.`,
          );
        }
        return { replay: false, result };
      } catch (err) {
        // Free the claim so a retry with the same key can succeed.
        await ignoreError(client.from("mcp_idempotency_keys").delete().eq("key", key));
        throw err;
      }
    }

    if (!isUniqueViolation(claimError)) {
      throw new Error(`Could not claim idempotency key "${key}": ${claimError.message}`);
    }

    // Conflict — a previous (or concurrent) request owns the key.
    const { data: row, error: readError } = await client
      .from("mcp_idempotency_keys")
      .select("*")
      .eq("key", key)
      .maybeSingle();

    if (readError) {
      throw new Error(`Could not read idempotency key "${key}": ${readError.message}`);
    }
    if (!row) {
      continue; // deleted by a concurrent stale-cleanup; retry the claim
    }

    // Stale wins over everything: after the 24h TTL a key may be re-claimed
    // even if it is still pending (a server that died between the claim and
    // the completion update — the exact timeout/retry scenario this protects
    // against — would otherwise wedge the key forever).
    if (isStale(row)) {
      await ignoreError(client.from("mcp_idempotency_keys").delete().eq("key", key));
      continue;
    }

    if (row.request_hash !== hash) {
      throw new Error(
        `idempotency key "${key}" was already used for a different request ` +
          `(operation "${row.operation}") — reuse of a key must repeat the exact same request. ` +
          "Use a fresh idempotency key for a new request.",
      );
    }

    if (row.status === "pending") {
      throw new Error(
        `idempotency key "${key}" is already being processed (operation "${row.operation}") — ` +
          "retry the request shortly.",
      );
    }

    if (row.response == null) {
      throw new Error(
        `idempotency key "${key}" is marked completed but has no stored response — ` +
          "the record is inconsistent; use a fresh key.",
      );
    }

    return { replay: true, result: row.response as T };
  }

  throw new Error(
    `Could not claim idempotency key "${key}" after ${MAX_CLAIM_ATTEMPTS} attempts — ` +
      "concurrent requests with the same key are in flight.",
  );
}
