// Shared question-review interface used by both AI preparation paths:
//
//   * Document-to-quiz (/create/$jobId and /prep/$jobId)
//   * Topic-to-quiz (/create/$jobid)
//
// The component is presentational: it manages local edit/exclude/regenerate
// state and calls callbacks provided by the parent route. The parent owns
// persistence (prep_drafts, questions table) and server-function calls.
//
// Renders one card per question with type-specific configuration controls,
// source evidence (for document-grounded questions), validation warnings,
// and per-card edit / regenerate / exclude actions. Bulk accept and bulk
// exclude are exposed via callbacks.

import { useCallback, useState } from "react";
import { Play, RefreshCw, Trash2 } from "lucide-react";
import { getQuestionType } from "@/lib/question-registry";
import { validateQuiz, type BrainBoltQuestion } from "@/lib/quiz/validate";

type SourceRef = {
  page: number;
  section: string | null;
  excerpt: string;
};

type SharedReviewProps = {
  /** Draft questions (canonical BrainBoltQuestion[]). */
  questions: BrainBoltQuestion[];
  /** Optional per-question source references, keyed by question index. */
  sources?: Map<number, SourceRef>;
  /** Currently excluded question indices. */
  excluded: Set<number>;
  /** Validation report (optional). */
  validation?: { valid: boolean; errors: Array<{ questionIndex: number | null; field: string; message: string }>; warnings: Array<{ questionIndex: number | null; message: string }> } | null;
  /** Warnings from generation/review (flat strings). */
  reviewWarnings?: string[];

  /** Called when the user edits a question's text. */
  onEditText: (index: number, text: string) => void;
  /** Called when the user toggles exclude/keep for a question. */
  onToggleExcluded: (index: number) => void;
  /** Called when the user requests regeneration of one question. */
  onRegenerate: (index: number) => void;
  /** Called when the user removes a question entirely. */
  onRemove: (index: number) => void;
  /** Called when the user accepts all valid kept questions. */
  onBulkAccept: () => void;
  /** Called when the user excludes all selected questions. */
  onBulkExcludeSelected: () => void;

  /** Whether a generation/regeneration is in flight. */
  generating?: boolean;
  /** Index of the question currently being regenerated. */
  regeneratingIdx?: number | null;

  /** Label for the primary action button. */
  acceptLabel?: string;
};

export function SharedQuestionReview({
  questions,
  sources,
  excluded,
  validation,
  reviewWarnings,
  onEditText,
  onToggleExcluded,
  onRegenerate,
  onRemove,
  onBulkAccept,
  onBulkExcludeSelected,
  generating = false,
  regeneratingIdx = null,
  acceptLabel = "Add to Quiz",
}: SharedReviewProps) {
  const [editedTexts, setEditedTexts] = useState<Record<number, string>>({});

  const keptQuestions = questions.filter((_, i) => !excluded.has(i));
  const allExcluded = keptQuestions.length === 0;

  const handleEditText = useCallback(
    (index: number, text: string) => {
      onEditText(index, text);
      setEditedTexts((prev) => ({ ...prev, [index]: text }));
    },
    [onEditText],
  );

  // Per-question validation errors (from the validation report).
  const errorsFor = (index: number) =>
    (validation?.errors ?? []).filter((e) => e.questionIndex === index);
  const warningsFor = (index: number) =>
    (validation?.warnings ?? []).filter((e) => e.questionIndex === index);

  const keptCount = keptQuestions.length;
  const excludedCount = excluded.size;

  return (
    <div className="border border-border bg-card/40">
      <div className="flex items-center justify-between gap-3 mb-4 p-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Draft questions
          </p>
          <h2 className="font-display text-xl italic uppercase mt-1">
            {keptCount} kept of {questions.length}
          </h2>
          {excludedCount > 0 && (
            <p className="font-mono text-xs text-foreground/40 mt-0">
              {excludedCount} excluded
            </p>
          )}
        </div>
        {reviewWarnings && reviewWarnings.length > 0 && (
          <span className="font-mono text-[10px] uppercase text-amber-spark">
            {reviewWarnings.length} review note{reviewWarnings.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {reviewWarnings && reviewWarnings.length > 0 && (
        <div className="mx-4 mb-4 p-3 bg-amber-spark/5 border border-amber-spark/20 font-mono text-xs uppercase text-amber-spark">
          {reviewWarnings.join(" — ")}
        </div>
      )}

      <div className="space-y-3 px-4 pb-4">
        {questions.map((q, i) => {
          const kept = !excluded.has(i);
          const accent = getQuestionType(q.type).accent;
          const src = sources?.get(i);
          const questionErrors = errorsFor(i);
          const questionWarnings = warningsFor(i);

          return (
            <div
              key={i}
              className={`border rounded-sm p-4 mb-2 ${
                kept ? "bg-background/40 border-border" : "bg-background/20 border-border/40 opacity-70"
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[10px] uppercase text-${accent}`}>
                    {getQuestionType(q.type).icon} {getQuestionType(q.type).label}
                  </span>
                  {!kept && (
                    <span className="font-mono text-[9px] uppercase text-foreground/40">
                      excluded
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onRegenerate(i)}
                    disabled={regeneratingIdx === i || generating}
                    aria-label="Regenerate this question"
                    className="p-1.5 border border-border hover:border-volt hover:text-volt disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {regeneratingIdx === i ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(i)}
                    aria-label="Remove from draft"
                    className="p-1.5 border border-border hover:border-pink-shock hover:text-pink-shock disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleExcluded(i)}
                    className="p-1.5 border border-border hover:border-pink-shock hover:text-pink-shock"
                    aria-label={kept ? "Exclude from quiz" : "Keep in quiz"}
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
                  onChange={(e) => handleEditText(i, e.target.value)}
                  rows={2}
                  className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                />
              </div>

              {/* Type-specific configuration (read-only preview; full editing
                  happens in the quiz editor after publish). */}
              {q.type === "mcq" && "options" in q && q.options && (
                <div className="space-y-1 mb-3">
                  <label className="font-mono text-[10px] uppercase text-foreground/60 block mb-1">
                    Options
                  </label>
                  {q.options.map((opt, oi) => (
                    <label
                      key={oi}
                      className="flex items-center gap-2 text-xs border p-2 rounded bg-background cursor-default hover:border-volt/30"
                    >
                      <input
                        type="radio"
                        name={`correct-${i}`}
                        checked={"correctIndex" in q && q.correctIndex === oi}
                        readOnly
                        className="accent-volt"
                      />
                      <span className={`text-foreground/70 ${"correctIndex" in q && q.correctIndex === oi ? "font-bold text-volt" : ""}`}>
                        {opt}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {q.type === "true_false" && (
                <div className="mb-3">
                  <label className="font-mono text-[10px] uppercase text-foreground/60 block mb-1">
                    Answer
                  </label>
                  <div className="flex gap-4 text-xs">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`tf-${i}`}
                        checked={q.correct === true}
                        readOnly
                        className="accent-volt"
                      />
                      <span>True</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`tf-${i}`}
                        checked={q.correct === false}
                        readOnly
                        className="accent-volt"
                      />
                      <span>False</span>
                    </label>
                  </div>
                </div>
              )}

              {q.type === "number" && (
                <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[9px] uppercase text-foreground/40">Correct</span>
                    <span className="font-mono text-foreground">{q.correctNumber}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[9px] uppercase text-foreground/40">Min</span>
                    <span className="font-mono text-foreground">{q.min}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[9px] uppercase text-foreground/40">Max</span>
                    <span className="font-mono text-foreground">{q.max}</span>
                  </div>
                </div>
              )}

              {q.type === "type" && "acceptedAnswers" in q && (
                <div className="mb-3">
                  <label className="font-mono text-[10px] uppercase text-foreground/60 block mb-1">
                    Accepted answers
                  </label>
                  <p className="font-mono text-xs text-foreground/70 bg-background/20 p-2 rounded">
                    {q.acceptedAnswers.join("; ")}
                  </p>
                </div>
              )}

              {q.type === "ordering" && "items" in q && (
                <div className="mb-3">
                  <label className="font-mono text-[10px] uppercase text-foreground/60 block mb-1">
                    Order (first → last)
                  </label>
                  <p className="font-mono text-xs text-foreground/70 bg-background/20 p-2 rounded">
                    {q.items.join(" → ")}
                  </p>
                </div>
              )}

              {q.type === "map_pin" && (
                <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[9px] uppercase text-foreground/40">Latitude</span>
                    <span className="font-mono text-foreground">{q.lat}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[9px] uppercase text-foreground/40">Longitude</span>
                    <span className="font-mono text-foreground">{q.lng}</span>
                  </div>
                </div>
              )}

              {/* Per-question validation issues. */}
              {questionErrors.length > 0 && (
                <div className="mb-3 p-2 bg-pink-shock/5 border border-pink-shock/20">
                  <p className="font-mono text-[9px] uppercase text-pink-shock mb-1">
                    Validation errors
                  </p>
                  <ul className="list-disc list-inside text-[9px] text-pink-shock">
                    {questionErrors.map((e, ei) => (
                      <li key={ei}>{e.field}: {e.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {questionWarnings.length > 0 && (
                <div className="mb-3 p-2 bg-amber-spark/5 border border-amber-spark/20">
                  <p className="font-mono text-[9px] uppercase text-amber-spark mb-1">
                    Review notes
                  </p>
                  <ul className="list-disc list-inside text-[9px] text-amber-spark">
                    {questionWarnings.map((e, ei) => (
                      <li key={ei}>{e.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Source evidence for document-grounded questions. */}
              {src && (
                <div className="mt-3 pt-3 border-t border-border/40">
                  <p className="font-mono text-[9px] uppercase text-foreground/40 mb-1">
                    Source · page {src.page}{src.section ? ` · ${src.section}` : ""}
                  </p>
                  <p className="font-mono text-xs text-foreground/60 bg-background/20 p-2 rounded italic">
                    "{src.excerpt}"
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border/40">
                <span className={`font-mono text-[9px] uppercase text-foreground/40`}>
                  Question {i + 1}{kept ? " · kept" : " · excluded"}
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

      {questions.length > 0 && (
        <div className="mt-5 border-t border-border pt-5 px-4 pb-4 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={onBulkAccept}
            disabled={keptCount === 0 || generating}
            className="bg-volt text-background font-display text-xs uppercase px-6 py-2.5 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {acceptLabel} ({keptCount})
          </button>
          <button
            type="button"
            onClick={onBulkExcludeSelected}
            disabled={excludedCount === questions.length || generating}
            className="border border-pink-shock/50 bg-pink-shock/5 px-5 py-2.5 font-mono text-xs uppercase hover:text-pink-shock hover:border-pink-shock disabled:opacity-40"
          >
            Exclude all
          </button>
          {allExcluded && (
            <span className="font-mono text-[10px] uppercase text-foreground/40">
              All questions excluded — keep at least one to continue
            </span>
          )}
        </div>
      )}
    </div>
  );
}
