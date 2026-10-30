// Server functions for topic-based AI quiz preparation.
//
// These are additive to the existing Phase 10 prep pipeline
// (src/lib/api/prep.functions.ts). A topic-based job is backed by a
// placeholder prep_document (object_key `topic://<slug>`, no file in
// storage) and a single synthetic prep_source carrying the topic text as
// its excerpt. The job skips extraction/OCR/content-map and advances
// straight to the host_blueprint stage, then reuses the existing
// prepSetBlueprint / prepGenerateBatch / prepValidate /
// prepQualityReview / prepAssembleDraft / prepPublish server fns.
//
// Every fn: requireSupabaseAuth → can('ai.prep_*', <resource>) →
// supabaseAdmin for writes. AWS credentials never reach the client.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BrainBoltAiService } from "@/lib/ai/service.server";
import { modelRouter, prepAiEnabled } from "@/lib/ai/model-router";
import { prepTaskConfig } from "@/lib/ai/cost-table";
import { PROMPT_PREP_VERSIONS } from "@/lib/ai/prep-prompts";
import { recordUsage } from "@/lib/ai/usage-log.server";
import { FRIENDLY_MESSAGES, type AiErrorCode } from "@/lib/ai/types";
import { validateQuiz, type BrainBoltQuestion } from "@/lib/quiz/validate";
import { extractJsonObject } from "@/lib/ai/prompts";
import { questionToDbRow } from "@/lib/quiz/validate";

type Supabase = import("@supabase/supabase-js").SupabaseClient;

const TOPIC_DOCUMENT_BUCKET = "quiz-prep-documents";
const TOPIC_OBJECT_KEY_PREFIX = "topic://";

async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function resolvePrincipalId(supabaseAdmin: Supabase, userId: string): Promise<string | null> {
  const { data: principal } = await supabaseAdmin
    .from("principals")
    .select("id")
    .eq("type", "user")
    .or(`user_id.eq.${userId},id.eq.${userId}`)
    .maybeSingle();
  if (!principal) return null;
  return (principal as { id: string }).id;
}

async function authorizePrep(
  supabaseAdmin: Supabase,
  principalId: string,
  action: string,
  resource: string | null,
): Promise<boolean> {
  const { data: allowed, error: canErr } = await supabaseAdmin.rpc("can", {
    p_principal: principalId,
    p_action: action,
    p_resource: resource ?? null,
  });
  if (canErr) {
    console.error(`[prep/topic] can(${action}) failed`, canErr);
    return false;
  }
  return allowed === true;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* Stage 1 (topic) — create job + placeholder document + source       */
/* ------------------------------------------------------------------ */

const prepCreateTopicJobInput = z.object({
  topic: z.string().trim().min(1).max(200),
  quizId: z.string().uuid().optional(),
});

export const prepCreateTopicJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepCreateTopicJobInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_upload", null))) {
      return { error: "not_authorized" as const, jobId: null, documentId: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, jobId: null, documentId: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, jobId: null, documentId: null };
    }

    const topicSlug = slugify(data.topic);
    const objectKey = `${TOPIC_OBJECT_KEY_PREFIX}${topicSlug}-${crypto.randomUUID().slice(0, 8)}`;

    // Placeholder document: no file in storage, status already "extracted"
    // so the pipeline skips extract/OCR/map.
    const { data: doc, error: docErr } = await (
      supabaseAdmin.from("prep_documents" as never) as any
    )
      .insert({
        owner_principal_id: principalId,
        bucket: TOPIC_DOCUMENT_BUCKET,
        object_key: objectKey,
        mime_type: "text/plain",
        size_bytes: 0,
        status: "extracted",
        needs_ocr: false,
      })
      .select("id")
      .single();
    if (docErr || !doc) {
      console.error("[prep/topic] create document row failed", docErr);
      return { error: "unknown" as const, jobId: null, documentId: null };
    }
    const documentId = doc.id;

    // Synthetic prep_source carrying the topic text as the excerpt.
    // Page 1, section "Topic" — the single source anchor for topic-based jobs.
    const { error: srcErr } = await (
      supabaseAdmin.from("prep_sources" as never) as any
    ).insert({
      job_id: "00000000-0000-0000-0000-000000000000", // placeholder, updated after job insert
      question_index: -1,
      document_id: documentId,
      version: 1,
      page: 1,
      section: "Topic",
      excerpt: data.topic,
      confidence: 1,
    });
    if (srcErr) {
      console.error("[prep/topic] insert placeholder source failed", srcErr);
      // Non-fatal: blueprint stage self-heals missing sources.
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .insert({
        document_id: documentId,
        owner_principal_id: principalId,
        quiz_id: data.quizId ?? null,
        topic: data.topic,
        status: "running",
        current_stage: "host_blueprint",
        progress_pct: 40,
      })
      .select("id")
      .single();
    if (jobErr || !job) {
      console.error("[prep/topic] create job row failed", jobErr);
      return { error: "unknown" as const, jobId: null, documentId: null };
    }
    const jobId = job.id;

    // Fix the placeholder job_id on the synthetic source row.
    if (!srcErr) {
      await (supabaseAdmin.from("prep_sources" as never) as any)
        .update({ job_id: jobId })
        .eq("job_id", "00000000-0000-0000-0000-000000000000");
    }

    // Content-map stage is trivially satisfied (one synthetic source).
    await (supabaseAdmin.from("prep_job_stages" as never) as any).insert({
      job_id: jobId,
      stage: "content_map",
      attempt: 1,
      status: "succeeded",
      retry_count: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      output_summary: { sourceCount: 1 },
    });

    return {
      error: null,
      jobId,
      documentId,
    };
  });

/* ------------------------------------------------------------------ */
/* Topic batch generation — reuses prepGenerateBatch's logic but works
 * when there are no real pages: generates from the topic excerpt.      */
/* ------------------------------------------------------------------ */

const prepGenerateTopicBatchInput = z.object({
  jobId: z.string().uuid(),
});

export const prepGenerateTopicBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepGenerateTopicBatchInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_generate", data.jobId))) {
      return { error: "not_authorized" as const, generated: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, generated: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, generated: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*, documents:prep_documents!prep_jobs_document_id_fkey(*)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, generated: null };
    const document = (job as any).documents;
    if (!document || document.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, generated: null };
    }
    if (job.status === "cancelled") {
      return { error: "over_limit" as const, generated: null };
    }

    const { data: stages } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .select("stage, output_summary")
      .eq("job_id", job.id);
    const byStage = Object.fromEntries((stages ?? []).map((s: any) => [s.stage, s.output_summary]));
    const blueprint: any = byStage.host_blueprint ?? {};

    const questionCount = Number(blueprint.questionCount ?? 5);
    const types = blueprint.types ?? ["mcq", "true_false"];
    const difficulty = blueprint.difficulty ?? "medium";
    const title = blueprint.title ?? "Quiz";
    const instructions = blueprint.instructions;

    // The single synthetic source holds the topic as its excerpt.
    const { data: allSources } = await (supabaseAdmin.from("prep_sources" as never) as any)
      .select("page, section, excerpt")
      .eq("job_id", job.id)
      .eq("question_index", -1)
      .order("page", { ascending: true });

    const sources = (allSources ?? []).filter((s: any) => s.page === 1);
    if (sources.length === 0) {
      return {
        error: "validation_failed" as const,
        detail: "No topic source found for this job. Re-create the preparation.",
        generated: null,
      };
    }

    const topicExcerpt = sources[0].excerpt;

    const svc = new BrainBoltAiService({ router: modelRouter });
    const allQuestions: BrainBoltQuestion[] = [];
    const allSourcesRefs: Array<{
      questionIndex: number;
      page: number;
      section: string | null;
      excerpt: string;
    }> = [];
    const warnings: string[] = [];

    let generatedSoFar = 0;
    for (let b = 0; b < Math.ceil(questionCount / 5) && generatedSoFar < questionCount; b++) {
      const remaining = questionCount - generatedSoFar;
      const countThisBatch = Math.min(5, remaining);

      const result = await svc.generateGroundedQuestions(
        supabaseAdmin,
        userId,
        {
          topic: title,
          count: countThisBatch,
          difficulty,
          types,
          instructions,
          excerpts: [{ page: 1, section: "Topic", excerpt: topicExcerpt }],
          existingQuestionTexts: allQuestions.map((q) => q.text),
        },
        "question_generate",
      );

      if (result.error) {
        const failureWarnings = [...warnings, ...result.warnings];
        await (supabaseAdmin.from("prep_job_stages" as never) as any)
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            error: result.error,
            output_summary: { generated: generatedSoFar, warnings: failureWarnings },
          })
          .eq("job_id", job.id)
          .eq("stage", "question_generate");
        await (supabaseAdmin.from("prep_jobs" as never) as any)
          .update({ status: "failed", error: result.error, current_stage: "question_generate" })
          .eq("id", job.id);
        return {
          error: result.error,
          detail: failureWarnings.slice(0, 3).join(" · ") || `No usable questions came back.`,
          generated: {
            questions: allQuestions,
            sources: allSourcesRefs,
            warnings: failureWarnings,
            completed: generatedSoFar,
          },
        };
      }

      allQuestions.push(...result.questions);
      allSourcesRefs.push(...result.sources);
      warnings.push(...result.warnings);
      generatedSoFar += result.questions.length;
    }

    const generateWrite = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        output_summary: { generated: allQuestions.length, warnings, questions: allQuestions },
      })
      .eq("job_id", job.id)
      .eq("stage", "question_generate");

    if (generateWrite.error) {
      console.error("[prep/topic/generate] stage write failed", generateWrite.error);
      return { error: "unknown" as const, detail: generateWrite.error, generated: null };
    }

    // Per-question provenance rows keyed by draft question index.
    const sourceRows = allSourcesRefs.map((s) => ({
      job_id: job.id,
      question_index: s.questionIndex,
      document_id: document.id,
      version: document.version ?? 1,
      page: s.page,
      section: s.section,
      excerpt: s.excerpt,
      confidence: s.excerpt ? 1 : null,
    }));
    if (sourceRows.length > 0) {
      const { error: srcErr } = await (
        supabaseAdmin.from("prep_sources" as never) as any
      ).insert(sourceRows);
      if (srcErr) {
        console.error("[prep/topic/generate] insert sources failed", srcErr);
        return { error: "unknown" as const, detail: srcErr.message, generated: null };
      }
      // Drop the -1 sentinel page-level row.
      await (supabaseAdmin.from("prep_sources" as never) as any)
        .delete()
        .eq("job_id", job.id)
        .eq("question_index", -1);
    }

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ current_stage: "validate", progress_pct: 80 })
      .eq("id", job.id);

    return {
      error: null,
      generated: {
        questions: allQuestions,
        sources: allSourcesRefs,
        warnings,
        completed: allQuestions.length,
      },
    };
  });
