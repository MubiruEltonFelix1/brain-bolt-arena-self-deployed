// Phase 8C competition lifecycle tests: list/get/create/update/schedule/cancel
// + idempotency + failure envelopes + session boundary, exercised against the
// in-memory fake Supabase client (principal resolution, can() capability
// checks, ownership, status gates, league/branding accessibility, positions).
//
// The fake has NO sessions table: any accidental session access by the
// production code surfaces as an "unknown table" error and fails the test —
// the implicit session-boundary guard.

import { describe, expect, test } from "bun:test";
import {
  cancelCompetition,
  CompetitionError,
  createCompetition,
  getCompetition,
  listCompetitions,
  scheduleCompetition,
  toErrorEnvelope,
  updateCompetition,
  type CompetitionVisibility,
} from "../src/competition";
import { saveQuizWithClient } from "../src/supabase";
import type { BrainBoltQuestion, BrainBoltQuiz } from "../src/schema";
import {
  asClient,
  createFakeDb,
  FakeSupabase,
  seedHostAuthorization,
  seedUser,
  type FakeDb,
} from "./fake-supabase";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_HOST = "22222222-2222-2222-2222-222222222222";
const NO_ROLE_USER = "33333333-3333-3333-3333-333333333333";
const GHOST = "44444444-4444-4444-4444-444444444444";
const ADMIN = "55555555-5555-5555-5555-555555555555";
const HOST_AUTH_USER = "66666666-6666-6666-6666-666666666666";
const MISSING = "99999999-9999-9999-9999-999999999999";

const QUIZ: BrainBoltQuiz = {
  title: "Solar System Smash",
  description: "Planets",
  timePerQuestionSec: 20,
  difficulty: "medium",
  questions: [
    {
      type: "mcq",
      text: "Which planet is the Red Planet?",
      options: ["Venus", "Mars"],
      correctIndex: 1,
    },
    { type: "true_false", text: "The Earth is round.", correct: true },
  ],
};

function futureIso(hours = 1): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}
function pastIso(hours = 1): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function makeEnv() {
  const db = createFakeDb();
  seedUser(db, OWNER, ["host"]);
  seedUser(db, OTHER_HOST, ["host"]);
  seedUser(db, NO_ROLE_USER);
  const client = asClient(new FakeSupabase(db));
  return { db, client };
}

async function saveOwnedQuiz(
  client: ReturnType<typeof asClient>,
  questions: BrainBoltQuestion[] = QUIZ.questions,
  ownerId = OWNER,
) {
  return saveQuizWithClient(client, { ...QUIZ, questions }, { ownerId });
}

async function seedLeague(
  client: ReturnType<typeof asClient>,
  ownerId: string,
  archived = false,
): Promise<string> {
  const { data, error } = await client
    .from("leagues")
    .insert({
      owner_principal_id: ownerId,
      name: "Season League",
      archived_at: archived ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seedLeague failed: ${error.message}`);
  return (data as unknown as { id: string }).id;
}

async function seedBranding(client: ReturnType<typeof asClient>, ownerId: string): Promise<string> {
  const { data, error } = await client
    .from("branding_profiles")
    .insert({ owner_principal_id: ownerId, organization_name: "Volt Media" })
    .select("id")
    .single();
  if (error) throw new Error(`seedBranding failed: ${error.message}`);
  return (data as unknown as { id: string }).id;
}

type CreateArgs = {
  actorId?: string;
  quizId?: string;
  title?: string;
  mode?: "hosted" | "arena" | "scheduled";
  visibility?: CompetitionVisibility;
  scheduledStartAt?: string;
  lobbyDurationSeconds?: number;
  leagueId?: string | null;
  brandingProfileId?: string | null;
  maxParticipants?: number | null;
  idempotencyKey?: string;
};

async function makeCompetition(
  client: ReturnType<typeof asClient>,
  { quizId, ...rest }: CreateArgs = {},
) {
  const id = quizId ?? (await saveOwnedQuiz(client)).quizId;
  return createCompetition(client, {
    actorId: OWNER,
    quizId: id,
    title: "Friday Night Trivia",
    mode: "scheduled",
    visibility: "private",
    scheduledStartAt: futureIso(),
    ...rest,
  });
}

function competitionRowOf(db: FakeDb, competitionId: string) {
  return db.competitions.find((c) => c.id === competitionId)!;
}

function questionIdsOf(db: FakeDb, quizId: string): string[] {
  return db.questions
    .filter((q) => q.quiz_id === quizId)
    .sort((a, b) => (a.position as number) - (b.position as number))
    .map((q) => q.id as string);
}

/* ------------------------------------------------------------------ */
/* toErrorEnvelope / CompetitionError                                   */
/* ------------------------------------------------------------------ */

describe("toErrorEnvelope", () => {
  test("maps typed errors to structured failure envelopes", () => {
    expect(
      toErrorEnvelope("schedule_competition", new CompetitionError("unauthorized", "nope")),
    ).toEqual({
      ok: false,
      action: "schedule_competition",
      error: { code: "unauthorized", message: "nope" },
    });
  });

  test("unknown errors become a generic unknown envelope — never raw internals", () => {
    const envelope = toErrorEnvelope(
      "create_competition",
      new Error("SQLSTATE 42P01: relation does not exist"),
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("unknown");
    expect(envelope.error.message).not.toContain("SQLSTATE");
  });
});

/* ------------------------------------------------------------------ */
/* create_competition                                                   */
/* ------------------------------------------------------------------ */

describe("create_competition", () => {
  test("creates a draft owned by the acting principal with stored scheduling config", async () => {
    const { db, client } = makeEnv();
    const start = futureIso();
    const result = await makeCompetition(client, { title: "Big Night", scheduledStartAt: start });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("create_competition");
    expect(result.status).toBe("draft");
    expect(result.scheduledStartAt).toBe(start);
    expect(result.competitionId).toBeTruthy();

    const row = competitionRowOf(db, result.competitionId!);
    expect(row.owner_principal_id).toBe(OWNER);
    expect(row.status).toBe("draft");
    expect(row.scheduled_start_at).toBe(start);
    expect(row.lobby_duration_seconds).toBe(300);
    expect(row.mode).toBe("scheduled");
    expect(row.visibility).toBe("private");
  });

  test("rejects a quiz owned by another principal — nothing written", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OTHER_HOST });
    const error = await makeCompetition(client, { quizId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionError);
    expect((error as CompetitionError).code).toBe("unauthorized");
    expect((error as CompetitionError).message).toContain("not authorized to use quiz");
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects an archived quiz", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await client.from("quizzes").update({ archived_at: new Date().toISOString() }).eq("id", quizId);
    const error = await makeCompetition(client, { quizId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionError);
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("archived");
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects a missing quiz as not-found", async () => {
    const { db, client } = makeEnv();
    const error = await makeCompetition(client, { quizId: MISSING }).catch((e: unknown) => e);
    expect((error as CompetitionError).code).toBe("not-found");
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects an invented mode", async () => {
    const { db, client } = makeEnv();
    const error = await makeCompetition(client, { mode: "league_fixture" as never }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain(
      "mode must be one of hosted, arena, scheduled",
    );
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects an invalid visibility", async () => {
    const { db, client } = makeEnv();
    const error = await makeCompetition(client, { visibility: "public-ish" as never }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("validation");
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects a past scheduled start — never coerced", async () => {
    const { db, client } = makeEnv();
    const error = await makeCompetition(client, { scheduledStartAt: pastIso() }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("must be in the future");
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects out-of-range lobby duration and max participants", async () => {
    const { db, client } = makeEnv();
    const lobbyError = await makeCompetition(client, { lobbyDurationSeconds: 10 }).catch(
      (e: unknown) => e,
    );
    expect((lobbyError as CompetitionError).code).toBe("validation");
    const maxError = await makeCompetition(client, { maxParticipants: 0 }).catch((e: unknown) => e);
    expect((maxError as CompetitionError).code).toBe("validation");
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects a principal without the host capability", async () => {
    const { db, client } = makeEnv();
    const error = await makeCompetition(client, { actorId: NO_ROLE_USER }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionError);
    expect((error as CompetitionError).code).toBe("unauthorized");
    expect((error as CompetitionError).message).toContain("host capability");
    expect(db.competitions).toHaveLength(0);
  });

  test("an active host authorization grants the host capability without a role", async () => {
    const { db, client } = makeEnv();
    // A real user principal, but NO admin/host role — the host capability
    // comes solely from the active host authorization (third resolver source).
    seedUser(db, HOST_AUTH_USER);
    seedHostAuthorization(db, HOST_AUTH_USER);
    const { quizId } = await saveOwnedQuiz(client, QUIZ.questions, HOST_AUTH_USER);
    const result = await makeCompetition(client, {
      actorId: HOST_AUTH_USER,
      quizId,
      title: "Auth'd host's",
    });
    expect(result.ok).toBe(true);
    expect(competitionRowOf(db, result.competitionId).owner_principal_id).toBe(HOST_AUTH_USER);

    // And they can manage their own competition (competition.manage gate).
    const updated = await updateCompetition(client, {
      actorId: HOST_AUTH_USER,
      competitionId: result.competitionId,
      patch: { title: "Auth'd host's (updated)" },
    });
    expect(updated.ok).toBe(true);
  });

  test("rejects an actor without a principal", async () => {
    const { db, client } = makeEnv();
    const error = await makeCompetition(client, { actorId: GHOST }).catch((e: unknown) => e);
    expect((error as CompetitionError).code).toBe("unauthorized");
    expect(db.competitions).toHaveLength(0);
  });

  test("rejects another principal's league and branding — accepts own", async () => {
    const { db, client } = makeEnv();
    const theirLeague = await seedLeague(client, OTHER_HOST);
    const myLeague = await seedLeague(client, OWNER);
    const theirBranding = await seedBranding(client, OTHER_HOST);
    const myBranding = await seedBranding(client, OWNER);

    const leagueError = await makeCompetition(client, { leagueId: theirLeague }).catch(
      (e: unknown) => e,
    );
    expect((leagueError as CompetitionError).code).toBe("unauthorized");

    const brandingError = await makeCompetition(client, { brandingProfileId: theirBranding }).catch(
      (e: unknown) => e,
    );
    expect((brandingError as CompetitionError).code).toBe("unauthorized");

    const ok = await makeCompetition(client, { leagueId: myLeague, brandingProfileId: myBranding });
    expect(ok.ok).toBe(true);
    const row = competitionRowOf(db, ok.competitionId!);
    expect(row.league_id).toBe(myLeague);
    expect(row.branding_profile_id).toBe(myBranding);
  });

  test("rejects an archived league", async () => {
    const { client } = makeEnv();
    const archivedLeague = await seedLeague(client, OWNER, true);
    const error = await makeCompetition(client, { leagueId: archivedLeague }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("archived");
  });

  test("rejects a quiz whose questions are all is_playable=false — nothing written", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    for (const questionId of questionIdsOf(db, quizId)) {
      await client.from("questions").update({ is_playable: false }).eq("id", questionId);
    }
    const error = await makeCompetition(client, { quizId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionError);
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("no playable questions");
    expect(db.competitions).toHaveLength(0);
  });

  test("accepts a quiz with at least one is_playable=true question", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    // Only the first question stays playable; the rest are excluded.
    const [playableId, ...restIds] = questionIdsOf(db, quizId);
    for (const questionId of restIds) {
      await client.from("questions").update({ is_playable: false }).eq("id", questionId!);
    }
    const result = await makeCompetition(client, { quizId });
    expect(result.ok).toBe(true);
    expect(competitionRowOf(db, result.competitionId!).quiz_id).toBe(quizId);
    expect(db.questions.find((q) => q.id === playableId)!.is_playable).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* list_competitions                                                    */
/* ------------------------------------------------------------------ */

describe("list_competitions", () => {
  test("lists only the acting principal's competitions with quiz titles", async () => {
    const { client } = makeEnv();
    const { quizId: quizA } = await saveOwnedQuiz(client);
    const { quizId: quizB } = await saveOwnedQuiz(client);
    await makeCompetition(client, { quizId: quizA, title: "Mine A" });
    await makeCompetition(client, { quizId: quizB, title: "Mine B" });
    const { quizId: theirQuiz } = await saveQuizWithClient(client, QUIZ, { ownerId: OTHER_HOST });
    await makeCompetition(client, { actorId: OTHER_HOST, quizId: theirQuiz, title: "Theirs" });

    const mine = await listCompetitions(client, { actorId: OWNER });
    expect(mine.count).toBe(2);
    expect(mine.items.map((i) => i.title).sort()).toEqual(["Mine A", "Mine B"]);
    expect(mine.items.every((i) => i.quizTitle === "Solar System Smash")).toBe(true);

    const theirs = await listCompetitions(client, { actorId: OTHER_HOST });
    expect(theirs.items.map((i) => i.title)).toEqual(["Theirs"]);
  });

  test("filters by status, mode, visibility, quizId and leagueId", async () => {
    const { client } = makeEnv();
    const { quizId: quizA } = await saveOwnedQuiz(client);
    const { quizId: quizB } = await saveOwnedQuiz(client);
    const league = await seedLeague(client, OWNER);
    await makeCompetition(client, {
      quizId: quizA,
      title: "Draft One",
      visibility: "public",
      leagueId: league,
    });
    await makeCompetition(client, { quizId: quizB, title: "Draft Two" });
    await makeCompetition(client, { quizId: quizA, title: "Arena One", mode: "arena" });

    const byStatus = await listCompetitions(client, { actorId: OWNER, status: "draft" });
    expect(byStatus.count).toBe(3);
    const byMode = await listCompetitions(client, { actorId: OWNER, mode: "arena" });
    expect(byMode.items.map((i) => i.title)).toEqual(["Arena One"]);
    const byVisibility = await listCompetitions(client, { actorId: OWNER, visibility: "public" });
    expect(byVisibility.items.map((i) => i.title)).toEqual(["Draft One"]);
    const byQuiz = await listCompetitions(client, { actorId: OWNER, quizId: quizA });
    expect(byQuiz.count).toBe(2);
    const byLeague = await listCompetitions(client, { actorId: OWNER, leagueId: league });
    expect(byLeague.items.map((i) => i.title)).toEqual(["Draft One"]);
  });

  test("filters by scheduled date range (gte/lte)", async () => {
    const { client } = makeEnv();
    await makeCompetition(client, { title: "Early", scheduledStartAt: futureIso(24) });
    await makeCompetition(client, { title: "Late", scheduledStartAt: futureIso(72) });

    const mid = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const early = await listCompetitions(client, { actorId: OWNER, scheduledTo: mid });
    expect(early.items.map((i) => i.title)).toEqual(["Early"]);
    const late = await listCompetitions(client, { actorId: OWNER, scheduledFrom: mid });
    expect(late.items.map((i) => i.title)).toEqual(["Late"]);
    const both = await listCompetitions(client, {
      actorId: OWNER,
      scheduledFrom: futureIso(12),
      scheduledTo: futureIso(96),
    });
    expect(both.count).toBe(2);
  });

  test("respects limit", async () => {
    const { client } = makeEnv();
    await makeCompetition(client, { title: "A" });
    await makeCompetition(client, { title: "B" });
    await makeCompetition(client, { title: "C" });
    const result = await listCompetitions(client, { actorId: OWNER, limit: 2 });
    expect(result.items).toHaveLength(2);
  });

  test("rejects an actor without a principal", async () => {
    const { client } = makeEnv();
    const error = await listCompetitions(client, { actorId: GHOST }).catch((e: unknown) => e);
    expect((error as CompetitionError).code).toBe("unauthorized");
  });
});

/* ------------------------------------------------------------------ */
/* get_competition                                                      */
/* ------------------------------------------------------------------ */

describe("get_competition", () => {
  test("owner reads the full business state — no session reads", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client, {
      title: "Readable",
      maxParticipants: 40,
    });
    const { competition } = await getCompetition(client, { actorId: OWNER, competitionId });
    expect(competition.id).toBe(competitionId);
    expect(competition.title).toBe("Readable");
    expect(competition.quizTitle).toBe("Solar System Smash");
    expect(competition.status).toBe("draft");
    expect(competition.mode).toBe("scheduled");
    expect(competition.visibility).toBe("private");
    expect(competition.maxParticipants).toBe(40);
    expect(competition.sessionId).toBeNull();
    expect(competition.metadata).toEqual({});
  });

  test("non-owner is denied even with host capability", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const error = await getCompetition(client, { actorId: OTHER_HOST, competitionId }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("unauthorized");
  });

  test("missing competition reports not-found, not a generic denial", async () => {
    const { client } = makeEnv();
    const error = await getCompetition(client, { actorId: OWNER, competitionId: MISSING }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("not-found");
    expect((error as CompetitionError).message).toContain("does not exist");
  });
});

/* ------------------------------------------------------------------ */
/* update_competition                                                   */
/* ------------------------------------------------------------------ */

describe("update_competition", () => {
  test("patches only the supplied fields", async () => {
    const { db, client } = makeEnv();
    const { competitionId } = await makeCompetition(client, {
      title: "Before",
      maxParticipants: 10,
    });
    const result = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { title: "After" },
    });
    expect(result.changed).toEqual({ title: true });
    const row = competitionRowOf(db, competitionId);
    expect(row.title).toBe("After");
    expect(row.max_participants).toBe(10);
    expect(row.scheduled_start_at).toBeTruthy();
    expect(row.visibility).toBe("private");
  });

  test("visibility change is an explicit patch", async () => {
    const { db, client } = makeEnv();
    const { competitionId } = await makeCompetition(client, { visibility: "private" });
    await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { visibility: "public" },
    });
    expect(competitionRowOf(db, competitionId).visibility).toBe("public");
  });

  test("null detaches league and clears description/maxParticipants", async () => {
    const { db, client } = makeEnv();
    const league = await seedLeague(client, OWNER);
    const { competitionId } = await makeCompetition(client, {
      leagueId: league,
      maxParticipants: 25,
    });
    const result = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { leagueId: null, maxParticipants: null },
    });
    expect(result.changed).toEqual({ leagueId: true, maxParticipants: true });
    const row = competitionRowOf(db, competitionId);
    expect(row.league_id).toBeNull();
    expect(row.max_participants).toBeNull();
  });

  test("admin who owns the competition retains full update capability", async () => {
    const { db, client } = makeEnv();
    seedUser(db, ADMIN, ["admin"]);
    const { quizId } = await saveOwnedQuiz(client, QUIZ.questions, ADMIN);
    const { competitionId } = await makeCompetition(client, {
      actorId: ADMIN,
      quizId,
      title: "Admin's",
    });
    const result = await updateCompetition(client, {
      actorId: ADMIN,
      competitionId,
      patch: { title: "Admin's (renamed)" },
    });
    expect(result.ok).toBe(true);
    expect(competitionRowOf(db, competitionId).title).toBe("Admin's (renamed)");
  });

  test("non-owner is denied", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const error = await updateCompetition(client, {
      actorId: OTHER_HOST,
      competitionId,
      patch: { title: "Hijack" },
    }).catch((e: unknown) => e);
    expect((error as CompetitionError).code).toBe("unauthorized");
  });

  test("protected lifecycle states reject updates", async () => {
    const { client } = makeEnv();
    for (const status of ["lobby_open", "running", "completed", "cancelled"] as const) {
      const { competitionId } = await makeCompetition(client, { title: `State ${status}` });
      await client.from("competitions").update({ status }).eq("id", competitionId);
      const error = await updateCompetition(client, {
        actorId: OWNER,
        competitionId,
        patch: { title: "nope" },
      }).catch((e: unknown) => e);
      expect((error as CompetitionError).code).toBe("conflict");
      expect((error as CompetitionError).message).toContain(status);
    }
  });

  test("draft and scheduled states both accept updates", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    await scheduleCompetition(client, { actorId: OWNER, competitionId });
    const result = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { description: "updated while scheduled" },
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual({ description: true });
  });

  test("backdated scheduledStartAt is rejected even while scheduled", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const error = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { scheduledStartAt: pastIso() },
    }).catch((e: unknown) => e);
    expect((error as CompetitionError).code).toBe("validation");
  });

  test("rejects an empty patch and a detach of another's league", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const empty = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: {},
    }).catch((e: unknown) => e);
    expect((empty as CompetitionError).code).toBe("validation");
    const theirLeague = await seedLeague(client, OTHER_HOST);
    const bad = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { leagueId: theirLeague },
    }).catch((e: unknown) => e);
    expect((bad as CompetitionError).code).toBe("unauthorized");
  });
});

/* ------------------------------------------------------------------ */
/* schedule_competition                                                 */
/* ------------------------------------------------------------------ */

describe("schedule_competition", () => {
  test("activates a draft for the autonomous scheduler", async () => {
    const { db, client } = makeEnv();
    const start = futureIso(3);
    const { competitionId } = await makeCompetition(client, { scheduledStartAt: start });
    const result = await scheduleCompetition(client, { actorId: OWNER, competitionId });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("schedule_competition");
    expect(result.status).toBe("scheduled");
    expect(result.scheduledStartAt).toBe(start);
    const row = competitionRowOf(db, competitionId);
    expect(row.status).toBe("scheduled");
    expect(row.scheduled_start_at).toBe(start);
  });

  test("reschedules a scheduled competition with a new future time", async () => {
    const { db, client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    await scheduleCompetition(client, { actorId: OWNER, competitionId });
    const later = futureIso(48);
    const result = await scheduleCompetition(client, {
      actorId: OWNER,
      competitionId,
      scheduledStartAt: later,
    });
    expect(result.scheduledStartAt).toBe(later);
    expect(competitionRowOf(db, competitionId).scheduled_start_at).toBe(later);
  });

  test("rejects a past time — no silent coercion", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const error = await scheduleCompetition(client, {
      actorId: OWNER,
      competitionId,
      scheduledStartAt: pastIso(),
    }).catch((e: unknown) => e);
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("must be in the future");
  });

  test("rejects hosted and arena modes — the scheduler runs mode 'scheduled' only", async () => {
    const { client } = makeEnv();
    for (const mode of ["hosted", "arena"] as const) {
      const { competitionId } = await makeCompetition(client, { mode });
      const error = await scheduleCompetition(client, { actorId: OWNER, competitionId }).catch(
        (e: unknown) => e,
      );
      expect((error as CompetitionError).code).toBe("validation");
      expect((error as CompetitionError).message).toContain("mode");
    }
  });

  test("rejects cancelled and completed competitions", async () => {
    const { client } = makeEnv();
    const cancelled = await makeCompetition(client);
    await cancelCompetition(client, { actorId: OWNER, competitionId: cancelled.competitionId! });
    const cancelError = await scheduleCompetition(client, {
      actorId: OWNER,
      competitionId: cancelled.competitionId!,
    }).catch((e: unknown) => e);
    expect((cancelError as CompetitionError).code).toBe("conflict");

    const completed = await makeCompetition(client);
    await client
      .from("competitions")
      .update({ status: "completed" })
      .eq("id", completed.competitionId!);
    const completeError = await scheduleCompetition(client, {
      actorId: OWNER,
      competitionId: completed.competitionId!,
    }).catch((e: unknown) => e);
    expect((completeError as CompetitionError).code).toBe("conflict");
  });

  test("rejects a missing stored start with a precise error", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    await client.from("competitions").update({ scheduled_start_at: null }).eq("id", competitionId);
    const error = await scheduleCompetition(client, { actorId: OWNER, competitionId }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("pass scheduledStartAt");
  });

  test("rejects a stored start that has passed", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    await client
      .from("competitions")
      .update({ scheduled_start_at: pastIso() })
      .eq("id", competitionId);
    const error = await scheduleCompetition(client, { actorId: OWNER, competitionId }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("in the past");
  });

  test("rejects scheduling when the quiz was archived after create", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const { competitionId } = await makeCompetition(client, { quizId });
    await client.from("quizzes").update({ archived_at: new Date().toISOString() }).eq("id", quizId);
    const error = await scheduleCompetition(client, { actorId: OWNER, competitionId }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("validation");
    expect((error as CompetitionError).message).toContain("archived");
  });
});

/* ------------------------------------------------------------------ */
/* cancel_competition                                                   */
/* ------------------------------------------------------------------ */

describe("cancel_competition", () => {
  test("cancels with the app's exact semantics (status + cancelled_at)", async () => {
    const { db, client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const result = await cancelCompetition(client, { actorId: OWNER, competitionId });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.changed).toEqual({ cancelled: true, cancelledAt: expect.any(String) });
    const row = competitionRowOf(db, competitionId);
    expect(row.status).toBe("cancelled");
    expect(row.cancelled_at).toBeTruthy();
  });

  test("cancels lobby_open and running competitions without touching sessions", async () => {
    const { db, client } = makeEnv();
    for (const status of ["lobby_open", "running"] as const) {
      const { competitionId } = await makeCompetition(client);
      // A linked session exists in the real schema; the fake has NO sessions
      // table, so any session access by the code would fail this test.
      await client
        .from("competitions")
        .update({ status, session_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" })
        .eq("id", competitionId);
      const result = await cancelCompetition(client, { actorId: OWNER, competitionId });
      expect(result.ok).toBe(true);
      expect(competitionRowOf(db, competitionId).status).toBe("cancelled");
    }
  });

  test("completed competitions are protected from cancellation", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    await client.from("competitions").update({ status: "completed" }).eq("id", competitionId);
    const error = await cancelCompetition(client, { actorId: OWNER, competitionId }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("conflict");
    expect((error as CompetitionError).message).toContain("completed");
  });

  test("cancelling an already-cancelled competition is a no-op with a warning", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    await cancelCompetition(client, { actorId: OWNER, competitionId });
    const again = await cancelCompetition(client, { actorId: OWNER, competitionId });
    expect(again.ok).toBe(true);
    expect(again.changed).toEqual({ cancelled: false });
    expect(again.warnings[0]).toContain("already cancelled");
  });

  test("non-owner cannot cancel", async () => {
    const { client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const error = await cancelCompetition(client, { actorId: OTHER_HOST, competitionId }).catch(
      (e: unknown) => e,
    );
    expect((error as CompetitionError).code).toBe("unauthorized");
  });
});

/* ------------------------------------------------------------------ */
/* idempotency                                                          */
/* ------------------------------------------------------------------ */

describe("competition idempotency", () => {
  test("a repeated create replays the same competitionId — one row only", async () => {
    const { db, client } = makeEnv();
    // Fixed quiz + fixed start so both calls hash identically (idempotency
    // scopes the full payload — a fresh quiz or timestamp would be a
    // different request).
    const { quizId } = await saveOwnedQuiz(client);
    const start = futureIso();
    const first = await makeCompetition(client, {
      idempotencyKey: "comp-create-1",
      quizId,
      scheduledStartAt: start,
    });
    const second = await makeCompetition(client, {
      idempotencyKey: "comp-create-1",
      quizId,
      scheduledStartAt: start,
    });
    expect(second.competitionId).toBe(first.competitionId);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    expect(db.competitions).toHaveLength(1);
  });

  test("a repeated update applies once and replays the stored envelope", async () => {
    const { db, client } = makeEnv();
    const { competitionId } = await makeCompetition(client);
    const first = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { title: "Renamed" },
      idempotencyKey: "comp-upd-1",
    });
    const second = await updateCompetition(client, {
      actorId: OWNER,
      competitionId,
      patch: { title: "Renamed" },
      idempotencyKey: "comp-upd-1",
    });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.changed).toEqual({ title: true });
    expect(competitionRowOf(db, competitionId).title).toBe("Renamed");
  });

  test("a repeated schedule and cancel replay without repeated side effects", async () => {
    const { db, client } = makeEnv();
    const { competitionId } = await makeCompetition(client);

    const s1 = await scheduleCompetition(client, {
      actorId: OWNER,
      competitionId,
      idempotencyKey: "comp-sched-1",
    });
    const s2 = await scheduleCompetition(client, {
      actorId: OWNER,
      competitionId,
      idempotencyKey: "comp-sched-1",
    });
    expect(s2.replayed).toBe(true);
    expect(s2.status).toBe("scheduled");

    const c1 = await cancelCompetition(client, {
      actorId: OWNER,
      competitionId,
      idempotencyKey: "comp-cancel-1",
    });
    const c2 = await cancelCompetition(client, {
      actorId: OWNER,
      competitionId,
      idempotencyKey: "comp-cancel-1",
    });
    expect(c2.replayed).toBe(true);
    expect(competitionRowOf(db, competitionId).status).toBe("cancelled");
    expect(competitionRowOf(db, competitionId).cancelled_at).toBeTruthy();
  });

  test("reusing a key with a different payload is rejected", async () => {
    const { db, client } = makeEnv();
    await makeCompetition(client, { idempotencyKey: "comp-create-2" });
    const error = await makeCompetition(client, {
      idempotencyKey: "comp-create-2",
      title: "Different",
    }).catch((e: unknown) => e);
    expect((error as CompetitionError).message).toContain("already used for a different request");
    expect(db.competitions).toHaveLength(1);
  });

  test("a failed create frees the key so a retry can succeed", async () => {
    const { client } = makeEnv();
    const bad = await makeCompetition(client, {
      idempotencyKey: "comp-create-3",
      scheduledStartAt: pastIso(),
    }).catch((e: unknown) => e);
    expect((bad as CompetitionError).code).toBe("validation");
    const retry = await makeCompetition(client, { idempotencyKey: "comp-create-3" });
    expect(retry.replayed).toBe(false);
    expect(retry.ok).toBe(true);
  });
});
