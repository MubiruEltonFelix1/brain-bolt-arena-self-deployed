import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_QUESTIONS, haversineKm, type DemoQuestion } from "@/lib/demo-questions";
import { computePoints } from "@/lib/game";
import {
  QuestionRenderer,
  QuestionTimerBar,
  type QuestionSpec,
  type SubmittedAnswer,
} from "@/components/question/QuestionRenderer";
import { useSoloTimer } from "@/hooks/use-solo-timer";
import { geoRatio, numberRatio, orderingRatio } from "@/lib/question-registry";
import { getQuestionMeta } from "@/lib/question-meta";

export const Route = createFileRoute("/training")({
  head: () => ({
    meta: [
      { title: "Training Arena — BrainBolt" },
      {
        name: "description",
        content:
          "Try every BrainBolt question type in under 2 minutes. No sign-up, no host — just play.",
      },
    ],
  }),
  component: TrainingArena,
});

type Phase = "intro" | "playing" | "reveal" | "done";

function TrainingArena() {
  const navigate = useNavigate();
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("intro");
  const [score, setScore] = useState(0);
  const [lastPoints, setLastPoints] = useState(0);
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [answered, setAnswered] = useState(false);

  const question = DEMO_QUESTIONS[idx];
  const total = DEMO_QUESTIONS.length;

  if (!question && phase !== "done") {
    // Safety
    return null;
  }

  function nextQuestion() {
    if (idx + 1 >= total) {
      setPhase("done");
    } else {
      setIdx(idx + 1);
      setAnswered(false);
      setLastCorrect(null);
      setLastPoints(0);
      setPhase("intro");
    }
  }

  function submit(isCorrect: boolean, responseMs: number, partialRatio?: number) {
    if (answered) return;
    setAnswered(true);
    const ratio = partialRatio ?? (isCorrect ? 1 : 0);
    const base = computePoints({
      isCorrect: ratio > 0,
      responseMs,
      timeLimitMs: question.timeLimitMs ?? 15000,
      streak: 0,
    });
    const partial = Math.round(base * ratio);
    const pts = (question.doublePoints ? 2 : 1) * partial;
    setLastPoints(pts);
    setLastCorrect(isCorrect);
    setScore((s) => s + pts);
    setTimeout(() => setPhase("reveal"), 350);
  }


  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 bg-background/80 backdrop-blur-md border-b border-border">
        <Link to="/" className="font-mono text-xs uppercase text-foreground/60 hover:text-volt">
          ← Exit demo
        </Link>
        <span className="font-mono text-xs uppercase tracking-widest text-volt">
          Training Arena
        </span>
        <span className="font-display italic text-lg text-volt">{score}</span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {phase !== "done" && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1 bg-border overflow-hidden">
              <div
                className="h-full bg-volt transition-all"
                style={{ width: `${((idx + (phase === "reveal" ? 1 : 0)) / total) * 100}%` }}
              />
            </div>
            <span className="font-mono text-[10px] uppercase text-foreground/60">
              {Math.min(idx + 1, total)} / {total}
            </span>
          </div>
        )}

        {phase === "intro" && question && (
          <IntroCard question={question} onStart={() => setPhase("playing")} />
        )}

        {phase === "playing" && question && (
          <QuestionCard question={question} onSubmit={submit} />
        )}

        {phase === "reveal" && question && (
          <RevealCard
            question={question}
            correct={lastCorrect === true}
            points={lastPoints}
            onNext={nextQuestion}
            isLast={idx + 1 >= total}
          />
        )}

        {phase === "done" && (
          <CompletionCard
            score={score}
            total={total}
            onLive={() => navigate({ to: "/" })}
            onRequest={() => navigate({ to: "/request-hosting" })}
          />
        )}
      </main>
    </div>
  );
}

// ---------- Intro ----------
function IntroCard({ question, onStart }: { question: DemoQuestion; onStart: () => void }) {
  const meta = getQuestionMeta(question.type);
  useEffect(() => {
    const t = setTimeout(onStart, 1400);
    return () => clearTimeout(t);
  }, [onStart]);
  return (
    <div
      className="p-8 border-2 text-center animate-fade-in"
      style={{ borderColor: "var(--volt)" }}
    >
      <div className="text-6xl mb-3">{meta.icon}</div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
        {meta.name}
      </p>
      <h2 className="mt-2 font-display text-2xl italic uppercase text-volt">
        Get Ready...
      </h2>
      {question.doublePoints && (
        <p className="mt-3 font-mono text-xs uppercase text-pink-shock animate-pulse">
          ⭐ Double Points
        </p>
      )}
    </div>
  );
}

// ---------- Question ----------

/** Demo question -> shared renderer spec (no answer key crosses this line). */
function toSpec(q: DemoQuestion): QuestionSpec {
  const base = { id: q.prompt, type: q.type, prompt: q.prompt };
  switch (q.type) {
    case "true_false":
      return { ...base, options: ["TRUE", "FALSE"] };
    case "ordering":
      return { ...base, options: q.items };
    case "map_pin":
      return { ...base, options: [] };
    case "number":
      return { ...base, options: [], number: { min: q.min, max: q.max, unit: q.unit } };
    case "image_reveal":
      return { ...base, options: q.choices, imageUrl: q.imageUrl, revealStages: q.revealStages };
    case "audio":
      return { ...base, options: q.choices, audioUrl: q.audioUrl };
    default:
      return { ...base, options: q.choices };
  }
}

function QuestionCard({
  question,
  onSubmit,
}: {
  question: DemoQuestion;
  onSubmit: (correct: boolean, responseMs: number, partialRatio?: number) => void;
}) {
  const timeLimit = question.timeLimitMs ?? 15000;
  const { elapsedMs, remainingMs, timedOut, responseMs } = useSoloTimer(question.prompt, timeLimit);
  const spec = useMemo(() => toSpec(question), [question]);

  useEffect(() => {
    if (timedOut) onSubmit(false, timeLimit, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timedOut]);

  function handleAnswer(answer: SubmittedAnswer) {
    const ms = responseMs();
    switch (answer.kind) {
      case "choice":
        if (question.type === "true_false") {
          return onSubmit((answer.index === 0) === question.correct, ms);
        }
        if (question.type === "mcq" || question.type === "image_reveal" || question.type === "audio") {
          return onSubmit(answer.index === question.correctIndex, ms);
        }
        return;
      case "order": {
        if (question.type !== "ordering") return;
        const ratio = orderingRatio(answer.labels, question.items);
        return onSubmit(ratio === 1, ms, ratio);
      }
      case "geo": {
        if (question.type !== "map_pin") return;
        const dist = haversineKm(answer, question.correct);
        const tol = question.toleranceKm ?? 500;
        return onSubmit(dist <= tol, ms, geoRatio(dist, tol));
      }
      case "number": {
        if (question.type !== "number") return;
        const diff = Math.abs(answer.value - question.correct);
        const tol = question.tolerance ?? 0;
        return onSubmit(diff <= tol, ms, numberRatio(diff, question.min, question.max));
      }
      case "text":
        return;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase text-foreground/60">
          {getQuestionMeta(question.type).name}
        </span>
        <span className="font-display italic text-xl text-volt">
          {Math.ceil(remainingMs / 1000)}s
        </span>
      </div>
      <QuestionTimerBar remainingMs={remainingMs} totalMs={timeLimit} />

      <h2 className="font-display text-2xl sm:text-3xl italic leading-tight">
        {question.prompt}
      </h2>

      <QuestionRenderer
        question={spec}
        elapsedMs={elapsedMs}
        timeLimitMs={timeLimit}
        onAnswer={handleAnswer}
      />
    </div>
  );
}

// ---------- Reveal ----------
function RevealCard({
  question,
  correct,
  points,
  onNext,
  isLast,
}: {
  question: DemoQuestion;
  correct: boolean;
  points: number;
  onNext: () => void;
  isLast: boolean;
}) {
  const label = correctAnswerLabel(question);
  return (
    <div
      className="p-8 border-2 text-center animate-fade-in"
      style={{ borderColor: correct ? "var(--volt)" : "var(--pink-shock)" }}
    >
      <p
        className="font-display text-3xl italic uppercase"
        style={{ color: correct ? "var(--volt)" : "var(--pink-shock)" }}
      >
        {correct ? "Correct!" : points > 0 ? "Close!" : "Missed"}
      </p>
      <p className="mt-3 font-mono text-xs uppercase text-foreground/60">Answer</p>
      <p className="mt-1 font-display text-2xl italic">{label}</p>
      <p className="mt-4 font-mono text-sm uppercase text-foreground/80">
        +<span className="text-volt">{points}</span> pts
      </p>
      <button
        onClick={onNext}
        className="mt-6 w-full bg-volt text-background font-display text-lg py-3 skew-cta active:scale-95 transition-transform"
      >
        {isLast ? "SEE RESULTS" : "NEXT QUESTION"}
      </button>
    </div>
  );
}

function correctAnswerLabel(q: DemoQuestion): string {
  switch (q.type) {
    case "mcq":
    case "image_reveal":
    case "audio":
      return q.choices[q.correctIndex];
    case "true_false":
      return q.correct ? "TRUE" : "FALSE";
    case "ordering":
      return q.items.join(" → ");
    case "map_pin":
      return `${q.correct.lat.toFixed(2)}, ${q.correct.lng.toFixed(2)}`;
    case "number":
      return `${q.correct}${q.unit ? " " + q.unit : ""}`;
  }
}

// ---------- Completion ----------
function CompletionCard({
  score,
  total,
  onLive,
  onRequest,
}: {
  score: number;
  total: number;
  onLive: () => void;
  onRequest: () => void;
}) {
  return (
    <div className="space-y-6 animate-fade-in text-center py-8">
      <div className="text-6xl">🏆</div>
      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-foreground/60">
          Training Complete
        </p>
        <h2 className="mt-2 font-display text-3xl sm:text-4xl italic uppercase">
          You've completed the<br />
          <span className="text-volt">BrainBolt Training Arena</span>
        </h2>
      </div>
      <div className="inline-block px-8 py-4 border-2 border-volt">
        <p className="font-mono text-[10px] uppercase text-foreground/60">Demo Score</p>
        <p className="font-display text-5xl italic text-volt">{score.toLocaleString()}</p>
        <p className="font-mono text-[10px] uppercase text-foreground/60">
          across {total} question types
        </p>
      </div>
      <div className="grid gap-3 max-w-sm mx-auto pt-4">
        <button
          onClick={onLive}
          className="w-full bg-volt text-background font-display text-lg py-4 skew-cta active:scale-95 transition-transform"
        >
          JOIN LIVE MATCH
        </button>
        <button
          onClick={onRequest}
          className="w-full border-2 border-pink-shock text-pink-shock font-display text-lg py-4 skew-cta active:scale-95 transition-transform uppercase"
        >
          Request Hosting Access
        </button>
      </div>
    </div>
  );
}
