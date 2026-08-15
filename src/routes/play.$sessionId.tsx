import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveChannel, type LiveStatus } from "@/hooks/use-live-channel";
import { ConnectionBanner, LiveScreenState } from "@/components/ConnectionState";

import { supabase } from "@/integrations/supabase/client";
import { seededShuffle } from "@/lib/game";
import { getParticipant, clearParticipant, type ParticipantIdentity } from "@/lib/participant-storage";
import { createSessionClaim, savePendingClaim } from "@/lib/claim";
import { MapPicker } from "@/components/MapPicker";
import { NumberGuess } from "@/components/NumberGuess";
import { OrderingBoard } from "@/components/OrderingBoard";
import { formatNumber, getNumberFormat } from "@/lib/number-format";
import { toast } from "sonner";
import { QuestionIntro } from "@/components/QuestionIntro";
import { getQuestionIntroTiming } from "@/lib/question-intro-timing";
import { getServerAdjustedNow, syncServerClock } from "@/lib/server-clock";
import { ShareCardPreview, downloadShareCard, shareShareCard, type ShareResultData } from "@/components/ShareResultCard";
import { BrandBanner } from "@/components/BrandBanner";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useCoalescedCallback } from "@/hooks/use-coalesced-callback";
import { liveRevealBlur } from "@/lib/question-registry";


export const Route = createFileRoute("/play/$sessionId")({
  ssr: false,
  component: PlayPage,
  errorComponent: () => (
    <LiveScreenState
      spinner={false}
      title="Lost the connection"
      message="Your score and answers are stored on the server. Reconnect to jump back into the match."
      action={{ label: "RECONNECT", onClick: () => window.location.reload() }}
    />
  ),
});


type Session = {
  id: string;
  status: string;
  current_question_index: number;
  current_question_started_at: string | null;
  current_question_revealed: boolean;
  team_mode: boolean;
  question_order: string[] | null;
  quiz_id: string;
  league_id: string | null;
  paused_at: string | null;
  time_added_ms: number | null;
  quiz: { time_per_question: number; title: string } | null;
  branding: import("@/lib/branding").BrandingProfile | null;
};


type Question = {
  id: string;
  text: string;
  options: string[];
  correct_index: number; // -1 until revealed
  position: number;
  time_limit_sec: number | null;
  point_value: number;
  question_type: string;
  image_url: string | null;
  double_points: boolean;
  max_distance_km: number | null;
  number_min: number | null;
  number_max: number | null;
  reveal_stages: number | null;
  audio_url: string | null;
};


type Participant = {
  id: string;
  nickname: string;
  score: number;
  streak: number;
  team_id: string | null;
  avatar_id: string | null;
};

type MyAnswer = {
  question_id: string;
  selected_index: number;
  is_correct: boolean;
  points: number;
};

const COLORS = ["pink-shock", "cyan-jolt", "volt", "amber-spark"];

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

type ConnInfo = { status: LiveStatus; recovered: boolean };

/** Thin wrapper so the connection indicator overlays every gameplay screen. */
function PlayPage() {
  const [conn, setConn] = useState<ConnInfo>({ status: "connecting", recovered: false });
  return (
    <>
      <PlayScreen onConn={setConn} />
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <ConnectionBanner status={conn.status} recovered={conn.recovered} />
      </div>
    </>
  );
}

function PlayScreen({ onConn }: { onConn: (c: ConnInfo) => void }) {

  const { sessionId } = Route.useParams();
  const [identity, setIdentity] = useState<ParticipantIdentity | null | undefined>(undefined);
  const [authedUserId, setAuthedUserId] = useState<string | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [me, setMe] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [now, setNow] = useState(() => getServerAdjustedNow());
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [myAnswers, setMyAnswers] = useState<MyAnswer[]>([]);
  const [progress, setProgress] = useState<{ answered: number; total: number }>({ answered: 0, total: 0 });
  const [roundResult, setRoundResult] = useState<{ answered: boolean; selected_index: number | null; is_correct: boolean; points: number; correct_index: number; total_score: number; answer_value?: any; correct_lat?: number | null; correct_lng?: number | null; correct_number?: number | null; correct_text?: string | null; text_submission?: string | null } | null>(null);
  const answeredQuestionId = useRef<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);


  useEffect(() => {
    setIdentity(getParticipant(sessionId));
    supabase.auth.getUser().then(({ data }) => setAuthedUserId(data.user?.id ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setAuthedUserId(s?.user?.id ?? null));
    return () => sub.subscription.unsubscribe();
  }, [sessionId]);


  // Snapshot of participants list at the moment a round is revealed — used to compute movement arrows
  const [prevRanks, setPrevRanks] = useState<Map<string, number>>(new Map());
  const prevRankIndexRef = useRef<number>(-1);

  useEffect(() => {
    syncServerClock(true);
    const tick = setInterval(() => setNow(getServerAdjustedNow()), 200);
    const resync = setInterval(() => { syncServerClock(); }, 30_000);
    const onVis = () => { if (document.visibilityState === "visible") syncServerClock(true); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(tick); clearInterval(resync); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // Re-sync clock immediately when a new intro window begins so both host and
  // player converge on the same server timeline before rendering the reveal.
  useEffect(() => {
    if (!session?.current_question_started_at) return;
    syncServerClock(true).then(() => setNow(getServerAdjustedNow()));
  }, [session?.current_question_started_at]);


  // Authoritative state read. Used for the initial load, after every realtime
  // (re)connect and when the tab returns to the foreground. It never replays
  // missed events — it rebuilds from the current server state.
  const loadState = useCallback(async () => {
    if (!identity) return;
    const { data: s, error: sErr } = await supabase
      .from("sessions")
      .select("id,status,current_question_index,current_question_started_at,current_question_revealed,team_mode,question_order,quiz_id,league_id,paused_at,time_added_ms,quiz:quizzes(time_per_question,title),branding:branding_profiles(id,owner_id,organization_name,logo_url,primary_color,secondary_color)")
      .eq("id", sessionId)
      .maybeSingle();
    if (sErr) { setLoadFailed(true); return; }
    if (!s) { setLoadFailed(true); return; }
    setLoadFailed(false);
    setSession(s as unknown as Session);

    const { data: qs } = await supabase.rpc("get_session_questions", { p_session_id: sessionId });
    const mappedQs: Question[] = ((qs as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
      id: r.q_id as string,
      text: r.q_text as string,
      options: (r.q_options as string[]) ?? [],
      correct_index: -1,
      position: r.q_position as number,
      time_limit_sec: (r.q_time_limit_sec as number | null) ?? null,
      point_value: r.q_point_value as number,
      question_type: (r.q_question_type as string) ?? "mcq",
      image_url: (r.q_image_url as string | null) ?? null,
      double_points: !!r.q_double_points,
      max_distance_km: (r.q_max_distance_km as number | null) ?? null,
      number_min: (r.q_number_min as number | null) ?? null,
      number_max: (r.q_number_max as number | null) ?? null,
      reveal_stages: (r.q_reveal_stages as number | null) ?? null,
      audio_url: (r.q_audio_url as string | null) ?? null,
    }));
    if (mappedQs.length) setQuestions(mappedQs);

    const { data: all } = await supabase
      .from("participants").select("id,nickname,score,streak,team_id,avatar_id")
      .eq("session_id", sessionId).order("score", { ascending: false });
    if (all) {
      setParticipants(all as Participant[]);
      const mine = (all as Participant[]).find((p) => p.id === identity.id);
      if (mine) setMe(mine);
    }

    const { data: ans } = await supabase
      .from("answers").select("question_id,selected_index,is_correct,points")
      .eq("session_id", sessionId).eq("participant_id", identity.id);
    if (ans) setMyAnswers(ans as MyAnswer[]);

    if (s.status === "ended") {
      const { data: key } = await supabase.rpc("get_session_answer_key", { p_session_id: sessionId });
      const keyArr = (key as Array<{ question_id: string; correct_index: number }> | null) ?? [];
      if (keyArr.length) {
        setQuestions((prev) => prev.map((q) => {
          const k = keyArr.find((x) => x.question_id === q.id);
          return k ? { ...q, correct_index: k.correct_index } : q;
        }));
      }
    }
  }, [sessionId, identity]);

  useEffect(() => { void loadState(); }, [loadState]);

  // One row event per participant arrives on every score update; coalesce the
  // burst into a single authoritative refetch.
  const refetchParticipants = useCallback(async () => {
    const { data } = await supabase
      .from("participants").select("id,nickname,score,streak,team_id,avatar_id")
      .eq("session_id", sessionId).order("score", { ascending: false });
    if (!data) return;
    setParticipants(data as Participant[]);
    const mine = (data as Participant[]).find((p) => p.id === identity?.id);
    if (mine) setMe(mine);
  }, [sessionId, identity?.id]);
  const onParticipantsChanged = useCoalescedCallback(refetchParticipants);

  // Realtime: session updates + participants updates, with automatic recovery.
  const { status: connStatus, recovered: connRecovered } = useLiveChannel({
    enabled: !!identity,
    name: `play:${sessionId}`,
    setup: (ch) =>
      ch
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sessionId}` },
          (payload) => setSession((prev) => ({ ...(prev as Session), ...(payload.new as Partial<Session>) } as Session))
        )
        .on("postgres_changes", { event: "*", schema: "public", table: "participants", filter: `session_id=eq.${sessionId}` },
          onParticipantsChanged),
    onResync: loadState,
  });

  useEffect(() => {
    // Only surface connection state once this browser actually holds a seat.
    onConn(identity ? { status: connStatus, recovered: connRecovered } : { status: "connected", recovered: false });
  }, [connStatus, connRecovered, onConn, identity]);



  const orderedQuestionIds = session?.question_order ?? questions.map((q) => q.id);
  const currentIdx = session?.current_question_index ?? -1;
  const currentQId = currentIdx >= 0 && currentIdx < orderedQuestionIds.length ? orderedQuestionIds[currentIdx] : null;
  const currentQuestion = currentQId ? questions.find((q) => q.id === currentQId) : null;
  const revealed = !!session?.current_question_revealed;
  const myCurrentAnswer = currentQId ? myAnswers.find((a) => a.question_id === currentQId) : null;
  const hasAnswered = !!myCurrentAnswer || selectedIndex !== null;

  // Reset per-round local state whenever the host moves to a new question
  useEffect(() => {
    setSelectedIndex(null);
    setRoundResult(null);
    answeredQuestionId.current = null;
    setProgress({ answered: 0, total: 0 });
  }, [currentQId]);

  // Snapshot previous ranks before a new round (so reveal shows movement)
  useEffect(() => {
    if (currentIdx <= 0 || currentIdx === prevRankIndexRef.current) return;
    const map = new Map<string, number>();
    participants.forEach((p, i) => map.set(p.id, i + 1));
    setPrevRanks(map);
    prevRankIndexRef.current = currentIdx;
    // intentionally not depending on participants — we want the snapshot AT round start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx]);

  // Poll progress while in waiting state
  useEffect(() => {
    if (!session || session.status !== "active" || !currentQId || revealed || !hasAnswered) return;
    let cancelled = false;
    async function tick() {
      const { data } = await supabase.rpc("get_round_progress", { p_session_id: sessionId, p_question_id: currentQId as string });
      const row = Array.isArray(data) ? data[0] : data;
      if (!cancelled && row) setProgress({ answered: row.answered_count, total: row.total_count });
    }
    tick();
    const id = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessionId, session?.status, currentQId, revealed, hasAnswered]);

  // When round revealed: fetch result + correct index
  useEffect(() => {
    if (!revealed || !currentQId || !identity || !session) return;
    (async () => {
      const { data, error } = await supabase.rpc("get_my_round_result", {
        p_participant_id: identity.id,
        p_secret_token: identity.secretToken,
        p_question_id: currentQId,
      });
      if (error) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        setRoundResult(row);
        setQuestions((prev) => prev.map((q) => q.id === currentQId ? { ...q, correct_index: row.correct_index } : q));
      }
    })();
  }, [revealed, currentQId, identity, session]);

  // Fetch final answer key when session ends
  useEffect(() => {
    if (session?.status !== "ended") return;
    (async () => {
      const { data: key } = await supabase.rpc("get_session_answer_key", { p_session_id: sessionId });
      const keyArr = (key as Array<{ question_id: string; correct_index: number }> | null) ?? [];
      if (!keyArr.length) return;
      setQuestions((prev) => prev.map((q) => {
        const k = keyArr.find((x) => x.question_id === q.id);
        return k ? { ...q, correct_index: k.correct_index } : q;
      }));
    })();
  }, [session?.status, sessionId]);

  // Recompute my answers when revealed so review screen has accurate is_correct/points
  useEffect(() => {
    if (!revealed || !identity) return;
    (async () => {
      const { data } = await supabase
        .from("answers").select("question_id,selected_index,is_correct,points")
        .eq("session_id", sessionId).eq("participant_id", identity.id);
      if (data) setMyAnswers(data as MyAnswer[]);
    })();
  }, [revealed, identity, sessionId]);

  const shuffledOptionIdx = currentQuestion
    ? seededShuffle(currentQuestion.options.map((_, i) => i), (identity?.id ?? "player") + currentQuestion.id)
    : [];

  const quizDefaultSec = session?.quiz?.time_per_question ?? 20;
  const timeLimitMs = ((currentQuestion?.time_limit_sec ?? quizDefaultSec)) * 1000;
  const timing = getQuestionIntroTiming({
    startedAtIso: session?.current_question_started_at,
    nowMs: now,
    timeLimitMs,
    hasQuestion: !!currentQuestion,
    revealed,
    pausedAtIso: session?.paused_at,
    timeAddedMs: session?.time_added_ms,
  });

  const inIntro = timing.inIntro;
  const elapsed = timing.questionElapsedMs;
  const remaining = timing.questionRemainingMs;
  const remainingSec = timing.questionRemainingSec;

  useEffect(() => {
    if (!session?.id || !currentQuestion || !session.current_question_started_at) return;
    const localNowMs = Date.now();
    const adjustedNowMs = getServerAdjustedNow();
    const startedAtMs = new Date(session.current_question_started_at).getTime();
    const elapsedMs = adjustedNowMs - startedAtMs;
    console.debug("[question-intro-sync]", {
      screen: "player",
      serverNow: new Date(adjustedNowMs).toISOString(),
      localNow: new Date(localNowMs).toISOString(),
      serverSkewMs: adjustedNowMs - localNowMs,
      adjustedNow: adjustedNowMs,
      elapsedMs,
      remainingMs: Math.max(0, 3600 - elapsedMs),
    });
  }, [session?.id, session?.current_question_started_at, currentQuestion?.id, timeLimitMs, revealed]);



  if (identity === undefined) {
    return <LiveScreenState title="Loading your seat" message="Restoring your place in this match." />;
  }

  if (!identity) {
    return (
      <div className="min-h-screen grid place-items-center bg-background px-6">
        <div className="text-center space-y-4">
          <p className="font-display text-3xl italic uppercase">No active session</p>
          <Link to="/" className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta inline-block">Back to arena</Link>
        </div>
      </div>
    );
  }
  if (!session) {
    if (loadFailed) {
      return (
        <LiveScreenState
          spinner={false}
          title="Can't reach the match"
          message="We couldn't load this match right now. Your score is stored on the server — nothing is lost."
          action={{ label: "TRY AGAIN", onClick: () => { setLoadFailed(false); void loadState(); } }}
        />
      );
    }
    return (
      <LiveScreenState
        title={connStatus === "offline" ? "Waiting for connection" : "Connecting to the match"}
        message={connStatus === "offline" ? "You appear to be offline. We'll reconnect automatically." : "Syncing with the live arena..."}
      />
    );
  }

  // A timeout can hide a write that actually landed. Re-read the server before
  // releasing the local lock so a retry can never record the same answer twice.
  async function handleSubmitFailure(questionId: string, message?: string) {
    const { data } = await supabase
      .from("answers").select("question_id,selected_index,is_correct,points")
      .eq("session_id", sessionId).eq("participant_id", identity!.id);
    const rows = (data as MyAnswer[] | null) ?? [];
    if (rows.length) setMyAnswers(rows);
    if (rows.some((a) => a.question_id === questionId)) {
      toast.success("Answer received");
      return;
    }
    answeredQuestionId.current = null;
    setSelectedIndex(null);
    toast.error(message ?? "Answer didn't send. Tap again to retry.");
  }

  async function submitAnswer(originalIndex: number) {
    if (!currentQuestion || !me || !session) return;
    if (selectedIndex !== null || myCurrentAnswer) return;
    if (revealed) return;
    if (answeredQuestionId.current === currentQuestion.id) return;
    answeredQuestionId.current = currentQuestion.id;
    setSelectedIndex(originalIndex);

    const { data, error } = await supabase.rpc("submit_answer", {
      p_participant_id: identity!.id,
      p_secret_token: identity!.secretToken,
      p_question_id: currentQuestion.id,
      p_selected_index: originalIndex,
      p_response_ms: Math.round(elapsed),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.accepted) {
      await handleSubmitFailure(currentQuestion.id, error?.message);
      return;
    }
    setMyAnswers((prev) => [
      ...prev.filter((a) => a.question_id !== currentQuestion.id),
      { question_id: currentQuestion.id, selected_index: originalIndex, is_correct: false, points: 0 },
    ]);
  }


  async function submitGeo(lat: number, lng: number) {
    if (!currentQuestion || !me || !session || revealed || myCurrentAnswer) return;
    if (answeredQuestionId.current === currentQuestion.id) return;
    answeredQuestionId.current = currentQuestion.id;
    setSelectedIndex(-1);
    const { data, error } = await supabase.rpc("submit_geo_answer", {
      p_participant_id: identity!.id, p_secret_token: identity!.secretToken,
      p_question_id: currentQuestion.id, p_lat: lat, p_lng: lng, p_response_ms: Math.round(elapsed),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.accepted) {
      await handleSubmitFailure(currentQuestion.id, error?.message); return;
    }
    setMyAnswers((prev) => [...prev.filter((a) => a.question_id !== currentQuestion.id),
      { question_id: currentQuestion.id, selected_index: -1, is_correct: false, points: 0 }]);
  }

  async function submitNumber(value: number) {
    if (!currentQuestion || !me || !session || revealed || myCurrentAnswer) return;
    if (answeredQuestionId.current === currentQuestion.id) return;
    answeredQuestionId.current = currentQuestion.id;
    setSelectedIndex(-1);
    const { data, error } = await supabase.rpc("submit_number_answer", {
      p_participant_id: identity!.id, p_secret_token: identity!.secretToken,
      p_question_id: currentQuestion.id, p_value: value, p_response_ms: Math.round(elapsed),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.accepted) {
      await handleSubmitFailure(currentQuestion.id, error?.message); return;
    }
    setMyAnswers((prev) => [...prev.filter((a) => a.question_id !== currentQuestion.id),
      { question_id: currentQuestion.id, selected_index: -1, is_correct: false, points: 0 }]);
  }

  async function submitText(text: string) {
    if (!currentQuestion || !me || !session || revealed || myCurrentAnswer) return;
    if (answeredQuestionId.current === currentQuestion.id) return;
    answeredQuestionId.current = currentQuestion.id;
    setSelectedIndex(-1);
    const { data, error } = await (supabase.rpc as any)("submit_text_answer", {
      p_participant_id: identity!.id, p_secret_token: identity!.secretToken,
      p_question_id: currentQuestion.id, p_text: text, p_response_ms: Math.round(elapsed),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.accepted) {
      await handleSubmitFailure(currentQuestion.id, error?.message); return;
    }
    setMyAnswers((prev) => [...prev.filter((a) => a.question_id !== currentQuestion.id),
      { question_id: currentQuestion.id, selected_index: -1, is_correct: !!row.is_correct, points: row.points ?? 0 }]);
  }

  async function submitOrdering(order: number[]) {
    if (!currentQuestion || !me || !session || revealed || myCurrentAnswer) return;
    if (answeredQuestionId.current === currentQuestion.id) return;
    answeredQuestionId.current = currentQuestion.id;
    setSelectedIndex(-1);
    const { data, error } = await (supabase.rpc as any)("submit_ordering_answer", {
      p_participant_id: identity!.id, p_secret_token: identity!.secretToken,
      p_question_id: currentQuestion.id, p_order: order, p_response_ms: Math.round(elapsed),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.accepted) {
      await handleSubmitFailure(currentQuestion.id, error?.message); return;
    }
    setMyAnswers((prev) => [...prev.filter((a) => a.question_id !== currentQuestion.id),
      { question_id: currentQuestion.id, selected_index: -1, is_correct: !!row.correct_positions && row.correct_positions === currentQuestion.options.length, points: row.points ?? 0 }]);
  }



  const myRank = me ? participants.findIndex((p) => p.id === me.id) + 1 : 0;
  const totalPlayers = participants.length;
  const ended = session.status === "ended";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="px-6 py-3 border-b border-border flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          <PlayerAvatar avatarId={me?.avatar_id ?? identity?.avatarId} seed={me?.id ?? identity?.id} size={36} />
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase text-foreground/60">Player</p>
            <p className="font-display text-base italic uppercase truncate">{me?.nickname}</p>
          </div>
        </div>
        {session.status === "active" && myRank > 0 && (
          <div className="text-center px-3 border-x border-border">
            <p className="font-mono text-[10px] uppercase text-foreground/60">Rank</p>
            <p className="font-display text-lg italic text-volt">{ordinal(myRank)}<span className="text-foreground/40 text-xs"> /{totalPlayers}</span></p>
          </div>
        )}
        <div className="text-right">
          <p className="font-mono text-[10px] uppercase text-foreground/60">Score</p>
          <p aria-live="polite" aria-atomic="true" className="font-display text-xl italic text-volt">
            <span className="sr-only">Score: </span>{me?.score.toLocaleString() ?? 0}
          </p>
        </div>
      </div>
      {session.branding && (
        <div className="px-6 py-2 border-b border-border">
          <BrandBanner branding={session.branding} variant="compact" />
        </div>
      )}
      {timing.isPaused && session.status === "active" && (
        <div className="px-6 py-2 border-b border-amber-spark/60 bg-amber-spark/10 text-center font-mono text-[11px] uppercase tracking-widest text-amber-spark">
          ⏸ Paused by host
        </div>
      )}


      <div className="flex-1 px-6 py-8 max-w-md w-full mx-auto">
        {session.status === "lobby" && <LobbyView count={participants.length} />}

        {session.status === "active" && currentQuestion && inIntro && (
          <QuestionIntro
            variant="player"
            questionType={currentQuestion.question_type}
            progress={timing.introProgress}
            roundNumber={currentIdx + 1}
            totalRounds={orderedQuestionIds.length}
            doublePoints={currentQuestion.double_points}
          />
        )}


        {session.status === "active" && currentQuestion && !revealed && !hasAnswered && !inIntro && (
          <QuestionView
            question={currentQuestion}
            shuffledOptionIdx={shuffledOptionIdx}
            remainingSec={remainingSec}
            remainingMs={remaining}
            totalMs={timeLimitMs}
            onAnswer={submitAnswer}
            onSubmitGeo={submitGeo}
            onSubmitNumber={submitNumber}
            onSubmitText={submitText}
            onSubmitOrdering={submitOrdering}
            roundNumber={currentIdx + 1}
            totalRounds={orderedQuestionIds.length}
            streak={me?.streak ?? 0}
          />
        )}

        {session.status === "active" && currentQuestion && !revealed && hasAnswered && !inIntro && (
          <WaitingView
            answered={progress.answered}
            total={progress.total || totalPlayers}
            remainingSec={remainingSec}
            roundNumber={currentIdx + 1}
            totalRounds={orderedQuestionIds.length}
          />
        )}

        {session.status === "active" && currentQuestion && revealed && roundResult && (
          <RoundRevealView
            question={currentQuestion}
            result={roundResult}
            roundNumber={currentIdx + 1}
            totalRounds={orderedQuestionIds.length}
            participants={participants}
            prevRanks={prevRanks}
            myId={me?.id ?? ""}
          />
        )}

        {session.status === "active" && currentQuestion && revealed && !roundResult && (
          <RevealLoadingView roundNumber={currentIdx + 1} totalRounds={orderedQuestionIds.length} />
        )}

        {session.status === "active" && !currentQuestion && (
          <RevealLoadingView roundNumber={Math.max(1, currentIdx + 1)} totalRounds={orderedQuestionIds.length || questions.length || 1} label="Loading round" />
        )}

        {ended && (
          <FinalView
            participants={participants}
            myId={me?.id ?? ""}
            myRank={myRank}
            questions={questions}
            orderedIds={orderedQuestionIds}
            myAnswers={myAnswers}
            quizTitle={session.quiz?.title ?? "Quiz"}
            isGuest={!authedUserId}
            identity={identity}
            onLeave={() => { clearParticipant(sessionId); window.location.href = "/"; }}
          />
        )}

      </div>
    </div>
  );
}

function LobbyView({ count }: { count: number }) {
  return (
    <div className="text-center space-y-8 animate-float">
      <div className="inline-flex items-center gap-2 px-3 py-1 border border-volt/30 bg-volt/5">
        <span className="size-2 bg-volt rounded-full animate-pulse" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-volt">In lobby</span>
      </div>
      <h2 className="font-display text-5xl italic uppercase leading-none">
        Locked in.<br /><span className="text-volt">Stand by.</span>
      </h2>
      <p className="font-mono text-sm text-foreground/60 uppercase tracking-widest">
        {count} {count === 1 ? "player" : "players"} ready
      </p>
    </div>
  );
}

function DoublePointsBadge() {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 border border-amber-spark bg-amber-spark/10">
      <span className="font-mono text-[10px] uppercase tracking-widest text-amber-spark">⚡ Double Points</span>
    </div>
  );
}

function QuestionView({
  question, shuffledOptionIdx, remainingSec, remainingMs, totalMs,
  onAnswer, onSubmitGeo, onSubmitNumber, onSubmitText, onSubmitOrdering, roundNumber, totalRounds, streak,
}: {
  question: Question;
  shuffledOptionIdx: number[];
  remainingSec: number;
  remainingMs: number;
  totalMs: number;
  onAnswer: (i: number) => void;
  onSubmitGeo: (lat: number, lng: number) => void;
  onSubmitNumber: (value: number) => void;
  onSubmitText: (text: string) => void;
  onSubmitOrdering: (order: number[]) => void;
  roundNumber: number;
  totalRounds: number;
  streak: number;
}) {
  const isTrueFalse = question.question_type === "true_false";
  const isMap = question.question_type === "map_pin";
  const isNum = question.question_type === "number";
  const isType = question.question_type === "type";
  const isFeedback = question.question_type === "feedback";
  const isReveal = question.question_type === "image_reveal";
  const isAudio = question.question_type === "audio";
  const isOrdering = question.question_type === "ordering";

  const nMin = question.number_min ?? 0;
  const nMax = question.number_max ?? 100;
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [num, setNum] = useState<number>(Math.round((nMin + nMax) / 2));
  const [typed, setTyped] = useState<string>("");
  const [submittedText, setSubmittedText] = useState(false);
  const shuffledOrder = useMemo(
    () => (isOrdering ? seededShuffle(question.options.map((_, i) => i), question.id + "-ord") : []),
    [isOrdering, question.id, question.options.length],
  );
  const [orderItems, setOrderItems] = useState<Array<{ id: string; label: string; orig: number }>>(() =>
    shuffledOrder.map((orig) => ({ id: `it-${orig}`, orig, label: question.options[orig] })),
  );
  useEffect(() => {
    if (isOrdering) {
      setOrderItems(shuffledOrder.map((orig) => ({ id: `it-${orig}`, orig, label: question.options[orig] })));
    }
  }, [question.id]);
  const [orderingSubmitted, setOrderingSubmitted] = useState(false);
  const timedOut = remainingMs <= 0;

  const elapsedMs = Math.max(0, totalMs - remainingMs);
  const { stage: stageIdx, stages: revealStages, blurPx } = liveRevealBlur(elapsedMs, totalMs, question.reveal_stages);

  return (
    <div className="space-y-6 animate-float">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-foreground/60">ROUND {roundNumber}/{totalRounds}</span>
        {streak >= 2 && (
          <span className="font-mono text-xs uppercase text-amber-spark">🔥 STREAK x{streak}</span>
        )}
      </div>

      {question.double_points && <DoublePointsBadge />}

      {isReveal && question.image_url && (
        <div className="bg-card border border-border overflow-hidden">
          <div className="relative w-full aspect-video bg-background overflow-hidden">
            <img
              src={question.image_url}
              alt={`Progressively revealed image for the question: ${question.text}`}
              className="absolute inset-0 w-full h-full object-contain"
              style={{ filter: `blur(${blurPx}px)`, transition: "filter 400ms linear" }}
            />
          </div>
          <div className="px-3 py-2 border-t border-border flex items-center justify-between font-mono text-[10px] uppercase text-foreground/60">
            <span>🖼️ Reveal stage {stageIdx + 1} / {revealStages}</span>
            <span className="text-volt">Answer fast — more points</span>
          </div>
        </div>
      )}

      {isAudio && question.audio_url && (
        <AudioAutoplayer key={question.id} url={question.audio_url} />
      )}

      {question.image_url && !isMap && !isReveal && (
        <div className="bg-card border border-border overflow-hidden">
          <img src={question.image_url} alt={`Illustration for the question: ${question.text}`} className="w-full max-h-72 object-contain bg-background" />
        </div>
      )}

      <div className="bg-card border border-border p-6 relative overflow-hidden">
        <div className="absolute top-0 left-0 h-1 bg-volt/20 w-full" />
        <div className="absolute top-0 left-0 h-1 bg-volt"
          style={{ width: `${Math.max(0, (remainingMs / totalMs) * 100)}%`, transition: "width 200ms linear" }} />
        <div className="flex justify-between items-start gap-4 pt-2">
          <p className="text-xl font-bold leading-tight">{question.text}</p>
          <div
            role="timer"
            aria-label={`${Math.max(0, remainingSec)} seconds remaining`}
            className="size-12 shrink-0 border-2 border-volt rounded-full grid place-items-center font-display text-2xl text-volt"
          >
            <span aria-hidden="true">{String(Math.max(0, remainingSec)).padStart(2, "0")}</span>
          </div>
        </div>
      </div>

      {isMap ? (
        <div className="space-y-3">
          <MapPicker height={340} guess={pin} onPick={(lat, lng) => setPin({ lat, lng })} />
          <p className="font-mono text-[10px] uppercase text-foreground/60 text-center">
            {pin ? `Pin @ ${pin.lat.toFixed(3)}, ${pin.lng.toFixed(3)}` : "Tap the map to drop your pin"}
          </p>
          <button
            disabled={!pin}
            onClick={() => pin && onSubmitGeo(pin.lat, pin.lng)}
            className="w-full bg-volt text-background font-display text-xl py-3 skew-cta disabled:opacity-30 disabled:cursor-not-allowed"
          >
            LOCK IN PIN
          </button>
        </div>
      ) : isNum ? (
        <div className="space-y-4 bg-card border border-border p-5">
          <NumberGuess min={nMin} max={nMax} value={num} onChange={setNum} format={getNumberFormat(question.options)} />
          <button
            onClick={() => onSubmitNumber(num)}
            className="w-full bg-volt text-background font-display text-xl py-3 skew-cta"
          >
            LOCK IN {formatNumber(num, getNumberFormat(question.options))}
          </button>
        </div>
      ) : isType || isFeedback ? (
        <form
          className="space-y-3 bg-card border border-border p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (submittedText || timedOut || !typed.trim()) return;
            setSubmittedText(true);
            onSubmitText(typed);
          }}
        >
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoCapitalize={isFeedback ? "sentences" : "off"}
            autoComplete="off"
            autoCorrect={isFeedback ? "on" : "off"}
            spellCheck={isFeedback}
            disabled={submittedText || timedOut}
            placeholder={isFeedback ? (question.options[0] || "Share your thoughts…") : "Type your answer…"}
            className="w-full bg-background border border-border p-4 text-lg focus:outline-none focus:border-volt disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={submittedText || timedOut || !typed.trim()}
            className="w-full bg-volt text-background font-display text-xl py-3 skew-cta disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {isFeedback ? "SUBMIT RESPONSE" : "LOCK IN ANSWER"}
          </button>
        </form>
      ) : isOrdering ? (
        <div className="space-y-3 bg-card border border-border p-4">
          <p className="font-mono text-[10px] uppercase text-foreground/60">🔀 Drag to reorder — top = first</p>
          <OrderingBoard
            items={orderItems.map((it) => ({ id: it.id, label: it.label }))}
            onReorder={(next) => setOrderItems(next.map((n) => {
              const found = orderItems.find((it) => it.id === n.id);
              return { id: n.id, label: n.label, orig: found ? found.orig : 0 };
            }))}
            disabled={orderingSubmitted || timedOut}
          />
          <button
            type="button"
            disabled={orderingSubmitted || timedOut}
            onClick={() => { if (orderingSubmitted || timedOut) return; setOrderingSubmitted(true); onSubmitOrdering(orderItems.map((it) => it.orig)); }}
            className="w-full bg-volt text-background font-display text-xl py-3 skew-cta disabled:opacity-30 disabled:cursor-not-allowed"
          >
            LOCK IN ORDER
          </button>
        </div>
      ) : isTrueFalse ? (
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => onAnswer(0)}
            className="p-6 border-2 border-volt/40 bg-volt/5 hover:bg-volt/15 active:scale-[0.98] transition-all">
            <p className="font-display text-3xl italic text-volt">TRUE</p>
          </button>
          <button onClick={() => onAnswer(1)}
            className="p-6 border-2 border-pink-shock/40 bg-pink-shock/5 hover:bg-pink-shock/15 active:scale-[0.98] transition-all">
            <p className="font-display text-3xl italic text-pink-shock">FALSE</p>
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          {shuffledOptionIdx.map((originalIdx, displayIdx) => {
            const color = COLORS[displayIdx % COLORS.length];
            const letter = ["A", "B", "C", "D", "E", "F"][displayIdx];
            return (
              <button key={originalIdx} onClick={() => onAnswer(originalIdx)}
                className="w-full p-4 border border-border bg-card text-left flex items-center gap-4 transition-all hover:border-volt active:scale-[0.98]">
                <div className={`size-8 grid place-items-center text-xs font-bold shrink-0 bg-${color}/20 text-${color}`}>{letter}</div>
                <span className="font-medium">{question.options[originalIdx]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


function WaitingView({ answered, total, remainingSec, roundNumber, totalRounds }: {
  answered: number; total: number; remainingSec: number; roundNumber: number; totalRounds: number;
}) {
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
  return (
    <div className="text-center space-y-6 animate-float py-6">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-foreground/60">ROUND {roundNumber}/{totalRounds}</span>
        <span className="font-mono text-xs uppercase text-foreground/40">{remainingSec}s left</span>
      </div>
      <div className="inline-flex items-center gap-2 px-3 py-1 border border-volt/40 bg-volt/10">
        <span className="size-2 bg-volt rounded-full animate-pulse" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-volt">Answer submitted</span>
      </div>
      <h2 className="font-display text-4xl italic uppercase leading-none">
        Waiting for<br /><span className="text-volt">other players</span>
      </h2>
      <div className="space-y-2">
        <div className="h-2 bg-border relative overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-volt transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        <p className="font-mono text-sm uppercase tracking-widest text-foreground/80">
          {answered} / {total} answered
        </p>
      </div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">
        Results reveal when everyone's in — or time runs out
      </p>
    </div>
  );
}

function RevealLoadingView({ roundNumber, totalRounds, label = "Revealing answer" }: {
  roundNumber: number;
  totalRounds: number;
  label?: string;
}) {
  return (
    <div className="text-center space-y-6 animate-float py-8">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-foreground/60">ROUND {roundNumber}/{totalRounds}</span>
        <span className="font-mono text-xs uppercase text-volt">Results</span>
      </div>
      <div className="inline-flex items-center gap-2 px-3 py-1 border border-volt/40 bg-volt/10">
        <span className="size-2 bg-volt rounded-full animate-pulse" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-volt">{label}</span>
      </div>
      <h2 className="font-display text-4xl italic uppercase leading-none">
        Hold tight.<br /><span className="text-volt">Scoring round.</span>
      </h2>
    </div>
  );
}

function RoundRevealView({ question, result, roundNumber, totalRounds, participants, prevRanks, myId }: {
  question: Question;
  result: { answered: boolean; selected_index: number | null; is_correct: boolean; points: number; correct_index: number; total_score: number; answer_value?: any; correct_lat?: number | null; correct_lng?: number | null; correct_number?: number | null; correct_text?: string | null; text_submission?: string | null };
  roundNumber: number;
  totalRounds: number;
  participants: Participant[];
  prevRanks: Map<string, number>;
  myId: string;
}) {
  const correct = result.answered && result.is_correct;
  const myCurrentRank = participants.findIndex((p) => p.id === myId) + 1;
  const totalPlayers = participants.length;
  const top3 = participants.slice(0, 3);
  const me = participants.find((p) => p.id === myId);
  const onPodium = myCurrentRank >= 1 && myCurrentRank <= 3;
  const aheadOfMe = myCurrentRank > 1 ? participants[myCurrentRank - 2] : null;
  const gapToAhead = aheadOfMe && me ? aheadOfMe.score - me.score : 0;

  const isMap = question.question_type === "map_pin";
  const isNum = question.question_type === "number";
  const isType = question.question_type === "type";
  const isFeedback = question.question_type === "feedback";
  const isOrdering = question.question_type === "ordering";
  const av: any = result.answer_value ?? null;

  if (isFeedback) {
    return (
      <div className="space-y-6 animate-float">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs uppercase text-foreground/60">ROUND {roundNumber}/{totalRounds}</span>
          <span className="font-mono text-xs uppercase text-cyan-jolt">💬 Feedback</span>
        </div>
        <div className="border-2 border-cyan-jolt/60 bg-cyan-jolt/5 p-6 text-center space-y-3">
          <p className="font-display text-4xl italic text-cyan-jolt">💬 THANKS</p>
          <p className="font-mono text-xs text-foreground/70">Your response was recorded.</p>
          {result.text_submission && (
            <p className="font-mono text-sm text-foreground/90 border-t border-border/40 pt-3 italic">"{result.text_submission}"</p>
          )}
        </div>
        {me && (
          <div className="border border-border bg-card p-4 text-center space-y-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Current position</p>
            <p className="font-display text-3xl italic text-volt">#{myCurrentRank}<span className="text-foreground/40 text-base"> of {totalPlayers}</span></p>
          </div>
        )}
        <p className="text-center font-mono text-[10px] uppercase tracking-widest text-foreground/40 animate-pulse">
          Waiting for host to advance...
        </p>
      </div>
    );
  }

  let correctAnswerLabel: React.ReactNode = "—";
  if (isMap) {
    correctAnswerLabel = result.correct_lat != null
      ? `${Number(result.correct_lat).toFixed(3)}, ${Number(result.correct_lng).toFixed(3)}`
      : "—";
  } else if (isNum) {
    correctAnswerLabel = result.correct_number != null ? formatNumber(Number(result.correct_number), getNumberFormat(question.options)) : "—";
  } else if (isType) {
    correctAnswerLabel = result.correct_text ?? "—";
  } else if (isOrdering) {
    correctAnswerLabel = `${av?.correct_positions ?? 0}/${av?.total ?? question.options.length} in place`;
  } else if (question.question_type === "true_false") {
    correctAnswerLabel = result.correct_index === 0 ? "TRUE" : "FALSE";
  } else {
    correctAnswerLabel = question.options[result.correct_index] ?? "—";
  }

  return (
    <div className="space-y-6 animate-float">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-foreground/60">ROUND {roundNumber}/{totalRounds}</span>
        {question.double_points && <span className="font-mono text-xs uppercase text-amber-spark">⚡ Double pts</span>}
      </div>

      {/* Result card */}
      <div role="status" aria-live="polite" className={`border-2 ${correct ? "border-volt bg-volt/5" : "border-pink-shock/60 bg-pink-shock/5"} p-6 text-center space-y-3`}>
        <p className={`font-display text-5xl italic ${correct ? "text-volt" : "text-pink-shock"}`}>
          {!result.answered ? "✗ NO ANSWER" : correct ? "✓ CORRECT" : (isMap || isNum || isOrdering) ? "◐ CLOSE" : "✗ INCORRECT"}
        </p>
        <div className="border-t border-border/40 pt-3 space-y-1">
          <p className="font-mono text-[10px] uppercase text-foreground/60">Correct answer</p>
          <p className="font-bold text-lg">{correctAnswerLabel}</p>
          {isMap && av?.distance_km != null && (
            <p className="font-mono text-xs text-foreground/60">Your pin was <span className="text-volt">{Number(av.distance_km).toFixed(0)} km</span> away</p>
          )}
          {isNum && av?.diff != null && (
            <p className="font-mono text-xs text-foreground/60">You guessed <span className="text-volt">{formatNumber(Number(av.value), getNumberFormat(question.options))}</span> · off by {formatNumber(Number(av.diff), getNumberFormat(question.options))}</p>
          )}
        </div>

        {isMap && result.correct_lat != null && result.correct_lng != null && (
          <div className="pt-2">
            <MapPicker
              height={260}
              disabled
              guess={av && av.lat != null ? { lat: Number(av.lat), lng: Number(av.lng) } : null}
              correct={{ lat: Number(result.correct_lat), lng: Number(result.correct_lng) }}
              center={[Number(result.correct_lat), Number(result.correct_lng)]}
              zoom={3}
            />
            <div className="flex justify-center gap-4 pt-2 font-mono text-[10px] uppercase text-foreground/60">
              <span className="flex items-center gap-1"><span className="size-2 bg-volt inline-block rounded-full" /> Correct</span>
              {av && av.lat != null && <span className="flex items-center gap-1"><span className="size-2 bg-cyan-jolt inline-block rounded-full" /> Your pin</span>}
            </div>
          </div>
        )}

        {isNum && result.correct_number != null && (
          <div className="pt-2 bg-background/40 border border-border p-4">
            <NumberGuess
              min={question.number_min ?? 0}
              max={question.number_max ?? 100}
              value={av?.value != null ? Number(av.value) : Number(result.correct_number)}
              onChange={() => {}}
              disabled
              correct={Number(result.correct_number)}
              format={getNumberFormat(question.options)}
            />
          </div>
        )}

        {isOrdering && (
          <div className="pt-2 space-y-2 text-left">
            <p className="font-mono text-[10px] uppercase text-foreground/60 text-center">Correct order · your placement</p>
            <div className="grid gap-1.5">
              {question.options.map((label, i) => {
                const myOrder: number[] = Array.isArray(av?.order) ? av.order : [];
                const myPos = myOrder.indexOf(i);
                const ok = myPos === i;
                return (
                  <div key={i} className={`flex items-center gap-2 border p-2 ${ok ? "border-volt bg-volt/5" : "border-pink-shock/40 bg-pink-shock/5"}`}>
                    <span className={`font-display text-lg italic w-6 shrink-0 ${ok ? "text-volt" : "text-pink-shock"}`}>{i + 1}</span>
                    <span className="font-medium flex-1 text-sm">{label}</span>
                    <span className={`font-mono text-[10px] uppercase ${ok ? "text-volt" : "text-pink-shock"}`}>
                      {myPos < 0 ? "—" : ok ? "✓" : `you: ${myPos + 1}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}



        <div className="grid grid-cols-2 gap-3 pt-2">
          <div className="border border-border p-3">
            <p className="font-mono text-[10px] uppercase text-foreground/40">Points earned</p>
            <p className={`font-display text-2xl italic ${result.points > 0 ? "text-volt" : "text-foreground/60"}`}>+{result.points}</p>
          </div>
          <div className="border border-border p-3">
            <p className="font-mono text-[10px] uppercase text-foreground/40">Total score</p>
            <p className="font-display text-2xl italic text-volt">{result.total_score.toLocaleString()}</p>
          </div>
        </div>
      </div>


      {/* Leaderboard reveal */}
      <div className="border border-border bg-card p-4 space-y-3">
        <p className="font-mono text-[10px] uppercase text-foreground/60">Leaderboard</p>
        <div className="grid grid-cols-3 gap-2">
          {top3.map((p, i) => {
            const accent = i === 0 ? "volt" : i === 1 ? "cyan-jolt" : "amber-spark";
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
            return (
              <div key={p.id} className={`border border-${accent}/40 bg-${accent}/5 p-3 text-center ${p.id === myId ? "ring-1 ring-volt" : ""}`}>
                <p className="text-xl">{medal}</p>
                <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={40} className="mx-auto my-1" />
                <p className="font-bold text-sm truncate">{p.nickname}</p>
                <p className="font-mono text-xs text-foreground/60">{p.score.toLocaleString()}</p>
                <RankDelta nowRank={i + 1} prevRank={prevRanks.get(p.id)} />
              </div>
            );
          })}
        </div>
        <div className="space-y-1">
          {participants.slice(3, 8).map((p, i) => {
            const rank = i + 4;
            return (
              <div key={p.id} className={`flex items-center gap-2 py-1.5 px-2 ${p.id === myId ? "bg-volt/10 border border-volt/40" : "bg-background/40"}`}>
                <span className="font-mono text-xs text-foreground/40 w-6">{String(rank).padStart(2, "0")}</span>
                <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={20} />
                <span className="font-medium text-sm grow truncate">{p.nickname}</span>
                <RankDelta nowRank={rank} prevRank={prevRanks.get(p.id)} inline />
                <span className="font-display text-sm italic">{p.score.toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Personal ranking feedback */}
      {me && (
        <div className={`border-2 ${onPodium ? "border-volt bg-volt/5" : "border-border bg-card"} p-4 text-center space-y-2`}>
          {onPodium ? (
            <>
              <p className="font-mono text-[10px] uppercase tracking-widest text-volt">🏆 On the podium</p>
              <p className="font-display text-4xl italic text-volt">
                {myCurrentRank === 1 ? "🥇 #1" : myCurrentRank === 2 ? "🥈 #2" : "🥉 #3"}
              </p>
            </>
          ) : (
            <>
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Current position</p>
              <p className="font-display text-4xl italic text-volt">#{myCurrentRank}<span className="text-foreground/40 text-lg"> of {totalPlayers}</span></p>
              {aheadOfMe && (
                <p className="font-mono text-xs text-foreground/70">
                  {gapToAhead} pts behind <span className="text-volt">{aheadOfMe.nickname}</span>
                </p>
              )}
            </>
          )}
        </div>
      )}

      <p className="text-center font-mono text-[10px] uppercase tracking-widest text-foreground/40 animate-pulse">
        Waiting for host to advance...
      </p>
    </div>
  );
}

function RankDelta({ nowRank, prevRank, inline }: { nowRank: number; prevRank?: number; inline?: boolean }) {
  if (!prevRank || prevRank === nowRank) {
    return inline ? <span className="font-mono text-[10px] text-foreground/40">—</span> : null;
  }
  const diff = prevRank - nowRank; // positive = moved up
  if (diff > 0) {
    return <span className={`font-mono text-[10px] text-volt ${inline ? "" : "block"}`}>▲ {diff}</span>;
  }
  return <span className={`font-mono text-[10px] text-pink-shock ${inline ? "" : "block"}`}>▼ {Math.abs(diff)}</span>;
}

function FinalView({
  participants, myId, myRank, questions, orderedIds, myAnswers, quizTitle, isGuest, identity, onLeave,
}: {
  participants: Participant[];
  myId: string;
  myRank: number;
  questions: Question[];
  orderedIds: string[];
  myAnswers: MyAnswer[];
  quizTitle: string;
  isGuest: boolean;
  identity: ParticipantIdentity;
  onLeave: () => void;
}) {

  const [reviewOpen, setReviewOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const podium = participants.slice(0, 3);
  const ordered = orderedIds.map((id) => questions.find((q) => q.id === id)).filter(Boolean) as Question[];
  const ansByQ = new Map(myAnswers.map((a) => [a.question_id, a]));
  const scored = ordered.filter((q) => q.question_type !== "feedback");
  const correctCount = myAnswers.filter((a) => a.is_correct).length;
  const me = participants.find((p) => p.id === myId);
  const accuracy = scored.length > 0 ? Math.round((correctCount / scored.length) * 100) : 0;

  // Longest streak from ordered scored answers
  let longestStreak = 0;
  let run = 0;
  for (const q of scored) {
    const a = ansByQ.get(q.id);
    if (a?.is_correct) { run += 1; if (run > longestStreak) longestStreak = run; }
    else run = 0;
  }

  // Determine optional achievement based on the field
  let achievement: string | null = null;
  if (myRank === 1) achievement = "Champion";
  else {
    const others = participants.filter((p) => p.id !== myId);
    if (scored.length > 0 && correctCount === scored.length) achievement = "Most Accurate";
    else if (others.length && longestStreak >= 3 && me) achievement = "Longest Streak";
  }

  const shareData: ShareResultData = {
    nickname: me?.nickname ?? "Player",
    rank: myRank,
    totalPlayers: participants.length,
    score: me?.score ?? 0,
    correct: correctCount,
    totalQuestions: scored.length,
    longestStreak,
    quizTitle,
    achievement,
  };

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const initials = (me?.nickname ?? "?").trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("") || "?";
  const rankAccent = myRank === 1 ? "volt" : myRank === 2 ? "cyan-jolt" : myRank === 3 ? "amber-spark" : "foreground";

  return (
    <div className="space-y-6 animate-float">
      <div className="text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-foreground/60">Final standings</p>
        <h2 className="font-display text-5xl italic uppercase mt-2">GG WP</h2>
      </div>

      {isGuest ? (
        <button
          type="button"
          disabled={claiming}
          onClick={async () => {
            setClaiming(true);
            try {
              const token = await createSessionClaim(identity.id, identity.secretToken);
              savePendingClaim({
                token,
                kind: "session",
                label: quizTitle,
                returnTo: typeof window !== "undefined" ? window.location.pathname : "/",
                createdAt: Date.now(),
              });
              window.location.href = `/auth?next=${encodeURIComponent(
                typeof window !== "undefined" ? window.location.pathname : "/"
              )}`;
            } catch (e) {
              toast.error((e as Error).message ?? "Could not prepare this result");
              setClaiming(false);
            }
          }}
          className="block w-full border border-volt/40 bg-volt/5 hover:bg-volt/10 transition-colors p-4 text-left disabled:opacity-60"
        >
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">Playing as guest</p>
          <p className="font-display text-lg italic mt-1 leading-tight">
            {claiming ? "Preparing…" : "Save this result to my account →"}
          </p>
          <p className="font-mono text-[10px] text-foreground/50 mt-1">
            Sign in or register next — this result attaches to your profile automatically.
          </p>
        </button>
      ) : (
        <div className="border border-border bg-card px-4 py-2 flex items-center gap-2">
          <span className="size-1.5 bg-volt rounded-full" />
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
            Saved to your competition history
          </p>
        </div>
      )}


      {/* Compact podium */}
      <div className="space-y-2">
        {podium.map((p, i) => {
          const accent = i === 0 ? "volt" : i === 1 ? "cyan-jolt" : "amber-spark";
          return (
            <div key={p.id} className={`flex items-center gap-4 p-3 border ${p.id === myId ? "border-volt bg-volt/5" : "border-border bg-card"}`}>
              <span className={`font-display text-2xl italic text-${accent} w-8 text-left`}>0{i + 1}</span>
              <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={32} />
              <span className="font-bold grow text-left truncate">{p.nickname}</span>
              <span className="font-display text-lg italic">{p.score.toLocaleString()}</span>
            </div>
          );
        })}
      </div>

      {/* Player Result Summary */}
      <div className="border border-border bg-card p-5">
        <div className="flex items-center gap-4">
          <PlayerAvatar avatarId={me?.avatar_id} seed={me?.id} size={64} className={`!border-2 border-${rankAccent}`} />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Your finish</p>
            <p className="font-display text-2xl italic truncate">{me?.nickname ?? "Player"}</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[10px] uppercase text-foreground/50">Rank</p>
            <p className={`font-display text-3xl italic text-${rankAccent}`}>#{myRank}</p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 mt-5">
          <SummaryStat label="Score" value={(me?.score ?? 0).toLocaleString()} />
          <SummaryStat label="Accuracy" value={`${accuracy}%`} />
          <SummaryStat label="Correct" value={`${correctCount}/${scored.length}`} />
          <SummaryStat label="Streak" value={String(longestStreak)} />
        </div>
      </div>

      {/* Share card — inline, mobile-first, ~92vw */}
      <div className="flex justify-center">
        <ShareCardPreview data={shareData} cardRef={cardRef} className="w-[min(92vw,420px)]" />
      </div>

      {/* Primary actions */}
      <div className="space-y-2">
        <button
          onClick={() => runAction(() => shareShareCard(cardRef.current, shareData))}
          disabled={busy}
          className="w-full bg-volt text-background font-display text-xl py-4 skew-cta disabled:opacity-50"
        >
          {busy ? "PREPARING…" : "SHARE RESULT"}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => runAction(() => downloadShareCard(cardRef.current, shareData))}
            disabled={busy}
            className="w-full border border-border bg-card text-foreground font-display text-base py-3 skew-cta disabled:opacity-50"
          >
            DOWNLOAD IMAGE
          </button>
          <button
            onClick={onLeave}
            className="w-full border border-border bg-card text-foreground font-display text-base py-3 skew-cta"
          >
            EXIT ARENA
          </button>
        </div>
      </div>

      {/* Collapsible question review */}
      <div className="border border-border bg-card">
        <button
          onClick={() => setReviewOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
          aria-expanded={reviewOpen}
        >
          <span className="font-mono text-xs uppercase tracking-widest text-foreground/70">
            Review Questions ({ordered.length})
          </span>
          <span className="font-mono text-xs text-foreground/60">
            {reviewOpen ? "Tap to collapse ▲" : "Tap to expand ▼"}
          </span>
        </button>
        {reviewOpen && (
          <div className="p-4 pt-0 space-y-3 text-left">
            {ordered.map((q, i) => {
              const a = ansByQ.get(q.id);
              const got = a?.is_correct;
              const isFb = q.question_type === "feedback";
              return (
                <div key={q.id} className="border border-border p-3 space-y-1.5 bg-background/40">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-mono text-[10px] text-foreground/40">Q{String(i + 1).padStart(2, "0")}</p>
                    {isFb ? (
                      <span className="font-mono text-[10px] uppercase text-cyan-jolt">
                        {a ? "💬 SUBMITTED" : "— NO RESPONSE"}
                      </span>
                    ) : (
                      <span className={`font-mono text-[10px] uppercase ${got ? "text-volt" : "text-pink-shock"}`}>
                        {a ? (got ? `+${a.points}` : "MISS") : "SKIPPED"}
                      </span>
                    )}
                  </div>
                  <p className="font-medium text-sm">{q.text}</p>
                  {!isFb && (q.correct_index >= 0 || q.question_type === "map_pin" || q.question_type === "number" || q.question_type === "ordering") ? (
                    <p className="font-mono text-[11px]">
                      <span className="text-foreground/40">Correct: </span>
                      <span className="text-volt">
                        {q.question_type === "true_false"
                          ? (q.correct_index === 0 ? "TRUE" : "FALSE")
                          : q.question_type === "map_pin"
                          ? "🗺️ (see round reveal)"
                          : q.question_type === "number"
                          ? "🎯 (see round reveal)"
                          : q.question_type === "ordering"
                          ? `🔀 ${q.options.join(" → ")}`
                          : q.options[q.correct_index]}
                      </span>
                    </p>
                  ) : null}
                  {!isFb && a && !got && a.selected_index >= 0 && q.question_type !== "map_pin" && q.question_type !== "number" && (
                    <p className="font-mono text-[11px]">
                      <span className="text-foreground/40">You picked: </span>
                      <span className="text-pink-shock">{q.question_type === "true_false" ? (a.selected_index === 0 ? "TRUE" : "FALSE") : q.options[a.selected_index]}</span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="font-mono text-[9px] uppercase tracking-widest text-foreground/50">{label}</p>
      <p className="font-display text-lg italic mt-1 truncate">{value}</p>
    </div>
  );
}


function AudioAutoplayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    let cancelled = false;
    const tryPlay = () => el.play().then(() => { if (!cancelled) setPlaying(true); });
    tryPlay().catch(() => {
      // Autoplay blocked — retry on the next user interaction anywhere in the document.
      const handler = () => {
        tryPlay().catch(() => {}).finally(() => {
          document.removeEventListener("pointerdown", handler);
          document.removeEventListener("keydown", handler);
          document.removeEventListener("touchstart", handler);
        });
      };
      document.addEventListener("pointerdown", handler, { once: true });
      document.addEventListener("keydown", handler, { once: true });
      document.addEventListener("touchstart", handler, { once: true });
    });
    return () => { cancelled = true; };
  }, [url]);

  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center gap-3">
        <span className="text-2xl">🎧</span>
        <div className="flex-1">
          <p className="font-mono text-[10px] uppercase text-foreground/60">Audio question</p>
          <p className="font-mono text-xs uppercase text-volt">
            {ended ? "Playback complete" : playing ? "Playing — one play only" : "Loading…"}
          </p>
        </div>
      </div>
      <audio
        ref={audioRef}
        src={url}
        preload="auto"
        onEnded={() => { setEnded(true); setPlaying(false); }}
      />
    </div>
  );
}


