// Bounded multi-step orchestration for the MCP server (Phase 8D).
//
// `orchestrate_competition_workflow` executes ONE explicit, declarative plan —
// never an arbitrary instruction stream, never a loop, never a self-modifying
// plan, never Session control. Supported workflows (fixed step sequences):
//   create_attach_schedule: create competition (draft, no league) → attach to
//                            league → schedule
//   create_schedule:        create competition (draft, no league) → schedule
//
// Contract:
//   preflight   — validates the complete plan statically (shape, capability,
//                 resource existence/ownership, future time, mode) and throws
//                 an OrchestrationError BEFORE anything is mutated. Live-state
//                 gates (archived flags, statuses) are deliberately left to
//                 the step functions, which re-check them — they can change
//                 between preflight and execution.
//   execution   — steps run in deterministic order, calling the existing MCP
//                 operation functions (createCompetition, attach, schedule).
//                 Each step claims a DERIVED idempotency key
//                 (`<workflowKey>#<n>:<tool>`) through the Phase 8B/8C
//                 mechanism: a retry after a partial failure replays the
//                 completed steps (same competitionId — no duplicates) and
//                 re-executes only the failed step. The orchestration entry
//                 point itself is NOT wrapped — only steps carry keys.
//   failure     — the first failed step stops the workflow. The response
//                 reports every step outcome explicitly; nothing is
//                 auto-compensated (no deleting business objects to hide a
//                 partial failure). Preflight failures are reported with
//                 phase:"preflight"; step failures surface as status:"partial".
//
// Error vocabulary (§13): unauthorized | not-found | validation | conflict |
// dependency-failed | partial-failure | unknown. dependency-failed is used
// when a step fails with not-found on a resource created by an earlier step
// of the same run (e.g. the competition vanished between create and attach).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMPETITION_VISIBILITIES,
  CompetitionError,
  createCompetition,
  scheduleCompetition,
  type CompetitionVisibility,
} from "./competition";
import { attachCompetitionToLeague } from "./league";
import {
  isValidUuid,
  resolveActor,
  type Actor,
} from "./lifecycle";

/* ------------------------------------------------------------------ */
/* Shared shapes                                                        */
/* ------------------------------------------------------------------ */

export type OrchestrationErrorCode =
  | CompetitionError["code"]
  | "dependency-failed"
  | "partial-failure";

export class OrchestrationError extends Error {
  code: Exclude<OrchestrationErrorCode, "partial-failure">;
  phase: "preflight";
  constructor(code: Exclude<OrchestrationErrorCode, "partial-failure">, message: string) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
    this.phase = "preflight";
  }
}

export type OrchestrationFailureEnvelope = {
  ok: false;
  action: string;
  phase: "preflight";
  error: { code: OrchestrationErrorCode; message: string };
};

/** Maps any thrown preflight failure to the structured envelope (§13). */
export function toOrchestrationEnvelope(
  action: string,
  err: unknown,
): OrchestrationFailureEnvelope {
  if (err instanceof OrchestrationError) {
    return { ok: false, action, phase: "preflight", error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : "";
  if (
    message.includes("reuse of a key must repeat the exact same request") ||
    message.includes("already being processed")
  ) {
    return { ok: false, action, phase: "preflight", error: { code: "conflict", message } };
  }
  return {
    ok: false,
    action,
    phase: "preflight",
    error: {
      code: "unknown",
      message: "Something went wrong — the workflow was not started.",
    },
  };
}

export const WORKFLOWS = {
  create_attach_schedule: [
    "create_competition",
    "attach_competition_to_league",
    "schedule_competition",
  ],
  create_schedule: ["create_competition", "schedule_competition"],
} as const;

export type WorkflowId = keyof typeof WORKFLOWS;

export type OrchestrationPlan = {
  quizId: string;
  title: string;
  /** Both supported workflows end in the schedule step, and the autonomous
   * scheduler opens mode 'scheduled' competitions only. */
  mode: "scheduled";
  visibility: CompetitionVisibility;
  scheduledStartAt: string;
  lobbyDurationSeconds?: number;
  description?: string | null;
  brandingProfileId?: string | null;
  maxParticipants?: number | null;
  /** Required when the workflow includes the attach step. */
  leagueId?: string;
};

export type OrchestrationOptions = {
  actorId: string;
  workflow: WorkflowId;
  plan: OrchestrationPlan;
  idempotencyKey: string;
};

export type OrchestrationStep =
  | {
      step: number;
      tool: string;
      status: "success";
      result: {
        competitionId: string | null;
        leagueId: string | null;
        status: string | null;
        warnings: string[];
        replayed?: boolean;
      };
    }
  | {
      step: number;
      tool: string;
      status: "failed";
      error: { code: string; message: string };
    };

export type OrchestrationEnvelope =
  | {
      ok: true;
      action: string;
      workflow: WorkflowId;
      status: "completed";
      steps: OrchestrationStep[];
      competitionId: string;
      warnings: string[];
      errors: never[];
      replayed?: boolean;
    }
  | {
      ok: true;
      action: string;
      workflow: WorkflowId;
      status: "partial";
      steps: OrchestrationStep[];
      competitionId: string | null;
      failedStep: { step: number; tool: string; error: { code: string; message: string } };
      warnings: string[];
      errors: never[];
    };

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function sanitizeError(err: unknown, fallback: string): OrchestrationError {
  if (err instanceof OrchestrationError) return err;
  return new OrchestrationError("unknown", fallback);
}

async function resolveOrchestrationActor(
  client: SupabaseClient,
  actorId: string,
): Promise<Actor> {
  try {
    return await resolveActor(client, actorId);
  } catch (err) {
    if (err instanceof Error) {
      const message = err.message;
      if (message.includes("No acting principal")) {
        throw new OrchestrationError("unauthorized", message);
      }
      if (message.includes("has no user principal")) {
        throw new OrchestrationError("unauthorized", message);
      }
      if (message.includes("not a valid uuid")) {
        throw new OrchestrationError("validation", message);
      }
    }
    throw sanitizeError(err, "Could not resolve the acting principal.");
  }
}

function assertFutureIso(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim() === "" || Number.isNaN(Date.parse(value))) {
    throw new OrchestrationError(
      "validation",
      `plan.${label} must be a valid ISO-8601 timestamp (e.g. 2026-09-01T14:00:00Z).`,
    );
  }
  if (Date.parse(value) < Date.now() - 60_000) {
    throw new OrchestrationError("validation", `plan.${label} must be in the future.`);
  }
}

/** Step failure mapping: idempotency conflicts → conflict; not-found on a
 * resource created by an earlier step of this run → dependency-failed. */
function toStepError(err: unknown, hasDependency: boolean): { code: string; message: string } {
  if (err instanceof CompetitionError) {
    const code = hasDependency && err.code === "not-found" ? "dependency-failed" : err.code;
    return { code, message: err.message };
  }
  const message = err instanceof Error ? err.message : "";
  if (
    message.includes("reuse of a key must repeat the exact same request") ||
    message.includes("already being processed")
  ) {
    return { code: "conflict", message };
  }
  return { code: "unknown", message: "The step failed unexpectedly — see the partial result." };
}

type TrimmedStepResult = {
  competitionId: string | null;
  leagueId: string | null;
  status: string | null;
  warnings: string[];
  replayed?: boolean;
};

function trimResult(result: unknown): TrimmedStepResult {
  const r = (result ?? {}) as Record<string, unknown>;
  return {
    competitionId: typeof r.competitionId === "string" ? r.competitionId : null,
    leagueId: typeof r.leagueId === "string" ? r.leagueId : null,
    status: typeof r.status === "string" ? r.status : null,
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
    replayed: r.replayed === true ? true : undefined,
  };
}

async function captureStep(
  step: number,
  tool: string,
  hasDependency: boolean,
  run: () => Promise<unknown>,
): Promise<OrchestrationStep> {
  try {
    const result = await run();
    return { step, tool, status: "success", result: trimResult(result) };
  } catch (err) {
    return { step, tool, status: "failed", error: toStepError(err, hasDependency) };
  }
}

function partialEnvelope(
  options: OrchestrationOptions,
  steps: OrchestrationStep[],
  competitionId: string | null,
): OrchestrationEnvelope {
  const failed = steps.find((s): s is Extract<OrchestrationStep, { status: "failed" }> => s.status === "failed");
  return {
    ok: true,
    action: "orchestrate_competition_workflow",
    workflow: options.workflow,
    status: "partial",
    steps,
    competitionId,
    failedStep: failed ? { step: failed.step, tool: failed.tool, error: failed.error } : { step: steps.length, tool: "", error: { code: "unknown", message: "The workflow stopped before completing." } },
    warnings: [],
    errors: [],
  };
}

/* ------------------------------------------------------------------ */
/* Preflight                                                            */
/* ------------------------------------------------------------------ */

async function preflight(client: SupabaseClient, options: OrchestrationOptions): Promise<Actor> {
  const { workflow, plan, idempotencyKey } = options;

  if (!(workflow in WORKFLOWS)) {
    throw new OrchestrationError(
      "validation",
      `workflow must be one of ${Object.keys(WORKFLOWS).join(", ")}.`,
    );
  }
  const requiresLeague = (WORKFLOWS[workflow] as readonly string[]).includes(
    "attach_competition_to_league",
  );

  if (!idempotencyKey || !idempotencyKey.trim()) {
    throw new OrchestrationError(
      "validation",
      "orchestrate_competition_workflow requires an idempotencyKey — the workflow must be retry-safe (a retry may never duplicate the competition, the attachment or the schedule).",
    );
  }
  if (!plan || typeof plan !== "object") {
    throw new OrchestrationError("validation", "plan must be an object.");
  }
  const p = plan as OrchestrationPlan;

  const title = (p.title ?? "").trim();
  if (!title) {
    throw new OrchestrationError("validation", "plan.title must be a non-empty string.");
  }
  if (typeof p.quizId !== "string" || !isValidUuid(p.quizId)) {
    throw new OrchestrationError("validation", "plan.quizId must be a valid uuid of an existing quiz.");
  }
  if (p.mode !== "scheduled") {
    throw new OrchestrationError(
      "validation",
      "plan.mode must be 'scheduled' — both supported workflows end in the schedule step, and the autonomous scheduler opens mode 'scheduled' competitions only.",
    );
  }
  if (typeof p.visibility !== "string" || !(COMPETITION_VISIBILITIES as readonly string[]).includes(p.visibility)) {
    throw new OrchestrationError(
      "validation",
      `plan.visibility must be one of ${COMPETITION_VISIBILITIES.join(", ")} — visibility is always explicit.`,
    );
  }
  assertFutureIso(p.scheduledStartAt, "scheduledStartAt");

  if (requiresLeague) {
    if (typeof p.leagueId !== "string" || !p.leagueId.trim()) {
      throw new OrchestrationError(
        "validation",
        `workflow "${workflow}" requires plan.leagueId — the league the competition will be attached to.`,
      );
    }
    if (!isValidUuid(p.leagueId)) {
      throw new OrchestrationError("validation", "plan.leagueId must be a valid uuid.");
    }
  }

  const actor = await resolveOrchestrationActor(client, options.actorId);

  const { data: allowed, error: canError } = await client.rpc("can", {
    p_principal: actor.principalId,
    p_action: "competition.create",
    p_resource: null,
  });
  if (canError) {
    throw new OrchestrationError("unknown", "Could not verify the competition.create capability.");
  }
  if (allowed !== true) {
    throw new OrchestrationError(
      "unauthorized",
      `actor "${actor.actorId}" is not authorized to create competitions — the host capability ` +
        "(admin role, host role, or active host authorization) is required.",
    );
  }

  const { data: quiz, error: quizError } = await client
    .from("quizzes")
    .select("id,owner_principal_id")
    .eq("id", p.quizId)
    .maybeSingle();
  if (quizError) {
    throw new OrchestrationError("unknown", `Could not read quiz "${p.quizId}".`);
  }
  if (!quiz) {
    throw new OrchestrationError("not-found", `quiz "${p.quizId}" does not exist — nothing was created.`);
  }
  if ((quiz as unknown as { owner_principal_id: string | null }).owner_principal_id !== actor.principalId) {
    throw new OrchestrationError(
      "unauthorized",
      `actor "${actor.actorId}" is not authorized to use quiz "${p.quizId}" — competitions can only be created from quizzes the acting principal owns.`,
    );
  }

  if (requiresLeague) {
    const { data: league, error: leagueError } = await client
      .from("leagues")
      .select("id,owner_principal_id")
      .eq("id", p.leagueId!)
      .maybeSingle();
    if (leagueError) {
      throw new OrchestrationError("unknown", `Could not read league "${p.leagueId}".`);
    }
    if (!league) {
      throw new OrchestrationError("not-found", `league "${p.leagueId}" does not exist — nothing was created.`);
    }
    if ((league as unknown as { owner_principal_id: string | null }).owner_principal_id !== actor.principalId) {
      throw new OrchestrationError(
        "unauthorized",
        `actor "${actor.actorId}" is not authorized to use league "${p.leagueId}" — only leagues the acting principal owns can be attached.`,
      );
    }
  }

  return actor;
}

/* ------------------------------------------------------------------ */
/* orchestrate_competition_workflow                                     */
/* ------------------------------------------------------------------ */

export async function orchestrateCompetitionWorkflow(
  client: SupabaseClient,
  options: OrchestrationOptions,
): Promise<OrchestrationEnvelope> {
  await preflight(client, options);

  const { workflow, plan } = options;
  const base = options.idempotencyKey.trim();
  const steps: OrchestrationStep[] = [];
  let competitionId: string | null = null;

  // Step 1 — create the competition as a draft WITHOUT a league; the attach
  // step owns the league link (deterministic, independently retryable steps).
  const step1 = await captureStep(1, "create_competition", false, () =>
    createCompetition(client, {
      actorId: options.actorId,
      quizId: plan.quizId,
      title: plan.title,
      mode: "scheduled",
      visibility: plan.visibility,
      scheduledStartAt: plan.scheduledStartAt,
      lobbyDurationSeconds: plan.lobbyDurationSeconds,
      description: plan.description ?? null,
      leagueId: null,
      brandingProfileId: plan.brandingProfileId ?? null,
      maxParticipants: plan.maxParticipants ?? null,
      idempotencyKey: `${base}#1:create_competition`,
    }),
  );
  steps.push(step1);
  if (step1.status === "failed") {
    return partialEnvelope(options, steps, null);
  }
  competitionId = step1.result.competitionId;
  if (competitionId === null) {
    return partialEnvelope(options, steps, null);
  }

  // Step 2 — attach to the league (create_attach_schedule only). The
  // competition was created by step 1 of this same run, so a not-found here
  // is a broken dependency, not a caller error.
  if (workflow === "create_attach_schedule") {
    const step2 = await captureStep(2, "attach_competition_to_league", true, () =>
      attachCompetitionToLeague(client, {
        actorId: options.actorId,
        competitionId: competitionId as string,
        leagueId: plan.leagueId as string,
        idempotencyKey: `${base}#2:attach_competition_to_league`,
      }),
    );
    steps.push(step2);
    if (step2.status === "failed") {
      return partialEnvelope(options, steps, competitionId);
    }
  }

  // Step 3 — schedule (hands off to the existing autonomous scheduler; MCP
  // never creates sessions).
  const step3 = await captureStep(3, "schedule_competition", true, () =>
    scheduleCompetition(client, {
      actorId: options.actorId,
      competitionId: competitionId as string,
      scheduledStartAt: plan.scheduledStartAt,
      idempotencyKey: `${base}#3:schedule_competition`,
    }),
  );
  steps.push(step3);
  if (step3.status === "failed") {
    return partialEnvelope(options, steps, competitionId);
  }

  const replayed = steps.every(
    (s) => s.status === "success" && s.result.replayed === true,
  );
  return {
    ok: true,
    action: "orchestrate_competition_workflow",
    workflow,
    status: "completed",
    steps,
    competitionId: competitionId as string,
    warnings: [],
    errors: [],
    ...(replayed ? { replayed: true } : {}),
  } as OrchestrationEnvelope;
}
