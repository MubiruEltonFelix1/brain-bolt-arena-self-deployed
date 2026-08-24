// In-memory fake of the Supabase client surface used by mcp/src (save_quiz +
// lifecycle + idempotency). Lets the Phase 8B tests exercise real logic —
// principal resolution, can() capability checks, ownership, archive state,
// question positions, idempotent replay — without a network or credentials.
//
// Mirrors the semantics the production code relies on:
//   - PK unique-violation errors carry code "23505" (idempotency claim)
//   - insert auto-assigns id + created_at (gen_random_uuid()/now() defaults)
//   - can(principal, action, resource) implements the app's resolver rules
//     (host/admin roles, active host authorizations, principal-aware
//     ownership with legacy fallback)
//   - or() filters parse the PostgREST-style filter strings we emit

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

export type FakeDb = {
  quizzes: Row[];
  questions: Row[];
  principals: Row[];
  userRoles: Array<{ user_id: string; role: "admin" | "host" }>;
  host_authorizations: Array<{
    profile_id: string;
    status: string;
    authorization_type: string;
    starts_at: string | null;
    expires_at: string | null;
    remaining_sessions: number | null;
  }>;
  mcp_idempotency_keys: Row[];
  competitions: Row[];
  leagues: Row[];
  branding_profiles: Row[];
  profiles: Row[];
  competition_results: Row[];
};

export function createFakeDb(): FakeDb {
  return {
    quizzes: [],
    questions: [],
    principals: [],
    userRoles: [],
    host_authorizations: [],
    mcp_idempotency_keys: [],
    competitions: [],
    leagues: [],
    branding_profiles: [],
    profiles: [],
    competition_results: [],
  };
}

/** A user with a principal and (optionally) host/admin roles — the Phase 7 model. */
export function seedUser(db: FakeDb, userId: string, roles: Array<"admin" | "host"> = []): void {
  db.principals.push({ id: userId, type: "user", user_id: userId });
  for (const role of roles) {
    db.userRoles.push({ user_id: userId, role });
  }
}

/** A player profile row (profiles.id is the auth-user id — id-identical). */
export function seedProfile(
  db: FakeDb,
  id: string,
  displayName: string,
  avatarId: string | null = null,
): void {
  db.profiles.push({ id, display_name: displayName, avatar_id: avatarId });
}

/**
 * An active time-based host authorization for a user (the real resolver's
 * third host source — `has_active_host_authorization`). Mirrors the minimal
 * active state: status 'active', no start gate, never expires.
 */
export function seedHostAuthorization(db: FakeDb, userId: string): void {
  db.host_authorizations.push({
    profile_id: userId,
    status: "active",
    authorization_type: "time",
    starts_at: null,
    expires_at: null,
    remaining_sessions: null,
  });
}

const PK_COLUMNS: Record<string, string> = {
  quizzes: "id",
  questions: "id",
  principals: "id",
  mcp_idempotency_keys: "key",
  competitions: "id",
  leagues: "id",
  branding_profiles: "id",
  profiles: "id",
  competition_results: "id",
};

type Filter =
  | { kind: "eq"; col: string; value: unknown }
  | { kind: "is"; col: string; value: unknown }
  | { kind: "not_is"; col: string }
  | { kind: "ilike"; col: string; value: string }
  | { kind: "in"; col: string; values: unknown[] }
  | { kind: "gte"; col: string; value: unknown }
  | { kind: "lte"; col: string; value: unknown }
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
      case "gte":
      case "lte": {
        // ISO-8601 timestamps compare numerically when both sides parse;
        // numbers compare natively; anything non-comparable excludes the row
        // (never silently passes it).
        const a = row[f.col];
        const b = f.value;
        if (a == null || b == null) return false;
        if (typeof a === "string" && typeof b === "string") {
          const ta = Date.parse(a);
          const tb = Date.parse(b);
          if (!Number.isNaN(ta) && !Number.isNaN(tb)) {
            if (f.kind === "gte" ? ta - tb < 0 : ta - tb > 0) return false;
            break;
          }
        }
        if (typeof a === "number" && typeof b === "number") {
          if (f.kind === "gte" ? a - b < 0 : a - b > 0) return false;
          break;
        }
        return false; // mixed or non-comparable — exclude rather than pass
      }
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
  for (const col of cols
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)) {
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

  gte(col: string, value: unknown): this {
    this.filters.push({ kind: "gte", col, value });
    return this;
  }

  lte(col: string, value: unknown): this {
    this.filters.push({ kind: "lte", col, value });
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
        if (matches(row, this.filters)) {
          Object.assign(row, this.payload as Record<string, unknown>);
          // Mirror the set_updated_at() / tg_touch_updated_at() triggers on
          // competitions, leagues and branding_profiles.
          if (
            this.table === "competitions" ||
            this.table === "leagues" ||
            this.table === "branding_profiles"
          ) {
            row.updated_at = new Date().toISOString();
          }
        }
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
        return this.ascending ? (av as number) - (bv as number) : (bv as number) - (av as number);
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

      // Competitions column defaults (20260724054750 CREATE TABLE).
      if (this.table === "competitions") {
        if (row.status == null) row.status = "draft";
        if (row.mode == null) row.mode = "scheduled";
        if (row.visibility == null) row.visibility = "private";
        if (row.lobby_duration_seconds == null) row.lobby_duration_seconds = 300;
        if (row.autonomous == null) row.autonomous = true;
        if (row.metadata == null) row.metadata = {};
        if (row.session_id == null) row.session_id = null;
        if (row.started_at == null) row.started_at = null;
        if (row.completed_at == null) row.completed_at = null;
        if (row.cancelled_at == null) row.cancelled_at = null;
        if (row.updated_at == null) row.updated_at = new Date().toISOString();
      }
      // Questions column defaults (20260821090000: is_playable NOT NULL DEFAULT true).
      if (this.table === "questions") {
        if (row.is_playable == null) row.is_playable = true;
      }

      // Leagues / branding_profiles minimal defaults. Leagues mirror the
      // scoring-config and archive defaults from 20260806054006.
      if (this.table === "leagues") {
        if (row.status == null) row.status = "draft";
        if (row.visibility == null) row.visibility = "private";
        if (row.points_first == null) row.points_first = 10;
        if (row.points_second == null) row.points_second = 7;
        if (row.points_third == null) row.points_third = 5;
        if (row.points_participation == null) row.points_participation = 1;
        if (row.archived_at == null) row.archived_at = null;
        if (row.description == null) row.description = null;
        if (row.season == null) row.season = "Season 1";
        if (row.updated_at == null) row.updated_at = new Date().toISOString();
      }
      if (this.table === "branding_profiles" && row.updated_at == null) {
        row.updated_at = new Date().toISOString();
      }
      // competition_results minimal defaults (20260722065824).
      if (this.table === "competition_results") {
        if (row.final_score == null) row.final_score = 0;
        if (row.accuracy_percentage == null) row.accuracy_percentage = 0;
        if (row.total_participants == null) row.total_participants = 0;
        if (row.completed_at == null) row.completed_at = new Date().toISOString();
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

  rpc(name: string, args: Record<string, unknown>): Promise<FakeResult<unknown>> {
    try {
      switch (name) {
        case "can":
          return Promise.resolve({ data: this.can(args), error: null });
        case "mcp_league_standings":
          return Promise.resolve({
            data: this.leagueStandings(args.p_principal as string, args.p_league_id as string),
            error: null,
          });
        case "mcp_league_overview":
          return Promise.resolve({
            data: this.leagueOverview(args.p_principal as string, args.p_league_id as string),
            error: null,
          });
        default:
          return Promise.resolve({
            data: null,
            error: { message: `fake-supabase: unknown rpc "${name}"` },
          });
      }
    } catch (err) {
      // The production wrappers raise 'Not authorized' — PostgREST surfaces
      // that as an error, so the fake must too (message match drives the
      // unauthorized mapping in league.ts).
      const message = err instanceof Error ? err.message : "unknown";
      return Promise.resolve({ data: null, error: { message } });
    }
  }

  /** Mirrors the Phase 8D wrapper gate: can(league.manage) OR public. */
  private leagueVisible(principal: string, leagueId: string): boolean {
    const league = this.db.leagues.find((l) => l.id === leagueId);
    if (league && league.visibility === "public") return true;
    return this.can({
      p_principal: principal,
      p_action: "league.manage",
      p_resource: leagueId,
    });
  }

  /** Faithful port of public.get_league_standings (20260806054006:21-74):
   * completed league competitions' permanent results aggregated with the
   * league's scoring config and the app's exact tie-break order. */
  private leagueStandings(principal: string, leagueId: string): Row[] {
    const league = this.db.leagues.find((l) => l.id === leagueId);
    if (!league || !this.leagueVisible(principal, leagueId)) {
      throw new Error("Not authorized");
    }
    const p1 = Number(league.points_first ?? 10);
    const p2 = Number(league.points_second ?? 7);
    const p3 = Number(league.points_third ?? 5);
    const pp = Number(league.points_participation ?? 1);

    const competitions = this.db.competitions as Row[];
    const byPid = new Map<
      string,
      {
        pts: number;
        played: number;
        wins: number;
        podiums: number;
        totalScore: number;
        accs: number[];
      }
    >();
    for (const cr of this.db.competition_results as Row[]) {
      const sessionId = cr.session_id as string | null;
      if (sessionId == null) continue;
      const comp = competitions.find((c) => c.session_id === sessionId);
      if (!comp || comp.league_id !== leagueId || comp.status !== "completed") continue;
      const rnk = Number(cr.final_rank);
      const acc = cr.accuracy_percentage == null ? null : Number(cr.accuracy_percentage);
      let agg = byPid.get(cr.profile_id as string);
      if (!agg) {
        agg = { pts: 0, played: 0, wins: 0, podiums: 0, totalScore: 0, accs: [] };
        byPid.set(cr.profile_id as string, agg);
      }
      agg.pts += rnk === 1 ? p1 : rnk === 2 ? p2 : rnk === 3 ? p3 : pp;
      agg.played += 1;
      if (rnk === 1) agg.wins += 1;
      if (rnk <= 3) agg.podiums += 1;
      agg.totalScore += Number(cr.final_score ?? 0);
      if (acc !== null) agg.accs.push(acc);
    }

    const rows = [...byPid.entries()].map(([pid, agg]) => {
      const profile = this.db.profiles.find((p) => p.id === pid);
      const avgAcc =
        agg.accs.length > 0
          ? Math.round((agg.accs.reduce((a, b) => a + b, 0) / agg.accs.length) * 10) / 10
          : null;
      return {
        pid,
        display_name: (profile?.display_name as string | undefined) ?? "Player",
        avatar_id: profile?.avatar_id ?? null,
        pts: agg.pts,
        played: agg.played,
        wins: agg.wins,
        podiums: agg.podiums,
        total_score: agg.totalScore,
        avg_acc: avgAcc,
      };
    });

    // ORDER BY pts DESC, wins DESC, podiums DESC, total_score DESC,
    //          avg_acc DESC NULLS LAST, COALESCE(display_name,'') ASC
    rows.sort((a, b) => {
      if (a.pts !== b.pts) return b.pts - a.pts;
      if (a.wins !== b.wins) return b.wins - a.wins;
      if (a.podiums !== b.podiums) return b.podiums - a.podiums;
      if (a.total_score !== b.total_score) return b.total_score - a.total_score;
      if (a.avg_acc !== b.avg_acc) {
        if (a.avg_acc === null) return 1;
        if (b.avg_acc === null) return -1;
        return b.avg_acc - a.avg_acc;
      }
      return a.display_name.localeCompare(b.display_name);
    });

    return rows.map((r, i) => ({
      standing_position: i + 1,
      profile_id: r.pid,
      display_name: r.display_name,
      avatar_id: r.avatar_id,
      league_points: r.pts,
      competitions_played: r.played,
      wins: r.wins,
      podiums: r.podiums,
      total_score: r.total_score,
      avg_accuracy: r.avg_acc,
    }));
  }

  /** Faithful port of public.get_league_overview (20260806054006:76-99). */
  private leagueOverview(principal: string, leagueId: string): Row[] {
    const league = this.db.leagues.find((l) => l.id === leagueId);
    if (!league || !this.leagueVisible(principal, leagueId)) {
      throw new Error("Not authorized");
    }
    const competitions = this.db.competitions as Row[];
    const results = this.db.competition_results as Row[];
    const participantCount = new Set(
      results
        .filter((cr) => {
          const sessionId = cr.session_id as string | null;
          if (sessionId == null) return false;
          const comp = competitions.find((c) => c.session_id === sessionId);
          return comp !== undefined && comp.league_id === leagueId && comp.status === "completed";
        })
        .map((cr) => cr.profile_id),
    ).size;
    const total = competitions.filter(
      (c) => c.league_id === leagueId && c.status !== "cancelled",
    ).length;
    const completed = competitions.filter(
      (c) => c.league_id === leagueId && c.status === "completed",
    ).length;
    const upcoming = competitions.filter(
      (c) =>
        c.league_id === leagueId &&
        ["draft", "scheduled", "lobby_open", "running"].includes(c.status as string),
    ).length;
    return [
      {
        participant_count: participantCount,
        competitions_total: total,
        competitions_completed: completed,
        competitions_upcoming: upcoming,
      },
    ];
  }

  /** Mirrors public.has_active_host_authorization() — the third host source. */
  private hasActiveHostAuthorization(user: string): boolean {
    const now = Date.now();
    return this.db.host_authorizations.some(
      (h) =>
        h.profile_id === user &&
        h.status === "active" &&
        (h.starts_at == null || Date.parse(h.starts_at) <= now) &&
        ((h.authorization_type === "time" &&
          (h.expires_at == null || Date.parse(h.expires_at) > now)) ||
          ((h.authorization_type === "single" || h.authorization_type === "bundle") &&
            (h.remaining_sessions ?? 0) > 0)),
    );
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

    const host = admin || hasRole("host") || this.hasActiveHostAuthorization(user);
    if (
      [
        "quiz.create",
        "competition.create",
        "league.create",
        "branding.create",
        "session.host",
      ].includes(action)
    ) {
      return host;
    }
    if (!resource) return false;

    const ownerPrincipal = this.db.principals.find((p) => p.type === "user" && p.user_id === user)
      ?.id as string | undefined;

    if (action === "quiz.edit" || action === "quiz.delete") {
      const owned = this.db.quizzes.some(
        (q) => q.id === resource && q.owner_principal_id === ownerPrincipal,
      );
      return owned && host;
    }
    if (action === "competition.manage") {
      const owned = this.db.competitions.some(
        (c) => c.id === resource && c.owner_principal_id === ownerPrincipal,
      );
      return owned && host;
    }
    if (action === "league.manage") {
      const owned = this.db.leagues.some(
        (l) => l.id === resource && l.owner_principal_id === ownerPrincipal,
      );
      return owned && host;
    }
    if (action === "branding.manage") {
      const owned = this.db.branding_profiles.some(
        (b) => b.id === resource && b.owner_principal_id === ownerPrincipal,
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
