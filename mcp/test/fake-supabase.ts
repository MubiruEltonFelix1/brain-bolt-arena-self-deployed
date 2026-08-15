// In-memory fake of the Supabase client surface used by mcp/src (save_quiz +
// lifecycle + idempotency). Lets the Phase 8B tests exercise real logic —
// principal resolution, can() capability checks, ownership, archive state,
// question positions, idempotent replay — without a network or credentials.
//
// Mirrors the semantics the production code relies on:
//   - PK unique-violation errors carry code "23505" (idempotency claim)
//   - insert auto-assigns id + created_at (gen_random_uuid()/now() defaults)
//   - can(principal, action, resource) implements the app's resolver rules
//     (host/admin roles, principal-aware ownership with legacy fallback)
//   - or() filters parse the PostgREST-style filter strings we emit

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

export type FakeDb = {
  quizzes: Row[];
  questions: Row[];
  principals: Row[];
  userRoles: Array<{ user_id: string; role: "admin" | "host" }>;
  mcp_idempotency_keys: Row[];
};

export function createFakeDb(): FakeDb {
  return {
    quizzes: [],
    questions: [],
    principals: [],
    userRoles: [],
    mcp_idempotency_keys: [],
  };
}

/** A user with a principal and (optionally) host/admin roles — the Phase 7 model. */
export function seedUser(
  db: FakeDb,
  userId: string,
  roles: Array<"admin" | "host"> = [],
): void {
  db.principals.push({ id: userId, type: "user", user_id: userId });
  for (const role of roles) {
    db.userRoles.push({ user_id: userId, role });
  }
}

const PK_COLUMNS: Record<string, string> = {
  quizzes: "id",
  questions: "id",
  principals: "id",
  mcp_idempotency_keys: "key",
};

type Filter =
  | { kind: "eq"; col: string; value: unknown }
  | { kind: "is"; col: string; value: unknown }
  | { kind: "not_is"; col: string }
  | { kind: "ilike"; col: string; value: string }
  | { kind: "in"; col: string; values: unknown[] }
  | { kind: "or"; predicate: (row: Row) => boolean };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function likeToRegex(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      re += escapeRegExp(pattern[i + 1]!);
      i++;
    } else if (ch === "%") {
      re += ".*";
    } else if (ch === "_") {
      re += ".";
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp(`${re}$`, "i");
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function matchesClause(clause: string, row: Row): boolean {
  if (clause.startsWith("and(") && clause.endsWith(")")) {
    return splitTopLevel(clause.slice(4, -1)).every((c) => matchesClause(c, row));
  }
  if (clause.startsWith("or(") && clause.endsWith(")")) {
    return splitTopLevel(clause.slice(3, -1)).some((c) => matchesClause(c, row));
  }
  const parts = clause.split(".");
  const col = parts[0]!;
  const op = parts[1]!;
  const raw = parts.slice(2).join(".");
  const value: unknown = raw === "null" ? null : raw;
  switch (op) {
    case "eq":
      return row[col] === value;
    case "neq":
      return row[col] !== value;
    case "is":
      return value === null ? row[col] == null : row[col] === value;
    default:
      throw new Error(`fake-supabase: unsupported or() operator "${op}" in "${clause}"`);
  }
}

function parseOrFilter(filter: string): (row: Row) => boolean {
  return (row) => splitTopLevel(filter).some((c) => matchesClause(c, row));
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    switch (f.kind) {
      case "eq":
        if (row[f.col] !== f.value) return false;
        break;
      case "is":
        if (f.value === null ? row[f.col] != null : row[f.col] !== f.value) return false;
        break;
      case "not_is":
        if (row[f.col] == null) return false;
        break;
      case "ilike":
        if (typeof row[f.col] !== "string" || !likeToRegex(f.value).test(row[f.col] as string)) {
          return false;
        }
        break;
      case "in":
        if (!f.values.includes(row[f.col])) return false;
        break;
      case "or":
        if (!f.predicate(row)) return false;
        break;
    }
  }
  return true;
}

function project(row: Row, cols: string): Row {
  if (cols === "*") return { ...row };
  const out: Row = {};
  for (const col of cols.split(",").map((c) => c.trim()).filter(Boolean)) {
    out[col] = row[col];
  }
  return out;
}

export type FakeError = { code?: string; message: string };

export type FakeResult<T> = { data: T | null; error: FakeError | null };

function resolve(value: FakeResult<unknown>): Promise<FakeResult<unknown>> {
  return Promise.resolve(value);
}

class FakeBuilder {
  private mode: "select" | "insert" | "update" | "delete";
  private selectCols = "*";
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private ascending = true;
  private limitN: number | null = null;
  private terminal: "none" | "maybeSingle" | "single" = "none";
  private payload: unknown;

  constructor(
    private db: FakeDb,
    private table: string,
    mode: "select" | "insert" | "update" | "delete",
    payload?: unknown,
  ) {
    this.mode = mode;
    this.payload = payload;
  }

  select(cols: string): this {
    this.selectCols = cols;
    return this;
  }

  insert(payload: unknown): this {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.mode = "update";
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.mode = "delete";
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ kind: "eq", col, value });
    return this;
  }

  is(col: string, value: unknown): this {
    this.filters.push({ kind: "is", col, value });
    return this;
  }

  not(col: string, op: string, value: unknown): this {
    if (op !== "is") {
      throw new Error(`fake-supabase: only .not(col, "is", value) is supported`);
    }
    if (value !== null) {
      throw new Error(`fake-supabase: only .not(col, "is", null) is supported`);
    }
    this.filters.push({ kind: "not_is", col });
    return this;
  }

  ilike(col: string, value: string): this {
    this.filters.push({ kind: "ilike", col, value });
    return this;
  }

  in(col: string, values: unknown[]): this {
    this.filters.push({ kind: "in", col, values });
    return this;
  }

  or(filter: string): this {
    this.filters.push({ kind: "or", predicate: parseOrFilter(filter) });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.ascending = opts?.ascending !== false;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  maybeSingle(): this {
    this.terminal = "maybeSingle";
    return this;
  }

  single(): this {
    this.terminal = "single";
    return this;
  }

  then<TResult1 = FakeResult<unknown>, TResult2 = never>(
    onFulfilled?: ((value: FakeResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return resolve(this.execute()).then(onFulfilled, onRejected);
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<FakeResult<unknown> | TResult> {
    return this.then(undefined, onRejected);
  }

  private execute(): FakeResult<unknown> {
    const table = this.db[this.table as keyof FakeDb] as Row[] | undefined;
    if (!table) {
      return { data: null, error: { message: `fake-supabase: unknown table "${this.table}"` } };
    }

    if (this.mode === "insert") {
      return this.executeInsert(table);
    }
    if (this.mode === "update") {
      for (const row of table) {
        if (matches(row, this.filters)) Object.assign(row, this.payload as Record<string, unknown>);
      }
      return { data: null, error: null };
    }
    if (this.mode === "delete") {
      for (let i = table.length - 1; i >= 0; i--) {
        if (matches(table[i]!, this.filters)) table.splice(i, 1);
      }
      return { data: null, error: null };
    }

    let rows = table.filter((row) => matches(row, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return this.ascending ? -1 : 1;
        if (bv == null) return this.ascending ? 1 : -1;
        if (typeof av === "string" && typeof bv === "string") {
          return this.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        }
        return this.ascending
          ? (av as number) - (bv as number)
          : (bv as number) - (av as number);
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);

    const projected = rows.map((row) => project(row, this.selectCols));
    if (this.terminal === "maybeSingle") {
      if (projected.length === 0) return { data: null, error: null };
      if (projected.length > 1) {
        return {
          data: null,
          error: { message: `fake-supabase: maybeSingle() matched ${projected.length} rows` },
        };
      }
      return { data: projected[0]!, error: null };
    }
    if (this.terminal === "single") {
      if (projected.length === 0) {
        return { data: null, error: { message: "fake-supabase: single() matched 0 rows" } };
      }
      if (projected.length > 1) {
        return {
          data: null,
          error: { message: `fake-supabase: single() matched ${projected.length} rows` },
        };
      }
      return { data: projected[0]!, error: null };
    }
    return { data: projected, error: null };
  }

  private executeInsert(table: Row[]): FakeResult<unknown> {
    const pk = PK_COLUMNS[this.table];
    const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
    const inserted: Row[] = [];

    for (const raw of incoming) {
      if (pk) {
        const keyValue = raw[pk];
        if (keyValue != null && table.some((row) => row[pk] === keyValue)) {
          return {
            data: null,
            error: {
              code: "23505",
              message: `duplicate key value violates unique constraint "${this.table}_pkey"`,
            },
          };
        }
      }
      const row: Row = { ...raw };
      if (row.id == null) row.id = randomUUID();
      if (row.created_at == null) row.created_at = new Date().toISOString();

      // Post-7L (M1) mirror: owner_principal_id is authoritative; the legacy
      // owner_id mirror is derived for user principals (bidirectional trigger,
      // principal direction). After 7L-2/7L-3 there is no trigger and no
      // column; the mirror keeps the fake truthful across the transition.
      if (this.table === "quizzes" && row.owner_principal_id != null && row.owner_id == null) {
        const principal = this.db.principals.find((p) => p.id === row.owner_principal_id);
        if (!principal) {
          return {
            data: null,
            error: {
              message: `No principal exists for owner_principal_id ${String(row.owner_principal_id)}`,
            },
          };
        }
        row.owner_id = principal.user_id ?? null;
      }

      // Column defaults the real table applies (archived_at NULL, is_arena
      // false, play_count 0) — production rows always carry these keys.
      if (this.table === "quizzes") {
        if (row.archived_at == null) row.archived_at = null;
        if (row.is_arena == null) row.is_arena = false;
        if (row.play_count == null) row.play_count = 0;
        if (row.featured_rank == null) row.featured_rank = null;
        if (row.estimated_duration_minutes == null) row.estimated_duration_minutes = null;
        if (row.difficulty == null) row.difficulty = null;
        if (row.time_per_question == null) row.time_per_question = 20;
      }

      table.push(row);
      inserted.push(row);
    }

    if (this.selectCols && this.selectCols !== "*") {
      const projected = inserted.map((row) => project(row, this.selectCols));
      if (this.terminal === "single") {
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    }
    return { data: null, error: null };
  }
}

export class FakeSupabase {
  constructor(public db: FakeDb) {}

  from(table: string): FakeBuilder {
    return new FakeBuilder(this.db, table, "select");
  }

  rpc(name: string, args: Record<string, unknown>): Promise<FakeResult<boolean>> {
    if (name !== "can") {
      return Promise.resolve({
        data: null,
        error: { message: `fake-supabase: unknown rpc "${name}"` },
      });
    }
    return Promise.resolve({ data: this.can(args), error: null });
  }

  /** Mirrors public.can(principal, action, resource) — the app's resolver. */
  private can(args: Record<string, unknown>): boolean {
    const principal = args.p_principal as string | null;
    const action = args.p_action as string;
    const resource = args.p_resource as string | null;
    if (!principal) return false;

    const principalRow = this.db.principals.find(
      (p) => p.type === "user" && (p.id === principal || p.user_id === principal),
    );
    const user = principalRow ? (principalRow.user_id as string) : principal;

    const hasRole = (role: string) =>
      this.db.userRoles.some((r) => r.user_id === user && r.role === role);
    const admin = hasRole("admin");
    if (action.startsWith("admin.")) return admin;

    const host = admin || hasRole("host");
    if (["quiz.create", "competition.create", "league.create", "branding.create", "session.host"].includes(action)) {
      return host;
    }
    if (!resource) return false;

    const ownerPrincipal = this.db.principals.find(
      (p) => p.type === "user" && p.user_id === user,
    )?.id as string | undefined;

    if (action === "quiz.edit" || action === "quiz.delete") {
      const owned = this.db.quizzes.some(
        (q) => q.id === resource && q.owner_principal_id === ownerPrincipal,
      );
      return owned && host;
    }
    return false;
  }
}

/** Cast helper — production code types the client as SupabaseClient. */
export function asClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}
