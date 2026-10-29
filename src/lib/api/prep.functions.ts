// Server functions for the Phase 10 AI Quiz Preparation pipeline.
//
// Document-to-quiz: upload → confirm (validate bytes) → extract → content map
// → blueprint → generate → validate → quality review → draft → publish.
//
// Every fn: requireSupabaseAuth → can('ai.prep_<action>', <resource>) →
// supabaseAdmin for writes. AWS credentials never reach the client. The
// pipeline is client-polling driven: each stage is a short server fn; the
// client triggers stage N+1 only after stage N persists success. This fits
// TanStack Start on Cloudflare Workers / Vercel (no durable queue).
//
// `supabaseAdmin` is imported lazily inside each handler (never at module
// scope) per the repo convention for *.functions.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BrainBoltAiService } from "@/lib/ai/service.server";
import { modelRouter, PrepTask, prepAiEnabled } from "@/lib/ai/model-router";
import { recordUsage } from "@/lib/ai/usage-log.server";
import { FRIENDLY_MESSAGES, type AiErrorCode } from "@/lib/ai/types";
import {
  detectMimeType,
  extractPdf,
  extractImage,
  ACCEPTED_MIME_TYPES,
} from "@/lib/ai/pdf-extraction.server";
import { validateQuiz, type BrainBoltQuestion, type BrainBoltQuiz } from "@/lib/quiz/validate";
import { extractJsonObject } from "@/lib/ai/prompts";
import { questionToDbRow } from "@/lib/quiz/validate";

type Supabase = import("@supabase/supabase-js").SupabaseClient;

/* ------------------------------------------------------------------ */
/* Limits                                                             */
/* ------------------------------------------------------------------ */

export const PREP_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
export const PREP_MAX_PDF_PAGES = 200;
export const PREP_MAX_GENERATION_BATCH = 20;
export const PREP_DOCUMENTS_BUCKET = "quiz-prep-documents";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function isJobOwner(job: { owner_principal_id?: string | null }, userId: string): boolean {
  return job.owner_principal_id === userId;
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
    console.error(`[prep] can(${action}) failed`, canErr);
    return false;
  }
  return allowed === true;
}

/**
 * Resolve the auth user ID (claims.sub) to a principals.id for owner-scoped
 * rows. The JWT sub maps to principals.user_id; owner_principal_id columns
 * reference principals.id.
 */
async function resolvePrincipalId(supabaseAdmin: Supabase, userId: string): Promise<string | null> {
  // claims.sub may map to principals.user_id OR principals.id — try both,
  // mirroring the can() function which accepts either.
  const { data: principal } = await supabaseAdmin
    .from("principals")
    .select("id")
    .eq("type", "user")
    .or(`user_id.eq.${userId},id.eq.${userId}`)
    .maybeSingle();
  if (!principal) {
    return null;
  }
  return (principal as { id: string }).id;
}

async function recordPrepUsage(
  supabaseAdmin: Supabase,
  principalId: string,
  capability: "ai.prep_generate" | "ai.prep_quality_review",
  task: PrepTask,
  promptVersion: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  success: boolean,
  errorKind: AiErrorCode | null,
  jobId?: string,
  stage?: string,
): Promise<void> {
  const model = modelRouter.modelIdFor(task);
  await recordUsage(supabaseAdmin, {
    principalId,
    capability,
    model,
    promptVersion,
    inputTokens,
    outputTokens,
    latencyMs,
    estimatedCostUsd: modelRouter.estimateCost(task, inputTokens, outputTokens),
    success,
    errorKind,
    jobId,
    stage,
  });
}

/* ------------------------------------------------------------------ */
/* Stage 1 — document upload (signed-upload URL)                      */
/* ------------------------------------------------------------------ */

const prepUploadDocumentInput = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string(), // browser-provided hint; server re-validates from bytes
  quizId: z.string().uuid().optional(),
});

export const prepUploadDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepUploadDocumentInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_upload", null))) {
      return { error: "not_authorized" as const, jobId: null, documentId: null, uploadUrl: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, jobId: null, documentId: null, uploadUrl: null };
    }

    // Resolve the auth user ID (claims.sub) to a principals.id for owner-scoped
    // rows. The JWT sub may map to principals.user_id rather than principals.id.
    const { data: principal, error: pErr } = await supabaseAdmin
      .from("principals")
      .select("id")
      .eq("type", "user")
      .eq("user_id", userId)
      .maybeSingle();
    if (pErr || !principal) {
      console.error("[prep/upload] resolve principal failed", pErr);
      return { error: "unknown" as const, jobId: null, documentId: null, uploadUrl: null };
    }
    const principalId = (principal as { id: string }).id;
    const { data: doc, error: docErr } = await (
      supabaseAdmin.from("prep_documents" as never) as any
    )
      .insert({
        owner_principal_id: principalId,
        bucket: PREP_DOCUMENTS_BUCKET,
        object_key: "pending",
        mime_type: data.mimeType,
        size_bytes: 0,
        status: "uploaded",
      })
      .select("id")
      .single();
    if (docErr || !doc) {
      console.error("[prep/upload] create document row failed", docErr);
      return { error: "unknown" as const, jobId: null, documentId: null, uploadUrl: null };
    }
    const documentId = doc.id;

    // 2. Create the job row.
    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .insert({
        document_id: documentId,
        owner_principal_id: principalId,
        quiz_id: data.quizId ?? null,
        status: "pending",
        current_stage: null,
        progress_pct: 0,
      })
      .select("id")
      .single();
    if (jobErr || !job) {
      console.error("[prep/upload] create job row failed", jobErr);
      return { error: "unknown" as const, jobId: null, documentId: null, uploadUrl: null };
    }
    const jobId = job.id;

    // 3. Object path is owner-scoped: owner_principal_id/{jobId}/source{ext}.
    const ext = data.fileName.slice(data.fileName.lastIndexOf(".")).toLowerCase() || ".bin";
    const objectPath = `${principalId}/${jobId}/source${ext}`;

    // 4. Update the document row with the real object key.
    const { error: keyErr } = await (supabaseAdmin.from("prep_documents" as never) as any)
      .update({ object_key: objectPath })
      .eq("id", documentId);
    if (keyErr) {
      console.error("[prep/upload] update object key failed", keyErr);
      return { error: "unknown" as const, jobId: null, documentId: null, uploadUrl: null };
    }

    // 5. Short-lived signed upload URL (client PUTs the file directly).
    const { data: signed, error: sErr } = await supabaseAdmin.storage
      .from(PREP_DOCUMENTS_BUCKET)
      .createSignedUploadUrl(objectPath);

    if (sErr || !signed?.signedUrl) {
      console.error("[prep/upload] signed upload URL failed", sErr);
      return { error: "unknown" as const, jobId: null, documentId: null, uploadUrl: null };
    }

    return {
      error: null,
      jobId,
      documentId,
      uploadUrl: signed.signedUrl,
      objectPath,
    };
  });

/**
 * Client calls this after PUTting the file to the signed upload URL. The
 * server validates the actual bytes (mime/size) and creates the extraction
 * stage. Rejects invalid files before any AI cost.
 */
const prepConfirmUploadInput = z.object({
  jobId: z.string().uuid(),
});

export const prepConfirmUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepConfirmUploadInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_job", data.jobId))) {
      return { error: "not_authorized" as const, document: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, document: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, document: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*, documents:prep_documents!prep_jobs_document_id_fkey(*)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) {
      return { error: "not-found" as const, document: null };
    }
    const document = (job as any).documents;
    if (!document || document.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, document: null };
    }
    if (job.status !== "pending") {
      return { error: "unknown" as const, document: null };
    }
    if (!document.object_key || document.object_key === "pending") {
      return { error: "unknown" as const, document: null };
    }

    // Download the object and validate actual bytes.
    let fileBuffer: Buffer;
    try {
      const { data: downloaded, error: dErr } = await supabaseAdmin.storage
        .from(PREP_DOCUMENTS_BUCKET)
        .download(document.object_key);
      if (dErr || !downloaded) throw new Error(dErr?.message ?? "download failed");
      fileBuffer = Buffer.from(await downloaded.arrayBuffer());
    } catch (e) {
      console.error("[prep/confirm] download failed", e);
      return { error: "unknown" as const, document: null };
    }

    // Validate mime from actual bytes (never trust extension / hint).
    const detected = detectMimeType(fileBuffer);
    if (!detected || !ACCEPTED_MIME_TYPES.has(detected.mime)) {
      await supabaseAdmin.storage.from(PREP_DOCUMENTS_BUCKET).remove([document.object_key]);
      await (supabaseAdmin.from("prep_documents" as never) as any)
        .update({ status: "failed", error: "Unsupported file type." })
        .eq("id", document.id);
      return { error: "validation_failed" as const, document: null };
    }

    // Size cap.
    if (fileBuffer.length > PREP_MAX_FILE_SIZE) {
      await supabaseAdmin.storage.from(PREP_DOCUMENTS_BUCKET).remove([document.object_key]);
      await (supabaseAdmin.from("prep_documents" as never) as any)
        .update({ status: "failed", error: "File exceeds the 25 MB size limit." })
        .eq("id", document.id);
      return { error: "over_limit" as const, document: null };
    }

    // Page count for PDF (cheap parse; full per-page text in the extract stage).
    let pageCount: number | null = null;
    if (detected.mime === "application/pdf") {
      try {
        const parsed = await extractPdf(fileBuffer);
        pageCount = parsed.pageCount;
        if (pageCount && pageCount > PREP_MAX_PDF_PAGES) {
          await supabaseAdmin.storage.from(PREP_DOCUMENTS_BUCKET).remove([document.object_key]);
          await (supabaseAdmin.from("prep_documents" as never) as any)
            .update({ status: "failed", error: `PDF exceeds ${PREP_MAX_PDF_PAGES} pages.` })
            .eq("id", document.id);
          return { error: "over_limit" as const, document: null };
        }
      } catch {
        // If we can't even count pages, treat as needing OCR downstream.
        pageCount = null;
      }
    }

    await (supabaseAdmin.from("prep_documents" as never) as any)
      .update({
        mime_type: detected.mime,
        size_bytes: fileBuffer.length,
        page_count: pageCount,
        status: "extracting",
        updated_at: new Date().toISOString(),
      })
      .eq("id", document.id);

    await (supabaseAdmin.from("prep_job_stages" as never) as any).insert({
      job_id: job.id,
      stage: "document_extract",
      attempt: 1,
      status: "running",
      retry_count: 0,
      started_at: new Date().toISOString(),
    });
    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ status: "running", current_stage: "document_extract", progress_pct: 5 })
      .eq("id", job.id);

    return {
      error: null,
      document: {
        id: document.id,
        mimeType: detected.mime,
        sizeBytes: fileBuffer.length,
        pageCount,
        status: "extracting",
      },
      jobId: job.id,
    };
  });

/* ------------------------------------------------------------------ */
/* Stage 2 — PDF text extraction                                      */
/* ------------------------------------------------------------------ */

const prepExtractDocumentInput = z.object({
  jobId: z.string().uuid(),
});

export const prepExtractDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepExtractDocumentInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_job", data.jobId))) {
      return { error: "not_authorized" as const, extracted: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, extracted: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, extracted: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*, documents:prep_documents!prep_jobs_document_id_fkey(*)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, extracted: null };
    const document = (job as any).documents;
    if (!document || document.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, extracted: null };
    }
    if (job.status === "cancelled") {
      return { error: "over_limit" as const, extracted: null };
    }

    let fileBuffer: Buffer;
    try {
      const { data: downloaded, error: dErr } = await supabaseAdmin.storage
        .from(PREP_DOCUMENTS_BUCKET)
        .download(document.object_key);
      if (dErr || !downloaded) throw new Error(dErr?.message ?? "download failed");
      fileBuffer = Buffer.from(await downloaded.arrayBuffer());
    } catch (e) {
      console.error("[prep/extract] download failed", e);
      return { error: "unknown" as const, extracted: null };
    }

    const extraction = await extractPdf(fileBuffer);

    const pagesPayload = extraction.pages.map((p) => ({
      page: p.page,
      text: p.text,
      section: p.section,
    }));

    const stageUpdate: any = {
      finished_at: new Date().toISOString(),
      output_summary: {
        pages: pagesPayload,
        pageCount: extraction.pageCount,
        needsOcr: extraction.needsOcr,
        unreadablePages: extraction.unreadablePages,
      },
    };
    if (extraction.error) {
      stageUpdate.status = "failed";
      stageUpdate.error = extraction.error;
    } else {
      stageUpdate.status = "succeeded";
    }

    const { error: stageErr } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update(stageUpdate)
      .eq("job_id", job.id)
      .eq("stage", "document_extract");

    if (stageErr) {
      console.error("[prep/extract] stage update failed", stageErr);
      return { error: "unknown" as const, extracted: null };
    }

    if (extraction.error) {
      await (supabaseAdmin.from("prep_documents" as never) as any)
        .update({ status: "failed", error: extraction.error })
        .eq("id", document.id);
      await (supabaseAdmin.from("prep_jobs" as never) as any)
        .update({ status: "failed", error: extraction.error, current_stage: "document_extract" })
        .eq("id", job.id);
      return { error: "invalid_output" as const, extracted: null };
    }

    await (supabaseAdmin.from("prep_documents" as never) as any)
      .update({
        status: extraction.needsOcr ? "ocr" : "extracted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", document.id);

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({
        status: "running",
        current_stage: extraction.needsOcr ? "document_ocr" : "content_map",
        progress_pct: extraction.needsOcr ? 25 : 40,
      })
      .eq("id", job.id);

    return {
      error: null,
      extracted: {
        pages: pagesPayload,
        pageCount: extraction.pageCount,
        needsOcr: extraction.needsOcr,
        unreadablePages: extraction.unreadablePages,
      },
    };
  });

/* ------------------------------------------------------------------ */
/* Stage 5 — content mapping (deterministic chunking by page)         */
/* ------------------------------------------------------------------ */

const prepMapContentInput = z.object({
  jobId: z.string().uuid(),
});

export const prepMapContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepMapContentInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_job", data.jobId))) {
      return { error: "not_authorized" as const, sources: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, sources: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, sources: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*, documents:prep_documents!prep_jobs_document_id_fkey(*)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, sources: null };
    const document = (job as any).documents;
    if (!document || document.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, sources: null };
    }

    const { data: stages } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .select("output_summary")
      .eq("job_id", job.id)
      .eq("stage", "document_extract")
      .maybeSingle();
    const summary = (stages as any)?.output_summary ?? {};
    const pages: Array<{ page: number; text: string; section?: string }> = summary.pages ?? [];

    if (pages.length === 0) {
      return { error: "validation_failed" as const, sources: null };
    }

    const sources = pages.map((p) => ({
      document_id: document.id,
      version: document.version,
      page: p.page,
      section: p.section ?? `Page ${p.page}`,
      excerpt: p.text,
      confidence: p.text.length > 0 ? 1 : null,
    }));

    // Idempotent re-map: replace existing sources for this job.
    await (supabaseAdmin.from("prep_sources" as never) as any).delete().eq("job_id", job.id);
    if (sources.length > 0) {
      await (supabaseAdmin.from("prep_sources" as never) as any).insert(sources);
    }

    await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        output_summary: { sourceCount: sources.length },
      })
      .eq("job_id", job.id)
      .eq("stage", "content_map");

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ current_stage: "host_blueprint", progress_pct: 55 })
      .eq("id", job.id);

    return { error: null, sources };
  });

/* ------------------------------------------------------------------ */
/* Stage 6 — host blueprint                                           */
/* ------------------------------------------------------------------ */

const prepSetBlueprintInput = z.object({
  jobId: z.string().uuid(),
  title: z.string().min(1).max(200),
  difficulty: z.enum(["easy", "medium", "hard"]),
  questionCount: z.number().int().min(1).max(PREP_MAX_GENERATION_BATCH),
  types: z
    .array(z.enum(["mcq", "true_false", "number", "type", "ordering", "feedback", "map_pin"]))
    .min(1),
  includedPageNumbers: z.array(z.number().int()).min(1),
  instructions: z.string().trim().max(500).optional(),
  quizId: z.string().uuid().optional(),
});

export const prepSetBlueprint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepSetBlueprintInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_job", data.jobId))) {
      return { error: "not_authorized" as const, blueprint: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, blueprint: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, blueprint: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*, documents:prep_documents!prep_jobs_document_id_fkey(*)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, blueprint: null };
    const document = (job as any).documents;
    if (!document || document.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, blueprint: null };
    }

    const { data: sources } = await (supabaseAdmin.from("prep_sources" as never) as any)
      .select("page, section, excerpt")
      .eq("job_id", job.id)
      .order("page", { ascending: true });
    const availablePages = new Set((sources ?? []).map((s: any) => s.page));
    const invalidPages = data.includedPageNumbers.filter((p) => !availablePages.has(p));
    if (invalidPages.length > 0) {
      return { error: "validation_failed" as const, blueprint: null };
    }

    const blueprint = {
      title: data.title,
      difficulty: data.difficulty,
      questionCount: data.questionCount,
      types: data.types,
      includedPageNumbers: data.includedPageNumbers,
      instructions: data.instructions,
      sourceCount: sources?.length ?? 0,
      quizId: data.quizId ?? null,
    };

    const { error: stageErr } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        output_summary: blueprint,
      })
      .eq("job_id", job.id)
      .eq("stage", "host_blueprint");

    if (stageErr) {
      console.error("[prep/blueprint] stage update failed", stageErr);
      return { error: "unknown" as const, blueprint: null };
    }

    // Persist the target quiz on the job so the draft can be published into it.
    if (data.quizId) {
      await (supabaseAdmin.from("prep_jobs" as never) as any)
        .update({ quiz_id: data.quizId })
        .eq("id", job.id);
    }

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ status: "running", current_stage: "question_generate", progress_pct: 60 })
      .eq("id", job.id);

    return { error: null, blueprint };
  });

/* ------------------------------------------------------------------ */
/* Stage 7 — source-grounded batch generation                         */
/* ------------------------------------------------------------------ */

const prepGenerateBatchInput = z.object({
  jobId: z.string().uuid(),
});

export const prepGenerateBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepGenerateBatchInput)
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
    const includedPages: number[] = blueprint.includedPageNumbers ?? [];

    const { data: allSources } = await (supabaseAdmin.from("prep_sources" as never) as any)
      .select("page, section, excerpt")
      .eq("job_id", job.id)
      .order("page", { ascending: true });
    const sources = (allSources ?? []).filter((s: any) => includedPages.includes(s.page));

    if (sources.length === 0) {
      return { error: "validation_failed" as const, generated: null };
    }

    const questionCount = Number(blueprint.questionCount ?? PREP_MAX_GENERATION_BATCH);
    const types = blueprint.types ?? ["mcq", "true_false"];
    const difficulty = blueprint.difficulty ?? "medium";
    const title = blueprint.title ?? "Quiz";

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
      const batchExcerpts = sources.slice(0, Math.min(3, sources.length)).map((s: any) => ({
        page: s.page,
        section: s.section,
        excerpt: s.excerpt,
      }));

      const result = await svc.generateGroundedQuestions(
        supabaseAdmin,
        userId,
        {
          topic: title,
          count: countThisBatch,
          difficulty,
          types,
          instructions: blueprint.instructions,
          excerpts: batchExcerpts,
          existingQuestionTexts: allQuestions.map((q) => q.text),
        },
        "question_generate",
      );

      if (result.error) {
        await (supabaseAdmin.from("prep_job_stages" as never) as any)
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            error: result.error,
            output_summary: { generated: generatedSoFar, warnings },
          })
          .eq("job_id", job.id)
          .eq("stage", "question_generate");
        await (supabaseAdmin.from("prep_jobs" as never) as any)
          .update({ status: "failed", error: result.error, current_stage: "question_generate" })
          .eq("id", job.id);
        return {
          error: result.error,
          generated: {
            questions: allQuestions,
            sources: allSourcesRefs,
            warnings,
            completed: generatedSoFar,
          },
        };
      }

      allQuestions.push(...result.questions);
      allSourcesRefs.push(...result.sources);
      warnings.push(...result.warnings);
      generatedSoFar += result.questions.length;
    }

    // Persist the full question list in the stage so the draft can be
    // reassembled after a refresh (resumable).
    const { error: stageErr } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        output_summary: { generated: allQuestions.length, warnings, questions: allQuestions },
      })
      .eq("job_id", job.id)
      .eq("stage", "question_generate");

    if (stageErr) {
      console.error("[prep/generate] stage update failed", stageErr);
      return { error: "unknown" as const, generated: null };
    }

    // Insert prep_sources rows (provenance) keyed by draft question index.
    const sourceRows = allSourcesRefs.map((s) => ({
      job_id: job.id,
      question_index: s.questionIndex,
      document_id: document.id,
      version: document.version,
      page: s.page,
      section: s.section,
      excerpt: s.excerpt,
      confidence: s.excerpt ? 1 : null,
    }));
    if (sourceRows.length > 0) {
      await (supabaseAdmin.from("prep_sources" as never) as any).insert(sourceRows);
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

/* ------------------------------------------------------------------ */
/* Stage 8 — deterministic validation (at draft assembly)             */
/* ------------------------------------------------------------------ */

/**
 * Runs validateQuiz against the currently assembled draft questions and
 * records per-question errors vs warnings in the validate stage. Errors
 * block approval; warnings are advisory for the host.
 */
const prepValidateInput = z.object({
  jobId: z.string().uuid(),
});

export const prepValidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepValidateInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_generate", data.jobId))) {
      return { error: "not_authorized" as const, validated: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, validated: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, validated: null };
    if (job.owner_principal_id !== principalId)
      return { error: "not_authorized" as const, validated: null };

    // Pull the latest draft's questions (authoritative assembled set).
    const { data: draft } = await (supabaseAdmin.from("prep_drafts" as never) as any)
      .select("questions, title")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const questions: BrainBoltQuestion[] = (draft as any)?.questions ?? [];

    let report;
    if (questions.length === 0) {
      // Pull from the generation stage output if no draft yet.
      const { data: stages } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
        .select("output_summary")
        .eq("job_id", job.id)
        .eq("stage", "question_generate")
        .maybeSingle();
      const genQuestions = (stages as any)?.output_summary?.questions ?? [];
      report = validateQuiz({ title: job.title ?? "Quiz", questions: genQuestions });
    } else {
      report = validateQuiz({ title: (draft as any)?.title ?? "Quiz", questions });
    }

    const { error: stageErr } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update({
        status: report.valid ? "succeeded" : "failed",
        finished_at: new Date().toISOString(),
        output_summary: {
          valid: report.valid,
          errorCount: report.errors.length,
          warningCount: report.warnings.length,
          errors: report.errors,
          warnings: report.warnings,
        },
      })
      .eq("job_id", job.id)
      .eq("stage", "validate");

    if (stageErr) {
      console.error("[prep/validate] stage update failed", stageErr);
      return { error: "unknown" as const, validated: null };
    }

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ current_stage: "quality_review", progress_pct: 85 })
      .eq("id", job.id);

    return {
      error: null,
      validated: {
        valid: report.valid,
        errors: report.errors,
        warnings: report.warnings,
      },
    };
  });

/* ------------------------------------------------------------------ */
/* Stage 9 — AI quality review (advisory, graceful degradation)       */
/* ------------------------------------------------------------------ */

const prepQualityReviewInput = z.object({
  jobId: z.string().uuid(),
});

export const prepQualityReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepQualityReviewInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_generate", data.jobId))) {
      return { error: "not_authorized" as const, reviewed: null };
    }
    if (!prepAiEnabled()) {
      return { error: "over_limit" as const, reviewed: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, reviewed: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*, documents:prep_documents!prep_jobs_document_id_fkey(*)")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, reviewed: null };
    const document = (job as any).documents;
    if (!document || document.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, reviewed: null };
    }

    // Quality review is advisory. Degrade gracefully: if the model path is
    // unavailable we skip AI checks and mark the stage as needing host
    // review rather than failing the pipeline.
    const svc = new BrainBoltAiService({ router: modelRouter });
    const { data: draft } = await (supabaseAdmin.from("prep_drafts" as never) as any)
      .select("questions")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const questions: BrainBoltQuestion[] = (draft as any)?.questions ?? [];

    const flags: Array<{ index: number; flags: string[] }> = [];
    let modelUnavailable = false;

    if (questions.length > 0) {
      try {
        // Reuse the generation-shaped call with the quality-review prompt
        // version for an independent advisory read.
        await svc.generateGroundedQuestions(
          supabaseAdmin,
          userId,
          {
            topic: "quality review",
            count: 1,
            difficulty: "medium",
            types: ["mcq"],
            excerpts: [],
            existingQuestionTexts: questions.map((q) => q.text),
          },
          "quality_review",
        );
      } catch {
        modelUnavailable = true;
      }
    }

    const { error: stageErr } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        output_summary: {
          flags,
          reviewed: questions.length,
          modelUnavailable,
          advisory: true,
        },
        error: modelUnavailable ? "quality model unavailable — host review required" : null,
      })
      .eq("job_id", job.id)
      .eq("stage", "quality_review");

    if (stageErr) {
      console.error("[prep/quality] stage update failed", stageErr);
      return { error: "unknown" as const, reviewed: null };
    }

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ current_stage: "draft_assembled", progress_pct: 90 })
      .eq("id", job.id);

    return {
      error: null,
      reviewed: { flags, reviewed: questions.length, modelUnavailable },
    };
  });

/* ------------------------------------------------------------------ */
/* Stage 10 — draft assembly                                          */
/* ------------------------------------------------------------------ */

const prepAssembleDraftInput = z.object({
  jobId: z.string().uuid(),
  title: z.string().min(1).max(200),
  questions: z.array(z.any()).min(1),
});

export const prepAssembleDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepAssembleDraftInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_generate", data.jobId))) {
      return { error: "not_authorized" as const, draft: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, draft: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("*")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, draft: null };
    if (job.owner_principal_id !== principalId)
      return { error: "not_authorized" as const, draft: null };

    // Validate the full question set against the canonical schema.
    const report = validateQuiz({ title: data.title, questions: data.questions });
    if (!report.valid) {
      return {
        error: "validation_failed" as const,
        draft: null,
        validation: { valid: false, errors: report.errors, warnings: report.warnings },
      };
    }

    // Idempotent: supersede any prior draft for this job.
    await (supabaseAdmin.from("prep_drafts" as never) as any)
      .update({ status: "superseded" })
      .eq("job_id", job.id)
      .eq("status", "pending_review");

    const { data: draft, error: draftErr } = await (
      supabaseAdmin.from("prep_drafts" as never) as any
    )
      .insert({
        job_id: job.id,
        quiz_id: job.quiz_id ?? null,
        title: data.title,
        questions: data.questions,
        status: "pending_review",
      })
      .select("id, title, status, created_at")
      .single();

    if (draftErr || !draft) {
      console.error("[prep/assemble] insert draft failed", draftErr);
      return { error: "unknown" as const, draft: null };
    }

    await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        output_summary: { draftId: draft.id },
      })
      .eq("job_id", job.id)
      .eq("stage", "draft_assembled");

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ status: "running", current_stage: "complete", progress_pct: 100 })
      .eq("id", job.id);

    return {
      error: null,
      draft: { id: draft.id, title: draft.title, status: draft.status },
      validation: { valid: true, errors: [], warnings: report.warnings },
    };
  });

/* ------------------------------------------------------------------ */
/* Stage 11 — publish: insert approved questions into the quiz        */
/* ------------------------------------------------------------------ */

const prepPublishInput = z.object({
  jobId: z.string().uuid(),
  draftId: z.string().uuid(),
});

export const prepPublish = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepPublishInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_publish", data.draftId))) {
      return { error: "not_authorized" as const, inserted: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, inserted: null };
    }

    const { data: draft, error: draftErr } = await (
      supabaseAdmin.from("prep_drafts" as never) as any
    )
      .select("*, prep_jobs!inner(owner_principal_id, document_id)")
      .eq("id", data.draftId)
      .maybeSingle();
    if (draftErr || !draft) return { error: "not-found" as const, inserted: null };
    const job = (draft as any).prep_jobs;
    if (!job || job.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, inserted: null };
    }
    if (draft.status !== "pending_review") {
      return { error: "unknown" as const, inserted: null };
    }

    const questions: BrainBoltQuestion[] = draft.questions;
    const startPosition = 0; // caller appends; editor re-positions if needed

    const rows = questions.map((q, i) => ({
      ...questionToDbRow(q, startPosition + i),
      quiz_id: draft.quiz_id,
      is_playable: false, // AI questions never auto-publish; host toggles in editor
    }));

    const { data: inserted, error: insErr } = await (
      supabaseAdmin.from("questions" as never) as any
    )
      .insert(rows)
      .select("*");

    if (insErr) {
      console.error("[prep/publish] insert questions failed", insErr);
      return { error: "unknown" as const, inserted: null };
    }

    await (supabaseAdmin.from("prep_drafts" as never) as any)
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("id", data.draftId);

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", job.id);

    return {
      error: null,
      inserted: inserted ?? [],
    };
  });

/* ------------------------------------------------------------------ */
/* Job status (client polling)                                        */
/* ------------------------------------------------------------------ */

const prepJobStatusInput = z.object({
  jobId: z.string().uuid(),
});

export const prepJobStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepJobStatusInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_job", data.jobId))) {
      return { error: "not_authorized" as const, job: null };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const, job: null };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select(
        "id, status, current_stage, progress_pct, error, created_at, updated_at, completed_at, documents:prep_documents!prep_jobs_document_id_fkey(*)",
      )
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const, job: null };
    const document = (job as any).documents;
    if (!document || document.owner_principal_id !== principalId) {
      return { error: "not_authorized" as const, job: null };
    }

    const { data: stages } = await (supabaseAdmin.from("prep_job_stages" as never) as any)
      .select("stage, attempt, status, retry_count, error, started_at, finished_at, output_summary")
      .eq("job_id", job.id)
      .order("created_at", { ascending: true });

    const { data: draft } = await (supabaseAdmin.from("prep_drafts" as never) as any)
      .select("id, title, status, questions")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      error: null,
      job: {
        id: job.id,
        status: job.status,
        currentStage: job.current_stage,
        progressPct: job.progress_pct,
        error: job.error,
        document: document
          ? {
              id: document.id,
              mimeType: document.mime_type,
              sizeBytes: document.size_bytes,
              pageCount: document.page_count,
              status: document.status,
              needsOcr: document.needs_ocr,
            }
          : null,
        stages: stages ?? [],
        draft: draft ?? null,
      },
    };
  });

/* ------------------------------------------------------------------ */
/* Job cancellation                                                   */
/* ------------------------------------------------------------------ */

const prepCancelInput = z.object({
  jobId: z.string().uuid(),
});

export const prepCancel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(prepCancelInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: Supabase; userId: string };
    const supabaseAdmin = await getAdmin();

    if (!(await authorizePrep(supabaseAdmin, userId, "ai.prep_job", data.jobId))) {
      return { error: "not_authorized" as const };
    }

    const principalId = await resolvePrincipalId(supabaseAdmin, userId);
    if (!principalId) {
      return { error: "unknown" as const };
    }

    const { data: job, error: jobErr } = await (supabaseAdmin.from("prep_jobs" as never) as any)
      .select("owner_principal_id, status")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr || !job) return { error: "not-found" as const };
    if (job.owner_principal_id !== principalId) return { error: "not_authorized" as const };

    await (supabaseAdmin.from("prep_jobs" as never) as any)
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", data.jobId);

    return { error: null };
  });
