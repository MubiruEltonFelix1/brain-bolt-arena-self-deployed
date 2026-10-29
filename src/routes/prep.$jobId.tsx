// Brain Bolt — AI Quiz Preparation: job page (Stages 2–11).
//
// Host watches the pipeline (extract → content map → blueprint → generate →
// validate → quality → draft), reviews source-grounded questions, and
// publishes approved questions to a quiz via the existing questions insert
// path (is_playable=false; host toggles playable in the editor).
//
// Polls prepJobStatus; each stage is a short server fn, resumable on refresh.

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useAuthUser } from "@/hooks/use-auth-user";
import {
  prepJobStatus,
  prepSetBlueprint,
  prepGenerateBatch,
  prepValidate,
  prepQualityReview,
  prepAssembleDraft,
  prepPublish,
  prepOcrDocument,
  prepCancel,
  PREP_MAX_GENERATION_BATCH,
} from "@/lib/api/prep.functions";
import { validateQuiz, type BrainBoltQuestion } from "@/lib/quiz/validate";
import { getQuestionType } from "@/lib/question-registry";
import { toast } from "sonner";
import { Loader2, Trash2, Play } from "lucide-react";

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

export const Route = createFileRoute("/prep/$jobId")({
  component: PrepJob,
});

function PrepJob() {
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
    errors: any[];
    warnings: string[];
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await prepJobStatus({ data: { jobId } });
    if (result.error) {
      setError(
        result.error === "not_authorized" ? "You can't view this job." : "Couldn't load the job.",
      );
      setLoading(false);
      return;
    }
    setJob(result.job ?? null);
    if (user) {
      const { data: qs } = await supabase
        .from("quizzes")
        .select("id,title")
        .eq("owner_principal_id", user.id)
        .is("archived_at", null)
        .order("created_at", { ascending: false });
      setQuizzes(
        ((qs as Array<{ id: string; title: string } | null>) ?? []).filter(
          (q): q is { id: string; title: string } => !!q,
        ),
      );
    }
    setLoading(false);
  }, [jobId, user]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 3000);
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

      // Image-based documents carry no native text in the extract stage; the
      // OCR stage holds the readable pages for those.
      const loadedPages =
        ocrPages.some(withText) || !extractPages.some(withText) ? ocrPages : extractPages;

      setPages(loadedPages);
      if (loadedPages.length > 0 && includedPages.size === 0) {
        setIncludedPages(new Set(loadedPages.map((p) => p.page)));
      }
    }
  }, [job, includedPages.size]);

  useEffect(() => {
    if (job?.draft?.questions) {
      setQuestions(job.draft.questions);
      setEditedTexts({});
      setExcluded(new Set());
    }
  }, [job?.draft]);

  async function runStage(
    stage: string,
    fn: () => Promise<{ error: string | null; [key: string]: any }>,
  ) {
    setError(null);
    const res = await fn();
    if (res.error) {
      setError(
        res.error === "not_authorized" ? "You're not allowed to do that." : String(res.error),
      );
    } else {
      await load();
    }
    return res;
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
    if (includedPages.size === 0) {
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
          includedPageNumbers: Array.from(includedPages).sort((a, b) => a - b),
          instructions: blueprint.instructions || undefined,
          quizId: blueprint.quizId,
        },
      }),
    );
  }

  async function doGenerate() {
    setGenerating(true);
    try {
      const res = await runStage("question_generate", () => prepGenerateBatch({ data: { jobId } }));
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
        setValidation(res.validated);
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
        warnings: report.warnings.map((w) => w.message),
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
    await load();
  }

  const current = job?.currentStage ?? null;
  const keptQuestions = questions.filter((_, i) => !excluded.has(i));
  const accent = (t: string) => getQuestionType(t).accent;

  return (
    <HostShell>
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-volt">✦ Quiz prep</p>
            <h1 className="font-display text-3xl italic uppercase mt-1">
              {job?.document ? `Source: ${job.document.mimeType}` : "Preparation"}
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
            <button onClick={load} className="ml-3 underline underline-offset-4 hover:text-volt">
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
                  const st = job.stages.find((x) => x.stage === s);
                  const done = st?.status === "succeeded";
                  const active = current === s;
                  return (
                    <div key={s} className="flex flex-col items-center gap-1">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-mono border ${
                          done
                            ? "bg-volt text-background border-volt"
                            : active
                              ? "border-volt text-volt"
                              : "border-border/40 text-foreground/40"
                        }`}
                      >
                        {done ? (
                          "✓"
                        ) : active ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
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
              <StagePanel
                title="Extracting content"
                description="Reading the document page by page."
                pending={extracting}
                onStart={doExtract}
              />
            ) : null}

            {current === "document_ocr" ? (
              <StagePanel
                title="OCR / reading pages"
                description="This document has no text layer (scan or image). Reading it with AI vision."
                pending={ocrRunning}
                onStart={doOcr}
              />
            ) : null}

            {current === "content_map" ? (
              <StagePanel
                title="Content map"
                description="Review the extracted pages and choose which to include in the quiz."
                pending={mapping}
                onStart={doMap}
              >
                <div className="mt-5 space-y-3">
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
              </StagePanel>
            ) : null}

            {current === "host_blueprint" ? (
              <StagePanel
                title="Quiz blueprint"
                description="Configure the quiz to generate from the selected pages."
                pending={false}
                onStart={doBlueprint}
              >
                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
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
                      onChange={(e) =>
                        setBlueprint({ ...blueprint, difficulty: e.target.value as any })
                      }
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
                      max={PREP_MAX_GENERATION_BATCH}
                      value={blueprint.questionCount}
                      onChange={(e) =>
                        setBlueprint({
                          ...blueprint,
                          questionCount: Math.max(
                            1,
                            Math.min(PREP_MAX_GENERATION_BATCH, Number(e.target.value) || 1),
                          ),
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
                      {[
                        "mcq",
                        "true_false",
                        "number",
                        "type",
                        "ordering",
                        "feedback",
                        "map_pin",
                      ].map((t) => {
                        const isSelected = blueprint.types.includes(t);
                        const cls = `flex items-center gap-2 border p-3 cursor-pointer rounded-sm font-mono text-xs uppercase transition-colors ${
                          isSelected
                            ? "border-volt text-volt bg-volt/5"
                            : "border-border text-foreground/70 hover:border-foreground/40"
                        }`;
                        return (
                          <label key={t} className={cls}>
                            <input
                              type="checkbox"
                              checked={blueprint.types.includes(t)}
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
                    disabled={includedPages.size === 0 || !blueprint.quizId}
                    className="bg-volt text-background font-display text-sm uppercase px-5 py-2.5 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Save blueprint
                  </button>
                </div>
              </StagePanel>
            ) : null}

            {current === "question_generate" ? (
              <StagePanel
                title="Generating questions"
                description="Drafting source-grounded questions from the selected pages."
                pending={generating}
                onStart={doGenerate}
              />
            ) : null}

            {questions.length > 0 && (
              <div className="border border-border bg-card/40 p-4">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                      Draft questions
                    </p>
                    <h2 className="font-display text-xl italic uppercase mt-1">
                      {keptQuestions.length} kept of {questions.length}
                    </h2>
                  </div>
                  {reviewWarnings.length > 0 && (
                    <span className="font-mono text-[10px] uppercase text-amber-spark">
                      {reviewWarnings.length} review note{reviewWarnings.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                {reviewWarnings.length > 0 && (
                  <div className="mb-4 p-3 bg-amber-spark/5 border border-amber-spark/20 font-mono text-xs uppercase text-amber-spark">
                    {reviewWarnings.join(" — ")}
                  </div>
                )}
                <div className="space-y-3">
                  {questions.map((q, i) => {
                    const kept = !excluded.has(i);
                    return (
                      <div
                        key={i}
                        className="border border-border/40 p-4 bg-background/40 rounded-sm"
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span
                            className={`font-mono text-[10px] uppercase text-${accent(q.type)}`}
                          >
                            {getQuestionType(q.type).icon} {getQuestionType(q.type).label}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                setExcluded((prev) => {
                                  const next = new Set(prev);
                                  if (kept) next.add(i);
                                  else next.delete(i);
                                  return next;
                                })
                              }
                              className="p-1.5 border border-border hover:border-pink-shock hover:text-pink-shock"
                              aria-label={kept ? "Exclude" : "Keep"}
                            >
                              {kept ? (
                                <Trash2 className="w-3.5 h-3.5" />
                              ) : (
                                <Play className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                        <div className="mb-3">
                          <label className="font-mono text-[10px] uppercase text-foreground/60 block mb-1">
                            Question
                          </label>
                          <textarea
                            value={editedTexts[i] ?? q.text}
                            onChange={(e) =>
                              setEditedTexts({ ...editedTexts, [i]: e.target.value })
                            }
                            rows={2}
                            className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                          />
                        </div>
                        {q.type === "mcq" && "options" in q && q.options && (
                          <div className="space-y-1 mb-3">
                            {q.options.map((opt, oi) => (
                              <label
                                key={oi}
                                className="flex items-center gap-2 text-xs border p-2 rounded bg-background cursor-pointer hover:border-volt/30"
                              >
                                <input
                                  type="radio"
                                  name={`correct-${i}`}
                                  checked={"correctIndex" in q && q.correctIndex === oi}
                                  readOnly
                                  className="accent-volt"
                                />
                                <span className="text-foreground/70">{opt}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-3 mt-2 pt-3 border-t border-border/40">
                          <span className={`font-mono text-[9px] uppercase text-foreground/40`}>
                            Question {i + 1}
                            {kept ? " · kept" : " · excluded"}
                          </span>
                          {q.type === "feedback" && (
                            <span className="font-mono text-[9px] uppercase text-cyan-jolt">
                              Feedback (no correct answer)
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-5 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={doValidate}
                    disabled={validating || keptQuestions.length === 0}
                    className="border border-border px-5 py-2.5 font-mono text-xs uppercase hover:border-volt hover:text-volt disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {validating ? "Validating…" : "Run validation"}
                  </button>
                  <button
                    type="button"
                    onClick={doAssemble}
                    disabled={keptQuestions.length === 0}
                    className="bg-volt text-background font-display text-xs uppercase px-6 py-2.5 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Assemble draft
                  </button>
                </div>
                {validation && (
                  <div
                    className={`mt-4 p-3 border rounded-sm font-mono text-xs uppercase ${
                      validation.valid
                        ? "bg-volt/5 border-volt/20"
                        : "bg-pink-shock/5 border-pink-shock/20"
                    }`}
                  >
                    {validation.valid ? "Validation passed." : "Validation errors:"}
                    {validation.errors.length > 0 && (
                      <ul className="mt-2 list-disc list-inside text-pink-shock">
                        {validation.errors.map((e, i) => (
                          <li key={i} className="text-[9px]">
                            {e.field}: {e.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {validation.warnings.length > 0 && (
                      <div className="mt-2 text-amber-spark text-[9px]">
                        {validation.warnings.join(" · ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {job.draft && job.draft.status === "pending_review" && (
              <div className="border border-border bg-card/40 p-4">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-3 block">
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
                  <Link
                    to="/quizzes/$id"
                    params={{ id: job.draft.id }}
                    className="border border-border px-4 py-3 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
                  >
                    Open in editor
                  </Link>
                </div>
              </div>
            )}

            {job.status === "completed" && (
              <div className="bg-volt/10 border border-volt/20 p-4 font-mono text-xs uppercase text-volt">
                Preparation complete. Questions were added to your quiz as not-yet-playable; toggle
                is_playable in the quiz editor to publish.
              </div>
            )}
            {job.status === "failed" && (
              <div className="bg-pink-shock/10 border border-pink-shock/20 p-4 font-mono text-xs uppercase text-pink-shock">
                Job failed: {job.error}
                <button
                  onClick={load}
                  className="ml-3 underline underline-offset-4 hover:text-volt"
                >
                  Retry
                </button>
              </div>
            )}
            {job.status === "cancelled" && (
              <div className="bg-foreground/10 border border-foreground/20 p-4 font-mono text-xs uppercase text-foreground/60">
                Job cancelled. Completed stages are preserved.
              </div>
            )}
          </>
        ) : null}

        {loading && (
          <div className="p-12 font-mono text-sm text-foreground/40">Loading preparation job…</div>
        )}
      </div>
    </HostShell>
  );
}

function StagePanel({
  title,
  description,
  pending,
  onStart,
  children,
}: {
  title: string;
  description: string;
  pending: boolean;
  onStart: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="border border-border bg-card/40 p-4 rounded-sm">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            {title}
          </p>
          <p className="text-foreground/70 text-sm">{description}</p>
        </div>
        <button
          type="button"
          onClick={onStart}
          disabled={pending}
          className="bg-volt text-background font-display text-xs uppercase px-4 py-2 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? <Loader2 className="w-3 h-3 animate-spin mr-2" /> : null}
          {pending ? "Working…" : "Start"}
        </button>
      </div>
      {children}
    </div>
  );
}
