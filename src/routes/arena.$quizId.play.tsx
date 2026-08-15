import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuthUser } from "@/hooks/use-auth-user";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { computePoints } from "@/lib/game";
import { getNumberFormat } from "@/lib/number-format";
import {
  QuestionRenderer,
  QuestionTimerBar,
  type QuestionSpec,
  type SubmittedAnswer,
} from "@/components/question/QuestionRenderer";
import { useSoloTimer } from "@/hooks/use-solo-timer";
import { geoRatio, haversineKm, numberRatio, orderingRatio } from "@/lib/question-registry";
import {
  fetchArenaDetail,
  fetchArenaQuestions,
  fetchPersonalBest,
  normalizeText,
  optionList,
  readPersonalBest,
  estimatedMinutes,
  formatUpdated,
  submitArenaRun,
  writePersonalBest,
  type ArenaAnswer,
  type ArenaQuestion,
  type ArenaQuizDetail,
} from "@/lib/arena";

import { difficultyTheme } from "@/lib/arena-visuals";
import { ArenaArtwork, DifficultyChip } from "@/components/arena/ArenaVisuals";
import { createArenaClaim, savePendingClaim } from "@/lib/claim";

export const Route = createFileRoute("/arena/$quizId/play")({
  head: () => ({
    meta: [
      { title: "Playing an Arena Challenge — Brain Bolt" },
      {
        name: "description",
        content: "Solo Arena run: answer fast, score high and beat your personal best in Brain Bolt Arena.",
      },
      { property: "og:title", content: "Playing an Arena Challenge — Brain Bolt" },
      { property: "og:description", content: "Solo Arena run in Brain Bolt Arena." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ArenaPlay,
});

type Phase = "pregame" | "playing" | "reveal" | "done";

type Identity = { name: string; avatarId: string | null; seed: string };


function ArenaPlay() {
  const { quizId } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuthUser();

  const [detail, setDetail] = useState<ArenaQuizDetail | null>(null);
  const [questions, setQuestions] = useState<ArenaQuestion[] | null>(null);
  const [identity, setIdentity] = useState<Identity>({
    name: "Guest Player",
    avatarId: null,
    seed: "guest",
  });

  const [phase, setPhase] = useState<Phase>("pregame");
  const [idx, setIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [lastPoints, setLastPoints] = useState(0);
  const [lastCorrect, setLastCorrect] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [prevBest, setPrevBest] = useState<number | null>(null);
  const runIdRef = useRef<string>(crypto.randomUUID());
  const answersRef = useRef<ArenaAnswer[]>([]);

  const [beatBest, setBeatBest] = useState(false);
  const [claimToken, setClaimToken] = useState<string | null>(null);

  useEffect(() => {
    setPrevBest(readPersonalBest(quizId));
    Promise.all([fetchArenaDetail(quizId), fetchArenaQuestions(quizId)])
      .then(([d, qs]) => {
        setDetail(d);
        setQuestions(qs);
      })
      .catch((e) => {
        toast.error(e.message ?? "Could not load this challenge");
        navigate({ to: "/arena" });
      });
  }, [quizId, navigate]);

  useEffect(() => {
    if (!user) return;
    // Authoritative personal best comes from stored results, not local cache.
    fetchPersonalBest(quizId, user.id).then((best) => {
      if (best != null) setPrevBest(best);
    });
    supabase
      .from("profiles")
      .select("display_name,username,avatar_id")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setIdentity({
          name: (data as any).username || (data as any).display_name || "Player",
          avatarId: (data as any).avatar_id ?? null,
          seed: user.id,
        });
      });
  }, [user, quizId]);


  const total = questions?.length ?? 0;
  const question = questions?.[idx];

  function finish(finalScore: number) {
    const improved = writePersonalBest(quizId, finalScore);
    setBeatBest(improved);
    setPhase("done");
    const answers = answersRef.current;
    // The client never reports a score: it sends the raw answers and the
    // server re-grades them against the stored questions.
    if (user && total > 0) {
      submitArenaRun({ runId: runIdRef.current, quizId, answers })
        .then((r) => {
          if (r) setScore(r.score);
        })
        .catch(() => {
          /* history write is best-effort; gameplay never blocks on it */
        });
    } else if (total > 0) {
      // Guest run: mint a single-use claim ticket so the run can be attached
      // to an account if the player registers within 24h.
      createArenaClaim(quizId, answers)
        .then((token) => {
          setClaimToken(token);
          savePendingClaim({
            token,
            kind: "arena",
            label: detail?.title ?? "Arena run",
            returnTo: `/arena/${quizId}`,
            createdAt: Date.now(),
          });
        })
        .catch(() => {
          /* claiming is optional; never block the completion screen */
        });
    }
  }

  function submit(
    isCorrect: boolean,
    responseMs: number,
    partialRatio?: number,
    raw?: Omit<ArenaAnswer, "question_id" | "response_ms">,
  ) {
    if (answered || !question) return;
    setAnswered(true);
    answersRef.current = [
      ...answersRef.current,
      { question_id: question.q_id, response_ms: Math.max(0, Math.round(responseMs)), ...(raw ?? {}) },
    ];
    const ratio = partialRatio ?? (isCorrect ? 1 : 0);
    const limitMs = (question.q_time_limit_sec ?? detail?.time_per_question ?? 20) * 1000;
    const base = computePoints({
      isCorrect: ratio > 0,
      responseMs,
      timeLimitMs: limitMs,
      streak: isCorrect ? streak : 0,
      basePoints: question.q_point_value || 1000,
    });
    const pts = Math.round(base * ratio) * (question.q_double_points ? 2 : 1);
    setLastPoints(pts);
    setLastCorrect(isCorrect);
    setScore((s) => s + pts);

    setStreak((s) => (isCorrect ? s + 1 : 0));
    if (isCorrect) setCorrectCount((c) => c + 1);
    setTimeout(() => setPhase("reveal"), 300);
  }

  function next() {
    if (idx + 1 >= total) {
      finish(score);
      return;
    }
    setIdx(idx + 1);
    setAnswered(false);
    setLastPoints(0);
    setLastCorrect(false);
    setPhase("playing");
  }

  function replay() {
    runIdRef.current = crypto.randomUUID();
    answersRef.current = [];
    setPrevBest(readPersonalBest(quizId));

    setIdx(0);
    setScore(0);
    setStreak(0);
    setCorrectCount(0);
    setAnswered(false);
    setLastPoints(0);
    setLastCorrect(false);
    setBeatBest(false);
    setPhase("pregame");
  }

  if (!questions || !detail) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center">
        <p className="font-mono text-xs uppercase text-foreground/50">Entering the arena…</p>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center px-6 text-center">
        <div className="space-y-4">
          <p className="font-mono text-xs uppercase text-foreground/50">
            This challenge has no playable questions yet.
          </p>
          <Link
            to="/arena"
            className="inline-block px-4 py-2 border border-volt text-volt font-mono text-xs uppercase"
          >
            Back to Arena
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 bg-background/80 backdrop-blur-md border-b border-border">
        <Link
          to="/arena/$quizId"
          params={{ quizId }}
          className="font-mono text-xs uppercase text-foreground/60 hover:text-volt"
        >
          ← Exit
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-widest text-volt truncate max-w-[45%]">
          {detail.title}
        </span>
        <span className="font-display italic text-lg text-volt">{score.toLocaleString()}</span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {phase === "pregame" && (
          <PreGame
            detail={detail}
            identity={identity}
            total={total}
            onStart={() => setPhase("playing")}
          />
        )}

        {(phase === "playing" || phase === "reveal") && (
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

        {phase === "playing" && question && (
          <QuestionCard
            key={question.q_id}
            question={question}
            fallbackLimitSec={detail.time_per_question}
            onSubmit={submit}
          />
        )}

        {phase === "reveal" && question && (
          <RevealCard
            question={question}
            correct={lastCorrect}
            points={lastPoints}
            isLast={idx + 1 >= total}
            onNext={next}
          />
        )}

        {phase === "done" && (
          <Completion
            detail={detail}
            identity={identity}
            score={score}
            correct={correctCount}
            total={total}
            prevBest={prevBest}
            beatBest={beatBest}
            signedIn={!!user}
            claimToken={claimToken}
            onReplay={replay}
          />
        )}
      </main>
    </div>
  );
}

/* ---------------- Pre-game ---------------- */

function PreGame({
  detail,
  identity,
  total,
  onStart,
}: {
  detail: ArenaQuizDetail;
  identity: Identity;
  total: number;
  onStart: () => void;
}) {
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (count <= 0) {
      const t = setTimeout(onStart, 500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count, onStart]);

  const theme = difficultyTheme(detail.difficulty);

  return (
    <div
      className="relative overflow-hidden border-2 bg-card p-8 text-center space-y-6 animate-fade-in min-h-[420px] flex flex-col justify-center"
      style={{
        borderColor: theme.color,
        boxShadow: `0 24px 60px -34px color-mix(in oklab, ${theme.color} 65%, transparent)`,
      }}
    >
      <span
        className="pointer-events-none absolute inset-0"
        style={{ background: theme.gradient, opacity: 0.5 }}
      />
      <div className="relative space-y-6">
        <div className="space-y-3">
          <ArenaArtwork
            quizId={detail.id}
            title={detail.title}
            difficulty={detail.difficulty}
            className="mx-auto size-24"
            rounded
          />
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
            Brain Bolt Arena
          </p>
          <h1 className="font-display text-3xl sm:text-4xl italic uppercase tracking-tight">
            {detail.title}
          </h1>
        </div>

        <div className="flex items-center justify-center gap-3">
          <PlayerAvatar avatarId={identity.avatarId} seed={identity.seed} size={56} />
          <div className="text-left">
            <p className="font-display text-xl italic">{identity.name}</p>
            <p className="font-mono text-[10px] uppercase text-foreground/50">Entering the arena</p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 font-mono text-[10px] uppercase tracking-widest text-foreground/60">
          <DifficultyChip difficulty={detail.difficulty} />
          <span>
            {total} questions ·{" "}
            {detail.estimated_duration_minutes ??
              Math.max(1, Math.round((total * detail.time_per_question) / 60))}{" "}
            min
          </span>
        </div>

        <div
          className="font-display text-7xl italic motion-safe:animate-pulse"
          style={{ color: theme.color }}
          aria-live="polite"
        >
          {count > 0 ? count : "GO"}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Question ---------------- */

/** Raw payload sent to the server for re-grading. */
type RawAnswer = Omit<ArenaAnswer, "question_id" | "response_ms">;

/** Arena question row → the shared, answer-key-free renderer spec. */
function toSpec(question: ArenaQuestion): QuestionSpec {
  const options = optionList(question.q_options);
  return {
    id: question.q_id,
    type: question.q_question_type,
    prompt: question.q_text,
    options,
    imageUrl: question.q_image_url ?? null,
    audioUrl: question.q_audio_url ?? null,
    revealStages: question.q_reveal_stages ?? null,
    number: {
      min: Number(question.q_number_min ?? 0),
      max: Number(question.q_number_max ?? 100),
      format: getNumberFormat(question.q_options),
    },
  };
}

function QuestionCard({
  question,
  fallbackLimitSec,
  onSubmit,
}: {
  question: ArenaQuestion;
  fallbackLimitSec: number;
  onSubmit: (correct: boolean, responseMs: number, ratio?: number, raw?: RawAnswer) => void;
}) {
  const timeLimit = (question.q_time_limit_sec ?? fallbackLimitSec ?? 20) * 1000;
  const { elapsedMs, remainingMs, timedOut, responseMs } = useSoloTimer(question.q_id, timeLimit);
  const spec = useMemo(() => toSpec(question), [question]);

  useEffect(() => {
    if (timedOut) onSubmit(false, timeLimit, 0, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timedOut]);

  /** Local grading for immediate feedback only — the server re-grades the run. */
  function handleAnswer(answer: SubmittedAnswer) {
    const ms = responseMs();
    switch (answer.kind) {
      case "choice":
        return onSubmit(answer.index === question.q_correct_index, ms, undefined, { selected_index: answer.index });
      case "order": {
        const ratio = orderingRatio(answer.labels, spec.options);
        return onSubmit(ratio === 1, ms, ratio, { order: answer.order });
      }
      case "geo": {
        const dist = haversineKm(answer, {
          lat: Number(question.q_correct_lat ?? 0),
          lng: Number(question.q_correct_lng ?? 0),
        });
        const tol = Number(question.q_max_distance_km ?? 500);
        return onSubmit(dist <= tol, ms, geoRatio(dist, tol), { lat: answer.lat, lng: answer.lng });
      }
      case "number": {
        const diff = Math.abs(answer.value - Number(question.q_correct_number ?? 0));
        const tol = Number(question.q_number_tolerance ?? 0);
        const ratio = numberRatio(diff, spec.number!.min, spec.number!.max);
        return onSubmit(diff <= tol, ms, ratio, { value: answer.value });
      }
      case "text": {
        const accepted = (question.q_accepted_answers ?? []).map(normalizeText);
        return onSubmit(accepted.includes(normalizeText(answer.text)), ms, undefined, { text: answer.text });
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase text-foreground/60">
          {question.q_double_points ? "⭐ Double points" : "Arena"}
        </span>
        <span className="font-display italic text-xl text-volt">
          {Math.ceil(remainingMs / 1000)}s
        </span>
      </div>
      <QuestionTimerBar remainingMs={remainingMs} totalMs={timeLimit} />

      <h2 className="font-display text-2xl sm:text-3xl italic leading-tight">{question.q_text}</h2>

      <QuestionRenderer
        question={spec}
        elapsedMs={elapsedMs}
        timeLimitMs={timeLimit}
        onAnswer={handleAnswer}
      />
    </div>
  );
}


/* ---------------- Reveal ---------------- */

function RevealCard({
  question,
  correct,
  points,
  isLast,
  onNext,
}: {
  question: ArenaQuestion;
  correct: boolean;
  points: number;
  isLast: boolean;
  onNext: () => void;
}) {
  const options = optionList(question.q_options);
  let answer = "—";
  switch (question.q_question_type) {
    case "ordering":
      answer = options.join(" → ");
      break;
    case "map_pin":
      answer = `${Number(question.q_correct_lat ?? 0).toFixed(2)}, ${Number(question.q_correct_lng ?? 0).toFixed(2)}`;
      break;
    case "number":
      answer = String(question.q_correct_number ?? "—");
      break;
    case "type":
      answer = (question.q_accepted_answers ?? [])[0] ?? "—";
      break;
    default:
      answer = options[question.q_correct_index] ?? "—";
  }

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
      <p className="mt-1 font-display text-2xl italic">{answer}</p>
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

/* ---------------- Completion ---------------- */

function Completion({
  detail,
  identity,
  score,
  correct,
  total,
  prevBest,
  beatBest,
  signedIn,
  claimToken,
  onReplay,
}: {
  detail: ArenaQuizDetail;
  identity: Identity;
  score: number;
  correct: number;
  total: number;
  prevBest: number | null;
  beatBest: boolean;
  signedIn: boolean;
  claimToken: string | null;
  onReplay: () => void;
}) {
  const accuracy = total ? Math.round((correct / total) * 100) : 0;
  const isFirstRun = prevBest == null;
  const theme = difficultyTheme(detail.difficulty);

  return (
    <div className="space-y-6 motion-safe:animate-fade-in text-center py-6">
      <div
        className="relative overflow-hidden border-2 bg-card px-6 py-8 space-y-5"
        style={{
          borderColor: theme.color,
          boxShadow: `0 26px 60px -34px color-mix(in oklab, ${theme.color} 65%, transparent)`,
        }}
      >
        <span
          className="pointer-events-none absolute inset-0"
          style={{ background: theme.gradient, opacity: 0.45 }}
        />
        <div className="relative space-y-5">
          <div className="flex items-center justify-center gap-3">
            <PlayerAvatar avatarId={identity.avatarId} seed={identity.seed} size={48} />
            <p className="font-display text-xl italic">{identity.name}</p>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
              Challenge complete
            </p>
            <h2 className="mt-1 font-display text-3xl sm:text-4xl italic uppercase">
              {detail.title}
            </h2>
          </div>

          <div className="motion-safe:animate-burst">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              Final score
            </p>
            <p
              className="font-display text-6xl sm:text-7xl italic leading-none"
              style={{ color: theme.color }}
            >
              {score.toLocaleString()}
            </p>
          </div>

          {(beatBest || isFirstRun) && (
            <p
              className="inline-block px-4 py-2 border font-mono text-[10px] uppercase tracking-widest motion-safe:animate-pulse"
              style={{ color: theme.color, borderColor: theme.color, background: theme.tint }}
            >
              {beatBest ? "★ New personal best" : "★ Personal best set"}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 max-w-md mx-auto">
        <Metric label="Score" value={score.toLocaleString()} accent />
        <Metric label="Accuracy" value={`${accuracy}%`} />
        <Metric label="Correct" value={`${correct}/${total}`} />
      </div>


      <div className="max-w-md mx-auto bg-card border border-border p-4 text-left space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
          Summary
        </p>
        <p className="text-foreground/70 text-sm">
          {total} questions · {(detail.difficulty ?? "medium").toLowerCase()} difficulty · ~
          {estimatedMinutes({
            estimated_duration_minutes: detail.estimated_duration_minutes,
            question_count: detail.question_count,
            time_per_question: detail.time_per_question,
          })}{" "}
          min · {detail.play_count.toLocaleString()} plays
        </p>
        <p className="text-foreground/50 text-sm">
          {prevBest != null ? `Previous best ${prevBest.toLocaleString()} pts` : "First run"} ·
          Updated {formatUpdated(detail.last_updated)}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">
          {signedIn
            ? "Saved to your profile history"
            : "Sign in to save this run to your profile"}
        </p>
      </div>

      <div className="grid gap-3 max-w-sm mx-auto pt-2">
        <button
          onClick={onReplay}
          className="w-full bg-volt text-background font-display text-lg py-4 skew-cta active:scale-95 transition-transform"
        >
          PLAY AGAIN
        </button>
        {!signedIn && claimToken && (
          <a
            href={`/auth?next=${encodeURIComponent(`/arena/${detail.id}`)}`}
            className="w-full text-center border-2 border-volt text-volt font-display text-lg py-4 skew-cta active:scale-95 transition-transform uppercase"
          >
            Save this result to my account
          </a>
        )}
        <Link
          to="/arena"
          className="w-full text-center border-2 border-cyan-jolt text-cyan-jolt font-display text-lg py-4 skew-cta active:scale-95 transition-transform uppercase"
        >
          Discover another challenge
        </Link>
        <Link
          to={signedIn ? "/profile" : "/auth"}
          className="w-full text-center border border-border py-3 font-mono text-xs uppercase tracking-widest text-foreground/60 hover:text-volt hover:border-volt transition-colors"
        >
          {signedIn ? "View your profile" : "Sign up to save your scores"}
        </Link>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`border p-4 ${accent ? "border-volt" : "border-border bg-card"}`}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">{label}</p>
      <p className={`font-display text-2xl italic ${accent ? "text-volt" : ""}`}>{value}</p>
    </div>
  );
}
