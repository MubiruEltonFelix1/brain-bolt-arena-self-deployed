// Phase 8D orchestration tests: the bounded create → attach → schedule and
// create → schedule workflows — preflight guarantees, per-step derived
// idempotency keys, retry semantics, partial-failure reporting and the
// no-compensation rule — against the in-memory fake Supabase client.

import { describe, expect, test } from "bun:test";
import { requestHash } from "../src/idempotency";
import {
  orchestrateCompetitionWorkflow,
  OrchestrationError,
  toOrchestrationEnvelope,
  WORKFLOWS,
  type OrchestrationPlan,
} from "../src/orchestrate";
import { saveQuizWithClient } from "../src/supabase";
import type { BrainBoltQuiz } from "../src/schema";
import { asClient, createFakeDb, FakeSupabase, seedUser, type FakeDb } from "./fake-supabase";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_HOST = "22222222-2222-2222-2222-222222222222";
const NO_ROLE_USER = "33333333-3333-3333-3333-333333333333";
const MISSING = "99999999-9999-9999-9999-999999999999";

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
  const client = asClient(new FakeSupabase(db));
  return { db, client };
}

async function saveOwnedQuiz(client: ReturnType<typeof asClient>, ownerId = OWNER) {
  return saveQuizWithClient(client, QUIZ, { ownerId });
}

async function seedLeague(
  client: ReturnType<typeof asClient>,
  options: { ownerId?: string; archived?: boolean; name?: string } = {},
): Promise<string> {
  const { data, error } = await client
    .from("leagues")
    .insert({
      owner_principal_id: options.ownerId ?? OWNER,
      name: options.name ?? "Season League",
      archived_at: options.archived ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seedLeague failed: ${error.message}`);
  return (data as unknown as { id: string }).id;
}

function competitionRowOf(db: FakeDb, competitionId: string) {
  return db.competitions.find((c) => c.id === competitionId)!;
}

function keyRows(db: FakeDb) {
  return db.mcp_idempotency_keys;
}

type PlanOverrides = Partial<{
  quizId: string;
  title: string;
  mode: string;
  visibility: string;
  scheduledStartAt: string;
  leagueId: string;
}>;

/** Builds a valid plan; preflight rejects any overridden field at runtime. */
function basePlan(overrides: PlanOverrides = {}): OrchestrationPlan {
  return {
    quizId: "",
    title: "Orchestrated",
    mode: "scheduled",
    visibility: "private",
    scheduledStartAt: futureIso(),
    ...overrides,
  } as unknown as OrchestrationPlan;
}

/* ------------------------------------------------------------------ */
/* Success paths                                                        */
/* ------------------------------------------------------------------ */

describe("orchestrate_competition_workflow — success", () => {
  test("create → attach → schedule completes and lands the competition in the league", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const start = futureIso();

    const result = await orchestrateCompetitionWorkflow(client, {
      actorId: OWNER,
      workflow: "create_attach_schedule",
      plan: basePlan({ quizId, leagueId, scheduledStartAt: start }),
      idempotencyKey: "wf-ok-1",
    });

    expect(result.ok).toBe(true);
    if (result.status !== "completed") return;
    expect(result.competitionId).toBeTruthy();
    expect(result.steps.map((s) => s.tool)).toEqual([
      "create_competition",
      "attach_competition_to_league",
      "schedule_competition",
    ]);
    for (const step of result.steps) {
      expect(step.status).toBe("success");
    }
    const step1 = result.steps[0]!;
    expect(step1.status).toBe("success");
    if (step1.status !== "success") return;
    expect(step1.result.competitionId).toBe(result.competitionId);
    const step3 = result.steps[2]!;
    expect(step3.status).toBe("success");
    if (step3.status !== "success") return;
    expect(step3.result.status).toBe("scheduled");

    const row = competitionRowOf(db, result.competitionId);
    expect(row.status).toBe("scheduled");
    expect(row.league_id).toBe(leagueId);
    expect(Date.parse(row.scheduled_start_at as string)).toBe(Date.parse(start));
    // Exactly three step-level idempotency claims, all completed.
    expect(keyRows(db)).toHaveLength(3);
    expect(keyRows(db).every((k) => k.status === "completed")).toBe(true);
  });

  test("create → schedule completes without a league", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;

    const result = await orchestrateCompetitionWorkflow(client, {
      actorId: OWNER,
      workflow: "create_schedule",
      plan: basePlan({ quizId }),
      idempotencyKey: "wf-ok-2",
    });

    expect(result.ok).toBe(true);
    if (result.status !== "completed") return;
    expect(result.steps.map((s) => s.tool)).toEqual(["create_competition", "schedule_competition"]);
    expect(competitionRowOf(db, result.competitionId).league_id).toBeNull();
    expect(competitionRowOf(db, result.competitionId).status).toBe("scheduled");
    expect(keyRows(db)).toHaveLength(2);
  });

  test("a fully replayed run reports replayed: true and creates nothing new", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const start = futureIso();
    const options = {
      actorId: OWNER,
      workflow: "create_attach_schedule" as const,
      plan: basePlan({ quizId, leagueId, scheduledStartAt: start }),
      idempotencyKey: "wf-replay-1",
    };

    const first = await orchestrateCompetitionWorkflow(client, options);
    const second = await orchestrateCompetitionWorkflow(client, options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.status !== "completed" || second.status !== "completed") return;
    expect(second.replayed).toBe(true);
    expect(second.competitionId).toBe(first.competitionId);
    expect(db.competitions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Preflight failures — nothing mutated                                 */
/* ------------------------------------------------------------------ */

describe("orchestrate_competition_workflow — preflight", () => {
  async function setup() {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    return { db, client, quizId, leagueId };
  }

  async function expectPreflight(
    client: ReturnType<typeof asClient>,
    code: string,
    workflow: "create_attach_schedule" | "create_schedule",
    plan: OrchestrationPlan,
    idempotencyKey = "wf-preflight",
  ) {
    await expect(
      orchestrateCompetitionWorkflow(client, {
        actorId: OWNER,
        workflow,
        plan,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code, phase: "preflight" });
  }

  test("unknown workflow", async () => {
    const { db, client, quizId, leagueId } = await setup();
    await expect(
      orchestrateCompetitionWorkflow(client, {
        actorId: OWNER,
        workflow: "create_publish_retire" as never,
        plan: basePlan({ quizId, leagueId }),
        idempotencyKey: "wf-bad",
      }),
    ).rejects.toMatchObject({ code: "validation", phase: "preflight" });
    expect(db.competitions).toHaveLength(0);
    expect(keyRows(db)).toHaveLength(0);
  });

  test("missing leagueId in an attach workflow", async () => {
    const { db, client, quizId } = await setup();
    await expectPreflight(client, "validation", "create_attach_schedule", basePlan({ quizId }));
    expect(db.competitions).toHaveLength(0);
    expect(keyRows(db)).toHaveLength(0);
  });

  test("empty idempotencyKey", async () => {
    const { db, client, quizId, leagueId } = await setup();
    await expectPreflight(client, "validation", "create_attach_schedule", basePlan({ quizId, leagueId }), "");
    expect(db.competitions).toHaveLength(0);
    expect(keyRows(db)).toHaveLength(0);
  });

  test("past scheduledStartAt", async () => {
    const { db, client, quizId, leagueId } = await setup();
    await expectPreflight(client, "validation", "create_attach_schedule", basePlan({ quizId, leagueId, scheduledStartAt: pastIso() }));
    expect(db.competitions).toHaveLength(0);
  });

  test("mode hosted", async () => {
    const { db, client, quizId, leagueId } = await setup();
    await expectPreflight(client, "validation", "create_attach_schedule", basePlan({ quizId, leagueId, mode: "hosted" }));
    expect(db.competitions).toHaveLength(0);
  });

  test("visibility not in the enum", async () => {
    const { db, client, quizId, leagueId } = await setup();
    await expectPreflight(client, "validation", "create_attach_schedule", basePlan({ quizId, leagueId, visibility: "secret" }));
    expect(db.competitions).toHaveLength(0);
  });

  test("nonexistent quiz", async () => {
    const { db, client, leagueId } = await setup();
    await expectPreflight(client, "not-found", "create_attach_schedule", basePlan({ quizId: MISSING, leagueId }));
    expect(db.competitions).toHaveLength(0);
  });

  test("quiz owned by another principal", async () => {
    const { db, client, leagueId } = await setup();
    const otherQuiz = (await saveOwnedQuiz(client, OTHER_HOST)).quizId;
    await expectPreflight(client, "unauthorized", "create_attach_schedule", basePlan({ quizId: otherQuiz, leagueId }));
    expect(db.competitions).toHaveLength(0);
  });

  test("nonexistent league", async () => {
    const { db, client, quizId } = await setup();
    await expectPreflight(client, "not-found", "create_attach_schedule", basePlan({ quizId, leagueId: MISSING }));
    expect(db.competitions).toHaveLength(0);
  });

  test("league owned by another principal", async () => {
    const { db, client, quizId } = await setup();
    const otherLeague = await seedLeague(client, { ownerId: OTHER_HOST });
    await expectPreflight(client, "unauthorized", "create_attach_schedule", basePlan({ quizId, leagueId: otherLeague }));
    expect(db.competitions).toHaveLength(0);
  });

  test("actor without the host capability", async () => {
    const { db, client, quizId, leagueId } = await setup();
    await expect(
      orchestrateCompetitionWorkflow(client, {
        actorId: NO_ROLE_USER,
        workflow: "create_attach_schedule",
        plan: basePlan({ quizId, leagueId }),
        idempotencyKey: "wf-norole",
      }),
    ).rejects.toMatchObject({ code: "unauthorized", phase: "preflight" });
    expect(db.competitions).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Step failures — partial completion, no compensation                  */
/* ------------------------------------------------------------------ */

describe("orchestrate_competition_workflow — step failures", () => {
  test("failure at step 1: archived quiz passes preflight but fails create", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    // Archive AFTER the quiz exists: preflight checks existence/ownership only.
    db.quizzes.find((q) => q.id === quizId)!.archived_at = new Date().toISOString();

    const result = await orchestrateCompetitionWorkflow(client, {
      actorId: OWNER,
      workflow: "create_attach_schedule",
      plan: basePlan({ quizId, leagueId }),
      idempotencyKey: "wf-step1",
    });

    expect(result.ok).toBe(true);
    if (result.status !== "partial") return;
    expect(result.failedStep).toMatchObject({ step: 1, tool: "create_competition", error: { code: "validation" } });
    expect(db.competitions).toHaveLength(0);
    // The failed step's key was freed — a retry can re-execute it.
    expect(keyRows(db)).toHaveLength(0);
  });

  test("failure at step 2: archived league passes preflight but fails attach", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER, archived: true });

    const result = await orchestrateCompetitionWorkflow(client, {
      actorId: OWNER,
      workflow: "create_attach_schedule",
      plan: basePlan({ quizId, leagueId }),
      idempotencyKey: "wf-step2",
    });

    expect(result.ok).toBe(true);
    if (result.status !== "partial") return;
    expect(result.failedStep).toMatchObject({ step: 2, tool: "attach_competition_to_league", error: { code: "validation" } });
    // Step 1 persisted: the competition exists as a draft, NOT scheduled,
    // NOT compensated away.
    expect(db.competitions).toHaveLength(1);
    expect(db.competitions[0]).toMatchObject({ status: "draft", league_id: null });
    const step2Row = db.competitions[0]!;
    const step2RowId: string = step2Row.id as string;
    expect(result.competitionId).toBe(step2RowId);
  });

  test("failure at step 3: replayed steps 1-2, schedule rejects the archived quiz", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const start = futureIso();
    const competitionId = "88888888-8888-8888-8888-888888888888";

    // World state as if a previous run had created + attached, then the quiz
    // was archived before the retry — step 3's live re-check must refuse it.
    db.quizzes.find((q) => q.id === quizId)!.archived_at = new Date().toISOString();
    db.competitions.push({
      id: competitionId,
      owner_principal_id: OWNER,
      quiz_id: quizId,
      league_id: leagueId,
      mode: "scheduled",
      status: "draft",
      scheduled_start_at: start,
      title: "Orchestrated",
    });

    // Steps 1-2 already completed under the SAME derived keys with the EXACT
    // payload hashes the workflow would compute.
    const step1Payload = {
      actor: OWNER,
      quizId,
      title: "Orchestrated",
      mode: "scheduled",
      visibility: "private",
      scheduledStartAt: start,
      lobbyDurationSeconds: undefined,
      description: null,
      leagueId: null,
      brandingProfileId: null,
      maxParticipants: null,
    };
    const step2Payload = { actor: OWNER, competitionId, leagueId };
    const now = new Date().toISOString();
    keyRows(db).push(
      {
        key: "wf-step3#1:create_competition",
        operation: "create_competition",
        request_hash: requestHash(step1Payload),
        status: "completed",
        response: {
          ok: true,
          action: "create_competition",
          id: competitionId,
          competitionId,
          status: "draft",
          scheduledStartAt: start,
          warnings: [],
          errors: [],
        },
        created_at: now,
        completed_at: now,
      },
      {
        key: "wf-step3#2:attach_competition_to_league",
        operation: "attach_competition_to_league",
        request_hash: requestHash(step2Payload),
        status: "completed",
        response: {
          ok: true,
          action: "attach_competition_to_league",
          id: competitionId,
          competitionId,
          leagueId,
          changed: { attached: true },
          warnings: [],
          errors: [],
        },
        created_at: now,
        completed_at: now,
      },
    );

    const result = await orchestrateCompetitionWorkflow(client, {
      actorId: OWNER,
      workflow: "create_attach_schedule",
      plan: basePlan({ quizId, leagueId, scheduledStartAt: start }),
      idempotencyKey: "wf-step3",
    });

    expect(result.ok).toBe(true);
    if (result.status !== "partial") return;
    expect(result.failedStep).toMatchObject({ step: 3, tool: "schedule_competition", error: { code: "validation" } });
    // No duplicate competition, no duplicate attachment.
    expect(db.competitions).toHaveLength(1);
    expect(db.competitions[0]!.league_id).toBe(leagueId);
    expect(result.competitionId).toBe(competitionId);
    const step1 = result.steps[0]!;
    expect(step1.status).toBe("success");
    if (step1.status !== "success") return;
    expect(step1.result.competitionId).toBe(competitionId);
  });

  test("retry with the same key resumes: replay step 1, re-run the failed step 2", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER, archived: true });
    const start = futureIso();
    const options = {
      actorId: OWNER,
      workflow: "create_attach_schedule" as const,
      plan: basePlan({ quizId, leagueId, scheduledStartAt: start }),
      idempotencyKey: "wf-retry",
    };

    const first = await orchestrateCompetitionWorkflow(client, options);
    expect(first.ok).toBe(true);
    if (first.status !== "partial") return;
    expect(db.competitions).toHaveLength(1);
    const created = db.competitions[0]!.id as string;

    // The league is un-archived between the attempts (state changed).
    db.leagues.find((l) => l.id === leagueId)!.archived_at = null;

    const second = await orchestrateCompetitionWorkflow(client, options);
    expect(second.ok).toBe(true);
    if (second.status !== "completed") return;
    expect(second.competitionId).toBe(created);
    expect(db.competitions).toHaveLength(1);
    expect(db.competitions[0]).toMatchObject({ status: "scheduled", league_id: leagueId });
    const step1 = second.steps[0]!;
    expect(step1.status).toBe("success");
    if (step1.status !== "success") return;
    expect(step1.result.replayed).toBe(true);
  });

  test("retry with a different payload is rejected at the step claim — no new rows", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER });
    const options = {
      actorId: OWNER,
      workflow: "create_attach_schedule" as const,
      plan: basePlan({ quizId, leagueId }),
      idempotencyKey: "wf-diff",
    };

    const first = await orchestrateCompetitionWorkflow(client, options);
    expect(first.ok).toBe(true);
    if (first.status !== "completed") return;

    const second = await orchestrateCompetitionWorkflow(client, {
      ...options,
      plan: basePlan({ quizId, leagueId, title: "Renamed" }),
    });
    expect(second.ok).toBe(true);
    if (second.status !== "partial") return;
    expect(second.failedStep).toMatchObject({ step: 1, error: { code: "conflict" } });
    expect(db.competitions).toHaveLength(1);
  });

  test("partial reporting never deletes the created competition", async () => {
    const { db, client } = makeEnv();
    const quizId = (await saveOwnedQuiz(client)).quizId;
    const leagueId = await seedLeague(client, { ownerId: OWNER, archived: true });

    const result = await orchestrateCompetitionWorkflow(client, {
      actorId: OWNER,
      workflow: "create_attach_schedule",
      plan: basePlan({ quizId, leagueId }),
      idempotencyKey: "wf-nocomp",
    });

    expect(result.ok).toBe(true);
    if (result.status !== "partial") return;
    const noCompRow = db.competitions[0]!;
    const noCompId: string = noCompRow.id as string;
    expect(result.competitionId).toBe(noCompId);
    expect(db.competitions).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ step: 1, status: "success" });
    expect(result.steps[1]).toMatchObject({ step: 2, status: "failed" });
  });
});

/* ------------------------------------------------------------------ */
/* Envelope mapping                                                     */
/* ------------------------------------------------------------------ */

describe("toOrchestrationEnvelope", () => {
  test("maps preflight errors to the phase envelope", () => {
    expect(
      toOrchestrationEnvelope("orchestrate_competition_workflow", new OrchestrationError("validation", "nope")),
    ).toEqual({
      ok: false,
      action: "orchestrate_competition_workflow",
      phase: "preflight",
      error: { code: "validation", message: "nope" },
    });
    const envelope = toOrchestrationEnvelope(
      "orchestrate_competition_workflow",
      new Error("SQLSTATE 42P01: relation does not exist"),
    );
    expect(envelope.error.code).toBe("unknown");
    expect(envelope.error.message).not.toContain("SQLSTATE");
  });

  test("documents the fixed workflow step sequences", () => {
    expect(WORKFLOWS).toEqual({
      create_attach_schedule: ["create_competition", "attach_competition_to_league", "schedule_competition"],
      create_schedule: ["create_competition", "schedule_competition"],
    });
  });
});
