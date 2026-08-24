// Competition lifecycle operations for the MCP server (Phase 8C).
//
// Every operation resolves the acting Principal (an auth user id — user
// principals are id-identical) and enforces capability through the app's
// existing `public.can(principal, action, resource)` resolver (service-role
// RPC), NOT a parallel MCP permission system. Ownership is principal-only
// (Phase 7L): owner_principal_id is authoritative.
//
// The Session boundary is absolute: this module never reads or writes the
// sessions table. The safe summarized state of a competition IS its `status`
// column (draft/scheduled/lobby_open/running/completed/cancelled), which the
// existing engine maintains (prepare_competition_session_internal sets
// lobby_open; the sessions-side sync trigger sets running/completed). The
// autonomous handoff is: status='scheduled' + scheduled_start_at → the
// existing pg_cron scheduler (run_autonomous_scheduler → run_autonomous_tick,
// whose due-competition predicate matches list_due_competitions() →
// prepare_competition_session_internal). MCP only ever configures the
// competition business object.
//
// Errors are typed (CompetitionError) with a fixed vocabulary
// (unauthorized | not-found | validation | conflict | unknown) and NEVER
// interpolate raw PostgREST/SQL messages — tools.ts maps them to the
// structured { ok:false, action, error:{code,message} } failure envelope.
//
// Writes accept an optional idempotencyKey; a repeated request with the same
// key replays the stored result (see idempotency.ts, same table as Phase 8B).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidUuid, resolveActor, wrapIdempotent, type Actor } from "./lifecycle";

/* ------------------------------------------------------------------ */
/* Shared shapes                                                        */
/* ------------------------------------------------------------------ */

export type CompetitionErrorCode =
  "unauthorized" | "not-found" | "validation" | "conflict" | "unknown";

export class CompetitionError extends Error {
  code: CompetitionErrorCode;
  constructor(code: CompetitionErrorCode, message: string) {
    super(message);
    this.name = "CompetitionError";
    this.code = code;
  }
}

export type CompetitionEnvelope = {
  ok: true;
  action: string;
  /** Always present on success — every write operation sets it. */
  competitionId: string;
  id?: string;
  status?: CompetitionStatus;
  scheduledStartAt?: string | null;
  changed?: Record<string, unknown>;
  warnings: string[];
  errors: never[];
  /** Present only when the request was replayed via an idempotency key. */
  replayed?: boolean;
};

export type CompetitionFailureEnvelope = {
  ok: false;
  action: string;
  error: { code: CompetitionErrorCode; message: string };
};

/** Maps any thrown value to the structured failure envelope (spec §16). */
export function toErrorEnvelope(action: string, err: unknown): CompetitionFailureEnvelope {
  if (err instanceof CompetitionError) {
    return { ok: false, action, error: { code: err.code, message: err.message } };
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

export const COMPETITION_MODES = ["hosted", "arena", "scheduled"] as const;
export type CompetitionMode = (typeof COMPETITION_MODES)[number];

export const COMPETITION_STATUSES = [
  "draft",
  "scheduled",
  "lobby_open",
  "running",
  "completed",
  "cancelled",
] as const;
export type CompetitionStatus = (typeof COMPETITION_STATUSES)[number];

export const COMPETITION_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type CompetitionVisibility = (typeof COMPETITION_VISIBILITIES)[number];

/** States in which update_competition / schedule_competition may write. */
const MUTABLE_STATUSES: readonly CompetitionStatus[] = ["draft", "scheduled"];

const LOBBY_MIN = 30;
const LOBBY_MAX = 3600;
const DEFAULT_LOBBY_SECONDS = 300;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;

const COMPETITION_COLUMNS =
  "id,title,description,quiz_id,owner_principal_id,mode,status,visibility," +
  "scheduled_start_at,lobby_duration_seconds,session_id,league_id,branding_profile_id," +
  "max_participants,metadata,started_at,completed_at,cancelled_at,created_at,updated_at";

type CompetitionRow = {
  id: string;
  title: string;
  description: string | null;
  quiz_id: string;
  owner_principal_id: string | null;
  mode: CompetitionMode;
  status: CompetitionStatus;
  visibility: CompetitionVisibility;
  scheduled_start_at: string | null;
  lobby_duration_seconds: number;
  session_id: string | null;
  league_id: string | null;
  branding_profile_id: string | null;
  max_participants: number | null;
  metadata: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CompetitionSummary = {
  id: string;
  title: string;
  description: string | null;
  quizId: string;
  quizTitle: string | null;
  ownerPrincipalId: string;
  mode: CompetitionMode;
  status: CompetitionStatus;
  visibility: CompetitionVisibility;
  scheduledStartAt: string | null;
  lobbyDurationSeconds: number;
  sessionId: string | null;
  leagueId: string | null;
  brandingProfileId: string | null;
  maxParticipants: number | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The full business state get_competition returns (metadata included). */
export type CompetitionDetail = CompetitionSummary & {
  metadata: Record<string, unknown>;
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function sanitizeError(err: unknown, fallback: string): CompetitionError {
  if (err instanceof CompetitionError) return err;
  return new CompetitionError("unknown", fallback);
}

/** Resolves the actor, converting shared resolver failures to typed errors. */
async function resolveCompetitionActor(
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

/** App rule (competitions.tsx): a start must be no older than 60s ago. */
function assertFutureIso(value: unknown, label: string): string {
  if (!isValidIsoDate(value)) {
    throw new CompetitionError(
      "validation",
      `${label} must be a valid ISO-8601 timestamp (e.g. 2026-09-01T14:00:00Z).`,
    );
  }
  if (Date.parse(value) < Date.now() - 60_000) {
    throw new CompetitionError("validation", `${label} must be in the future.`);
  }
  return value;
}

function assertLobbyDuration(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < LOBBY_MIN ||
    value > LOBBY_MAX
  ) {
    throw new CompetitionError(
      "validation",
      `${label} must be an integer between ${LOBBY_MIN} and ${LOBBY_MAX} seconds.`,
    );
  }
  return value;
}

function assertMaxParticipants(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CompetitionError("validation", `${label} must be a positive integer.`);
  }
  return value;
}

function toSummary(row: CompetitionRow, quizTitle: string | null): CompetitionSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    quizId: row.quiz_id,
    quizTitle,
    ownerPrincipalId: row.owner_principal_id ?? "",
    mode: row.mode,
    status: row.status,
    visibility: row.visibility,
    scheduledStartAt: row.scheduled_start_at,
    lobbyDurationSeconds: row.lobby_duration_seconds,
    sessionId: row.session_id,
    leagueId: row.league_id,
    brandingProfileId: row.branding_profile_id,
    maxParticipants: row.max_participants,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function fetchCompetitionRow(
  client: SupabaseClient,
  competitionId: string,
): Promise<CompetitionRow | null> {
  if (!isValidUuid(competitionId)) {
    throw new CompetitionError(
      "validation",
      `competitionId "${competitionId}" is not a valid uuid.`,
    );
  }
  const { data, error } = await client
    .from("competitions")
    .select(COMPETITION_COLUMNS)
    .eq("id", competitionId)
    .maybeSingle();
  if (error) {
    throw sanitizeError(error, `Could not read competition "${competitionId}".`);
  }
  return (data as unknown as CompetitionRow | null) ?? null;
}

/** Quiz title lookup for a set of quiz ids (mirrors list_quizzes' counts). */
async function fetchQuizTitles(
  client: SupabaseClient,
  quizIds: string[],
): Promise<Map<string, string>> {
  const { data, error } = await client.from("quizzes").select("id,title").in("id", quizIds);
  if (error) {
    throw sanitizeError(error, "Could not read quiz titles.");
  }
  const titles = new Map<string, string>();
  for (const row of (data ?? []) as unknown as Array<{ id: string; title: string }>) {
    titles.set(row.id, row.title);
  }
  return titles;
}

/**
 * Capability gate: the acting principal must pass the app's own
 * `can(principal, 'competition.manage', id)` resolver — ownership
 * (owner_principal_id) AND the host capability. Admins do not bypass
 * ownership. Fetches the competition first so the failure mode is
 * "does not exist" rather than a generic denial.
 */
export async function assertCompetitionCan(
  client: SupabaseClient,
  actor: Actor,
  competitionId: string,
  verb: string,
): Promise<CompetitionRow> {
  const row = await fetchCompetitionRow(client, competitionId);
  if (!row) {
    throw new CompetitionError(
      "not-found",
      `competition "${competitionId}" does not exist — nothing was changed.`,
    );
  }

  const { data, error } = await client.rpc("can", {
    p_principal: actor.principalId,
    p_action: "competition.manage",
    p_resource: competitionId,
  });
  if (error) {
    throw sanitizeError(
      error,
      `Could not verify authorization for competition "${competitionId}".`,
    );
  }
  if (data !== true) {
    throw new CompetitionError(
      "unauthorized",
      `actor "${actor.actorId}" is not authorized to ${verb} competition "${competitionId}" ` +
        `("${row.title}") — the acting principal must own the competition and hold the host capability.`,
    );
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* list_competitions                                                    */
/* ------------------------------------------------------------------ */

export type ListCompetitionsOptions = {
  actorId: string;
  quizId?: string;
  leagueId?: string;
  status?: CompetitionStatus;
  mode?: CompetitionMode;
  visibility?: CompetitionVisibility;
  /** ISO timestamp — competitions scheduled at or after this. */
  scheduledFrom?: string;
  /** ISO timestamp — competitions scheduled at or before this. */
  scheduledTo?: string;
  limit?: number;
};

export async function listCompetitions(
  client: SupabaseClient,
  options: ListCompetitionsOptions,
): Promise<{ items: CompetitionSummary[]; count: number }> {
  const actor = await resolveCompetitionActor(client, options.actorId);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  let query = client
    .from("competitions")
    .select(COMPETITION_COLUMNS)
    .eq("owner_principal_id", actor.principalId);

  if (options.quizId) {
    if (!isValidUuid(options.quizId)) {
      throw new CompetitionError("validation", `quizId "${options.quizId}" is not a valid uuid.`);
    }
    query = query.eq("quiz_id", options.quizId);
  }
  if (options.leagueId) {
    if (!isValidUuid(options.leagueId)) {
      throw new CompetitionError(
        "validation",
        `leagueId "${options.leagueId}" is not a valid uuid.`,
      );
    }
    query = query.eq("league_id", options.leagueId);
  }
  if (options.status) query = query.eq("status", options.status);
  if (options.mode) query = query.eq("mode", options.mode);
  if (options.visibility) query = query.eq("visibility", options.visibility);
  if (options.scheduledFrom) {
    if (!isValidIsoDate(options.scheduledFrom)) {
      throw new CompetitionError("validation", "scheduledFrom must be a valid ISO-8601 timestamp.");
    }
    query = query.gte("scheduled_start_at", options.scheduledFrom);
  }
  if (options.scheduledTo) {
    if (!isValidIsoDate(options.scheduledTo)) {
      throw new CompetitionError("validation", "scheduledTo must be a valid ISO-8601 timestamp.");
    }
    query = query.lte("scheduled_start_at", options.scheduledTo);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) {
    throw sanitizeError(error, "Could not list competitions.");
  }
  const rows = (data as unknown as CompetitionRow[] | null) ?? [];
  if (rows.length === 0) {
    return { items: [], count: 0 };
  }

  const titles = await fetchQuizTitles(
    client,
    rows.map((r) => r.quiz_id),
  );

  const items: CompetitionSummary[] = rows.map((r) => toSummary(r, titles.get(r.quiz_id) ?? null));
  return { items, count: items.length };
}

/* ------------------------------------------------------------------ */
/* get_competition                                                      */
/* ------------------------------------------------------------------ */

export type GetCompetitionOptions = {
  actorId: string;
  competitionId: string;
};

export async function getCompetition(
  client: SupabaseClient,
  options: GetCompetitionOptions,
): Promise<{ competition: CompetitionDetail }> {
  const actor = await resolveCompetitionActor(client, options.actorId);
  const row = await assertCompetitionCan(client, actor, options.competitionId, "read");

  const titles = await fetchQuizTitles(client, [row.quiz_id]);
  const competition: CompetitionDetail = {
    ...toSummary(row, titles.get(row.quiz_id) ?? null),
    metadata: row.metadata ?? {},
  };

  return { competition };
}

/* ------------------------------------------------------------------ */
/* create_competition                                                   */
/* ------------------------------------------------------------------ */

export type CreateCompetitionOptions = {
  actorId: string;
  quizId: string;
  title: string;
  mode: CompetitionMode;
  visibility: CompetitionVisibility;
  scheduledStartAt: string;
  lobbyDurationSeconds?: number;
  description?: string | null;
  leagueId?: string | null;
  brandingProfileId?: string | null;
  maxParticipants?: number | null;
  idempotencyKey?: string;
};

export async function createCompetition(
  client: SupabaseClient,
  options: CreateCompetitionOptions,
): Promise<CompetitionEnvelope> {
  const run = async (): Promise<CompetitionEnvelope> => {
    const actor = await resolveCompetitionActor(client, options.actorId);

    const { data: allowed, error: canError } = await client.rpc("can", {
      p_principal: actor.principalId,
      p_action: "competition.create",
      p_resource: null,
    });
    if (canError) {
      throw sanitizeError(canError, "Could not verify the competition.create capability.");
    }
    if (allowed !== true) {
      throw new CompetitionError(
        "unauthorized",
        `actor "${actor.actorId}" is not authorized to create competitions — the host capability ` +
          "(admin role, host role, or active host authorization) is required.",
      );
    }

    const title = (options.title ?? "").trim();
    if (!title) {
      throw new CompetitionError(
        "validation",
        "create_competition: title must be a non-empty string.",
      );
    }
    const mode = options.mode;
    if (!COMPETITION_MODES.includes(mode)) {
      throw new CompetitionError(
        "validation",
        `create_competition: mode must be one of ${COMPETITION_MODES.join(", ")}.`,
      );
    }
    const visibility = options.visibility;
    if (!COMPETITION_VISIBILITIES.includes(visibility)) {
      throw new CompetitionError(
        "validation",
        `create_competition: visibility must be one of ${COMPETITION_VISIBILITIES.join(", ")} ` +
          "(visibility is always explicit — MCP never defaults it).",
      );
    }
    const scheduledStartAt = assertFutureIso(options.scheduledStartAt, "scheduledStartAt");
    const lobbyDurationSeconds =
      options.lobbyDurationSeconds === undefined
        ? DEFAULT_LOBBY_SECONDS
        : assertLobbyDuration(options.lobbyDurationSeconds, "lobbyDurationSeconds");
    if (options.maxParticipants !== undefined && options.maxParticipants !== null) {
      assertMaxParticipants(options.maxParticipants, "maxParticipants");
    }

    // Quiz gate: exists, owned by the acting principal, not archived.
    if (!isValidUuid(options.quizId)) {
      throw new CompetitionError("validation", `quizId "${options.quizId}" is not a valid uuid.`);
    }
    const { data: quiz, error: quizError } = await client
      .from("quizzes")
      .select("id,owner_principal_id,archived_at")
      .eq("id", options.quizId)
      .maybeSingle();
    if (quizError) {
      throw sanitizeError(quizError, `Could not read quiz "${options.quizId}".`);
    }
    if (!quiz) {
      throw new CompetitionError(
        "not-found",
        `quiz "${options.quizId}" does not exist — nothing was created.`,
      );
    }
    const quizRow = quiz as unknown as {
      id: string;
      owner_principal_id: string | null;
      archived_at: string | null;
    };
    if (quizRow.owner_principal_id !== actor.principalId) {
      throw new CompetitionError(
        "unauthorized",
        `actor "${actor.actorId}" is not authorized to use quiz "${options.quizId}" ("${quizRow.id}") — ` +
          "competitions can only be created from quizzes the acting principal owns.",
      );
    }
    if (quizRow.archived_at !== null) {
      throw new CompetitionError(
        "validation",
        `quiz "${options.quizId}" is archived — competitions require an active quiz.`,
      );
    }

    // Playability gate: at least one question must be servable to players.
    const { data: playableRows, error: playableError } = await client
      .from("questions")
      .select("id")
      .eq("quiz_id", options.quizId)
      .eq("is_playable", true);
    if (playableError) {
      throw sanitizeError(playableError, `Could not read questions of quiz "${options.quizId}".`);
    }
    if (!playableRows || playableRows.length === 0) {
      throw new CompetitionError(
        "validation",
        `quiz "${options.quizId}" has no playable questions — enable at least one question before creating a competition.`,
      );
    }

    // League gate (if attached): exists, owned, not archived.
    if (options.leagueId != null) {
      await assertAccessibleLeague(client, actor, options.leagueId);
    }
    // Branding gate (if attached): exists, owned.
    if (options.brandingProfileId != null) {
      await assertAccessibleBranding(client, actor, options.brandingProfileId);
    }

    const { data: inserted, error: insertError } = await client
      .from("competitions")
      .insert({
        owner_principal_id: actor.principalId,
        quiz_id: options.quizId,
        title,
        description: options.description ?? null,
        mode,
        visibility,
        scheduled_start_at: scheduledStartAt,
        lobby_duration_seconds: lobbyDurationSeconds,
        league_id: options.leagueId ?? null,
        branding_profile_id: options.brandingProfileId ?? null,
        max_participants: options.maxParticipants ?? null,
        status: "draft",
        metadata: {},
      })
      .select("id")
      .single();
    if (insertError) {
      throw sanitizeError(insertError, "Could not create the competition.");
    }
    const competitionId = (inserted as unknown as { id: string }).id;

    return {
      ok: true,
      action: "create_competition",
      id: competitionId,
      competitionId,
      status: "draft",
      scheduledStartAt,
      warnings: [],
      errors: [],
    };
  };

  return wrapIdempotent(
    client,
    "create_competition",
    options.idempotencyKey,
    {
      actor: options.actorId,
      quizId: options.quizId,
      title: options.title,
      mode: options.mode,
      visibility: options.visibility,
      scheduledStartAt: options.scheduledStartAt,
      lobbyDurationSeconds: options.lobbyDurationSeconds,
      description: options.description,
      leagueId: options.leagueId,
      brandingProfileId: options.brandingProfileId,
      maxParticipants: options.maxParticipants,
    },
    run,
  );
}

/* ------------------------------------------------------------------ */
/* update_competition                                                   */
/* ------------------------------------------------------------------ */

export type CompetitionPatch = {
  title?: string;
  description?: string | null;
  visibility?: CompetitionVisibility;
  scheduledStartAt?: string;
  lobbyDurationSeconds?: number;
  /** null detaches the league; absent leaves it unchanged. */
  leagueId?: string | null;
  /** null detaches the branding profile; absent leaves it unchanged. */
  brandingProfileId?: string | null;
  /** null clears the limit; absent leaves it unchanged. */
  maxParticipants?: number | null;
};

export type UpdateCompetitionOptions = {
  actorId: string;
  competitionId: string;
  patch: CompetitionPatch;
  idempotencyKey?: string;
};

export async function updateCompetition(
  client: SupabaseClient,
  options: UpdateCompetitionOptions,
): Promise<CompetitionEnvelope> {
  const run = async (): Promise<CompetitionEnvelope> => {
    const actor = await resolveCompetitionActor(client, options.actorId);
    const row = await assertCompetitionCan(client, actor, options.competitionId, "update");

    if (!MUTABLE_STATUSES.includes(row.status)) {
      throw new CompetitionError(
        "conflict",
        `competition "${options.competitionId}" is ${row.status} and cannot be modified — ` +
          "only draft and scheduled competitions accept updates.",
      );
    }

    const patch = options.patch ?? {};
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new CompetitionError(
        "validation",
        "update_competition needs at least one field to change " +
          "(title, description, visibility, scheduledStartAt, lobbyDurationSeconds, leagueId, " +
          "brandingProfileId, maxParticipants).",
      );
    }

    const update: Record<string, unknown> = {};
    const changed: Record<string, boolean> = {};

    if ("title" in patch) {
      const title = (patch.title ?? "").trim();
      if (!title)
        throw new CompetitionError(
          "validation",
          "update_competition: title must be a non-empty string.",
        );
      update.title = title;
      changed.title = title !== row.title;
    }
    if ("description" in patch) {
      const description = patch.description ?? null;
      update.description = description;
      changed.description = description !== row.description;
    }
    if ("visibility" in patch) {
      const visibility = patch.visibility;
      if (visibility === undefined || !COMPETITION_VISIBILITIES.includes(visibility)) {
        throw new CompetitionError(
          "validation",
          `update_competition: visibility must be one of ${COMPETITION_VISIBILITIES.join(", ")}.`,
        );
      }
      update.visibility = visibility;
      changed.visibility = visibility !== row.visibility;
    }
    if ("scheduledStartAt" in patch) {
      const scheduledStartAt = assertFutureIso(patch.scheduledStartAt, "scheduledStartAt");
      update.scheduled_start_at = scheduledStartAt;
      // Compare semantically (Date.parse), not lexically: the DB stores
      // TIMESTAMPTZ-normalized text, the client may pass +00:00 offsets.
      const before = row.scheduled_start_at;
      changed.scheduledStartAt =
        before === null || Date.parse(scheduledStartAt) !== Date.parse(before);
    }
    if ("lobbyDurationSeconds" in patch) {
      const lobbyDurationSeconds = assertLobbyDuration(
        patch.lobbyDurationSeconds,
        "lobbyDurationSeconds",
      );
      update.lobby_duration_seconds = lobbyDurationSeconds;
      changed.lobbyDurationSeconds = lobbyDurationSeconds !== row.lobby_duration_seconds;
    }
    if ("leagueId" in patch) {
      const leagueId = patch.leagueId ?? null;
      if (leagueId !== null) {
        await assertAccessibleLeague(client, actor, leagueId);
      }
      update.league_id = leagueId;
      changed.leagueId = leagueId !== row.league_id;
    }
    if ("brandingProfileId" in patch) {
      const brandingProfileId = patch.brandingProfileId ?? null;
      if (brandingProfileId !== null) {
        await assertAccessibleBranding(client, actor, brandingProfileId);
      }
      update.branding_profile_id = brandingProfileId;
      changed.brandingProfileId = brandingProfileId !== row.branding_profile_id;
    }
    if ("maxParticipants" in patch) {
      const maxParticipants = patch.maxParticipants ?? null;
      if (maxParticipants !== null) {
        assertMaxParticipants(maxParticipants, "maxParticipants");
      }
      update.max_participants = maxParticipants;
      changed.maxParticipants = maxParticipants !== row.max_participants;
    }

    const applied = Object.values(changed).some(Boolean);
    if (applied) {
      const { error } = await client
        .from("competitions")
        .update(update)
        .eq("id", options.competitionId);
      if (error) {
        throw sanitizeError(error, `Could not update competition "${options.competitionId}".`);
      }
    }

    const warnings: string[] = [];
    if (!applied) {
      warnings.push("The supplied values match the current competition — nothing changed.");
    }

    return {
      ok: true,
      action: "update_competition",
      id: options.competitionId,
      competitionId: options.competitionId,
      changed,
      warnings,
      errors: [],
    };
  };

  return wrapIdempotent(
    client,
    "update_competition",
    options.idempotencyKey,
    {
      actor: options.actorId,
      competitionId: options.competitionId,
      patch: options.patch,
    },
    run,
  );
}

/* ------------------------------------------------------------------ */
/* schedule_competition                                                 */
/* ------------------------------------------------------------------ */

export type ScheduleCompetitionOptions = {
  actorId: string;
  competitionId: string;
  /** New start time; defaults to the stored scheduled_start_at when omitted. */
  scheduledStartAt?: string;
  idempotencyKey?: string;
};

export async function scheduleCompetition(
  client: SupabaseClient,
  options: ScheduleCompetitionOptions,
): Promise<CompetitionEnvelope> {
  const run = async (): Promise<CompetitionEnvelope> => {
    const actor = await resolveCompetitionActor(client, options.actorId);
    const row = await assertCompetitionCan(client, actor, options.competitionId, "schedule");

    // Mode gate: the existing autonomous scheduler only opens lobbies for
    // mode='scheduled' (run_autonomous_tick), so scheduling any other mode
    // would create a row the tick never opens.
    if (row.mode !== "scheduled") {
      throw new CompetitionError(
        "validation",
        `competition "${options.competitionId}" is mode "${row.mode}" and cannot be scheduled — ` +
          "the autonomous scheduler runs mode 'scheduled' competitions only.",
      );
    }
    if (!MUTABLE_STATUSES.includes(row.status)) {
      throw new CompetitionError(
        "conflict",
        `competition "${options.competitionId}" is ${row.status} and cannot be scheduled.`,
      );
    }

    // Quiz-usable re-check: a quiz archived after create would leave the
    // armed competition silently stuck (the tick skips it).
    const { data: quiz, error: quizError } = await client
      .from("quizzes")
      .select("id,archived_at")
      .eq("id", row.quiz_id)
      .maybeSingle();
    if (quizError) {
      throw sanitizeError(quizError, `Could not read quiz "${row.quiz_id}".`);
    }
    if (!quiz) {
      throw new CompetitionError(
        "validation",
        `quiz "${row.quiz_id}" no longer exists — the competition cannot be scheduled.`,
      );
    }
    if ((quiz as unknown as { archived_at: string | null }).archived_at !== null) {
      throw new CompetitionError(
        "validation",
        `quiz "${row.quiz_id}" is archived — the competition cannot be scheduled.`,
      );
    }

    let scheduledStartAt: string;
    if (options.scheduledStartAt !== undefined) {
      scheduledStartAt = assertFutureIso(options.scheduledStartAt, "scheduledStartAt");
    } else {
      if (row.scheduled_start_at === null) {
        throw new CompetitionError(
          "validation",
          `competition "${options.competitionId}" has no scheduled start time — pass scheduledStartAt.`,
        );
      }
      if (Date.parse(row.scheduled_start_at) < Date.now() - 60_000) {
        throw new CompetitionError(
          "validation",
          `the stored scheduled start (${row.scheduled_start_at}) is in the past — pass a future scheduledStartAt.`,
        );
      }
      scheduledStartAt = row.scheduled_start_at;
    }

    const { error } = await client
      .from("competitions")
      .update({ status: "scheduled", scheduled_start_at: scheduledStartAt })
      .eq("id", options.competitionId);
    if (error) {
      throw sanitizeError(error, `Could not schedule competition "${options.competitionId}".`);
    }

    return {
      ok: true,
      action: "schedule_competition",
      id: options.competitionId,
      competitionId: options.competitionId,
      status: "scheduled",
      scheduledStartAt,
      warnings: [],
      errors: [],
    };
  };

  return wrapIdempotent(
    client,
    "schedule_competition",
    options.idempotencyKey,
    {
      actor: options.actorId,
      competitionId: options.competitionId,
      scheduledStartAt: options.scheduledStartAt,
    },
    run,
  );
}

/* ------------------------------------------------------------------ */
/* cancel_competition                                                   */
/* ------------------------------------------------------------------ */

export type CancelCompetitionOptions = {
  actorId: string;
  competitionId: string;
  idempotencyKey?: string;
};

export async function cancelCompetition(
  client: SupabaseClient,
  options: CancelCompetitionOptions,
): Promise<CompetitionEnvelope> {
  const run = async (): Promise<CompetitionEnvelope> => {
    const actor = await resolveCompetitionActor(client, options.actorId);
    const row = await assertCompetitionCan(client, actor, options.competitionId, "cancel");

    if (row.status === "completed") {
      throw new CompetitionError(
        "conflict",
        `competition "${options.competitionId}" already completed on ${row.completed_at} — completed competitions cannot be cancelled.`,
      );
    }
    if (row.status === "cancelled") {
      return {
        ok: true,
        action: "cancel_competition",
        id: options.competitionId,
        competitionId: options.competitionId,
        status: "cancelled",
        changed: { cancelled: false },
        warnings: [
          `competition "${options.competitionId}" was already cancelled on ${row.cancelled_at}.`,
        ],
        errors: [],
      };
    }

    const cancelledAt = new Date().toISOString();
    const { error } = await client
      .from("competitions")
      .update({ status: "cancelled", cancelled_at: cancelledAt })
      .eq("id", options.competitionId);
    if (error) {
      throw sanitizeError(error, `Could not cancel competition "${options.competitionId}".`);
    }

    return {
      ok: true,
      action: "cancel_competition",
      id: options.competitionId,
      competitionId: options.competitionId,
      status: "cancelled",
      changed: { cancelled: true, cancelledAt },
      warnings: [],
      errors: [],
    };
  };

  return wrapIdempotent(
    client,
    "cancel_competition",
    options.idempotencyKey,
    {
      actor: options.actorId,
      competitionId: options.competitionId,
    },
    run,
  );
}

/* ------------------------------------------------------------------ */
/* League / branding accessibility (owner-scoped, like the app form)     */
/* ------------------------------------------------------------------ */

/** Exported for the Phase 8D league tools (attach/detach reuse the same gate). */
export async function assertAccessibleLeague(
  client: SupabaseClient,
  actor: Actor,
  leagueId: string,
): Promise<void> {
  if (!isValidUuid(leagueId)) {
    throw new CompetitionError("validation", `leagueId "${leagueId}" is not a valid uuid.`);
  }
  const { data, error } = await client
    .from("leagues")
    .select("id,owner_principal_id,archived_at")
    .eq("id", leagueId)
    .maybeSingle();
  if (error) {
    throw sanitizeError(error, `Could not read league "${leagueId}".`);
  }
  if (!data) {
    throw new CompetitionError("not-found", `league "${leagueId}" does not exist.`);
  }
  const league = data as unknown as {
    id: string;
    owner_principal_id: string | null;
    archived_at: string | null;
  };
  if (league.owner_principal_id !== actor.principalId) {
    throw new CompetitionError(
      "unauthorized",
      `actor "${actor.actorId}" is not authorized to use league "${leagueId}" — only leagues the acting principal owns can be attached.`,
    );
  }
  if (league.archived_at !== null) {
    throw new CompetitionError(
      "validation",
      `league "${leagueId}" is archived and cannot be attached.`,
    );
  }
}

async function assertAccessibleBranding(
  client: SupabaseClient,
  actor: Actor,
  brandingProfileId: string,
): Promise<void> {
  if (!isValidUuid(brandingProfileId)) {
    throw new CompetitionError(
      "validation",
      `brandingProfileId "${brandingProfileId}" is not a valid uuid.`,
    );
  }
  const { data, error } = await client
    .from("branding_profiles")
    .select("id,owner_principal_id")
    .eq("id", brandingProfileId)
    .maybeSingle();
  if (error) {
    throw sanitizeError(error, `Could not read branding profile "${brandingProfileId}".`);
  }
  if (!data) {
    throw new CompetitionError(
      "not-found",
      `branding profile "${brandingProfileId}" does not exist.`,
    );
  }
  const profile = data as unknown as { id: string; owner_principal_id: string | null };
  if (profile.owner_principal_id !== actor.principalId) {
    throw new CompetitionError(
      "unauthorized",
      `actor "${actor.actorId}" is not authorized to use branding profile "${brandingProfileId}" — ` +
        "only branding profiles the acting principal owns can be attached.",
    );
  }
}
