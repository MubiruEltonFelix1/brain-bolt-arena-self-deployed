// League, results and standings operations for the MCP server (Phase 8D).
//
// Every operation resolves the acting Principal (an auth user id — user
// principals are id-identical) and enforces capability through the app's
// existing `public.can(principal, action, resource)` resolver (service-role
// RPC), NOT a parallel MCP permission system. Ownership is principal-only
// (Phase 7L): owner_principal_id is authoritative and may be NULL only on
// legacy rows, which are treated as not-owned by anyone.
//
// League-read authorization mirrors the app's can_view_league rule:
//   can(principal, 'league.manage', league)  OR  league.visibility = 'public'
// The app's is_admin() view-all branch is deliberately NOT included — the MCP
// agent must never see more than the corresponding Brain Bolt principal's
// app-visible data, and an admin who owns nothing cannot read a private league
// through the app's manage surface.
//
// Standings/overview are computed ONLY by the existing database functions
// (get_league_standings / get_league_overview) through the service-role
// wrappers mcp_league_standings / mcp_league_overview (Phase 8D migration) —
// no points logic is recreated in TypeScript. The wrappers impersonate the
// acting principal transaction-scoped so the originals' JWT-based gate passes
// for private leagues the principal owns.
//
// The Session boundary is absolute: this module reads the session_id column
// on competitions/competition_results as a VALUE only (the competitions module
// already exposes it) and never queries the sessions table.
//
// Errors are typed (CompetitionError, same vocabulary) and NEVER interpolate
// raw PostgREST/SQL messages. Idempotency-key conflict errors raised by the
// Phase 8B machinery (plain Error) are mapped to the conflict code here.
//
// Writes accept an optional idempotencyKey (same mechanism as Phase 8B/8C).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertAccessibleLeague,
  assertCompetitionCan,
  COMPETITION_STATUSES,
  CompetitionError,
  type CompetitionStatus,
} from "./competition";
import {
  isValidUuid,
  resolveActor,
  wrapIdempotent,
  type Actor,
} from "./lifecycle";

/* ------------------------------------------------------------------ */
/* Shared shapes                                                        */
/* ------------------------------------------------------------------ */

export type LeagueFailureEnvelope = {
  ok: false;
  action: string;
  error: { code: CompetitionError["code"]; message: string };
};

/** Maps any thrown value to the structured failure envelope (§13). */
export function toLeagueEnvelope(
  action: string,
  err: unknown,
): LeagueFailureEnvelope {
  if (err instanceof CompetitionError) {
    return { ok: false, action, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : "";
  if (
    message.includes("reuse of a key must repeat the exact same request") ||
    message.includes("already being processed")
  ) {
    return {
      ok: false,
      action,
      error: { code: "conflict", message },
    };
  }
  return {
    ok: false,
    action,
    error: {
      code: "unknown",
      message: "Something went wrong — the operation was not completed.",
    },
  };
}

export const LEAGUE_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type LeagueVisibility = (typeof LEAGUE_VISIBILITIES)[number];

export const LEAGUE_STATUSES = ["draft", "registration_open", "active", "completed"] as const;
export type LeagueStatus = (typeof LEAGUE_STATUSES)[number];

/** States in which a competition may be attached to / detached from a league.
 * Completed competitions are locked so their results cannot retroactively
 * enter a league's standings. */
const MUTABLE_COMPETITION_STATUSES: readonly CompetitionStatus[] = ["draft", "scheduled"];

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const UPCOMING_LIMIT = 20;

const LEAGUE_COLUMNS =
  "id,name,description,season,status,visibility,start_date,end_date,cover_image_url," +
  "points_first,points_second,points_third,points_participation,archived_at," +
  "owner_principal_id,created_at,updated_at";

type LeagueRow = {
  id: string;
  name: string;
  description: string | null;
  season: string;
  status: LeagueStatus;
  visibility: LeagueVisibility;
  start_date: string | null;
  end_date: string | null;
  cover_image_url: string | null;
  points_first: number;
  points_second: number;
  points_third: number;
  points_participation: number;
  archived_at: string | null;
  owner_principal_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LeagueSummary = {
  id: string;
  name: string;
  description: string | null;
  season: string;
  status: LeagueStatus;
  visibility: LeagueVisibility;
  ownerPrincipalId: string;
  archivedAt: string | null;
  competitionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LeagueDetail = LeagueSummary & {
  startDate: string | null;
  endDate: string | null;
  coverImageUrl: string | null;
  scoring: {
    pointsFirst: number;
    pointsSecond: number;
    pointsThird: number;
    pointsParticipation: number;
  };
  overview: {
    participantCount: number;
    competitionsTotal: number;
    competitionsCompleted: number;
    competitionsUpcoming: number;
  } | null;
  upcomingCompetitions: Array<{
    id: string;
    title: string;
    status: CompetitionStatus;
    scheduledStartAt: string | null;
  }>;
};

export type StandingRow = {
  standingPosition: number;
  profileId: string;
  displayName: string;
  avatarId: string | null;
  leaguePoints: number;
  competitionsPlayed: number;
  wins: number;
  podiums: number;
  totalScore: number;
  avgAccuracy: number | null;
};

export type LeagueCompetitionSummary = {
  id: string;
  title: string;
  status: CompetitionStatus;
  mode: string;
  scheduledStartAt: string | null;
  completedAt: string | null;
  visibility: string;
  hasResults: boolean;
};

export type CompetitionResultRow = {
  profileId: string;
  displayName: string | null;
  avatarId: string | null;
  finalRank: number;
  finalScore: number;
  totalParticipants: number;
  accuracyPercentage: number;
  completedAt: string;
};

export type PlayerLeagueHistoryRow = {
  competitionId: string;
  title: string;
  completedAt: string;
  finalRank: number;
  finalScore: number;
  totalParticipants: number;
  accuracyPercentage: number;
};

/** Envelope for the attach/detach write tools (extends LifecycleEnvelope). */
export type LeagueMutationEnvelope = {
  ok: true;
  action: string;
  id?: string;
  competitionId?: string;
  leagueId?: string | null;
  changed?: Record<string, unknown>;
  warnings: string[];
  errors: never[];
  replayed?: boolean;
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function sanitizeError(err: unknown, fallback: string): CompetitionError {
  if (err instanceof CompetitionError) return err;
  return new CompetitionError("unknown", fallback);
}

/** Resolves the actor, converting shared resolver failures to typed errors. */
async function resolveLeagueActor(
  client: SupabaseClient,
  actorId: string,
  label = "actorId",
): Promise<Actor> {
  try {
    return await resolveActor(client, actorId, label);
  } catch (err) {
    if (err instanceof Error) {
      const message = err.message;
      if (message.includes("No acting principal")) {
        throw new CompetitionError("unauthorized", message);
      }
      if (message.includes("has no user principal")) {
        throw new CompetitionError("unauthorized", message);
      }
      if (message.includes("not a valid uuid")) {
        throw new CompetitionError("validation", message);
      }
    }
    throw sanitizeError(err, "Could not resolve the acting principal.");
  }
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  return !Number.isNaN(Date.parse(value));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

async function fetchLeagueRow(
  client: SupabaseClient,
  leagueId: string,
): Promise<LeagueRow | null> {
  if (!isValidUuid(leagueId)) {
    throw new CompetitionError(
      "validation",
      `leagueId "${leagueId}" is not a valid uuid.`,
    );
  }
  const { data, error } = await client
    .from("leagues")
    .select(LEAGUE_COLUMNS)
    .eq("id", leagueId)
    .maybeSingle();
  if (error) {
    throw sanitizeError(error, `Could not read league "${leagueId}".`);
  }
  return (data as unknown as LeagueRow | null) ?? null;
}

async function canLeagueManage(
  client: SupabaseClient,
  actor: Actor,
  leagueId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("can", {
    p_principal: actor.principalId,
    p_action: "league.manage",
    p_resource: leagueId,
  });
  if (error) {
    throw sanitizeError(error, `Could not verify authorization for league "${leagueId}".`);
  }
  return data === true;
}

/** Maps a wrapper-RPC failure: the wrapper's own gate raising 'Not authorized'
 * is impossible after assertLeagueVisible passes (defense in depth). */
function mapRpcError(err: unknown, leagueId: string): CompetitionError {
  const message = err instanceof Error ? err.message : "";
  if (message.includes("Not authorized")) {
    return new CompetitionError(
      "unauthorized",
      `actor is not authorized to read league "${leagueId}".`,
    );
  }
  return sanitizeError(err, `Could not read league "${leagueId}".`);
}

/**
 * League-read gate mirroring the app's can_view_league: the acting principal
 * may read a league they manage (owner AND host via can()) or a public one.
 * Fetches the league first so the failure mode is "does not exist" rather than
 * a generic denial. The app's is_admin() view-all branch is deliberately
 * excluded (read-safety tightening — MCP never exceeds the principal).
 */
export async function assertLeagueVisible(
  client: SupabaseClient,
  actor: Actor,
  leagueId: string,
  verb: string,
): Promise<LeagueRow> {
  const row = await fetchLeagueRow(client, leagueId);
  if (!row) {
    throw new CompetitionError(
      "not-found",
      `league "${leagueId}" does not exist.`,
    );
  }
  if (row.visibility === "public") return row;
  const allowed = await canLeagueManage(client, actor, leagueId);
  if (!allowed) {
    throw new CompetitionError(
      "unauthorized",
      `actor "${actor.actorId}" is not authorized to ${verb} league "${leagueId}" ` +
        `("${row.name}") — the acting principal must own the league and hold the host capability.`,
    );
  }
  return row;
}

/**
 * Competition gate for league mutations: owner + host (assertCompetitionCan)
 * AND the competition must still be draft/scheduled — attaching or detaching a
 * completed competition would retroactively change a league's standings, and
 * lobby_open/running competitions are the engine's live territory.
 */
async function assertCompetitionMutable(
  client: SupabaseClient,
  actor: Actor,
  competitionId: string,
  verb: string,
) {
  const row = await assertCompetitionCan(client, actor, competitionId, verb);
  if (!MUTABLE_COMPETITION_STATUSES.includes(row.status)) {
    throw new CompetitionError(
      "conflict",
      `competition "${competitionId}" is ${row.status} and cannot be ${verb} — ` +
        "only draft and scheduled competitions accept league attachment changes.",
    );
  }
  return row;
}

function toSummary(row: LeagueRow, competitionCount: number): LeagueSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    season: row.season,
    status: row.status,
    visibility: row.visibility,
    ownerPrincipalId: row.owner_principal_id ?? "",
    archivedAt: row.archived_at,
    competitionCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* list_leagues                                                         */
/* ------------------------------------------------------------------ */

export type ListLeaguesOptions = {
  actorId: string;
  /** Literal substring match on the league name. */
  search?: string;
  /** true = archived only, false = not archived, undefined = both. */
  archived?: boolean;
  visibility?: LeagueVisibility;
  status?: LeagueStatus;
  /** true restricts the result to leagues the acting principal owns. */
  ownerOnly?: boolean;
  limit?: number;
};

export async function listLeagues(
  client: SupabaseClient,
  options: ListLeaguesOptions,
): Promise<{ items: LeagueSummary[]; count: number }> {
  const actor = await resolveLeagueActor(client, options.actorId);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  let query = client.from("leagues").select(LEAGUE_COLUMNS);
  if (options.ownerOnly) {
    query = query.eq("owner_principal_id", actor.principalId);
  } else {
    // Legitimately inspectable: owned OR public (can_view_league rule).
    query = query.or(`owner_principal_id.eq.${actor.principalId},visibility.eq.public`);
  }

  if (options.archived === true) {
    query = query.not("archived_at", "is", null);
  } else if (options.archived === false) {
    query = query.is("archived_at", null);
  }
  if (options.search && options.search.trim()) {
    query = query.ilike("name", `%${escapeLike(options.search.trim())}%`);
  }
  if (options.visibility) {
    query = query.eq("visibility", options.visibility);
  }
  if (options.status) {
    query = query.eq("status", options.status);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) {
    throw sanitizeError(error, "Could not list leagues.");
  }
  const rows = (data as unknown as LeagueRow[] | null) ?? [];
  if (rows.length === 0) {
    return { items: [], count: 0 };
  }

  const { data: compRows, error: compError } = await client
    .from("competitions")
    .select("league_id")
    .in("league_id", rows.map((r) => r.id));
  if (compError) {
    throw sanitizeError(compError, "Could not count league competitions.");
  }
  const counts = new Map<string, number>();
  for (const c of (compRows ?? []) as unknown as Array<{ league_id: string | null }>) {
    if (c.league_id) counts.set(c.league_id, (counts.get(c.league_id) ?? 0) + 1);
  }

  const items = rows.map((r) => toSummary(r, counts.get(r.id) ?? 0));
  return { items, count: items.length };
}

/* ------------------------------------------------------------------ */
/* get_league                                                           */
/* ------------------------------------------------------------------ */

export type GetLeagueOptions = {
  actorId: string;
  leagueId: string;
};

type LeagueOverviewRow = {
  participant_count: number;
  competitions_total: number;
  competitions_completed: number;
  competitions_upcoming: number;
};

export async function getLeague(
  client: SupabaseClient,
  options: GetLeagueOptions,
): Promise<{ league: LeagueDetail }> {
  const actor = await resolveLeagueActor(client, options.actorId);
  const row = await assertLeagueVisible(client, actor, options.leagueId, "read");

  const { data: overview, error: overviewError } = await client.rpc(
    "mcp_league_overview",
    { p_principal: actor.principalId, p_league_id: row.id },
  );
  if (overviewError) {
    throw mapRpcError(overviewError, row.id);
  }
  // RETURNS TABLE functions come back as an array of rows from PostgREST.
  const ov = ((overview as unknown as LeagueOverviewRow[] | null) ?? [])[0] ?? null;

  const { data: upcoming, error: upError } = await client
    .from("competitions")
    .select("id,title,status,scheduled_start_at")
    .eq("league_id", row.id)
    .in("status", ["draft", "scheduled", "lobby_open", "running"])
    .order("scheduled_start_at", { ascending: true, nullsFirst: false })
    .limit(UPCOMING_LIMIT);
  if (upError) {
    throw sanitizeError(upError, `Could not read competitions of league "${row.id}".`);
  }

  const league: LeagueDetail = {
    ...toSummary(row, ov?.competitions_total ?? 0),
    startDate: row.start_date,
    endDate: row.end_date,
    coverImageUrl: row.cover_image_url,
    scoring: {
      pointsFirst: row.points_first,
      pointsSecond: row.points_second,
      pointsThird: row.points_third,
      pointsParticipation: row.points_participation,
    },
    overview: ov
      ? {
          participantCount: ov.participant_count,
          competitionsTotal: ov.competitions_total,
          competitionsCompleted: ov.competitions_completed,
          competitionsUpcoming: ov.competitions_upcoming,
        }
      : null,
    upcomingCompetitions: ((upcoming ?? []) as unknown as Array<{
      id: string;
      title: string;
      status: CompetitionStatus;
      scheduled_start_at: string | null;
    }>).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      scheduledStartAt: c.scheduled_start_at,
    })),
  };

  return { league };
}

/* ------------------------------------------------------------------ */
/* get_league_standings                                                 */
/* ------------------------------------------------------------------ */

export type GetLeagueStandingsOptions = {
  actorId: string;
  leagueId: string;
};

type RawStandingRow = {
  standing_position: number;
  profile_id: string;
  display_name: string;
  avatar_id: string | null;
  league_points: number;
  competitions_played: number;
  wins: number;
  podiums: number;
  total_score: number;
  avg_accuracy: number | null;
};

function toStandingRow(r: RawStandingRow): StandingRow {
  return {
    standingPosition: r.standing_position,
    profileId: r.profile_id,
    displayName: r.display_name,
    avatarId: r.avatar_id,
    leaguePoints: r.league_points,
    competitionsPlayed: r.competitions_played,
    wins: r.wins,
    podiums: r.podiums,
    totalScore: r.total_score,
    avgAccuracy: r.avg_accuracy,
  };
}

export async function getLeagueStandings(
  client: SupabaseClient,
  options: GetLeagueStandingsOptions,
): Promise<{ standings: StandingRow[]; count: number }> {
  const actor = await resolveLeagueActor(client, options.actorId);
  await assertLeagueVisible(client, actor, options.leagueId, "read standings");

  const { data, error } = await client.rpc("mcp_league_standings", {
    p_principal: actor.principalId,
    p_league_id: options.leagueId,
  });
  if (error) {
    throw mapRpcError(error, options.leagueId);
  }
  const standings = ((data as unknown as RawStandingRow[] | null) ?? []).map(toStandingRow);
  return { standings, count: standings.length };
}

/* ------------------------------------------------------------------ */
/* list_league_competitions                                             */
/* ------------------------------------------------------------------ */

export type ListLeagueCompetitionsOptions = {
  actorId: string;
  leagueId: string;
  status?: CompetitionStatus;
  limit?: number;
};

export async function listLeagueCompetitions(
  client: SupabaseClient,
  options: ListLeagueCompetitionsOptions,
): Promise<{ items: LeagueCompetitionSummary[]; count: number }> {
  const actor = await resolveLeagueActor(client, options.actorId);
  const league = await assertLeagueVisible(client, actor, options.leagueId, "inspect competitions");
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  // Row visibility: the league owner sees every attached competition; a
  // non-owner (public league) sees only public competitions in the statuses
  // the app's "Public competitions are viewable" policy exposes.
  const isOwner = await canLeagueManage(client, actor, league.id);

  let query = client
    .from("competitions")
    .select("id,title,status,mode,visibility,scheduled_start_at,completed_at,session_id")
    .eq("league_id", league.id);
  if (!isOwner) {
    query = query
      .eq("visibility", "public")
      .in("status", ["scheduled", "lobby_open", "running", "completed"]);
  }
  if (options.status) {
    if (!(COMPETITION_STATUSES as readonly string[]).includes(options.status)) {
      throw new CompetitionError("validation", `status must be one of ${COMPETITION_STATUSES.join(", ")}.`);
    }
    query = query.eq("status", options.status);
  }
  const { data, error } = await query
    .order("scheduled_start_at", { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) {
    throw sanitizeError(error, `Could not list competitions of league "${league.id}".`);
  }
  const rows = (data as unknown as Array<{
    id: string;
    title: string;
    status: CompetitionStatus;
    mode: string;
    visibility: string;
    scheduled_start_at: string | null;
    completed_at: string | null;
    session_id: string | null;
  }> | null) ?? [];

  const sessionIds = rows.map((r) => r.session_id).filter((s): s is string => s !== null);
  const withResults = new Set<string>();
  if (sessionIds.length > 0) {
    const { data: resRows, error: resError } = await client
      .from("competition_results")
      .select("session_id")
      .in("session_id", sessionIds);
    if (resError) {
      throw sanitizeError(resError, "Could not read result availability.");
    }
    for (const r of (resRows ?? []) as unknown as Array<{ session_id: string }>) {
      withResults.add(r.session_id);
    }
  }

  const items: LeagueCompetitionSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    mode: r.mode,
    scheduledStartAt: r.scheduled_start_at,
    completedAt: r.completed_at,
    visibility: r.visibility,
    hasResults: r.session_id !== null && withResults.has(r.session_id),
  }));
  return { items, count: items.length };
}

/* ------------------------------------------------------------------ */
/* get_competition_results                                              */
/* ------------------------------------------------------------------ */

export type GetCompetitionResultsOptions = {
  actorId: string;
  competitionId: string;
};

async function fetchQuizTitle(
  client: SupabaseClient,
  quizId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("quizzes")
    .select("title")
    .eq("id", quizId)
    .maybeSingle();
  if (error) return null;
  return ((data as unknown as { title?: string } | null)?.title) ?? null;
}

export async function getCompetitionResults(
  client: SupabaseClient,
  options: GetCompetitionResultsOptions,
): Promise<{
  competitionId: string;
  competitionTitle: string;
  quizTitle: string | null;
  status: CompetitionStatus;
  items: CompetitionResultRow[];
  count: number;
  warnings: string[];
}> {
  const actor = await resolveLeagueActor(client, options.actorId);
  const comp = await assertCompetitionCan(client, actor, options.competitionId, "read results");

  if (comp.status !== "completed") {
    throw new CompetitionError(
      "conflict",
      `competition "${options.competitionId}" is ${comp.status} — permanent results exist only after completion.`,
    );
  }

  const quizTitle = await fetchQuizTitle(client, comp.quiz_id);

  if (comp.session_id === null) {
    return {
      competitionId: comp.id,
      competitionTitle: comp.title,
      quizTitle,
      status: comp.status,
      items: [],
      count: 0,
      warnings: ["This completed competition has no session — no permanent results exist."],
    };
  }

  const { data, error } = await client
    .from("competition_results")
    .select("profile_id,final_rank,final_score,total_participants,accuracy_percentage,completed_at")
    .eq("session_id", comp.session_id)
    .order("final_rank", { ascending: true });
  if (error) {
    throw sanitizeError(error, "Could not read competition results.");
  }
  const raw = (data as unknown as Array<{
    profile_id: string;
    final_rank: number;
    final_score: number;
    total_participants: number;
    accuracy_percentage: number;
    completed_at: string;
  }> | null) ?? [];

  const names = new Map<string, { display_name: string | null; avatar_id: string | null }>();
  if (raw.length > 0) {
    const { data: profiles, error: pError } = await client
      .from("profiles")
      .select("id,display_name,avatar_id")
      .in("id", raw.map((r) => r.profile_id));
    if (!pError) {
      for (const p of (profiles ?? []) as unknown as Array<{
        id: string;
        display_name: string | null;
        avatar_id: string | null;
      }>) {
        names.set(p.id, { display_name: p.display_name, avatar_id: p.avatar_id });
      }
    }
  }

  const items: CompetitionResultRow[] = raw.map((r) => {
    const profile = names.get(r.profile_id);
    return {
      profileId: r.profile_id,
      displayName: profile?.display_name ?? null,
      avatarId: profile?.avatar_id ?? null,
      finalRank: r.final_rank,
      finalScore: r.final_score,
      totalParticipants: r.total_participants,
      accuracyPercentage: Number(r.accuracy_percentage),
      completedAt: r.completed_at,
    };
  });

  return {
    competitionId: comp.id,
    competitionTitle: comp.title,
    quizTitle,
    status: comp.status,
    items,
    count: items.length,
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* get_player_league_history                                            */
/* ------------------------------------------------------------------ */

export type GetPlayerLeagueHistoryOptions = {
  actorId: string;
  leagueId: string;
  /** The auth-user / profile id whose league history is requested. */
  profileId: string;
};

export async function getPlayerLeagueHistory(
  client: SupabaseClient,
  options: GetPlayerLeagueHistoryOptions,
): Promise<{
  leagueId: string;
  profileId: string;
  displayName: string | null;
  competitionsEntered: number;
  leaguePoints: number | null;
  overallRank: number | null;
  items: PlayerLeagueHistoryRow[];
}> {
  const actor = await resolveLeagueActor(client, options.actorId);
  if (!isValidUuid(options.profileId)) {
    throw new CompetitionError(
      "validation",
      `profileId "${options.profileId}" is not a valid uuid.`,
    );
  }

  // Authorization: the player may read their own history (their results are
  // theirs under the app's own-results RLS); anyone else needs the
  // owner-or-public league gate.
  const isSelf = options.profileId === actor.principalId;
  let ownerOrPublic = false;
  if (!isSelf) {
    await assertLeagueVisible(client, actor, options.leagueId, "read player history");
    ownerOrPublic = true;
  } else {
    try {
      await assertLeagueVisible(client, actor, options.leagueId, "read player history");
      ownerOrPublic = true;
    } catch {
      // Self-read of a private league the player does not own: still allowed
      // for their own rows; standings-level aggregates stay unavailable.
    }
  }

  const { data: comps, error: compError } = await client
    .from("competitions")
    .select("id,title,session_id")
    .eq("league_id", options.leagueId)
    .eq("status", "completed")
    .not("session_id", "is", null);
  if (compError) {
    throw sanitizeError(compError, `Could not read competitions of league "${options.leagueId}".`);
  }
  const competitions = (comps as unknown as Array<{
    id: string;
    title: string;
    session_id: string;
  }> | null) ?? [];
  const sessionToCompetition = new Map(competitions.map((c) => [c.session_id, c]));

  let rows: Array<{
    session_id: string;
    final_rank: number;
    final_score: number;
    total_participants: number;
    accuracy_percentage: number;
    completed_at: string;
  }> = [];
  if (sessionToCompetition.size > 0) {
    const { data, error } = await client
      .from("competition_results")
      .select("session_id,final_rank,final_score,total_participants,accuracy_percentage,completed_at")
      .eq("profile_id", options.profileId)
      .in("session_id", [...sessionToCompetition.keys()])
      .order("completed_at", { ascending: false });
    if (error) {
      throw sanitizeError(error, "Could not read the player's results.");
    }
    rows = (data as unknown as typeof rows | null) ?? [];
  }

  const items: PlayerLeagueHistoryRow[] = rows
    .map((r) => {
      const comp = sessionToCompetition.get(r.session_id);
      if (!comp) return null;
      return {
        competitionId: comp.id,
        title: comp.title,
        completedAt: r.completed_at,
        finalRank: r.final_rank,
        finalScore: r.final_score,
        totalParticipants: r.total_participants,
        accuracyPercentage: Number(r.accuracy_percentage),
      };
    })
    .filter((r): r is PlayerLeagueHistoryRow => r !== null);

  // Cumulative points/rank come from the authoritative standings computation —
  // available only when the caller passes the owner-or-public gate.
  let leaguePoints: number | null = null;
  let overallRank: number | null = null;
  if (ownerOrPublic) {
    const { data, error } = await client.rpc("mcp_league_standings", {
      p_principal: actor.principalId,
      p_league_id: options.leagueId,
    });
    if (!error) {
      const found = ((data as unknown as RawStandingRow[] | null) ?? []).find(
        (s) => s.profile_id === options.profileId,
      );
      if (found) {
        leaguePoints = found.league_points;
        overallRank = found.standing_position;
      }
    }
  }

  let displayName: string | null = null;
  const { data: profile } = await client
    .from("profiles")
    .select("display_name")
    .eq("id", options.profileId)
    .maybeSingle();
  displayName = ((profile as unknown as { display_name: string | null } | null)?.display_name) ?? null;

  return {
    leagueId: options.leagueId,
    profileId: options.profileId,
    displayName,
    competitionsEntered: items.length,
    leaguePoints,
    overallRank,
    items,
  };
}

/* ------------------------------------------------------------------ */
/* attach / detach competition ↔ league                                 */
/* ------------------------------------------------------------------ */

export type AttachCompetitionToLeagueOptions = {
  actorId: string;
  competitionId: string;
  leagueId: string;
  idempotencyKey?: string;
};

export async function attachCompetitionToLeague(
  client: SupabaseClient,
  options: AttachCompetitionToLeagueOptions,
): Promise<LeagueMutationEnvelope> {
  const run = async (): Promise<LeagueMutationEnvelope> => {
    const actor = await resolveLeagueActor(client, options.actorId);
    const row = await assertCompetitionMutable(client, actor, options.competitionId, "attached to a league");
    await assertAccessibleLeague(client, actor, options.leagueId);

    if (row.league_id === options.leagueId) {
      return {
        ok: true,
        action: "attach_competition_to_league",
        id: options.competitionId,
        competitionId: options.competitionId,
        leagueId: options.leagueId,
        changed: { attached: false },
        warnings: [
          `competition "${options.competitionId}" is already attached to league "${options.leagueId}" — nothing changed.`,
        ],
        errors: [],
      };
    }

    const { error } = await client
      .from("competitions")
      .update({ league_id: options.leagueId })
      .eq("id", options.competitionId);
    if (error) {
      throw sanitizeError(error, `Could not attach competition "${options.competitionId}" to league "${options.leagueId}".`);
    }

    return {
      ok: true,
      action: "attach_competition_to_league",
      id: options.competitionId,
      competitionId: options.competitionId,
      leagueId: options.leagueId,
      changed: { attached: true, previousLeagueId: row.league_id },
      warnings: [],
      errors: [],
    };
  };

  return wrapIdempotent(
    client,
    "attach_competition_to_league",
    options.idempotencyKey,
    {
      actor: options.actorId,
      competitionId: options.competitionId,
      leagueId: options.leagueId,
    },
    run,
  );
}

export type DetachCompetitionFromLeagueOptions = {
  actorId: string;
  competitionId: string;
  idempotencyKey?: string;
};

export async function detachCompetitionFromLeague(
  client: SupabaseClient,
  options: DetachCompetitionFromLeagueOptions,
): Promise<LeagueMutationEnvelope> {
  const run = async (): Promise<LeagueMutationEnvelope> => {
    const actor = await resolveLeagueActor(client, options.actorId);
    const row = await assertCompetitionMutable(client, actor, options.competitionId, "detached from a league");

    if (row.league_id === null) {
      return {
        ok: true,
        action: "detach_competition_from_league",
        id: options.competitionId,
        competitionId: options.competitionId,
        leagueId: null,
        changed: { detached: false },
        warnings: [
          `competition "${options.competitionId}" is not attached to any league — nothing changed.`,
        ],
        errors: [],
      };
    }

    const { error } = await client
      .from("competitions")
      .update({ league_id: null })
      .eq("id", options.competitionId);
    if (error) {
      throw sanitizeError(error, `Could not detach competition "${options.competitionId}" from its league.`);
    }

    return {
      ok: true,
      action: "detach_competition_from_league",
      id: options.competitionId,
      competitionId: options.competitionId,
      leagueId: null,
      changed: { detached: true, previousLeagueId: row.league_id },
      warnings: [],
      errors: [],
    };
  };

  return wrapIdempotent(
    client,
    "detach_competition_from_league",
    options.idempotencyKey,
    {
      actor: options.actorId,
      competitionId: options.competitionId,
    },
    run,
  );
}
