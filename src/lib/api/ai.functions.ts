// Server functions for the AI Question Builder.
//
// First real *.functions.ts in src/lib/api/ — the existing example.functions.ts
// is a "hello world" demo with no middleware. Pattern is:
//   createServerFn({ method: "POST" })
//     .middleware([requireSupabaseAuth])
//     .inputValidator(z.object(...))
//     .handler(async ({ data, context }) => { ... })
//
// The handler NEVER throws raw provider errors — it returns the typed
// GenerationResult / RegenerationResult envelope from BrainBoltAiService.
// The client renders friendly messages via FRIENDLY_MESSAGES[error.code].

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BrainBoltAiService, MAX_GENERATION_COUNT } from "@/lib/ai/service.server";
import {
  SUPPORTED_AI_TYPES,
  type GenerateQuestionsRequest,
  type RegenerateQuestionRequest,
} from "@/lib/ai/types";
import { questionSchema } from "@/lib/quiz/validate";

const SUPPORTED_TYPE_ENUM = z.enum(SUPPORTED_AI_TYPES);

const generateQuestionsInput = z.object({
  quizId: z.string().uuid(),
  topic: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(MAX_GENERATION_COUNT),
  difficulty: z.enum(["easy", "medium", "hard"]),
  types: z.array(SUPPORTED_TYPE_ENUM).min(1).max(SUPPORTED_AI_TYPES.length),
  instructions: z.string().trim().max(500).optional(),
  excludeExistingTopicDuplication: z.boolean().optional(),
});

const regenerateQuestionInput = z.object({
  quizId: z.string().uuid(),
  replace: questionSchema,
  instructions: z.string().trim().max(500).optional(),
});

/**
 * Generate a draft batch of questions for the given quiz.
 *
 * Authorization: server-side `can('ai.generate_questions', quizId)` via
 * the Supabase RPC. Returns the typed GenerationResult envelope; the
 * `not_authorized` error code is set when the principal is not the quiz
 * owner + host-capable.
 */
export const generateQuestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(generateQuestionsInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as {
      supabase: import("@supabase/supabase-js").SupabaseClient;
      userId: string;
    };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Authorize via the existing can(...) resolver.
    const { data: allowed, error: canErr } = await supabase.rpc("can", {
      p_action: "ai.generate_questions",
      p_resource: data.quizId,
    });
    if (canErr) {
      console.error("[ai/generateQuestions] can() RPC failed", canErr);
      return { draft: null, warnings: [], error: "unknown" as const };
    }
    if (allowed !== true) {
      // Authorization denied — log a failed usage row then return the
      // typed envelope. No AI call was made (no provider cost).
      await recordAuthDenied(supabaseAdmin, userId, "ai.generate_questions");
      return { draft: null, warnings: [], error: "not_authorized" as const };
    }

    // 2. Fetch existing question texts (max 20) for de-duplication context.
    // The caller can opt out via excludeExistingTopicDuplication: false.
    // Default (true) sends the existing texts to the LLM so it can avoid
    // duplicates. Opt-out skips the fetch AND sends an empty list.
    let existingQuestionTexts: string[] | undefined;
    if (data.excludeExistingTopicDuplication !== false) {
      const { data: existing, error: qsErr } = await supabase
        .from("questions")
        .select("text")
        .eq("quiz_id", data.quizId)
        .order("position", { ascending: true })
        .limit(20);
      if (!qsErr && existing && existing.length > 0) {
        existingQuestionTexts = (existing as { text: string }[]).map((q) => q.text);
      }
    }

    // 3. Run the AI service.
    const svc = new BrainBoltAiService();
    const req: GenerateQuestionsRequest = {
      quizId: data.quizId,
      topic: data.topic,
      count: data.count,
      difficulty: data.difficulty,
      types: data.types,
      instructions: data.instructions,
      existingQuestionTexts,
    };
    return await svc.generateQuestions(supabaseAdmin, userId, req);
  });

/**
 * Regenerate one previously-generated question. Same authorization model.
 */
export const regenerateQuestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(regenerateQuestionInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as {
      supabase: import("@supabase/supabase-js").SupabaseClient;
      userId: string;
    };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: allowed, error: canErr } = await supabase.rpc("can", {
      p_action: "ai.generate_questions",
      p_resource: data.quizId,
    });
    if (canErr) {
      console.error("[ai/regenerateQuestion] can() RPC failed", canErr);
      return { question: null, warnings: [], error: "unknown" as const };
    }
    if (allowed !== true) {
      await recordAuthDenied(supabaseAdmin, userId, "ai.regenerate_question");
      return { question: null, warnings: [], error: "not_authorized" as const };
    }

    const svc = new BrainBoltAiService();
    const req: RegenerateQuestionRequest = {
      quizId: data.quizId,
      replace: data.replace,
      instructions: data.instructions,
    };
    return await svc.regenerateQuestion(supabaseAdmin, userId, req);
  });

/**
 * Record a denied-auth attempt to ai_usage_log. Mirrors the UsageRecord
 * shape; the entry proves the user tried (and was blocked) so we can audit
 * attempted spend.
 */
async function recordAuthDenied(
  supabaseAdmin: import("@supabase/supabase-js").SupabaseClient,
  principalId: string,
  capability: "ai.generate_questions" | "ai.regenerate_question",
): Promise<void> {
  const { error } = await supabaseAdmin.from("ai_usage_log").insert({
    principal_id: principalId,
    capability,
    model: process.env.BRAINBOLT_AI_MODEL ?? "us.deepseek.r1-v1:0",
    prompt_version:
      capability === "ai.generate_questions" ? "generate_questions_v1" : "regenerate_question_v1",
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    estimated_cost_usd: 0,
    success: false,
    error_kind: "not_authorized",
  });
  if (error) {
    console.error("[ai] failed to record auth-denied row", error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Admin-only server functions (Mission Control)                      */
/* ------------------------------------------------------------------ */

type AdminContext = {
  supabase: import("@supabase/supabase-js").SupabaseClient;
  userId: string;
};

async function requireAdmin(context: AdminContext): Promise<boolean> {
  const { data: allowed } = await context.supabase.rpc("can", {
    p_action: "admin.ai.stats",
    p_resource: null,
  });
  return allowed === true;
}

export const adminAiStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as AdminContext;
    if (!(await requireAdmin(ctx))) {
      return { error: "not_authorized" as const, stats: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await (supabaseAdmin.from("ai_usage_log" as never) as any)
      .select(
        "capability, success, estimated_cost_usd, input_tokens, output_tokens, latency_ms, error_kind, model",
      );

    if (error) {
      console.error("[admin/ai/stats] failed", error);
      return { error: "unknown" as const, stats: null };
    }

    const logs = (rows ?? []) as Array<{
      capability: string;
      success: boolean;
      estimated_cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      latency_ms: number;
      error_kind: string | null;
      model: string;
    }>;

    const totalCalls = logs.length;
    const successCalls = logs.filter((r) => r.success).length;
    const failedCalls = totalCalls - successCalls;
    const totalCostUsd = logs.reduce((a, r) => a + Number(r.estimated_cost_usd || 0), 0);
    const totalInputTokens = logs.reduce((a, r) => a + r.input_tokens, 0);
    const totalOutputTokens = logs.reduce((a, r) => a + r.output_tokens, 0);
    const avgLatencyMs =
      totalCalls > 0 ? logs.reduce((a, r) => a + r.latency_ms, 0) / totalCalls : null;

    const byModel: Record<string, { calls: number; cost: number }> = {};
    for (const r of logs) {
      if (!byModel[r.model]) byModel[r.model] = { calls: 0, cost: 0 };
      byModel[r.model].calls += 1;
      byModel[r.model].cost += Number(r.estimated_cost_usd || 0);
    }

    const byCapability: Record<string, { calls: number; success: number }> = {};
    for (const r of logs) {
      if (!byCapability[r.capability]) byCapability[r.capability] = { calls: 0, success: 0 };
      byCapability[r.capability].calls += 1;
      if (r.success) byCapability[r.capability].success += 1;
    }

    return {
      error: null,
      stats: {
        totalCalls,
        successCalls,
        failedCalls,
        totalCostUsd,
        totalInputTokens,
        totalOutputTokens,
        avgLatencyMs,
        byModel,
        byCapability,
      },
    };
  });

export const adminAiUsageLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as AdminContext;
    if (!(await requireAdmin(ctx))) {
      return { error: "not_authorized" as const, rows: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await (supabaseAdmin.from("ai_usage_log" as never) as any)
      .select(
        "id, principal_id, capability, model, success, estimated_cost_usd, error_kind, created_at, principals(user_id)",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (error) {
      console.error("[admin/ai/usage-log] failed", error);
      return { error: "unknown" as const, rows: null };
    }

    return {
      error: null,
      rows: (rows ?? []) as Array<{
        id: string;
        principal_id: string;
        capability: string;
        model: string;
        success: boolean;
        estimated_cost_usd: number;
        error_kind: string | null;
        created_at: string;
        principals: { user_id: string | null } | null;
      }>,
    };
  });

export const adminAiKillSwitch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      enabled: z.boolean(),
    }),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as AdminContext;
    if (!(await requireAdmin(ctx))) {
      return { error: "not_authorized" as const, enabled: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Record the toggle intent as an audit row in ai_usage_log so the latest
    // state can be reconstructed by reading back through the log.
    const { error } = await (supabaseAdmin.from("ai_usage_log" as never) as any).insert({
      principal_id: ctx.userId,
      capability: "ai.kill_switch_toggled",
      model: "kill_switch",
      prompt_version: "kill_switch_v1",
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      estimated_cost_usd: data.enabled ? 1 : 0,
      success: true,
      error_kind: null,
    });

    if (error) {
      console.error("[admin/ai/kill-switch] failed", error);
      return { error: null, enabled: null };
    }

    return { error: null, enabled: data.enabled };
  });

/* ------------------------------------------------------------------ */
/* Admin-only server functions (Mission Control — System Health)      */
/* ------------------------------------------------------------------ */

type HealthContext = {
  supabase: import("@supabase/supabase-js").SupabaseClient;
  userId: string;
};

type HealthOverviewRow = {
  total_sessions_7d: number;
  stuck_lobby_sessions: number;
  frozen_active_sessions: number;
  avg_response_ms_7d: number | null;
  slow_question_sessions: number;
  completion_rate_7d: number | null;
  total_sessions_all_time: number;
  total_players_all_time: number;
  total_answers_all_time: number;
};

type StuckLobbyRow = {
  session_id: string;
  code: string;
  quiz_title: string;
  host_id: string;
  participant_count: number;
  minutes_stuck: number;
  created_at: string;
};

type FrozenActiveRow = {
  session_id: string;
  code: string;
  quiz_title: string;
  current_question_index: number;
  current_question_started_at: string | null;
  participant_count: number;
  minutes_on_question: number;
};

type SlowQuestionRow = {
  question_id: string;
  question_text: string;
  session_code: string;
  current_question_index: number;
  answer_count: number;
  avg_response_ms: number;
  max_response_ms: number;
  pct_slow_answers: number;
};

type AnswerGapRow = {
  session_id: string;
  code: string;
  quiz_title: string;
  question_id: string;
  gap_seconds: number;
  participant_count: number;
  latest_answer_at: string;
};

async function requireHealthAdmin(context: HealthContext): Promise<boolean> {
  const { data: allowed } = await context.supabase.rpc("can", {
    p_action: "admin.health.stats",
    p_resource: null,
  });
  return allowed === true;
}

export const adminHealthOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as HealthContext;
    if (!(await requireHealthAdmin(ctx))) {
      return { error: "not_authorized" as const, overview: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data, error } = await (supabaseAdmin.rpc as any)("admin_health_overview");

    if (error) {
      console.error("[admin/health/overview] failed", error);
      return { error: "unknown" as const, overview: null };
    }

    const row = (data as HealthOverviewRow | null) ?? null;

    return {
      error: null,
      overview: row
        ? {
            totalSessions7d: Number(row.total_sessions_7d ?? 0),
            stuckLobbySessions: Number(row.stuck_lobby_sessions ?? 0),
            frozenActiveSessions: Number(row.frozen_active_sessions ?? 0),
            avgResponseMs7d: row.avg_response_ms_7d != null ? Number(row.avg_response_ms_7d) : null,
            slowQuestionSessions: Number(row.slow_question_sessions ?? 0),
            completionRate7d: row.completion_rate_7d != null ? Number(row.completion_rate_7d) : null,
            totalSessionsAllTime: Number(row.total_sessions_all_time ?? 0),
            totalPlayersAllTime: Number(row.total_players_all_time ?? 0),
            totalAnswersAllTime: Number(row.total_answers_all_time ?? 0),
          }
        : null,
    };
  });

export const adminHealthStuckLobby = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      minutesStuck: z.number().int().min(1).max(10080).default(15),
    }),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as HealthContext;
    if (!(await requireHealthAdmin(ctx))) {
      return { error: "not_authorized" as const, rows: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await (supabaseAdmin.rpc as any)(
      "admin_health_stuck_lobby_sessions",
      { p_minutes_stuck: data.minutesStuck },
    );

    if (error) {
      console.error("[admin/health/stuck-lobby] failed", error);
      return { error: "unknown" as const, rows: null };
    }

    return {
      error: null,
      rows: (rows as StuckLobbyRow[] | null) ?? [],
    };
  });

export const adminHealthFrozenActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      minutesStuck: z.number().int().min(1).max(10080).default(10),
    }),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as HealthContext;
    if (!(await requireHealthAdmin(ctx))) {
      return { error: "not_authorized" as const, rows: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await (supabaseAdmin.rpc as any)(
      "admin_health_frozen_active_sessions",
      { p_minutes_stuck: data.minutesStuck },
    );

    if (error) {
      console.error("[admin/health/frozen-active] failed", error);
      return { error: "unknown" as const, rows: null };
    }

    return {
      error: null,
      rows: (rows as FrozenActiveRow[] | null) ?? [],
    };
  });

export const adminHealthSlowQuestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      days: z.number().int().min(1).max(90).default(7),
      msThreshold: z.number().int().min(1000).max(3600000).default(60000),
    }),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as HealthContext;
    if (!(await requireHealthAdmin(ctx))) {
      return { error: "not_authorized" as const, rows: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await (supabaseAdmin.rpc as any)(
      "admin_health_slow_questions",
      { p_days: data.days, p_ms_threshold: data.msThreshold },
    );

    if (error) {
      console.error("[admin/health/slow-questions] failed", error);
      return { error: "unknown" as const, rows: null };
    }

    return {
      error: null,
      rows: (rows as SlowQuestionRow[] | null) ?? [],
    };
  });

export const adminHealthAnswerGaps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      days: z.number().int().min(1).max(90).default(7),
      gapSeconds: z.number().int().min(60).max(86400).default(300),
    }),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as HealthContext;
    if (!(await requireHealthAdmin(ctx))) {
      return { error: "not_authorized" as const, rows: null };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await (supabaseAdmin.rpc as any)(
      "admin_health_answer_gaps",
      { p_days: data.days, p_gap_seconds: data.gapSeconds },
    );

    if (error) {
      console.error("[admin/health/answer-gaps] failed", error);
      return { error: "unknown" as const, rows: null };
    }

    return {
      error: null,
      rows: (rows as AnswerGapRow[] | null) ?? [],
    };
  });
