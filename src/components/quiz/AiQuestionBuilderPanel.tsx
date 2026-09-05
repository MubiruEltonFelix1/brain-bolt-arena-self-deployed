// AI Question Builder panel.
//
// Renders inside src/routes/quizzes.$id.tsx — sits next to the existing
// `+ ADD`, `IMPORT CSV`, `Enable all` / `Exclude all` controls. Clicking
// `AI Generate` expands the panel inline (NOT a modal — modals are cramped
// at 390px per §20 of the brief).
//
// Flow:
//   1. Creator fills structured fields + optional natural-language note.
//   2. Click Generate -> calls generateQuestions serverFn.
//   3. Draft appears as editable cards below the form.
//   4. Per-card: edit / regenerate / remove / exclude.
//   5. Click "Add to Quiz" -> inserts each kept card via the existing
//      supabase.from("questions").insert(...) path with is_playable=false.
//
// The panel calls the AI service through createServerFn (provider-agnostic).
// The panel NEVER knows the provider name, model ID, or AWS keys.

import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { generateQuestions, regenerateQuestion } from "@/lib/api/ai.functions";
import {
  FRIENDLY_MESSAGES,
  SUPPORTED_AI_TYPES,
  type AiErrorCode,
  type SupportedAiType,
  type Difficulty,
} from "@/lib/ai/types";
import { validateQuiz } from "@/lib/quiz/validate";
import { questionToDbRow } from "@/lib/quiz/validate";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { getQuestionType } from "@/lib/question-registry";

type DraftQuestion = import("@/lib/quiz/validate").BrainBoltQuestion;

type DraftState = {
  questions: DraftQuestion[];
  excluded: Set<number>;
  warnings: string[];
};

type Props = {
  /** Quiz id — passed to serverFn as authorization scope. */
  quizId: string;
  /** Inserted-position helper from the editor (passes the existing next index). */
  startPosition: number;
  /**
   * Called when the creator accepts the draft — the panel already inserted
   * the rows via supabase and passes the returned DB rows back. The parent
   * should append them to its local state so they appear in the editor's
   * per-question cards.
   */
  onInsert: (rows: Array<Record<string, unknown>>) => Promise<void> | void;
  /** Total questions currently in the editor (used for the "Add to Quiz" CTA label). */
  currentQuestionCount: number;
};

export function AiQuestionBuilderPanel({
  quizId,
  startPosition,
  onInsert,
  currentQuestionCount,
}: Props) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [types, setTypes] = useState<SupportedAiType[]>(["mcq", "true_false"]);
  const [instructions, setInstructions] = useState("");

  // In-flight guards. useRef (not state) so the guard is synchronous and
  // survives the React batch — a double-click on "Generate" or "Add to Quiz"
  // must not fire two parallel Bedrock calls or two parallel inserts.
  // The `questions` table has no UNIQUE(quiz_id, position), so duplicate
  // inserts would create duplicate rows.
  const generatingRef = useRef(false);
  const acceptingRef = useRef(false);
  const regeneratingRef = useRef(false);

  const [generating, setGenerating] = useState(false);
  const [regeneratingIdx, setRegeneratingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [error, setError] = useState<AiErrorCode | null>(null);

  function toggleType(t: SupportedAiType) {
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  function showFriendlyError(code: AiErrorCode) {
    toast.error(FRIENDLY_MESSAGES[code]);
  }

  async function onGenerate() {
    if (generatingRef.current) return;
    if (!topic.trim()) {
      toast.error("Tell Brain Bolt AI what topic to generate questions about.");
      return;
    }
    if (types.length === 0) {
      toast.error("Pick at least one question type.");
      return;
    }
    generatingRef.current = true;
    setGenerating(true);
    setError(null);
    setDraft(null);
    try {
      const result = await generateQuestions({
        data: {
          quizId,
          topic: topic.trim(),
          count,
          difficulty,
          types,
          instructions: instructions.trim() || undefined,
        },
      });
      if (result.error || !result.draft) {
        setError(result.error ?? "unknown");
        showFriendlyError(result.error ?? "unknown");
        return;
      }
      // Defense in depth: validate once more on the client before showing.
      const report = validateQuiz(result.draft);
      if (!report.valid) {
        setError("validation_failed");
        showFriendlyError("validation_failed");
        return;
      }
      setDraft({
        questions: result.draft.questions,
        excluded: new Set(),
        warnings: result.warnings ?? [],
      });
      if (result.warnings && result.warnings.length > 0) {
        for (const w of result.warnings) toast.message(w, { duration: 6000 });
      }
    } catch (e) {
      console.error("[AiQuestionBuilderPanel] generateQuestions failed", e);
      setError("unknown");
      showFriendlyError("unknown");
    } finally {
      setGenerating(false);
      generatingRef.current = false;
    }
  }

  async function onRegenerate(idx: number) {
    if (regeneratingRef.current) return;
    const target = draft?.questions[idx];
    if (!target) return;
    regeneratingRef.current = true;
    setRegeneratingIdx(idx);
    try {
      const result = await regenerateQuestion({
        data: {
          quizId,
          replace: target,
          instructions: instructions.trim() || undefined,
        },
      });
      if (result.error || !result.question) {
        showFriendlyError(result.error ?? "unknown");
        return;
      }
      // Same-type check is enforced server-side too.
      if (result.question.type !== target.type) {
        showFriendlyError("validation_failed");
        return;
      }
      setDraft((prev) => {
        if (!prev) return prev;
        const next = [...prev.questions];
        next[idx] = result.question!;
        return { ...prev, questions: next };
      });
    } catch (e) {
      console.error("[AiQuestionBuilderPanel] regenerateQuestion failed", e);
      showFriendlyError("unknown");
    } finally {
      setRegeneratingIdx(null);
      regeneratingRef.current = false;
    }
  }

  function onRemove(idx: number) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = prev.questions.filter((_, i) => i !== idx);
      // Reindex excluded to match the new positions.
      const newExcluded = new Set<number>();
      prev.excluded.forEach((oldIdx) => {
        if (oldIdx < idx) newExcluded.add(oldIdx);
        else if (oldIdx > idx) newExcluded.add(oldIdx - 1);
      });
      return { questions: next, excluded: newExcluded, warnings: prev.warnings };
    });
  }

  function onEditField(idx: number, patch: Partial<DraftQuestion>) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = [...prev.questions];
      next[idx] = { ...next[idx], ...patch } as DraftQuestion;
      return { ...prev, questions: next };
    });
  }

  function onToggleExcluded(idx: number) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.excluded);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return { ...prev, excluded: next };
    });
  }

  async function onAcceptAll() {
    // Hard guard: prevent duplicate bulk inserts on double-click or
    // laggy-network rapid clicks. The `questions` table has no
    // UNIQUE(quiz_id, position) constraint, so a second successful
    // insert would silently create duplicate AI rows in the user's
    // quiz. The ref (not state) is intentional — state updates are
    // batched in React, so two rapid clicks can both pass a state
    // check before the first one renders.
    if (acceptingRef.current) return;
    if (!draft) return;
    acceptingRef.current = true;
    try {
      const kept = draft.questions.filter((_, i) => !draft.excluded.has(i));
      if (kept.length === 0) {
        toast.error("No questions to add — every card is excluded or removed.");
        return;
      }
      // Final client-side validation gate (defense in depth).
      const finalReport = validateQuiz({
        title: "AI Draft",
        questions: kept,
      });
      if (!finalReport.valid) {
        showFriendlyError("validation_failed");
        return;
      }
      const rows = kept.map((q, i) => questionToDbRow(q, startPosition + i));
      try {
        // The CSV importer uses an `as any` cast here for the same reason:
        // the inferred row type from questionToDbRow has `geo_region` typed
        // as `{ type, coordinates? } | null` but the DB Json type doesn't
        // accept `unknown` for nested coordinates. The structural shape is
        // correct; the cast only relaxes the recursive Json type check.
        const insertRows = rows.map((r) => ({
          ...r,
          quiz_id: quizId,
          is_playable: false,
        }));

        const { data: inserted, error: insErr } = await supabase
          .from("questions")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .insert(insertRows as any)
          .select("*");
        if (insErr) {
          toast.error(insErr.message);
          return;
        }
        toast.success(
          `${inserted?.length ?? rows.length} AI-generated questions added (excluded from play until you enable them).`,
        );
        if (inserted && inserted.length > 0) {
          await onInsert(inserted as Array<Record<string, unknown>>);
        }
        // Reset.
        setDraft(null);
        setTopic("");
        setInstructions("");
        setOpen(false);
      } catch (e) {
        console.error("[AiQuestionBuilderPanel] insert failed", e);
        toast.error("Couldn't add the AI-generated questions to your quiz.");
      }
    } finally {
      acceptingRef.current = false;
    }
  }

  function onDiscard() {
    setDraft(null);
    setError(null);
  }

  return (
    <div className="border border-border bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 font-mono text-xs uppercase hover:text-volt"
      >
        <span className="flex items-center gap-2">
          <span className="text-volt">✦</span> AI Generate Questions
        </span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {open && (
        <div className="border-t border-border p-4 space-y-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
            ✦ AI-generated draft — review before publishing
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Topic</span>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Genetics"
                maxLength={200}
                className="w-full bg-card border border-border p-2 font-sans text-sm focus:outline-none focus:border-volt"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="font-mono text-[10px] uppercase text-foreground/60">Count</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={count}
                  onChange={(e) =>
                    setCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))
                  }
                  className="w-full bg-card border border-border p-2 font-mono text-sm text-center focus:outline-none focus:border-volt"
                />
              </label>
              <label className="space-y-1">
                <span className="font-mono text-[10px] uppercase text-foreground/60">
                  Difficulty
                </span>
                <select
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as Difficulty)}
                  className="w-full bg-card border border-border p-2 font-sans text-sm focus:outline-none focus:border-volt"
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </label>
            </div>
          </div>

          <fieldset className="space-y-1">
            <legend className="font-mono text-[10px] uppercase text-foreground/60">
              Question types
            </legend>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {SUPPORTED_AI_TYPES.map((t) => {
                const checked = types.includes(t);
                return (
                  <label
                    key={t}
                    className={`flex items-center gap-2 px-3 py-2 border cursor-pointer ${
                      checked
                        ? "border-volt text-volt"
                        : "border-border text-foreground/70 hover:border-foreground/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleType(t)}
                      className="accent-volt"
                    />
                    <span className="font-mono text-[11px] uppercase">
                      {getQuestionType(t).name}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="block space-y-1">
            <span className="font-mono text-[10px] uppercase text-foreground/60">
              Anything else to add? (optional, max 500 chars)
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, 500))}
              rows={2}
              placeholder="e.g. Make five harder questions on incomplete dominance and include realistic distractors."
              className="w-full bg-card border border-border p-2 font-sans text-sm focus:outline-none focus:border-volt"
            />
          </label>

          <div className="flex gap-2 flex-wrap items-center">
            <button
              type="button"
              onClick={onGenerate}
              disabled={generating || !topic.trim() || types.length === 0}
              className="bg-volt text-background font-display text-sm uppercase px-5 py-2.5 skew-cta disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              aria-live="polite"
            >
              {generating && <Loader2 className="w-4 h-4 animate-spin" />}
              {generating ? "Generating..." : "Generate"}
            </button>
            {draft && (
              <button
                type="button"
                onClick={onDiscard}
                className="border border-border px-3 py-2 font-mono text-[11px] uppercase hover:border-pink-shock hover:text-pink-shock"
              >
                Discard draft
              </button>
            )}
          </div>

          {error && !draft && (
            <div className="border border-pink-shock/40 bg-pink-shock/5 p-3">
              <p className="font-mono text-[11px] uppercase text-pink-shock">
                {FRIENDLY_MESSAGES[error]}
              </p>
            </div>
          )}

          {draft && (
            <div className="space-y-3 pt-2">
              <p className="font-mono text-[11px] uppercase text-foreground/60">
                Draft · {draft.questions.length} question
                {draft.questions.length === 1 ? "" : "s"} · {draft.excluded.size} excluded
              </p>
              {draft.questions.map((q, i) => (
                <DraftCard
                  key={i}
                  index={i}
                  question={q}
                  excluded={draft.excluded.has(i)}
                  regenerating={regeneratingIdx === i}
                  onEdit={(patch) => onEditField(i, patch)}
                  onRegenerate={() => onRegenerate(i)}
                  onRemove={() => onRemove(i)}
                  onToggleExcluded={() => onToggleExcluded(i)}
                />
              ))}
              <div className="flex gap-2 flex-wrap items-center pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={onAcceptAll}
                  disabled={
                    draft.questions.length === 0 || draft.excluded.size === draft.questions.length
                  }
                  className="bg-volt text-background font-display text-sm uppercase px-5 py-2.5 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Add {draft.questions.length - draft.excluded.size} to Quiz
                </button>
                <span className="font-mono text-[10px] text-foreground/40">
                  (added as excluded from play — toggle per question in the editor)
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DraftCard({
  index,
  question,
  excluded,
  regenerating,
  onEdit,
  onRegenerate,
  onRemove,
  onToggleExcluded,
}: {
  index: number;
  question: DraftQuestion;
  excluded: boolean;
  regenerating: boolean;
  onEdit: (patch: Partial<DraftQuestion>) => void;
  onRegenerate: () => void;
  onRemove: () => void;
  onToggleExcluded: () => void;
}) {
  const accent = getQuestionType(question.type).accent;
  return (
    <div
      className={`border ${excluded ? "border-border/40 opacity-60" : "border-border"} bg-background/40 p-3 space-y-2`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`font-mono text-[10px] uppercase tracking-widest text-${accent}`}>
          {getQuestionType(question.type).icon} {getQuestionType(question.type).name}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            aria-label="Regenerate this question"
            className="p-1.5 border border-border hover:border-volt hover:text-volt disabled:opacity-40"
          >
            {regenerating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove from draft"
            className="p-1.5 border border-border hover:border-pink-shock hover:text-pink-shock"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <textarea
        value={question.text}
        onChange={(e) => onEdit({ text: e.target.value })}
        rows={2}
        className="w-full bg-card border border-border p-2 font-sans text-sm focus:outline-none focus:border-volt"
      />

      {/* Per-type mini-editor — kept minimal. The editor's own per-question
          editor will be the canonical place to fine-tune once the draft is
          accepted. */}
      {"options" in question && question.options && (
        <div className="space-y-1">
          {question.options.map((opt, i) => (
            <label key={i} className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name={`correct-${index}`}
                checked={"correctIndex" in question && question.correctIndex === i}
                onChange={() => onEdit({ correctIndex: i } as Partial<DraftQuestion>)}
                className="accent-volt"
              />
              <input
                type="text"
                value={opt}
                onChange={(e) => {
                  if (!("options" in question)) return;
                  const next = [...question.options];
                  next[i] = e.target.value;
                  onEdit({ options: next } as Partial<DraftQuestion>);
                }}
                className="flex-1 bg-card border border-border p-1.5 font-sans focus:outline-none focus:border-volt"
              />
            </label>
          ))}
        </div>
      )}

      {"correct" in question && (
        <div className="flex gap-2 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`tf-${index}`}
              checked={question.correct === true}
              onChange={() => onEdit({ correct: true } as Partial<DraftQuestion>)}
              className="accent-volt"
            />
            True
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`tf-${index}`}
              checked={question.correct === false}
              onChange={() => onEdit({ correct: false } as Partial<DraftQuestion>)}
              className="accent-volt"
            />
            False
          </label>
        </div>
      )}

      {question.type === "number" && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <label className="space-y-0.5">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Correct</span>
            <input
              type="number"
              value={question.correctNumber}
              onChange={(e) =>
                onEdit({ correctNumber: parseFloat(e.target.value) } as Partial<DraftQuestion>)
              }
              className="w-full bg-card border border-border p-1.5 font-mono text-center focus:outline-none focus:border-volt"
            />
          </label>
          <label className="space-y-0.5">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Min</span>
            <input
              type="number"
              value={question.min}
              onChange={(e) =>
                onEdit({ min: parseFloat(e.target.value) } as Partial<DraftQuestion>)
              }
              className="w-full bg-card border border-border p-1.5 font-mono text-center focus:outline-none focus:border-volt"
            />
          </label>
          <label className="space-y-0.5">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Max</span>
            <input
              type="number"
              value={question.max}
              onChange={(e) =>
                onEdit({ max: parseFloat(e.target.value) } as Partial<DraftQuestion>)
              }
              className="w-full bg-card border border-border p-1.5 font-mono text-center focus:outline-none focus:border-volt"
            />
          </label>
        </div>
      )}

      {question.type === "type" && (
        <div className="space-y-1 text-xs">
          <span className="font-mono text-[10px] uppercase text-foreground/60">
            Accepted answers (semicolon-separated)
          </span>
          <input
            type="text"
            value={question.acceptedAnswers.join("; ")}
            onChange={(e) =>
              onEdit({
                acceptedAnswers: e.target.value
                  .split(";")
                  .map((s) => s.trim())
                  .filter(Boolean),
              } as Partial<DraftQuestion>)
            }
            className="w-full bg-card border border-border p-1.5 font-sans focus:outline-none focus:border-volt"
          />
        </div>
      )}

      {question.type === "ordering" && (
        <div className="space-y-1 text-xs">
          <span className="font-mono text-[10px] uppercase text-foreground/60">
            Order (first → last)
          </span>
          <input
            type="text"
            value={question.items.join("; ")}
            onChange={(e) =>
              onEdit({
                items: e.target.value
                  .split(";")
                  .map((s) => s.trim())
                  .filter(Boolean),
              } as Partial<DraftQuestion>)
            }
            className="w-full bg-card border border-border p-1.5 font-sans focus:outline-none focus:border-volt"
          />
        </div>
      )}

      {question.type === "map_pin" && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="space-y-0.5">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Latitude</span>
            <input
              type="number"
              step="0.0001"
              value={question.lat}
              onChange={(e) =>
                onEdit({ lat: parseFloat(e.target.value) } as Partial<DraftQuestion>)
              }
              className="w-full bg-card border border-border p-1.5 font-mono text-center focus:outline-none focus:border-volt"
            />
          </label>
          <label className="space-y-0.5">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Longitude</span>
            <input
              type="number"
              step="0.0001"
              value={question.lng}
              onChange={(e) =>
                onEdit({ lng: parseFloat(e.target.value) } as Partial<DraftQuestion>)
              }
              className="w-full bg-card border border-border p-1.5 font-mono text-center focus:outline-none focus:border-volt"
            />
          </label>
        </div>
      )}

      <label className="flex items-center gap-2 font-mono text-[10px] uppercase text-foreground/60 cursor-pointer pt-1 border-t border-border/40">
        <input
          type="checkbox"
          checked={excluded}
          onChange={onToggleExcluded}
          className="accent-pink-shock"
        />
        Exclude from play
      </label>
    </div>
  );
}
