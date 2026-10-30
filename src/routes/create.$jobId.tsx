// Brain Bolt — unified preparation + review page.
//
// Handles both document-based jobs (created via /prep/new or /create → From
// Material) and topic-based jobs (created via /create → From a Topic).
//
// Stages:
//   document_extract → document_ocr → content_map → host_blueprint →
//   question_generate → validate → quality_review → draft_assembled →
//   review → publish → /quizzes/$id
//
// Topic-based jobs skip extract/ocr/map and advance straight to host_blueprint.
//
// Reuses SharedQuestionReview for the review stage and prepPublish for the
// final save. Document-based jobs also continue to work via the existing
// /prep/$jobId route unchanged.

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { HostShell } from "@/components/host-shell";
import { useAuthUser } from "@/hooks/use-auth-user";
import { supabase } from "@/integrations/supabase/client";
import {
  prepSetBlueprint,
  prepGenerateBatch,
  prepValidate,
  prepQualityReview,
  prepAssembleDraft,
  prepPublish,
  prepExtractDocument,
  prepOcrDocument,
  prepMapContent,
  prepJobStatus,
  prepCancel,
} from "@/lib/api/prep.functions";
import { SharedQuestionReview } from "@/components/quiz/SharedQuestionReview";
import { getQuestionType } from "@/lib/question-registry";
import type { BrainBoltQuestion } from "@/lib/quiz/validate";
import { validateQuiz } from "@/lib/quiz/validate";
import { toast } from "sonner";

export const Route = createFileRoute("/create/$jobId")({
  component: CreateJob,
});

type PrepJob = {
  id: string;
  status: string;
  currentStage: string | null;
  progressPct: number;
  error: string | null;
  document: {
    id: string;
    mimeType: string;
    sizeBytes: number;
    pageCount: number | null;
    status: string;
    needsOcr: boolean;
  } | null;
  stages: Array<{
    stage: string;
    attempt: number;
    status: string;
    retryCount: number;
    error: string | null;
    outputSummary: any;
  }>;
  draft: {
    id: string;
    title: string;
    status: string;
    questions: BrainBoltQuestion[];
    quiz_id: string | null;
  } | null;
};

type ExtractedPage = {
  page: number;
  text: string;
  section: string | null;
};

const STAGE_LABELS: Record<string, string> = {
  document_extract: "Extracting content",
  document_ocr: "OCR / reading pages",
  content_map: "Content map",
  host_blueprint: "Quiz blueprint",
  question_generate: "Generating questions",
  validate: "Validation",
  quality_review: "Quality review",
  draft_assembled: "Draft ready",
};

function CreateJob() {
  const { jobId } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [job, setJob] = useState<PrepJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Content map review
  const [pages, setPages] = useState<ExtractedPage[]>([]);
  const [includedPages, setIncludedPages] = useState<Set<number>>(new Set());
  const [mapping, setMapping] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);

  // Blueprint
  const [blueprint, setBlueprint] = useState({
    title: "",
    difficulty: "medium" as const,
    questionCount: 5,
    types: ["mcq", "true_false"] as string[],
    instructions: "",
    quizId: "" as string,
  });
  const [quizzes, setQuizzes] = useState<Array<{ id: string; title: string }>>([]);

  // Generation / review
  const [generating, setGenerating] = useState(false);
  const [questions, setQuestions] = useState<BrainBoltQuestion[]>([]);
  const [reviewWarnings, setReviewWarnings] = useState<string[]>([]);
  const [editedTexts, setEditedTexts] = useState<Record<number, string>>({});
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    errors: Array<{ questionIndex: number | null; field: string; message: string }>;
    warnings: Array<{ questionIndex: number | null; message: string }>;
  } | null>(null);

  const draftSyncRef = useRef<string>("");
  const pagesSyncRef = useRef<string>("");
  const autoRanRef = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const result = await prepJobStatus({ data: { jobId } });
      if (result.error) {
        setError(
          result.error === "not_authorized" ? "You can't view this job." : "Couldn't load the job.",
        );
        if (!silent) setLoading(false);
        return;
      }
      setJob(result.job ?? null);
      if (!silent) setLoading(false);
    },
    [jobId],
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data: qs } = await supabase
        .from("quizzes")
        .select("id,title")
        .eq("owner_principal_id", user.id)
        .is("archived_at", null)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setQuizzes(
        ((qs as Array<{ id: string; title: string } | null>) ?? []).filter(
          (q): q is { id: string; title: string } => !!q,
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load({ silent: true }), 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load, jobId]);

  useEffect(() => {
    if (job?.stages) {
      const withText = (p: ExtractedPage) => (p.text ?? "").trim().length > 0;
      const extractPages: ExtractedPage[] =
        job.stages.find((s) => s.stage === "document_extract")?.outputSummary?.pages ?? [];
      const ocrPages: ExtractedPage[] =
        job.stages.find((s) => s.stage === "document_ocr")?.outputSummary?.pages ?? [];
      const loadedPages =
        ocrPages.some(withText) || !extractPages.some(withText) ? ocrPages : extractPages;

      const signature = loadedPages.map((p) => `${p.page}:${p.text.length}`).join("|");
      if (signature === pagesSyncRef.current) return;
      pagesSyncRef.current = signature;

      setPages(loadedPages);
      if (loadedPages.length > 0 && includedPages.size === 0) {
        setIncludedPages(new Set(loadedPages.map((p) => p.page)));
      }
    }
  }, [job, includedPages.size]);

  useEffect(() => {
    const draft = job?.draft;
    if (!draft?.questions) return;
    const signature = `${draft.id}:${draft.questions.length}:${JSON.stringify(draft.questions).length}`;
    if (signature === draftSyncRef.current) return;
    draftSyncRef.current = signature;

    setQuestions(draft.questions);
    setEditedTexts({});
    setExcluded(new Set());
  }, [job?.draft]);

  useEffect(() => {
    if (!job || job.status === "failed" || job.status === "cancelled") return;

    const statusOf = (name: string) => job.stages.find((s) => s.stage === name)?.status ?? null;

    if (job.currentStage === "document_extract") {
      const st = statusOf("document_extract");
      const canRun =
        st !== "succeeded" && st !== "failed" && !extracting && !autoRanRef.current.has("document_extract");
      if (canRun) {
        autoRanRef.current.add("document_extract");
        void doExtract();
      }
      return;
    }

    if (job.currentStage === "document_ocr") {
      const st = statusOf("document_ocr");
      const canRun = st === "pending" && !ocrRunning && !autoRanRef.current.has("document_ocr");
      if (canRun) {
        autoRanRef.current.add("document_ocr");
        void doOcr();
      }
    }
  }, [job, extracting, ocrRunning]);

  async function runStage(
    stage: string,
    fn: () => Promise<{ error: string | null; [key: string]: any }>,
  ) {
    setError(null);
    try {
      const res = await fn();
      if (res.error) {
        const label = STAGE_LABELS[stage] ?? stage;
        const detail = typeof res.detail === "string" ? res.detail : null;
        setError(
          res.error === "not_authorized"
            ? "You're not allowed to do that."
            : detail
              ? `${label} failed: ${detail}`
              : String(res.error),
        );
      } else {
        await load({ silent: true });
      }
      return res;
    } catch (e) {
      console.error(`[create/prep] ${stage} failed`, e);
      setError(`${STAGE_LABELS[stage] ?? stage} failed unexpectedly. Try again.`);
      return { error: "unknown" as const };
    }
  }

  async function doExtract() {
    setExtracting(true);
    try {
      const { prepExtractDocument } = await import("@/lib/api/prep.functions");
      return await runStage("document_extract", () => prepExtractDocument({ data: { jobId } }));
    } finally {
      setExtracting(false);
    }
  }

  async function doOcr() {
    setOcrRunning(true);
    try {
      const { prepOcrDocument } = await import("@/lib/api/prep.functions");
      return await runStage("document_ocr", () => prepOcrDocument({ data: { jobId } }));
    } finally {
      setOcrRunning(false);
    }
  }

  async function doMap() {
    setMapping(true);
    try {
      const { prepMapContent } = await import("@/lib/api/prep.functions");
      await runStage("content_map", () => prepMapContent({ data: { jobId } }));
    } finally {
      setMapping(false);
    }
  }

  async function doBlueprint() {
    if (includedPages.size === 0 && job?.document) {
      setError("Select at least one page/section to build the quiz from.");
      return;
    }
    if (!blueprint.quizId) {
      setError("Pick a target quiz to save the questions into.");
      return;
    }
    await runStage("host_blueprint", () =>
      prepSetBlueprint({
        data: {
          jobId,
          title: blueprint.title,
          difficulty: blueprint.difficulty,
          questionCount: blueprint.questionCount,
          types: blueprint.types as any,
          includedPageNumbers: job?.document
            ? Array.from(includedPages).sort((a, b) => a - b)
            : [1], // topic-based: single synthetic source page
          instructions: blueprint.instructions || undefined,
          quizId: blueprint.quizId,
        },
      }),
    );
  }

  async function doGenerate() {
    setGenerating(true);
    try {
      const res = await runStage("question_generate", () =>
        prepGenerateBatch({ data: { jobId } }),
      );
      if (!res.error && res.generated) {
        setQuestions(res.generated.questions);
        setReviewWarnings(res.generated.warnings ?? []);
      }
    } finally {
      setGenerating(false);
    }
  }

  async function doValidate() {
    setValidating(true);
    try {
      const res = await runStage("validate", () => prepValidate({ data: { jobId } }));
      if (!res.error && res.validated) {
        setValidation({
          valid: res.validated.valid,
          errors: res.validated.errors,
          warnings: res.validated.warnings.map((w: { questionIndex: number | null; field: string; message: string }) => ({
            questionIndex: w.questionIndex,
            message: w.message,
          })),
        });
      }
    } finally {
      setValidating(false);
    }
  }

  async function doAssemble() {
    const keptQuestions = questions.filter((_, i) => !excluded.has(i));
    if (keptQuestions.length === 0) {
      setError("Every question is excluded. Keep at least one.");
      return;
    }
    const report = validateQuiz({ title: blueprint.title || "Quiz", questions: keptQuestions });
    if (!report.valid) {
      setValidation({
        valid: false,
        errors: report.errors,
        warnings: report.warnings.map((w) => ({
          questionIndex: w.questionIndex,
          message: w.message,
        })),
      });
      setError("Some questions fail validation. Fix them before assembling.");
      return;
    }
    await runStage("draft_assembled", () =>
      prepAssembleDraft({
        data: { jobId, title: blueprint.title || "Quiz", questions: keptQuestions },
      }),
    );
  }

  async function doPublish() {
    if (!job?.draft) {
      setError("No draft to publish.");
      return;
    }
    const res = await prepPublish({ data: { jobId, draftId: job.draft.id } });
    if (res.error) {
      setError(
        res.error === "not_authorized" ? "You can't publish this draft." : "Couldn't publish.",
      );
      return;
    }
    toast.success(`${res.inserted?.length ?? 0} questions added to your quiz.`);
    if (job.draft.quiz_id) {
      navigate({ to: `/quizzes/${job.draft.quiz_id}` });
    } else {
      navigate({ to: "/dashboard" });
    }
  }

  async function doCancel() {
    await prepCancel({ data: { jobId } });
    await load({ silent: true });
  }

  const current = job?.currentStage ?? null;
  const keptQuestions = questions.filter((_, i) => !excluded.has(i));
  const accent = (t: string) => getQuestionType(t).accent;
  const isTopicJob = job?.document == null && job?.status !== "pending";

  return (
    <HostShell>
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
              ✦ Quiz preparation
            </p>
            <h1 className="font-display text-3xl italic uppercase mt-1">
              {job?.document ? `Source: ${job.document.mimeType}` : "Topic-based quiz"}
            </h1>
            <p className="mt-1 text-foreground/60">{job?.document ? `Job ${jobId}` : ""}</p>
          </div>
          {job &&
            job.status !== "completed" &&
            job.status !== "cancelled" &&
            job.status !== "failed" && (
              <button
                type="button"
                onClick={doCancel}
                className="border border-pink-shock/50 bg-pink-shock/5 px-4 py-2 font-mono text-xs uppercase hover:text-pink-shock hover:border-pink-shock transition-colors"
              >
                Cancel job
              </button>
            )}
        </div>

        {error && (
          <div className="border border-pink-shock/40 bg-pink-shock/5 p-4 font-mono text-xs uppercase text-pink-shock">
            {error}
            <button onClick={() => load()} className="ml-3 underline underline-offset-4 hover:text-volt">
              Retry
            </button>
          </div>
        )}

        {!loading && job ? (
          <>
            <div className="border border-border bg-card/40 p-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50 mb-3 block">
                Pipeline
              </p>
              <div className="flex items-center gap-2">
                {[
                  "document_extract",
                  "document_ocr",
                  "content_map",
                  "host_blueprint",
                  "question_generate",
                  "draft_assembled",
                ].map((s) => {
                  // Topic jobs skip extract/ocr/map — show them as skipped.
                  const isSkipped = isTopicJob && ["document_extract", "document_ocr", "content_map"].includes(s);
                  const st = job.stages.find((x) => x.stage === s);
                  const done = st?.status === "succeeded";
                  const active = current === s && !isSkipped;
                  return (
                    <div key={s} className="flex flex-col items-center gap-1">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-mono border ${
                          done
                            ? "bg-volt text-background border-volt"
                            : isSkipped
                              ? "bg-border border-border/40 text-foreground/40"
                              : active
                                ? "border-volt text-volt"
                                : "border-border/40 text-foreground/40"
                        }`}
                      >
                        {done ? (
                          "✓"
                        ) : isSkipped ? (
                          "–"
                        ) : active ? (
                          <span className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          s.split("_")[0][0]
                        )}
                      </div>
                      <span className="font-mono text-[10px] uppercase">{STAGE_LABELS[s]}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-[10px] uppercase text-foreground/40 mb-1">
                  <span>Progress</span>
                  <span>{job.progressPct}%</span>
                </div>
                <div className="h-1.5 bg-background/60 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-volt"
                    style={{ width: `${Math.max(0, Math.min(100, job.progressPct))}%` }}
                  />
                </div>
              </div>
              {job.error && (
                <p className="mt-3 font-mono text-[10px] uppercase text-pink-shock">{job.error}</p>
              )}
            </div>

            {current === "document_extract" || (!job.currentStage && job.status === "running") ? (
              <div className="mt-6 p-4 border border-border bg-card/40 rounded-sm">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
                  Extracting content
                </p>
                <p className="text-sm text-foreground/70 mb-3">
                  Reading the document page by page.
                </p>
                <button
                  type="button"
                  onClick={doExtract}
                  disabled={extracting}
                  className="bg-volt text-background font-mono text-xs uppercase px-4 py-2 skew-cta disabled:opacity-40"
                >
                  {extracting ? "Extracting…" : "Start extraction"}
                </button>
              </div>
            ) : null}

            {current === "document_ocr" ? (
              <div className="mt-6 p-4 border border-border bg-card/40 rounded-sm">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
                  OCR / reading pages
                </p>
                <p className="text-sm text-foreground/70 mb-3">
                  This document has no text layer (scan or image). Reading it with AI vision.
                </p>
                <button
                  type="button"
                  onClick={doOcr}
                  disabled={ocrRunning}
                  className="bg-volt text-background font-mono text-xs uppercase px-4 py-2 skew-cta disabled:opacity-40"
                >
                  {ocrRunning ? "OCR running…" : "Start OCR"}
                </button>
              </div>
            ) : null}

            {current === "content_map" ? (
              <div className="mt-6 p-4 border border-border bg-card/40 rounded-sm">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
                  Content map
                </p>
                <p className="text-sm text-foreground/70 mb-4">
                  Review the extracted pages and choose which to include in the quiz.
                </p>
                <div className="space-y-3">
                  <p className="font-mono text-[10px] uppercase text-foreground/60">
                    Pages ({pages.length})
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto border border-border bg-background/30 p-3">
                    {pages.map((p) => {
                      const inc = includedPages.has(p.page);
                      return (
                        <div
                          key={p.page}
                          className="flex items-start gap-3 border border-border/40 p-3 bg-background/40"
                        >
                          <input
                            type="checkbox"
                            checked={inc}
                            onChange={() =>
                              setIncludedPages((prev) => {
                                const next = new Set(prev);
                                if (inc) next.delete(p.page);
                                else next.add(p.page);
                                return next;
                              })
                            }
                            className="accent-volt mt-1"
                          />
                          <div className="flex-1">
                            <div className="font-mono text-xs uppercase text-volt">
                              Page {p.page}
                            </div>
                            <div className="mt-1 text-foreground/70 text-sm">
                              {p.section ?? "Untitled section"}
                            </div>
                            <div className="mt-1 text-foreground/40 text-xs font-mono max-w-full break-all">
                              {p.text.slice(0, 200)}
                              {p.text.length > 200 ? "…" : ""}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="font-mono text-[10px] uppercase text-foreground/40">
                    {includedPages.size} of {pages.length} pages selected
                  </p>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={doMap}
                    disabled={mapping}
                    className="bg-volt text-background font-mono text-xs uppercase px-4 py-2 skew-cta disabled:opacity-40"
                  >
                    {mapping ? "Mapping…" : "Save content map"}
                  </button>
                </div>
              </div>
            ) : null}

            {current === "host_blueprint" ? (
              <div className="mt-6 p-4 border border-border bg-card/40 rounded-sm">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
                  Quiz blueprint
                </p>
                <p className="text-sm text-foreground/70 mb-4">
                  Configure the quiz to generate from the selected pages.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60">
                      Quiz title
                    </label>
                    <input
                      value={blueprint.title}
                      onChange={(e) => setBlueprint({ ...blueprint, title: e.target.value })}
                      className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60">
                      Save questions to quiz
                    </label>
                    <select
                      value={blueprint.quizId}
                      onChange={(e) => setBlueprint({ ...blueprint, quizId: e.target.value })}
                      className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                    >
                      <option value="">Select a quiz…</option>
                      {quizzes.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.title}
                        </option>
                      ))}
                    </select>
                    {quizzes.length === 0 && (
                      <p className="font-mono text-[10px] uppercase text-foreground/40">
                        No quizzes yet — create one in the dashboard first.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60">
                      Difficulty
                    </label>
                    <select
                      value={blueprint.difficulty}
                      onChange={(e) => setBlueprint({ ...blueprint, difficulty: e.target.value as any })}
                      className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                    >
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60">
                      Number of questions
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={blueprint.questionCount}
                      onChange={(e) =>
                        setBlueprint({
                          ...blueprint,
                          questionCount: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                        })
                      }
                      className="w-full bg-background border border-border p-3 font-mono text-sm text-center focus:border-volt"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60">
                      Question types
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {["mcq", "true_false", "number", "type", "ordering", "feedback", "map_pin"].map((t) => {
                        const isSelected = blueprint.types.includes(t);
                        return (
                          <label
                            key={t}
                            className={`flex items-center gap-2 p-3 border rounded-sm cursor-pointer transition-colors ${
                              isSelected
                                ? "border-volt text-volt bg-volt/5"
                                : "border-border text-foreground/70 hover:border-foreground/40"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() =>
                                setBlueprint({
                                  ...blueprint,
                                  types: blueprint.types.includes(t)
                                    ? blueprint.types.filter((x) => x !== t)
                                    : [...blueprint.types, t],
                                })
                            }
                              className="accent-volt"
                            />
                            {getQuestionType(t).label}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60">
                      Additional instructions (optional)
                    </label>
                    <textarea
                      value={blueprint.instructions}
                      onChange={(e) => setBlueprint({ ...blueprint, instructions: e.target.value })}
                      rows={2}
                      className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                    />
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={doBlueprint}
                    disabled={!blueprint.quizId || (job?.document && includedPages.size === 0) === true}
                    className="bg-volt text-background font-mono text-xs uppercase px-4 py-2 skew-cta disabled:opacity-40"
                  >
                    Save blueprint
                  </button>
                </div>
              </div>
            ) : null}

            {current === "question_generate" ? (
              <div className="mt-6 p-4 border border-border bg-card/40 rounded-sm">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
                  Generating questions
                </p>
                <p className="text-sm text-foreground/70 mb-4">
                  Drafting source-grounded questions from the selected pages.
                </p>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={doGenerate}
                    disabled={generating}
                    className="bg-volt text-background font-mono text-xs uppercase px-4 py-2 skew-cta disabled:opacity-40"
                  >
                    {generating ? "Generating…" : "Generate questions"}
                  </button>
                </div>
              </div>
            ) : null}

            {questions.length > 0 && (
              <SharedQuestionReview
                questions={questions}
                excluded={excluded}
                reviewWarnings={reviewWarnings}
                validation={validation}
                onEditText={(i, text) => setEditedTexts({ ...editedTexts, [i]: text })}
                onToggleExcluded={(i) =>
                  setExcluded((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
                onRegenerate={(i) => {
                  // Individual regenerate — handled by the prep pipeline via a
                  // server fn. For now, mark as excluded and let the host edit
                  // manually in the editor, or regenerate the whole batch.
                  toast.error("Individual regenerate is available in the quiz editor.");
                }}
                onRemove={(i) => {
                  setQuestions((prev) => prev.filter((_, j) => j !== i));
                  setExcluded((prev) => {
                    const next = new Set(prev);
                    next.delete(i);
                    // Shift down excluded indices above the removed one.
                    const shifted = new Set<number>();
                    next.forEach((idx) => {
                      if (idx > i) shifted.add(idx - 1);
                      else shifted.add(idx);
                    });
                    return shifted;
                  });
                  setEditedTexts({});
                }}
                onBulkAccept={() => {
                  // Validate then assemble
                  void doAssemble();
                }}
                onBulkExcludeSelected={() => {
                  setExcluded(new Set(questions.map((_, i) => i)));
                }}
                generating={generating}
                acceptLabel="Assemble draft"
              />
            )}

            {job.draft && job.draft.status === "pending_review" && (
              <div className="mt-6 p-4 border border-border bg-card/40 rounded-sm">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
                  Draft assembled · ready to publish
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={doPublish}
                    className="bg-volt text-background font-display text-sm uppercase px-6 py-3 skew-cta flex items-center gap-2"
                  >
                    Publish to quiz
                  </button>
                  {job.draft.quiz_id && (
                    <Link
                      to="/quizzes/$id"
                      params={{ id: job.draft.quiz_id }}
                      className="border border-border px-4 py-3 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
                    >
                      Open in editor
                    </Link>
                  )}
                </div>
                <p className="mt-3 text-sm text-foreground/60">
                  Approved questions will be added to your quiz as not-yet-playable.
                  Toggle is_playable in the quiz editor to include them in live games.
                </p>
              </div>
            )}

            {job.status === "completed" && (
              <div className="bg-volt/10 border border-volt/20 p-4 font-mono text-xs uppercase text-volt">
                Preparation complete. Questions were added to your quiz as not-yet-playable; toggle
                is_playable in the quiz editor to publish.
              </div>
            )}
          </>
        ) : null}
      </div>
    </HostShell>
  );
}
