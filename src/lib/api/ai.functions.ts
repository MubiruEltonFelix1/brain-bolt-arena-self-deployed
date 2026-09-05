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
