// Phase 8D league tests: reads (list/get/standings/competitions), permanent
// results, player history and attach/detach mutations, exercised against the
// in-memory fake Supabase client. The fake's rpc() ports mcp_league_standings
// and mcp_league_overview with the exact SQL semantics (points mapping,
// tie-break chain, overview counts) so the standings contract tests are
// meaningful.

import { describe, expect, test } from "bun:test";
import { CompetitionError } from "../src/competition";
import {
  attachCompetitionToLeague,
  detachCompetitionFromLeague,
  getCompetitionResults,
  getLeague as getLeagueFn,
  getLeagueStandings,
  getPlayerLeagueHistory,
  listLeagueCompetitions,
  listLeagues,
} from "../src/league";
import { saveQuizWithClient } from "../src/supabase";
import type { BrainBoltQuiz } from "../src/schema";
import {
  asClient,
  createFakeDb,
  FakeSupabase,
  seedProfile,
  seedUser,
  type FakeDb,
} from "./fake-supabase";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_HOST = "22222222-2222-2222-2222-222222222222";
const NO_ROLE_USER = "33333333-3333-3333-3333-333333333333";
const ADMIN = "55555555-5555-5555-5555-555555555555";
const MISSING = "99999999-9999-9999-9999-999999999999";

const PLAYER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const PLAYER_B = "aaaaaaaa-0000-0000-0000-000000000002";
const PLAYER_C = "aaaaaaaa-0000-0000-0000-000000000003";

const QUIZ: BrainBoltQuiz = {
  title: "Solar System Smash",
  description: "Planets",
  timePerQuestionSec: 20,
  difficulty: "medium",
  questions: [
    { type: "mcq", text: "Which planet is the Red Planet?", options: ["Venus", "Mars"], correctIndex: 1 },
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
  seedUser(db, ADMIN, ["admin"]);
  // Players double as auth users (profiles are id-identical) — they need
  // principals to act as actorId in the self-history tests.
  seedUser(db, PLAYER_A);
  seedUser(db, PLAYER_B);
  seedProfile(db, PLAYER_A, "Alice");
  seedProfile(db, PLAYER_B, "Bob");
  seedProfile(db, PLAYER_C, "Cara");
  const client = asClient(new FakeSupabase(db));
  return { db, client };
}

async function saveOwnedQuiz(client: ReturnType<typeof asClient>, ownerId = OWNER) {
  return saveQuizWithClient(client, QUIZ, { ownerId });
}

async function seedLeague(
  client: ReturnType<typeof asClient>,
  options: {
    ownerId?: string;
    name?: string;
    visibility?: string;
    status?: string;
    archived?: boolean;
    points?: { first: number; second: number; third: number; participation: number };
  } = {},
): Promise<string> {
  const { data, error } = await client
    .from("leagues")
    .insert({
      owner_principal_id: options.ownerId ?? OWNER,
      name: options.name ?? "Season League",
      visibility: options.visibility ?? "private",
      status: options.status ?? "active",
      archived_at: options.archived ? new Date().toISOString() : null,
      points_first: options.points?.first,
      points_second: options.points?.second,
      points_third: options.points?.third,
      points_participation: options.points?.participation,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seedLeague failed: ${error.message}`);
  return (data as unknown as { id: string }).id;
}

async function seedCompetition(
  client: ReturnType<typeof asClient>,
  options: {
    id?: string;
    ownerId?: string;
    quizId: string;
    leagueId?: string | null;
    status?: string;
    sessionId?: string | null;
    scheduledStartAt?: string | null;
    visibility?: string;
    title?: string;
  },
): Promise<string> {
  const { data, error } = await client
    .from("competitions")
    .insert({
      id: options.id,
      owner_principal_id: options.ownerId ?? OWNER,
      quiz_id: options.quizId,
      league_id: options.leagueId ?? null,
      status: options.status ?? "draft",
      session_id: options.sessionId ?? null,
      scheduled_start_at: options.scheduledStartAt ?? futureIso(),
      visibility: options.visibility ?? "private",
      title: options.title ?? "League Match",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seedCompetition failed: ${error.message}`);
  return (data as unknown as { id: string }).id;
}

async function seedResult(
  client: ReturnType<typeof asClient>,
  options: {
    profileId: string;
    sessionId: string;
    quizId: string;
    finalRank: number;
    finalScore: number;
    accuracy?: number;
    totalParticipants?: number;
  },
): Promise<void> {
  const { error } = await client.from("competition_results").insert({
    profile_id: options.profileId,
    session_id: options.sessionId,
    quiz_id: options.quizId,
    final_rank: options.finalRank,
    final_score: options.finalScore,
    accuracy_percentage: options.accuracy ?? 0,
    total_participants: options.totalParticipants ?? 3,
  });
  if (error) throw new Error(`seedResult failed: ${error.message}`);
}

function competitionRowOf(db: FakeDb, competitionId: string) {
  return db.competitions.find((c) => c.id === competitionId)!;
}

/* ------------------------------------------------------------------ */
/* list_leagues                                                         */
/* ------------------------------------------------------------------ */

describe("list_leagues", () => {
  test("returns owned leagues plus public leagues for any principal", async () => {
    const { client } = makeEnv();
    const mine = await seedLeague(client, { ownerId: OWNER, name: "My Private" });
    await seedLeague(client, { ownerId: OTHER_HOST, name: "Their Private" });
    const publicLeague = await seedLeague(client, { ownerId: OTHER_HOST, name: "Public One", visibility: "public" });

    const { items } = await listLeagues(client, { actorId: OWNER });
    const ids = items.map((l) => l.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(publicLeague);
    expect(ids).not.toContain(await seedLeague(client, { ownerId: OTHER_HOST, name: "Hidden" }));

    const summary = items.find((l) => l.id === mine)!;
    expect(summary).toMatchObject({
      name: "My Private",
      status: "active",
      visibility: "private",
      ownerPrincipalId: OWNER,
      archivedAt: null,
    });
    expect(summary.competitionCount).toBe(0);
  });

  test("ownerOnly restricts the result to owned leagues", async () => {
    const { client } = makeEnv();
    const mine = await seedLeague(client, { ownerId: OWNER, name: "Mine" });
    await seedLeague(client, { ownerId: OTHER_HOST, name: "Public One", visibility: "public" });

    const { items } = await listLeagues(client, { actorId: OWNER, ownerOnly: true });
    expect(items.map((l) => l.id)).toEqual([mine]);
  });

  test("filters: search, archived, visibility, status", async () => {
    const { client } = makeEnv();
    await seedLeague(client, { ownerId: OWNER, name: "Summer Slam" });
    await seedLeague(client, { ownerId: OWNER, name: "Winter League" });
    const archived = await seedLeague(client, { ownerId: OWNER, name: "Old Season", archived: true });
    await seedLeague(client, { ownerId: OWNER, name: "Draft Season", status: "draft" });
    const pub = await seedLeague(client, { ownerId: OWNER, name: "Public League", visibility: "public" });

    expect((await listLeagues(client, { actorId: OWNER, search: "Slam" })).count).toBe(1);
    expect((await listLeagues(client, { actorId: OWNER, archived: true })).items.map((l) => l.id)).toEqual([archived]);
    expect((await listLeagues(client, { actorId: OWNER, archived: false })).count).toBe(4);
    expect((await listLeagues(client, { actorId: OWNER, visibility: "public" })).items.map((l) => l.id)).toEqual([pub]);
    expect((await listLeagues(client, { actorId: OWNER, status: "draft" })).count).toBe(1);
    expect((await listLeagues(client, { actorId: OWNER, limit: 2 })).items.length).toBe(2);
  });

  test("counts attached competitions cheaply", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId });

    const { items } = await listLeagues(client, { actorId: OWNER });
    expect(items.find((l) => l.id === leagueId)!.competitionCount).toBe(2);
  });

  test("anonymous (no actor) is unauthorized", async () => {
    const { client } = makeEnv();
    await expect(listLeagues(client, { actorId: "" })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

/* ------------------------------------------------------------------ */
/* get_league                                                            */
/* ------------------------------------------------------------------ */

describe("get_league", () => {
  test("owner reads a private league with scoring, overview and upcoming competitions", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, {
      ownerId: OWNER,
      points: { first: 25, second: 15, third: 10, participation: 2 },
    });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "scheduled", scheduledStartAt: futureIso(3) });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "cancelled", scheduledStartAt: futureIso(5) });

    const { league } = await getLeagueFn(client, { actorId: OWNER, leagueId });
    expect(league).toMatchObject({
      id: leagueId,
      name: "Season League",
      status: "active",
      visibility: "private",
      ownerPrincipalId: OWNER,
      scoring: { pointsFirst: 25, pointsSecond: 15, pointsThird: 10, pointsParticipation: 2 },
      overview: { participantCount: 0, competitionsTotal: 1, competitionsCompleted: 0, competitionsUpcoming: 1 },
    });
    expect(league.upcomingCompetitions).toHaveLength(1);
    const upcoming = league.upcomingCompetitions[0]!;
    expect(upcoming).toMatchObject({ status: "scheduled" });
    expect(Object.keys(upcoming)).not.toContain("sessionId");
    expect(Object.keys(upcoming)).not.toContain("session_id");
  });

  test("non-owner can read a public league", async () => {
    const { client } = makeEnv();
    const leagueId = await seedLeague(client, { ownerId: OTHER_HOST, visibility: "public" });
    const { league } = await getLeagueFn(client, { actorId: NO_ROLE_USER, leagueId });
    expect(league.visibility).toBe("public");
  });

  test("non-owner of a private league is unauthorized — even an admin", async () => {
    const { client } = makeEnv();
    const leagueId = await seedLeague(client, { ownerId: OTHER_HOST });
    await expect(getLeagueFn(client, { actorId: OWNER, leagueId })).rejects.toMatchObject({
      code: "unauthorized",
    });
    // Deliberate divergence: the app's can_view_league has an is_admin()
    // view-all branch; the MCP wrapper does not.
    await expect(getLeagueFn(client, { actorId: ADMIN, leagueId })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  test("missing league is not-found", async () => {
    const { client } = makeEnv();
    await expect(getLeagueFn(client, { actorId: OWNER, leagueId: MISSING })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  test("invalid league uuid is validation", async () => {
    const { client } = makeEnv();
    await expect(getLeagueFn(client, { actorId: OWNER, leagueId: "not-a-uuid" })).rejects.toMatchObject({
      code: "validation",
    });
  });
});

/* ------------------------------------------------------------------ */
/* get_league_standings                                                 */
/* ------------------------------------------------------------------ */

async function seedStandingsFixture(client: ReturnType<typeof asClient>) {
  const quizId = (await saveOwnedQuiz(client)).quizId;
  const leagueId = await seedLeague(client, {
    ownerId: OWNER,
    points: { first: 10, second: 7, third: 5, participation: 1 },
  });
  const s1 = "11111111-0000-0000-0000-000000000001";
  const s2 = "11111111-0000-0000-0000-000000000002";
  await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s1 });
  await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s2 });
  // C1: A rank1 (1000, 90%) · B rank2 (800, 80%) · C rank3 (700, 70%)
  await seedResult(client, { profileId: PLAYER_A, sessionId: s1, quizId, finalRank: 1, finalScore: 1000, accuracy: 90 });
  await seedResult(client, { profileId: PLAYER_B, sessionId: s1, quizId, finalRank: 2, finalScore: 800, accuracy: 80 });
  await seedResult(client, { profileId: PLAYER_C, sessionId: s1, quizId, finalRank: 3, finalScore: 700, accuracy: 70 });
  // C2: B rank1 (1200, 85%) · A rank2 (900, 75%)
  await seedResult(client, { profileId: PLAYER_B, sessionId: s2, quizId, finalRank: 1, finalScore: 1200, accuracy: 85 });
  await seedResult(client, { profileId: PLAYER_A, sessionId: s2, quizId, finalRank: 2, finalScore: 900, accuracy: 75 });
  return { leagueId };
}

describe("get_league_standings", () => {
  test("returns the exact app computation: points, counts and tie-break order", async () => {
    const { client } = makeEnv();
    const { leagueId } = await seedStandingsFixture(client);

    const { standings, count } = await getLeagueStandings(client, { actorId: OWNER, leagueId });
    expect(count).toBe(3);
    // Hand-computed from the SQL: pts = 10/7/5/1 mapping; tie-break
    // pts → wins → podiums → total_score → avg_accuracy → display_name.
    expect(standings).toEqual([
      {
        standingPosition: 1,
        profileId: PLAYER_B,
        displayName: "Bob",
        avatarId: null,
        leaguePoints: 17, // 7 + 10
        competitionsPlayed: 2,
        wins: 1,
        podiums: 2,
        totalScore: 2000,
        avgAccuracy: 82.5,
      },
      {
        standingPosition: 2,
        profileId: PLAYER_A,
        displayName: "Alice",
        avatarId: null,
        leaguePoints: 17, // 10 + 7
        competitionsPlayed: 2,
        wins: 1,
        podiums: 2,
        totalScore: 1900, // loses the tie-break on total_score
        avgAccuracy: 82.5,
      },
      {
        standingPosition: 3,
        profileId: PLAYER_C,
        displayName: "Cara",
        avatarId: null,
        leaguePoints: 5,
        competitionsPlayed: 1,
        wins: 0,
        podiums: 1,
        totalScore: 700,
        avgAccuracy: 70,
      },
    ]);
  });

  test("average accuracy breaks ties after total_score", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const s1 = "11111111-0000-0000-0000-000000000011";
    const s2 = "11111111-0000-0000-0000-000000000012";
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s1 });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s2 });
    // A and B swap ranks with identical scores → equal pts/wins/podiums/total.
    await seedResult(client, { profileId: PLAYER_A, sessionId: s1, quizId, finalRank: 1, finalScore: 1000, accuracy: 90 });
    await seedResult(client, { profileId: PLAYER_B, sessionId: s1, quizId, finalRank: 2, finalScore: 800, accuracy: 80 });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s2, quizId, finalRank: 2, finalScore: 800, accuracy: 75 });
    await seedResult(client, { profileId: PLAYER_B, sessionId: s2, quizId, finalRank: 1, finalScore: 1000, accuracy: 80 });
    // A avg 82.5 > B avg 80 → A first.

    const { standings } = await getLeagueStandings(client, { actorId: OWNER, leagueId });
    expect(standings.map((s) => s.profileId)).toEqual([PLAYER_A, PLAYER_B]);
  });

  test("display_name is the final tie-break", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const s1 = "11111111-0000-0000-0000-000000000021";
    const s2 = "11111111-0000-0000-0000-000000000022";
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s1 });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s2 });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s1, quizId, finalRank: 1, finalScore: 1000, accuracy: 85 });
    await seedResult(client, { profileId: PLAYER_B, sessionId: s1, quizId, finalRank: 2, finalScore: 800, accuracy: 85 });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s2, quizId, finalRank: 2, finalScore: 800, accuracy: 85 });
    await seedResult(client, { profileId: PLAYER_B, sessionId: s2, quizId, finalRank: 1, finalScore: 1000, accuracy: 85 });
    // Everything equal → COALESCE(display_name,'') ASC → "Alice" < "Bob".

    const { standings } = await getLeagueStandings(client, { actorId: OWNER, leagueId });
    expect(standings.map((s) => s.profileId)).toEqual([PLAYER_A, PLAYER_B]);
  });

  test("empty standings for a league without completed results", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "scheduled" });

    const { standings, count } = await getLeagueStandings(client, { actorId: OWNER, leagueId });
    expect(count).toBe(0);
    expect(standings).toEqual([]);
  });

  test("results of non-completed competitions never count", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const running = "11111111-0000-0000-0000-000000000031";
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "running", sessionId: running });
    await seedResult(client, { profileId: PLAYER_A, sessionId: running, quizId, finalRank: 1, finalScore: 900, accuracy: 90 });

    const { count } = await getLeagueStandings(client, { actorId: OWNER, leagueId });
    expect(count).toBe(0);
  });

  test("rpc output has the authoritative column shape", async () => {
    const { client } = makeEnv();
    const { leagueId } = await seedStandingsFixture(client);
    const { data } = await client.rpc("mcp_league_standings", {
      p_principal: OWNER,
      p_league_id: leagueId,
    });
    const rows = data as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "avatar_id",
      "avg_accuracy",
      "competitions_played",
      "display_name",
      "league_points",
      "podiums",
      "profile_id",
      "standing_position",
      "total_score",
      "wins",
    ]);
  });

  test("private-league standings are gated per principal", async () => {
    const { client } = makeEnv();
    const { leagueId } = await seedStandingsFixture(client);
    await expect(getLeagueStandings(client, { actorId: OTHER_HOST, leagueId })).rejects.toMatchObject({
      code: "unauthorized",
    });
    // Public league readable by a non-owner.
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const pubLeague = await seedLeague(client, { ownerId: OWNER, visibility: "public" });
    const ps = "11111111-0000-0000-0000-000000000041";
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId: pubLeague, status: "completed", sessionId: ps });
    await seedResult(client, { profileId: PLAYER_A, sessionId: ps, quizId, finalRank: 1, finalScore: 500, accuracy: 80 });
    const { standings } = await getLeagueStandings(client, { actorId: OTHER_HOST, leagueId: pubLeague });
    expect(standings).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* list_league_competitions                                             */
/* ------------------------------------------------------------------ */

describe("list_league_competitions", () => {
  test("owner sees every attached competition with result availability", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const s1 = "11111111-0000-0000-0000-000000000051";
    const done = await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s1 });
    const draft = await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "draft", scheduledStartAt: null });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s1, quizId, finalRank: 1, finalScore: 500, accuracy: 80 });

    const { items, count } = await listLeagueCompetitions(client, { actorId: OWNER, leagueId });
    expect(count).toBe(2);
    expect(items.find((c) => c.id === done)).toMatchObject({ status: "completed", hasResults: true });
    expect(items.find((c) => c.id === draft)).toMatchObject({ status: "draft", hasResults: false });
    for (const item of items) {
      expect(Object.keys(item)).not.toContain("sessionId");
      expect(Object.keys(item)).not.toContain("session_id");
    }
  });

  test("non-owner of a public league sees only public competitions in app-visible statuses", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER, visibility: "public" });
    const publicScheduled = await seedCompetition(client, {
      ownerId: OWNER, quizId, leagueId, status: "scheduled", visibility: "public",
    });
    await seedCompetition(client, {
      ownerId: OWNER, quizId, leagueId, status: "scheduled", visibility: "private",
    });
    await seedCompetition(client, {
      ownerId: OWNER, quizId, leagueId, status: "draft", visibility: "public",
    });

    const { items } = await listLeagueCompetitions(client, { actorId: NO_ROLE_USER, leagueId });
    expect(items.map((c) => c.id)).toEqual([publicScheduled]);
  });

  test("non-owner of a private league is unauthorized", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    await seedCompetition(client, { ownerId: OWNER, quizId, leagueId });
    await expect(listLeagueCompetitions(client, { actorId: OTHER_HOST, leagueId })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

/* ------------------------------------------------------------------ */
/* get_competition_results                                              */
/* ------------------------------------------------------------------ */

describe("get_competition_results", () => {
  test("returns permanent results in final-rank order with player identity", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const s1 = "11111111-0000-0000-0000-000000000061";
    const compId = await seedCompetition(client, {
      ownerId: OWNER, quizId, status: "completed", sessionId: s1, title: "Grand Final",
    });
    await seedResult(client, { profileId: PLAYER_B, sessionId: s1, quizId, finalRank: 1, finalScore: 1200, accuracy: 88, totalParticipants: 3 });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s1, quizId, finalRank: 2, finalScore: 900, accuracy: 75, totalParticipants: 3 });

    const r = await getCompetitionResults(client, { actorId: OWNER, competitionId: compId });
    expect(r.competitionTitle).toBe("Grand Final");
    expect(r.count).toBe(2);
    expect(r.items.map((i) => i.profileId)).toEqual([PLAYER_B, PLAYER_A]);
    expect(r.items[0]).toMatchObject({
      displayName: "Bob",
      finalRank: 1,
      finalScore: 1200,
      totalParticipants: 3,
      accuracyPercentage: 88,
    });
    // Never answer data — the projection is strictly result fields.
    for (const item of r.items) {
      expect(Object.keys(item).sort()).toEqual([
        "accuracyPercentage",
        "avatarId",
        "completedAt",
        "displayName",
        "finalRank",
        "finalScore",
        "profileId",
        "totalParticipants",
      ]);
    }
  });

  test("refuses non-completed competitions", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const compId = await seedCompetition(client, { ownerId: OWNER, quizId, status: "scheduled" });
    await expect(getCompetitionResults(client, { actorId: OWNER, competitionId: compId })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  test("non-owner cannot read another owner's results", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const s1 = "11111111-0000-0000-0000-000000000062";
    const compId = await seedCompetition(client, { ownerId: OWNER, quizId, status: "completed", sessionId: s1 });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s1, quizId, finalRank: 1, finalScore: 500, accuracy: 80 });
    await expect(getCompetitionResults(client, { actorId: OTHER_HOST, competitionId: compId })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  test("completed competition without a session has no results (empty + warning)", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const compId = await seedCompetition(client, { ownerId: OWNER, quizId, status: "completed", sessionId: null });
    const r = await getCompetitionResults(client, { actorId: OWNER, competitionId: compId });
    expect(r.count).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* get_player_league_history                                            */
/* ------------------------------------------------------------------ */

describe("get_player_league_history", () => {
  async function seedHistoryFixture(client: ReturnType<typeof asClient>) {
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const s1 = "11111111-0000-0000-0000-000000000071";
    const s2 = "11111111-0000-0000-0000-000000000072";
    const c1 = await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s1, title: "Match One" });
    const c2 = await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s2, title: "Match Two" });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s1, quizId, finalRank: 1, finalScore: 1000, accuracy: 90 });
    await seedResult(client, { profileId: PLAYER_B, sessionId: s1, quizId, finalRank: 2, finalScore: 700, accuracy: 70 });
    await seedResult(client, { profileId: PLAYER_A, sessionId: s2, quizId, finalRank: 2, finalScore: 800, accuracy: 80 });
    // A solo-arena result (null session) must never leak into league history.
    await seedResult(client, { profileId: PLAYER_A, sessionId: "00000000-0000-0000-0000-0000000000aa", quizId, finalRank: 1, finalScore: 9999, accuracy: 99 });
    return { leagueId, c1, c2 };
  }

  test("league owner queries a player's history with cumulative points from standings", async () => {
    const { client } = makeEnv();
    const { leagueId } = await seedHistoryFixture(client);
    const r = await getPlayerLeagueHistory(client, { actorId: OWNER, leagueId, profileId: PLAYER_A });
    expect(r.competitionsEntered).toBe(2);
    expect(r.displayName).toBe("Alice");
    // Cumulative from the authoritative standings: 10 + 7 = 17 points, rank 1.
    expect(r.leaguePoints).toBe(17);
    expect(r.overallRank).toBe(1);
    expect(r.items).toHaveLength(2);
    for (const item of r.items) {
      expect(Object.keys(item).sort()).toEqual([
        "accuracyPercentage",
        "competitionId",
        "completedAt",
        "finalRank",
        "finalScore",
        "title",
        "totalParticipants",
      ]);
    }
    expect(r.items.find((i) => i.title === "Match One")).toMatchObject({ finalRank: 1, finalScore: 1000 });
  });

  test("a player can read their own history in a league they do not own", async () => {
    const { client } = makeEnv();
    const { leagueId } = await seedHistoryFixture(client);
    const r = await getPlayerLeagueHistory(client, { actorId: PLAYER_B, leagueId, profileId: PLAYER_B });
    expect(r.competitionsEntered).toBe(1);
    expect(r.items[0]).toMatchObject({ title: "Match One", finalRank: 2 });
    // Standings-level aggregates are unavailable for a private league the
    // player does not own.
    expect(r.leaguePoints).toBeNull();
    expect(r.overallRank).toBeNull();
  });

  test("a stranger on a private league is unauthorized", async () => {
    const { client } = makeEnv();
    const { leagueId } = await seedHistoryFixture(client);
    await expect(
      getPlayerLeagueHistory(client, { actorId: OTHER_HOST, leagueId, profileId: PLAYER_A }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("invalid profileId is validation", async () => {
    const { client } = makeEnv();
    const { leagueId } = await seedHistoryFixture(client);
    await expect(
      getPlayerLeagueHistory(client, { actorId: OWNER, leagueId, profileId: "nope" }),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

/* ------------------------------------------------------------------ */
/* attach / detach                                                      */
/* ------------------------------------------------------------------ */

describe("attach_competition_to_league", () => {
  async function makeDraftCompetition(client: ReturnType<typeof asClient>, ownerId = OWNER) {
    const quizId = (await saveOwnedQuiz(client, ownerId)).quizId;
    return seedCompetition(client, { ownerId, quizId, status: "draft" });
  }

  test("attaches a draft competition owned by the actor to their league", async () => {
    const { db, client } = makeEnv();
    const compId = await makeDraftCompetition(client);
    const leagueId = await seedLeague(client, { ownerId: OWNER });

    const result = await attachCompetitionToLeague(client, { actorId: OWNER, competitionId: compId, leagueId });
    expect(result).toMatchObject({ ok: true, action: "attach_competition_to_league", competitionId: compId, leagueId });
    expect(competitionRowOf(db, compId).league_id).toBe(leagueId);
  });

  test("duplicate attach to the same league is a no-op with a warning", async () => {
    const { db, client } = makeEnv();
    const compId = await makeDraftCompetition(client);
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    await attachCompetitionToLeague(client, { actorId: OWNER, competitionId: compId, leagueId });
    const second = await attachCompetitionToLeague(client, { actorId: OWNER, competitionId: compId, leagueId });
    expect(second).toMatchObject({ ok: true, changed: { attached: false } });
    expect((second.warnings as string[]).length).toBeGreaterThan(0);
    expect(competitionRowOf(db, compId).league_id).toBe(leagueId);
  });

  test("competition not owned by the actor is unauthorized", async () => {
    const { client } = makeEnv();
    const compId = await makeDraftCompetition(client, OTHER_HOST);
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    await expect(
      attachCompetitionToLeague(client, { actorId: OWNER, competitionId: compId, leagueId }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("league not owned by the actor is unauthorized", async () => {
    const { client } = makeEnv();
    const compId = await makeDraftCompetition(client, OWNER);
    const leagueId = await seedLeague(client, { ownerId: OTHER_HOST });
    await expect(
      attachCompetitionToLeague(client, { actorId: OWNER, competitionId: compId, leagueId }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("archived league is rejected", async () => {
    const { client } = makeEnv();
    const compId = await makeDraftCompetition(client);
    const leagueId = await seedLeague(client, { ownerId: OWNER, archived: true });
    await expect(
      attachCompetitionToLeague(client, { actorId: OWNER, competitionId: compId, leagueId }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  test("completed / running competitions are protected", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const s1 = "11111111-0000-0000-0000-000000000081";
    const completed = await seedCompetition(client, { ownerId: OWNER, quizId, status: "completed", sessionId: s1 });
    const running = await seedCompetition(client, { ownerId: OWNER, quizId, status: "running" });
    await expect(
      attachCompetitionToLeague(client, { actorId: OWNER, competitionId: completed, leagueId }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      attachCompetitionToLeague(client, { actorId: OWNER, competitionId: running, leagueId }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("idempotency key replays the stored result on retry", async () => {
    const { db, client } = makeEnv();
    const compId = await makeDraftCompetition(client);
    const leagueId = await seedLeague(client, { ownerId: OWNER });

    const first = await attachCompetitionToLeague(client, {
      actorId: OWNER, competitionId: compId, leagueId, idempotencyKey: "attach-key-1",
    });
    const second = await attachCompetitionToLeague(client, {
      actorId: OWNER, competitionId: compId, leagueId, idempotencyKey: "attach-key-1",
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true, competitionId: compId, leagueId });
    expect(competitionRowOf(db, compId).league_id).toBe(leagueId);
  });

  test("reusing the key with a different league is rejected as conflict", async () => {
    const { client } = makeEnv();
    const compId = await makeDraftCompetition(client);
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const otherLeague = await seedLeague(client, { ownerId: OWNER, name: "Other" });
    await attachCompetitionToLeague(client, { actorId: OWNER, competitionId: compId, leagueId, idempotencyKey: "attach-key-2" });
    // The idempotency machinery raises a plain Error; the envelope mapper
    // (tools.ts layer) turns it into the conflict code.
    const { toLeagueEnvelope } = await import("../src/league");
    let err: unknown;
    try {
      await attachCompetitionToLeague(client, {
        actorId: OWNER, competitionId: compId, leagueId: otherLeague, idempotencyKey: "attach-key-2",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const envelope = toLeagueEnvelope("attach_competition_to_league", err);
    expect(envelope.error.code).toBe("conflict");
    expect(envelope.error.message).toContain("reuse of a key");
  });
});

describe("detach_competition_from_league", () => {
  test("detaches an attached draft competition", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const compId = await seedCompetition(client, { ownerId: OWNER, quizId, leagueId });

    const result = await detachCompetitionFromLeague(client, { actorId: OWNER, competitionId: compId });
    expect(result).toMatchObject({ ok: true, action: "detach_competition_from_league", leagueId: null });
    expect(competitionRowOf(db, compId).league_id).toBeNull();
  });

  test("detaching an unattached competition is a no-op with a warning", async () => {
    const { client } = makeEnv();
    const compId = await (async () => {
      const quizId = (await saveOwnedQuiz(client)).quizId;
      return seedCompetition(client, { ownerId: OWNER, quizId, status: "draft" });
    })();
    const result = await detachCompetitionFromLeague(client, { actorId: OWNER, competitionId: compId });
    expect(result).toMatchObject({ ok: true, changed: { detached: false } });
    expect((result.warnings as string[]).length).toBeGreaterThan(0);
  });

  test("completed competitions cannot be detached", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const s1 = "11111111-0000-0000-0000-000000000082";
    const compId = await seedCompetition(client, { ownerId: OWNER, quizId, leagueId, status: "completed", sessionId: s1 });
    await expect(detachCompetitionFromLeague(client, { actorId: OWNER, competitionId: compId })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  test("non-owner cannot detach", async () => {
    const { client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client, OTHER_HOST)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OTHER_HOST });
    const compId = await seedCompetition(client, { ownerId: OTHER_HOST, quizId, leagueId });
    await expect(detachCompetitionFromLeague(client, { actorId: OWNER, competitionId: compId })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Error envelope mapping                                               */
/* ------------------------------------------------------------------ */

describe("toLeagueEnvelope", () => {
  test("maps typed errors and sanitizes unknown ones", async () => {
    const { toLeagueEnvelope } = await import("../src/league");
    expect(toLeagueEnvelope("get_league", new CompetitionError("unauthorized", "nope"))).toEqual({
      ok: false,
      action: "get_league",
      error: { code: "unauthorized", message: "nope" },
    });
    const envelope = toLeagueEnvelope("get_league", new Error("SQLSTATE 42P01"));
    expect(envelope.error.code).toBe("unknown");
    expect(envelope.error.message).not.toContain("SQLSTATE");
  });
});
