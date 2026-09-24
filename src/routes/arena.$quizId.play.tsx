import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toastError } from "@/lib/errors";
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
import { geoCorrectness, numberRatio, orderingRatio } from "@/lib/question-registry";
import {
  arenaShareDataFromRun,
  fetchArenaDetail,
  fetchArenaList,
  fetchArenaPlatformState,
  fetchArenaQuestions,
  fetchArenaRunInsights,
  fetchArenaHistory,
  fetchPersonalBest,
  fetchPersonalBests,
  fetchPreviousBest,
  normalizeText,
  optionList,
  pickNextBolt,
  readPersonalBest,
  estimatedMinutes,
  submitArenaRun,
  writePersonalBest,
  type ArenaAnswer,
  type ArenaListItem,
  type ArenaPlayerHistory,
  type ArenaQuestion,
  type ArenaQuizDetail,
  type ArenaRunInsights,
  type ArenaRunResult,
} from "@/lib/arena";

import { difficultyTheme } from "@/lib/arena-visuals";
import { ArenaArtwork, DifficultyChip } from "@/components/arena/ArenaVisuals";
import { createArenaClaim, savePendingClaim } from "@/lib/claim";
import { ShareCardVisual, downloadShareCard, shareShareCard } from "@/components/ShareResultCard";
import { canAnnounceBest, deriveRunInsights, formatResponseMs, personalBestVerdict } from "@/lib/arena-insights";
import { LOADING, answeredLabel, bestComparisonLabel } from "@/lib/terminology";
import { questionTypeLabel } from "@/lib/question-presentation";

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

  const [claimToken, setClaimToken] = useState<string | null>(null);
  // Highest streak reached during this run — the share card reports it.
  const [maxStreak, setMaxStreak] = useState(0);

  // Phase 9B — platform state + insights + server-confirmed previous best.
  const [platformClosed, setPlatformClosed] = useState(false);
  const [closedMessage, setClosedMessage] = useState<string | null>(null);
  /**
   * The server's re-grade of this run. It is the single source of the headline
   * score, the "questions right" count and the accuracy, because the client's
   * partial-credit maths is only a preview — the two graders genuinely differ
   * (the server omits the streak bonus for partial-credit types and uses a
   * tighter tolerance for Closest Number). Showing a client number anywhere
   * after this lands would put two different scores on screen at once.
   */
  const [serverResult, setServerResult] = useState<ArenaRunResult | null>(null);
  /**
   * False only while a signed-in run is waiting for the server's grade. The
   * comparative claims (new personal best, the improvement figure) stay hidden
   * until it is true, because `score` is briefly the local preview and would
   * otherwise make a badge appear and then retract.
   */
  const [gradeSettled, setGradeSettled] = useState(true);
  const [insights, setInsights] = useState<ArenaRunInsights | null>(null);
  const [serverPrevBest, setServerPrevBest] = useState<number | null>(null);
  // History captured BEFORE this run starts, so the result screen can compare
  // against what the player walked in with rather than what they just set.
  const [historyBeforeRun, setHistoryBeforeRun] = useState<ArenaPlayerHistory | null>(null);
  // The published catalog + the challenges this player has already finished.
  // Grouped so "Next Bolt" can prefer something genuinely new.
  const [arenaCatalog, setArenaCatalog] = useState<ArenaListItem[]>([]);
  const [playedIds, setPlayedIds] = useState<string[]>([]);
  const nextBolt = useMemo(
    () => pickNextBolt(arenaCatalog, quizId, playedIds),
    [arenaCatalog, quizId, playedIds],
  );

  useEffect(() => {
    setPrevBest(readPersonalBest(quizId));
    fetchArenaPlatformState()
      .then((s) => {
        setPlatformClosed(!s.arena_open);
        setClosedMessage(s.arena_closed_message);
      })
      .catch(() => {
        /* non-fatal — the run submission is the real gate */
      });
    Promise.all([fetchArenaDetail(quizId), fetchArenaQuestions(quizId)])
      .then(([d, qs]) => {
        setDetail(d);
        setQuestions(qs);
      })
      .catch((e) => {
        toastError(e, { context: "challenge play", fallback: "Could not load this challenge" });
        navigate({ to: "/arena" });
      });
    // Loaded up front so "Next Bolt" resolves instantly on the result screen.
    fetchArenaList()
      .then(setArenaCatalog)
      .catch(() => {
        /* the Next Bolt button hides itself when there is no target */
      });
  }, [quizId, navigate]);

  useEffect(() => {
    if (!user) return;
    // Authoritative personal best comes from stored results, not local cache.
    fetchPersonalBest(quizId, user.id).then((best) => {
      if (best != null) setPrevBest(best);
    });
    // Snapshot the history now — after `finish()` this would already include
    // the run the player is looking at.
    fetchArenaHistory(quizId, user.id)
      .then((h) => setHistoryBeforeRun(h))
      .catch(() => {
        /* the result screen degrades to the local personal best */
      });
    // Which challenges this player has already finished — Next Bolt prefers one
    // they haven't.
    fetchPersonalBests(user.id)
      .then((m) => setPlayedIds(Array.from(m.keys())))
      .catch(() => setPlayedIds([]));
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

  // Used to name the fastest / toughest question on the result screen.
  const questionPrompts = useMemo(
    () => new Map((questions ?? []).map((q) => [q.q_id, q.q_text])),
    [questions],
  );

  function finish(finalScore: number) {
    setPhase("done");
    const answers = answersRef.current;
    // The client never reports a score: it sends the raw answers and the
    // server re-grades them against the stored questions.
    if (user && total > 0) {
      // A signed-in run is graded server-side, so the local accumulator is only
      // a preview and must not become the record. Writing it to the local cache
      // would leave the cache claiming a personal best the Arena never stored.
      // Hold the comparative claims until the real grade lands, then write the
      // authoritative number.
      setGradeSettled(false);
      const runId = runIdRef.current;
      submitArenaRun({ runId, quizId, answers })
        .then((r) => {
          if (r) {
            // Adopt the authoritative run wholesale. `setScore` (rather than a
            // separate server field) keeps the sticky header and the completion
            // card on the same number.
            setServerResult(r);
            setScore(r.score);
            writePersonalBest(quizId, r.score);
          }
          // Fetched whether or not a grade came back, so a run that failed to
          // persist still gets whatever context the server can give.
          // NOTE: `get_previous_best_for_profile` orders by completed_at DESC,
          // so it returns the previous *score*, not the previous best — it is
          // only ever shown as "previous score".
          Promise.all([
            fetchArenaRunInsights(runId).catch(() => null),
            fetchPreviousBest({ quizId, profileId: user.id, beforeRunId: runId }).catch(
              () => null,
            ),
          ]).then(([i, prev]) => {
            if (i) setInsights(i);
            if (prev != null) setServerPrevBest(prev);
          });
        })
        .catch((e) => {
          // Platform-closed or quiz-unavailable race condition: the server
          // raises a structured error. Surface a friendly message and bail
          // to the catalog.
          const msg = String((e as { message?: string })?.message ?? "");
          if (msg.includes("arena_closed")) {
            setPlatformClosed(true);
            setClosedMessage(
              "The Arena was closed while you were playing. Your score was not saved.",
            );
          } else if (msg.includes("not an arena quiz")) {
            toastError(e, {
              context: "challenge play",
              fallback: "This challenge is no longer available in the Arena.",
            });
            navigate({ to: "/arena" });
          } else {
            toastError(e, { context: "challenge play" });
          }
        })
        .finally(() => {
          // Even a failed grade must release the comparative claims, or the
          // badge would never render for this run.
          setGradeSettled(true);
        });
    } else if (total > 0) {
      // Guest run: there is no server grade to wait for, so the local
      // accumulator IS the record and the cache is written straight away.
      writePersonalBest(quizId, finalScore);
      // Mint a single-use claim ticket so the run can be attached to an account
      // if the player registers within 24h.
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

    const nextStreak = isCorrect ? streak + 1 : 0;
    setStreak(nextStreak);
    setMaxStreak((m) => Math.max(m, nextStreak));
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
    setMaxStreak(0);
    setCorrectCount(0);
    setAnswered(false);
    setLastPoints(0);
    setLastCorrect(false);
    setClaimToken(null);
    setGradeSettled(true);
    // Run 1's result data must not survive into run 2, or the next completion
    // screen shows run 1's insights and verified score until the new fetches
    // resolve — or forever, if they fail.
    setServerResult(null);
    setServerPrevBest(null);
    setInsights(null);
    // The pre-run snapshot now has to include the run that just finished.
    if (user) {
      fetchArenaHistory(quizId, user.id)
        .then((h) => setHistoryBeforeRun(h))
        .catch(() => setHistoryBeforeRun(null));
      fetchPersonalBests(user.id)
        .then((m) => setPlayedIds(Array.from(m.keys())))
        .catch(() => setPlayedIds([]));
    }
    setPhase("pregame");
  }

  if (!questions || !detail) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center">
        <p role="status" className="font-mono text-xs uppercase text-foreground/50">
          {LOADING.loadingChallenge}
        </p>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center px-6 text-center">
        <div className="space-y-4">
          <p className="text-foreground/70 max-w-sm mx-auto">
            This challenge has no questions ready to play yet. Pick another one from the Arena —
            there are plenty waiting.
          </p>
          <Link
            to="/arena"
            className="inline-flex min-h-11 items-center px-4 py-2 border border-volt text-volt font-mono text-xs uppercase"
          >
            Back to the Arena
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 px-4 py-3 bg-background/80 backdrop-blur-md border-b border-border">
        <Link
          to="/arena/$quizId"
          params={{ quizId }}
          className="inline-flex min-h-11 items-center font-mono text-xs uppercase text-foreground/60 hover:text-volt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
        >
          ← Exit
        </Link>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-[10px] uppercase tracking-widest text-foreground/70">
          {detail.title}
        </span>
        <span
          className="font-display italic text-lg text-volt tabular-nums"
          aria-label={`Score ${score}`}
        >
          {score.toLocaleString()}
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {phase === "pregame" && platformClosed && (
          <div
            role="status"
            className="border-2 border-pink-shock/30 bg-pink-shock/10 p-6 space-y-3 text-center"
          >
            <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">
              Arena closed
            </p>
            <p className="text-foreground/80 text-sm">
              {closedMessage ?? "The Arena is closed at the moment. Please check back soon."}
            </p>
            <Link
              to="/arena"
              className="inline-flex min-h-11 items-center border border-volt text-volt font-mono text-xs uppercase px-4 py-2 hover:bg-volt hover:text-background"
            >
              Back to the Arena
            </Link>
          </div>
        )}

        {phase === "pregame" && !platformClosed && (
          <PreGame
            detail={detail}
            identity={identity}
            total={total}
            personalBest={historyBeforeRun?.best ?? prevBest}
            attempts={historyBeforeRun?.attempts ?? null}
            onStart={() => setPhase("playing")}
          />
        )}

        {(phase === "playing" || phase === "reveal") && (
          <div className="flex items-center gap-3" role="group" aria-label="Challenge progress">
            <div className="flex-1 h-1.5 bg-border overflow-hidden">
              <div
                className="h-full bg-volt transition-all"
                style={{ width: `${((idx + (phase === "reveal" ? 1 : 0)) / total) * 100}%` }}
              />
            </div>
            <span className="font-mono text-[10px] uppercase text-foreground/60 tabular-nums">
              {answeredLabel(Math.min(idx + (phase === "reveal" ? 1 : 0), total), total)}
            </span>
            {streak >= 2 && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-amber-spark">
                {streak} in a row
              </span>
            )}
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
            // `score` is the single shared number: the local accumulator during
            // play, replaced by the authoritative value once the server
            // re-grades the run. The header reads the same state.
            score={score}
            correct={serverResult?.correct_count ?? correctCount}
            gradedCount={serverResult?.graded_count ?? total}
            serverAccuracy={serverResult?.accuracy ?? null}
            gradeSettled={gradeSettled}
            // Distinct from `gradeSettled`: a thrown submit also settles, and a
            // run that never persisted must not be described as saved.
            gradeSaved={serverResult != null}
            total={total}
            prevBest={prevBest}
            historyBeforeRun={historyBeforeRun}
            serverPrevBest={serverPrevBest}
            insights={insights}
            questionPrompts={questionPrompts}
            nextBolt={nextBolt}
            maxStreak={maxStreak}
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
  personalBest,
  attempts,
  onStart,
}: {
  detail: ArenaQuizDetail;
  identity: Identity;
  total: number;
  personalBest: number | null;
  attempts: number | null;
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

        <div className="flex flex-wrap items-center justify-center gap-3 font-mono text-[10px] uppercase tracking-widest text-foreground/60">
          <DifficultyChip difficulty={detail.difficulty} />
          <span>
            {total} {total === 1 ? "question" : "questions"} ·{" "}
            {detail.estimated_duration_minutes ??
              Math.max(1, Math.round((total * detail.time_per_question) / 60))}{" "}
            min
          </span>
          {personalBest != null ? (
            <span className="text-volt">to beat {personalBest.toLocaleString()}</span>
          ) : (
            <span>first run — set your best</span>
          )}
        </div>

        {personalBest != null && attempts != null && attempts > 0 && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">
            Run {attempts + 1} on this challenge
          </p>
        )}

        <div
          className="font-display text-7xl italic motion-safe:animate-pulse"
          style={{ color: theme.color }}
          aria-live="polite"
          aria-label={count > 0 ? `Starting in ${count}` : "Go"}
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
        // Preview grading only — the server re-grades the run via
        // evaluate_question_answer with the same unified formula.
        const correctness = geoCorrectness(answer, {
          lat: Number(question.q_correct_lat ?? 0),
          lng: Number(question.q_correct_lng ?? 0),
          maxDistanceKm: Number(question.q_max_distance_km ?? 5000),
          region: question.q_geo_region ?? null,
        });
        return onSubmit(correctness >= 0.9, ms, correctness, { lat: answer.lat, lng: answer.lng });
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
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
          {questionTypeLabel(question.q_question_type)}
          {question.q_double_points && <span className="ml-2 text-amber-spark">· Double points</span>}
        </span>
        <span className="font-display italic text-xl text-volt tabular-nums">
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
      answer =
        question.q_geo_region_label ??
        `${Number(question.q_correct_lat ?? 0).toFixed(2)}, ${Number(question.q_correct_lng ?? 0).toFixed(2)}`;
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
  gradedCount,
  serverAccuracy,
  gradeSettled,
  gradeSaved,
  total,
  prevBest,
  historyBeforeRun,
  serverPrevBest,
  insights,
  questionPrompts,
  nextBolt,
  maxStreak,
  signedIn,
  claimToken,
  onReplay,
}: {
  detail: ArenaQuizDetail;
  identity: Identity;
  score: number;
  correct: number;
  /** Questions that could be graded (excludes ungraded types like Written Answer). */
  gradedCount: number;
  /** The server's accuracy, 0-100. Null while the run is still being graded. */
  serverAccuracy: number | null;
  /**
   * False while a signed-in run awaits the server's grade. `score` is briefly
   * the local preview, so the best/improvement claims wait for it.
   */
  gradeSettled: boolean;
  /**
   * True only when the authoritative run actually came back. A failed submit
   * also settles the grade, so this is what the "saved" copy is allowed to
   * claim.
   */
  gradeSaved: boolean;
  total: number;
  prevBest: number | null;
  historyBeforeRun: ArenaPlayerHistory | null;
  serverPrevBest: number | null;
  insights: ArenaRunInsights | null;
  questionPrompts: Map<string, string>;
  nextBolt: ArenaListItem | null;
  maxStreak: number;
  signedIn: boolean;
  claimToken: string | null;
  onReplay: () => void;
}) {
  // Accuracy must be derived from the same grading the score came from, or the
  // two numbers on this screen explain nothing about each other.
  const accuracy =
    serverAccuracy != null
      ? Math.round(serverAccuracy)
      : gradedCount > 0
        ? Math.round((correct / gradedCount) * 100)
        : 0;
  const theme = difficultyTheme(detail.difficulty);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);

  // The best the player had BEFORE this run. `historyBeforeRun.best` is the max
  // over every stored run, which is the only correct basis for a best
  // comparison. `serverPrevBest` is deliberately excluded here: it comes from
  // `get_previous_best_for_profile`, which orders by completed_at DESC and so
  // returns the previous *score*, not the previous best.
  const previousBest = historyBeforeRun?.best ?? prevBest;
  const previousScore = historyBeforeRun?.lastScore ?? serverPrevBest;
  const verdict = personalBestVerdict(score, previousBest);

  const runInsights = deriveRunInsights({
    insights,
    questionPrompts,
    quizAvgAccuracy: detail.avg_accuracy,
  });

  const shareData = arenaShareDataFromRun({
    quizTitle: detail.title,
    identityName: identity.name,
    score,
    correct,
    // The share card recomputes its own accuracy as correct/totalQuestions, so
    // it must use the same denominator as the screen's "Questions right" or the
    // exported image can disagree with the page it came from.
    totalQuestions: gradedCount,
    longestStreak: maxStreak,
  });

  // Guarded as well as disabled: an exported image is a durable record, so the
  // preview score must never be able to leave the screen no matter how the
  // handler is reached.
  async function handleShare() {
    if (!gradeSettled || sharing) return;
    setSharing(true);
    try {
      await shareShareCard(shareCardRef.current, shareData);
    } catch (e) {
      toastError(e, { context: "arena share", fallback: "Couldn't share your result." });
    } finally {
      setSharing(false);
    }
  }

  async function handleDownload() {
    if (!gradeSettled || sharing) return;
    setSharing(true);
    try {
      await downloadShareCard(shareCardRef.current, shareData);
    } catch (e) {
      toastError(e, { context: "arena download", fallback: "Couldn't save the image." });
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="space-y-6 motion-safe:animate-fade-in py-6">
      {/* Off-screen full-resolution card used for the share/download export. */}
      <div aria-hidden="true" style={{ position: "absolute", left: -99999, top: 0 }}>
        <ShareCardVisual data={shareData} innerRef={shareCardRef} />
      </div>

      <div
        className="relative overflow-hidden border-2 bg-card px-6 py-8 space-y-5 text-center"
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
            <div className="text-left">
              <p className="font-display text-xl italic">{identity.name}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                {detail.title}
              </p>
            </div>
          </div>

          <div className="motion-safe:animate-burst">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              Your score
            </p>
            <p
              className="font-display text-6xl sm:text-8xl italic leading-none tabular-nums"
              style={{ color: theme.color }}
            >
              {score.toLocaleString()}
            </p>
          </div>

          {/* The comparative claims wait for the authoritative grade. Showing
              them off the local preview would make a personal-best badge appear
              and then retract whenever the two graders disagree. */}
          {canAnnounceBest(gradeSettled, score, previousBest) && (
            <div className="space-y-2">
              <p
                className="inline-block px-4 py-2 border font-mono text-[11px] uppercase tracking-widest"
                style={{ color: theme.color, borderColor: theme.color, background: theme.tint }}
              >
                {verdict.isFirstRun ? "First score set" : "New personal best"}
              </p>
              <p className="font-display text-2xl italic text-volt">
                {bestComparisonLabel(score, previousBest)}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* The numbers a competitive player actually checks. Every tile that makes
          a claim about the player's record waits for the authoritative grade —
          a preview number that retracts is worse than no number. */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg mx-auto">
        <Metric label="Accuracy" value={`${accuracy}%`} accent />
        <Metric label="Questions right" value={`${correct}/${gradedCount}`} />
        <Metric
          label="Avg. answer speed"
          value={insights?.avg_response_ms != null ? formatResponseMs(insights.avg_response_ms) : "—"}
        />
        <Metric
          label="Personal best"
          value={
            !gradeSettled
              ? "Checking…"
              : (previousBest == null ? score : Math.max(score, previousBest)).toLocaleString()
          }
        />
        <Metric label="Previous score" value={previousScore != null ? previousScore.toLocaleString() : "—"} />
        <Metric
          label={!gradeSettled ? "Improvement" : verdict.delta >= 0 ? "Improvement" : "Difference"}
          value={
            !gradeSettled
              ? "Checking…"
              : previousBest == null
                ? "—"
                : `${verdict.delta >= 0 ? "+" : ""}${verdict.delta.toLocaleString()}`
          }
        />
      </dl>

      {runInsights.length > 0 && (
        <section className="max-w-lg mx-auto bg-card border border-border p-5 space-y-3 text-left">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-volt">
            How the run went
          </h2>
          <ul className="space-y-2.5">
            {runInsights.map((i) => (
              <li key={i.id} className="text-sm">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                  {i.label}
                </p>
                <p className="text-foreground/80">{i.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="max-w-lg mx-auto bg-card border border-border p-4 text-left space-y-1">
        <p className="text-foreground/70 text-sm">
          {total} {total === 1 ? "question" : "questions"} ·{" "}
          {(detail.difficulty ?? "medium").toLowerCase()} difficulty · ~
          {estimatedMinutes({
            estimated_duration_minutes: detail.estimated_duration_minutes,
            question_count: detail.question_count,
            time_per_question: detail.time_per_question,
          })}{" "}
          min
        </p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
          {!gradeSettled
            ? "Checking your score…"
            : signedIn && !gradeSaved
              ? "We couldn't save this run to your profile"
              : signedIn
                ? "Saved to your profile history"
                : "Sign in to keep this score on your profile"}
        </p>
        {gradeSettled && maxStreak >= 2 && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-amber-spark">
            Longest streak: {maxStreak} in a row
          </p>
        )}
      </div>

      {/* One obvious next step, then clear alternatives. */}
      <div className="grid gap-3 max-w-sm mx-auto pt-2">
        <button
          onClick={onReplay}
          className="w-full min-h-14 bg-volt text-background font-display text-xl uppercase italic py-4 skew-cta active:scale-95 transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
        >
          {/* The label only distinguishes once the grade is authoritative — it
              must not be decided by the local preview and then change. */}
          {gradeSettled && !verdict.isNewBest ? "Beat This Score" : "Play Again"}
        </button>

        {nextBolt && (
          <Link
            to="/arena/$quizId"
            params={{ quizId: nextBolt.id }}
            className="w-full min-h-14 text-center border-2 border-volt text-volt font-display text-xl uppercase italic py-4 skew-cta active:scale-95 transition-transform hover:bg-volt hover:text-background"
          >
            Next Bolt
            <span className="block font-sans text-[10px] normal-case tracking-normal opacity-70 mt-0.5">
              {nextBolt.title}
            </span>
          </Link>
        )}

        <Link
          to="/arena"
          className="w-full min-h-14 flex items-center justify-center border-2 border-cyan-jolt text-cyan-jolt font-display text-xl uppercase italic py-4 skew-cta active:scale-95 transition-transform hover:bg-cyan-jolt hover:text-background"
        >
          Explore Arena
        </Link>

        {/* Exporting is the one place a preview number could become a durable
            record, so the buttons wait for the authoritative grade too. Guests
            are unaffected — `gradeSettled` starts true for them. */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={handleShare}
            disabled={sharing || !gradeSettled}
            title={gradeSettled ? undefined : "Available once your score is confirmed"}
            className="min-h-11 border border-border py-3 font-mono text-xs uppercase tracking-widest text-foreground/70 transition-colors hover:border-volt hover:text-volt disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
          >
            {sharing ? "Preparing…" : "Share result"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={sharing || !gradeSettled}
            title={gradeSettled ? undefined : "Available once your score is confirmed"}
            className="min-h-11 border border-border py-3 font-mono text-xs uppercase tracking-widest text-foreground/70 transition-colors hover:border-volt hover:text-volt disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
          >
            Save image
          </button>
        </div>

        {!signedIn && claimToken && (
          <a
            href={`/auth?next=${encodeURIComponent(`/arena/${detail.id}`)}`}
            className="w-full text-center border border-volt text-volt font-mono text-xs uppercase tracking-widest py-3 hover:bg-volt hover:text-background transition-colors"
          >
            Save this result to my account
          </a>
        )}
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
