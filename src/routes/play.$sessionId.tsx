import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveChannel, type LiveStatus } from "@/hooks/use-live-channel";
import { ConnectionBanner, LiveScreenState } from "@/components/ConnectionState";

import { supabase } from "@/integrations/supabase/client";
import { seededShuffle } from "@/lib/game";
import { standingsFor, rankPlayers, type Standing } from "@/lib/ranking";
import { accentText, accentBorder, PODIUM_ACCENT_BORDER, PODIUM_ACCENT_BORDER_SOFT, PODIUM_ACCENT_SURFACE } from "@/lib/podium-accents";
import { presentHosted, shareMessage, type Metric } from "@/lib/result-presentation";
import { trackResultEvent, detectShareMethod } from "@/lib/result-analytics";
import { getParticipant, clearParticipant, type ParticipantIdentity } from "@/lib/participant-storage";
import { SaveResultPanel } from "@/components/SaveResultPanel";
import { useAuthState, isAuthResolved } from "@/lib/auth-state";
import { MapPicker } from "@/components/MapPicker";
import { NumberGuess } from "@/components/NumberGuess";
import { OrderingBoard } from "@/components/OrderingBoard";
import { formatNumber, getNumberFormat } from "@/lib/number-format";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import { QuestionIntro } from "@/components/QuestionIntro";
import { getQuestionIntroTiming } from "@/lib/question-intro-timing";
import { getServerAdjustedNow, syncServerClock } from "@/lib/server-clock";
import { ShareCardPreview, downloadShareCard, type ShareResultData } from "@/components/ShareResultCard";
import { BrandBanner } from "@/components/BrandBanner";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useCoalescedCallback } from "@/hooks/use-coalesced-callback";
import { liveRevealBlur, type GeoRegion } from "@/lib/question-registry";
import { playSound, haptic, isSoundMuted, toggleSoundMuted, unlockAudio } from "@/lib/sound";
import { Confetti } from "@/components/Confetti";
import { Volume2, VolumeX } from "lucide-react";


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
  code: string;
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
  /**
   * When the player took their seat. The server's authoritative rank is
   * `rank() OVER (ORDER BY score DESC, joined_at ASC)`, so the tie-break has
   * to be read here too - ordering the query by `score` alone leaves Postgres
   * free to return tied rows in any order. See `lib/ranking.ts`.
   */
  joined_at: string;
};

type MyAnswer = {
  question_id: string;
  selected_index: number;
  is_correct: boolean;
  points: number;
  /**
   * Authoritative server-side timing, used for the average response stat.
   * Optional because the optimistic row written the instant a player taps an
   * option has no server timing yet. Such a row is simply excluded from the
   * average rather than contributing a guessed value.
   */
  response_ms?: number;
};

const COLORS = ["pink-shock", "cyan-jolt", "volt", "amber-spark"];

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

type ConnInfo = { status: LiveStatus; recovered: boolean; stalled: boolean };

/** Thin wrapper so the connection indicator overlays every gameplay screen. */
function PlayPage() {
  const [conn, setConn] = useState<ConnInfo>({ status: "connecting", recovered: false, stalled: false });
  return (
    <>
      <PlayScreen onConn={setConn} />
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <ConnectionBanner status={conn.status} recovered={conn.recovered} stalled={conn.stalled} />
      </div>
    </>
  );
}

function PlayScreen({ onConn }: { onConn: (c: ConnInfo) => void }) {

  const { sessionId } = Route.useParams();
  const [identity, setIdentity] = useState<ParticipantIdentity | null | undefined>(undefined);
  // Read-only. Used solely to label the result panel, never to decide who the
  // player is or to gate anything during play.
  const auth = useAuthState();
  const authedUserId = auth.user?.id ?? null;
  // Must come from the store's own rule, not `status !== "loading"`. The store
  // deliberately treats a FAILED session check as unresolved
  // (auth-state.ts: isAuthResolved), because a failed check is not evidence of
  // being signed out. Deriving it here as `status !== "loading"` reported a
  // dropped connection as resolved, which let the panel assert a save verdict
  // for a player whose session we had not actually verified.
  const authResolved = isAuthResolved(auth);
  // Whether THIS seat is already attached to a profile, which is what actually
  // makes the result appear in competition history. Read from our own row
  // only: the scoreboard query deliberately does not expose other players'
  // profile ids.
  const [seatProfileId, setSeatProfileId] = useState<string | null>(null);
  const [seatChecked, setSeatChecked] = useState(false);

  useEffect(() => {
    if (!identity?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("participants")
          .select("profile_id")
          .eq("id", identity.id)
          .maybeSingle();
        if (cancelled) return;
        // Supabase resolves with `{ error }` rather than throwing on a rejected
        // query, so the error has to be inspected explicitly.
        if (error) {
          // A failed ownership read is not proof the result is unsaved. Leave
          // seatProfileId null: the panel then offers a save, and the server
          // rejects it with an accurate message if it is already claimed. We
          // never assert "saved" from a failed read.
          setSeatProfileId(null);
          return;
        }
        setSeatProfileId((data as { profile_id?: string | null } | null)?.profile_id ?? null);
      } catch {
        if (cancelled) return;
        setSeatProfileId(null);
      } finally {
        if (!cancelled) setSeatChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity?.id]);

  const [session, setSession] = useState<Session | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [me, setMe] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [now, setNow] = useState(() => getServerAdjustedNow());
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [myAnswers, setMyAnswers] = useState<MyAnswer[]>([]);
  const [progress, setProgress] = useState<{ answered: number; total: number }>({ answered: 0, total: 0 });
  const [roundResult, setRoundResult] = useState<{ answered: boolean; selected_index: number | null; is_correct: boolean; points: number; correct_index: number; total_score: number; answer_value?: any; correct_lat?: number | null; correct_lng?: number | null; correct_number?: number | null; correct_text?: string | null; text_submission?: string | null; geo_region?: GeoRegion | null; geo_region_label?: string | null } | null>(null);
  const answeredQuestionId = useRef<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [soundOn, setSoundOn] = useState(() => !isSoundMuted());

  // AudioContext must be created/resumed after a user gesture (autoplay policy).
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);


  useEffect(() => {
    setIdentity(getParticipant(sessionId));
    // Auth state is deliberately NOT read here. The guest seat identity, the
    // current question, the timer and the answer log are all keyed on
    // `sessionId` alone, so nothing about signing in or refreshing a token can
    // recreate the participant or reset gameplay.
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
      .select("id,code,status,current_question_index,current_question_started_at,current_question_revealed,team_mode,question_order,quiz_id,league_id,paused_at,time_added_ms,quiz:quizzes(time_per_question,title),branding:branding_profiles(id,owner_principal_id,organization_name,logo_url,primary_color,secondary_color)")
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
      .from("participants").select("id,nickname,score,streak,team_id,avatar_id,joined_at")
      .eq("session_id", sessionId).order("score", { ascending: false }).order("joined_at", { ascending: true });
    if (all) {
      setParticipants(all as Participant[]);
      const mine = (all as Participant[]).find((p) => p.id === identity.id);
      if (mine) setMe(mine);
    }

    const { data: ans } = await supabase
      .from("answers").select("question_id,selected_index,is_correct,points,response_ms")
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
      .from("participants").select("id,nickname,score,streak,team_id,avatar_id,joined_at")
      .eq("session_id", sessionId).order("score", { ascending: false }).order("joined_at", { ascending: true });
    if (!data) return;
    setParticipants(data as Participant[]);
    const mine = (data as Participant[]).find((p) => p.id === identity?.id);
    if (mine) setMe(mine);
  }, [sessionId, identity?.id]);
  const onParticipantsChanged = useCoalescedCallback(refetchParticipants);

  // Phase 9D.2 P0-A: gameplay activity arrives as DATABASE-PUBLISHED broadcasts
  // on the private session topic.
  //   game:answer_row — one per accepted answer (authoritative, unconditional):
  //                     drives the live "X/Y answered" counter.
  //   game:answer     — emitted only when a participant's score/streak changed:
  //                     drives the (coalesced) participants refetch.
  // Transitional (Phase 9D.2b): the pre-9D.2 WAL bindings stay attached until
  // browser-side broadcast decoding is verified end-to-end. Duplicate delivery
  // is harmless — the counter de-dupes by participant id and the refetch is
  // coalesced.
  const seenAnsweredRef = useRef<Set<string>>(new Set());
  const progressSeedRef = useRef(0);
  const progressQidRef = useRef<string | null>(null);
  const countAnsweredEvent = useCallback((msg: unknown) => {
    const m = msg as {
      payload?: unknown;
      new?: { id?: string; score?: number; streak?: number };
      old?: { score?: number; streak?: number } | null;
    };
    // WAL fallback shape: a participants row event. Only genuine answer activity
    // (score/streak moved) counts — mirrors the server-side trigger filter.
    if (m && typeof m === "object" && "new" in m) {
      if (!m.new?.id) return;
      if (m.new.score === m.old?.score && m.new.streak === m.old?.streak) return;
      seenAnsweredRef.current.add(m.new.id);
      setProgress((prev) => ({ answered: Math.max(prev.answered, seenAnsweredRef.current.size), total: prev.total }));
      return;
    }
    const p = m?.payload ?? msg;
    const pid = (p as { participant_id?: string } | null)?.participant_id;
    if (!pid) return;
    seenAnsweredRef.current.add(pid);
    setProgress((prev) => ({ answered: Math.max(prev.answered, seenAnsweredRef.current.size), total: prev.total }));
  }, []);

  const { status: connStatus, recovered: connRecovered, stalled: connStalled } = useLiveChannel({
    enabled: !!identity,
    name: `session:${sessionId}`,
    private: true,
    setup: (ch) =>
      ch
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sessionId}` },
          (payload) => setSession((prev) => ({ ...(prev as Session), ...(payload.new as Partial<Session>) } as Session))
        )
        .on("broadcast", { event: "game:join" }, () => onParticipantsChanged())
        .on("broadcast", { event: "game:answer_row" }, (msg) => countAnsweredEvent(msg))
        .on("broadcast", { event: "game:answer" }, () => onParticipantsChanged())
        // Phase 9D.3: load-bearing, not redundant. With the publication diet
        // applied, an anonymous player receives NO `sessions` postgres_changes
        // (measured: the private-broadcast probe sees 0, and a real /play page
        // stays on round 1 while the server advances). These participants
        // bindings are what actually deliver a transition to a player, via the
        // coalesced refetch in onParticipantsChanged(). Removing them requires
        // transitions on the broadcast transport first.
        .on("postgres_changes", { event: "*", schema: "public", table: "participants", filter: `session_id=eq.${sessionId}` },
          () => onParticipantsChanged())
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "participants", filter: `session_id=eq.${sessionId}` },
          (payload) => countAnsweredEvent(payload)),
    onResync: loadState,
  });

  useEffect(() => {
    // Only surface connection state once this browser actually holds a seat.
    onConn(identity ? { status: connStatus, recovered: connRecovered, stalled: connStalled } : { status: "connected", recovered: false, stalled: false });
  }, [connStatus, connRecovered, connStalled, onConn, identity]);



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
    // Same contract as everywhere else, so a movement arrow compares two
    // rankings that mean the same thing. An index here would disagree with the
    // displayed rank on a tie and show a phantom jump.
    rankPlayers(participants).forEach((p) => map.set(p.id, p.rank));
    setPrevRanks(map);
    prevRankIndexRef.current = currentIdx;
    // intentionally not depending on participants — we want the snapshot AT round start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx]);

  // Round progress: seed once per question with an authoritative count, then
  // live-increment via countAnsweredEvent. Re-seeds on reconnect (connStatus
  // transition) so a dropped connection never leaves a stale counter.
  useEffect(() => {
    if (session?.status !== "active" || !currentQId) return;
    if (progressQidRef.current !== currentQId) {
      progressQidRef.current = currentQId;
      seenAnsweredRef.current = new Set();
      progressSeedRef.current = 0;
      setProgress({ answered: 0, total: participants.length });
    }
    let cancelled = false;
    supabase.rpc("get_round_progress", { p_session_id: sessionId, p_question_id: currentQId }).then(({ data }) => {
      if (cancelled) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        progressSeedRef.current = Number(row.answered_count) || 0;
        setProgress((prev) => ({
          answered: Math.max(prev.answered, progressSeedRef.current),
          total: Number(row.total_count) || prev.total || participants.length,
        }));
      }
    });
    return () => { cancelled = true; };
  }, [currentQId, sessionId, session?.status, participants.length, connStatus]);

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
        setRoundResult({
          ...row,
          geo_region: row.geo_region != null ? (row.geo_region as unknown as GeoRegion) : null,
          geo_region_label: row.geo_region_label ?? null,
        });
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
        .from("answers").select("question_id,selected_index,is_correct,points,response_ms")
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
    return (
      <LiveScreenState title="Getting you back in" message="Restoring your place in this game." />
    );
  }

  if (!identity) {
    return (
      <div className="min-h-screen grid place-items-center bg-background px-6">
        <div className="text-center space-y-4">
          <p className="font-display text-3xl italic uppercase">You're not in a game</p>
          <p className="text-foreground/60 text-sm max-w-xs mx-auto">
            Enter your host's Game PIN to join.
          </p>
          <Link
            to="/"
            className="inline-flex min-h-11 items-center bg-volt text-background font-display text-lg uppercase italic px-6 py-3 skew-cta"
          >
            Join a game
          </Link>
        </div>
      </div>
    );
  }
  if (!session) {
    if (loadFailed) {
      return (
        <LiveScreenState
          spinner={false}
          title="Can't reach the game"
          message="We couldn't load this game right now. Your score is stored on the server — nothing is lost."
          action={{ label: "TRY AGAIN", onClick: () => { setLoadFailed(false); void loadState(); } }}
        />
      );
    }
    return (
      <LiveScreenState
        title={connStatus === "offline" ? "Waiting for connection" : "Joining the game"}
        message={connStatus === "offline" ? "You appear to be offline. We'll reconnect automatically." : "Syncing with the live game…"}
      />
    );
  }

  // A timeout can hide a write that actually landed. Re-read the server before
  // releasing the local lock so a retry can never record the same answer twice.
  async function handleSubmitFailure(questionId: string, error?: unknown) {
    const { data } = await supabase
      .from("answers").select("question_id,selected_index,is_correct,points,response_ms")
      .eq("session_id", sessionId).eq("participant_id", identity!.id);
    const rows = (data as MyAnswer[] | null) ?? [];
    if (rows.length) setMyAnswers(rows);
    if (rows.some((a) => a.question_id === questionId)) {
      toast.success("Answer locked in");
      return;
    }
    answeredQuestionId.current = null;
    setSelectedIndex(null);
    toastError(error, { context: "submit answer", fallback: "Answer didn't send. Tap again to retry." });
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
      await handleSubmitFailure(currentQuestion.id, error);
      return;
    }
    playSound("lock");
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
      await handleSubmitFailure(currentQuestion.id, error); return;
    }
    playSound("lock");
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
      await handleSubmitFailure(currentQuestion.id, error); return;
    }
    playSound("lock");
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
      await handleSubmitFailure(currentQuestion.id, error); return;
    }
    playSound("lock");
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
      await handleSubmitFailure(currentQuestion.id, error); return;
    }
    playSound("lock");
    setMyAnswers((prev) => [...prev.filter((a) => a.question_id !== currentQuestion.id),
      { question_id: currentQuestion.id, selected_index: -1, is_correct: !!row.correct_positions && row.correct_positions === currentQuestion.options.length, points: row.points ?? 0 }]);
  }



  // Authoritative standing. Replaces the old
  // `participants.findIndex(p => p.id === me.id) + 1`, which ranked in the
  // browser from a score-ordered list with no tie-break and could therefore
  // disagree with the `final_rank` the server persisted in
  // `competition_results`. The same value now drives the live header, the
  // podium and the personal placement on the results screen.
  //
  // Deliberately NOT a useMemo. This sits below the identity/session early
  // returns, where a hook would violate the rules of hooks. The sort is O(n log
  // n) over one session's players and re-runs at most a few times a second, so
  // memoising it would trade a real bug for a saving nobody can measure.
  const standings = standingsFor(participants, me?.id ?? "");
  const myRank = standings.me?.rank ?? 0;
  const totalPlayers = standings.total;
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
        <button
          type="button"
          onClick={() => setSoundOn(toggleSoundMuted())}
          aria-label={soundOn ? "Mute sounds" : "Unmute sounds"}
          className="size-10 shrink-0 grid place-items-center border border-border bg-card text-foreground/70 hover:text-volt hover:border-volt/40 transition-colors"
        >
          {soundOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
        </button>
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
        {session.status === "lobby" && (
          <LobbyView
            count={participants.length}
            quizTitle={session.quiz?.title ?? "Your game"}
            code={session.code}
          />
        )}

        {session.status === "active" && currentQuestion && inIntro && (
          <QuestionIntro
            variant="player"
            questionType={currentQuestion.question_type}
            progress={timing.introProgress}
            roundNumber={currentIdx + 1}
            totalRounds={orderedQuestionIds.length}
            doublePoints={currentQuestion.double_points}
            introCountdown={timing.introCountdown}
            showIntroGo={timing.showIntroGo}
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
            standings={standings}
            participants={participants}
            myId={me?.id ?? ""}
            myRank={myRank}
            questions={questions}
            orderedIds={orderedQuestionIds}
            myAnswers={myAnswers}
            quizTitle={session.quiz?.title ?? "Quiz"}
            authResolved={authResolved}
            authFailed={auth.status === "error"}
            isAuthenticated={authedUserId != null}
            seatLinked={seatProfileId != null}
            seatChecked={seatChecked}
            identity={identity}
            onLeave={() => { clearParticipant(sessionId); window.location.href = "/"; }}
          />
        )}

      </div>
    </div>
  );
}

function LobbyView({
  count,
  quizTitle,
  code,
}: {
  count: number;
  quizTitle: string;
  code: string;
}) {
  return (
    <div className="text-center space-y-8 animate-float">
      <div className="inline-flex items-center gap-2 px-3 py-1 border border-volt/30 bg-volt/10">
        <span aria-hidden="true" className="size-2 bg-volt rounded-full animate-pulse" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-volt">
          You're in
        </span>
      </div>

      {/* Which game am I in? Always answered, never implied. */}
      <div className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
          Game Pin {code}
        </p>
        <h2 className="font-display text-3xl sm:text-4xl italic uppercase leading-none">
          {quizTitle}
        </h2>
      </div>

      <p className="font-display text-4xl italic uppercase leading-none text-volt">
        Stand by
      </p>
      <p className="font-mono text-sm text-foreground/60 uppercase tracking-widest">
        {count} {count === 1 ? "player" : "players"} joined
      </p>
      <p className="text-foreground/50 text-sm max-w-xs mx-auto">
        Waiting for the host to start. The first question appears here automatically.
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

  // Instant tactile + audio feedback the moment a player commits their answer.
  const tapFeedback = () => {
    haptic(15);
    playSound("select");
  };

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
            onClick={() => { tapFeedback(); if (pin) onSubmitGeo(pin.lat, pin.lng); }}
            className="w-full bg-volt text-background font-display text-xl py-3 skew-cta disabled:opacity-30 disabled:cursor-not-allowed"
          >
            LOCK IN PIN
          </button>
        </div>
      ) : isNum ? (
        <div className="space-y-4 bg-card border border-border p-5">
          <NumberGuess min={nMin} max={nMax} value={num} onChange={setNum} format={getNumberFormat(question.options)} />
          <button
            onClick={() => { tapFeedback(); onSubmitNumber(num); }}
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
            tapFeedback();
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
            onClick={() => { if (orderingSubmitted || timedOut) return; tapFeedback(); setOrderingSubmitted(true); onSubmitOrdering(orderItems.map((it) => it.orig)); }}
            className="w-full bg-volt text-background font-display text-xl py-3 skew-cta disabled:opacity-30 disabled:cursor-not-allowed"
          >
            LOCK IN ORDER
          </button>
        </div>
      ) : isTrueFalse ? (
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => { tapFeedback(); onAnswer(0); }}
            className="p-6 border-2 border-volt/40 bg-volt/5 hover:bg-volt/15 active:scale-[0.98] transition-all">
            <p className="font-display text-3xl italic text-volt">TRUE</p>
          </button>
          <button onClick={() => { tapFeedback(); onAnswer(1); }}
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
              <button key={originalIdx} onClick={() => { tapFeedback(); onAnswer(originalIdx); }}
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
        Locked in.<br /><span className="text-volt">Waiting…</span>
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
  result: { answered: boolean; selected_index: number | null; is_correct: boolean; points: number; correct_index: number; total_score: number; answer_value?: any; correct_lat?: number | null; correct_lng?: number | null; correct_number?: number | null; correct_text?: string | null; text_submission?: string | null; geo_region?: GeoRegion | null; geo_region_label?: string | null };
  roundNumber: number;
  totalRounds: number;
  participants: Participant[];
  prevRanks: Map<string, number>;
  myId: string;
}) {
  const correct = result.answered && result.is_correct;
  // The SAME ranking contract as the results screen and the server's persisted
  // `final_rank`. Two rank computations coexisting in one file is exactly the
  // divergence `lib/ranking.ts` exists to remove - and a mid-game rank that
  // disagreed with the final result would be a visible bug on its own.
  const live = standingsFor(participants, myId);
  const myCurrentRank = live.me?.rank ?? 0;
  const totalPlayers = live.total;
  const top3 = live.podium;
  const me = live.me;
  const onPodium = myCurrentRank >= 1 && myCurrentRank <= 3;
  // "The player directly above me", taken from the ordered list rather than by
  // arithmetic on the rank, so a tie cannot index the wrong row.
  const myIndex = live.ranked.findIndex((p) => p.id === myId);
  const aheadOfMe = myIndex > 0 ? live.ranked[myIndex - 1] : null;
  const gapToAhead = aheadOfMe && me ? aheadOfMe.score - me.score : 0;

  // One-shot payoff feedback per round (this view remounts each round).
  const playedRoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (playedRoundRef.current === question.id) return;
    playedRoundRef.current = question.id;
    if (question.question_type === "feedback") {
      playSound("reveal");
    } else if (correct) {
      playSound("correct");
      haptic([30, 40, 60]);
    } else if (result.answered) {
      playSound("wrong");
      haptic(60);
    } else {
      playSound("reveal");
    }
  }, [question.id, correct, result.answered, question.question_type]);

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
    correctAnswerLabel =
      result.geo_region_label ??
      (result.correct_lat != null
        ? `${Number(result.correct_lat).toFixed(3)}, ${Number(result.correct_lng).toFixed(3)}`
        : "—");
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
      <div role="status" aria-live="polite" className={`border-2 ${correct ? "border-volt bg-volt/5 animate-burst" : "border-pink-shock/60 bg-pink-shock/5 animate-wrong"} p-6 text-center space-y-3`}>
        <p className={`font-display text-5xl italic ${correct ? "text-volt" : "text-pink-shock"}`}>
          {!result.answered ? "✗ NO ANSWER" : correct ? "✓ CORRECT" : (isMap || isNum || isOrdering) ? "◐ CLOSE" : "✗ INCORRECT"}
        </p>
        <div className="border-t border-border/40 pt-3 space-y-1">
          <p className="font-mono text-[10px] uppercase text-foreground/60">Correct answer</p>
          <p className="font-bold text-lg">{correctAnswerLabel}</p>
          {isMap && av?.distance_km != null && result.geo_region_label != null && (
            <p className="font-mono text-xs text-foreground/60">
              {av.inside_region ? (
                <>Your pin was inside <span className="text-volt">{result.geo_region_label}</span></>
              ) : (
                <>Your pin was <span className="text-volt">{Number(av.border_distance_km ?? av.distance_km).toFixed(0)} km</span> outside {result.geo_region_label}</>
              )}
            </p>
          )}
          {isMap && av?.distance_km != null && result.geo_region_label == null && (
            <p className="font-mono text-xs text-foreground/60">Your pin was <span className="text-volt">{Number(av.distance_km).toFixed(0)} km</span> away</p>
          )}
          {isNum && av?.diff != null && (
            <p className="font-mono text-xs text-foreground/60">You guessed <span className="text-volt">{formatNumber(Number(av.value), getNumberFormat(question.options))}</span> · off by {formatNumber(Number(av.diff), getNumberFormat(question.options))}</p>
          )}
        </div>

        {isMap && (result.geo_region != null || (result.correct_lat != null && result.correct_lng != null)) && (
          <div className="pt-2">
            <MapPicker
              height={260}
              disabled
              guess={av && av.lat != null ? { lat: Number(av.lat), lng: Number(av.lng) } : null}
              correct={result.correct_lat != null && result.correct_lng != null ? { lat: Number(result.correct_lat), lng: Number(result.correct_lng) } : null}
              region={result.geo_region ?? null}
              center={result.correct_lat != null && result.correct_lng != null ? [Number(result.correct_lat), Number(result.correct_lng)] : undefined}
              zoom={3}
            />
            <div className="flex justify-center gap-4 pt-2 font-mono text-[10px] uppercase text-foreground/60">
              {result.geo_region != null ? (
                <span className="flex items-center gap-1"><span className="size-2 bg-volt inline-block" /> {result.geo_region_label ?? "Region"}</span>
              ) : (
                <span className="flex items-center gap-1"><span className="size-2 bg-volt inline-block rounded-full" /> Correct</span>
              )}
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

        {correct && me && me.streak >= 2 && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-amber-spark pt-2">
            🔥 ×{(1 + Math.min(me.streak - 1, 5) * 0.1).toFixed(1)} streak bonus
          </p>
        )}
      </div>


      {/* Leaderboard reveal */}
      <div className="border border-border bg-card p-4 space-y-3">
        <p className="font-mono text-[10px] uppercase text-foreground/60">Leaderboard</p>
        <div className="grid grid-cols-3 gap-2">
          {top3.map((p) => {
            // Keyed on the server rank, not the array index: rank() skips after
            // a tie, so index 2 can be a 4th-place player who must not wear a
            // bronze medal.
            const medal = p.rank === 1 ? "🥇" : p.rank === 2 ? "🥈" : p.rank === 3 ? "🥉" : `#${p.rank}`;
            return (
              <div key={p.id} className={`border ${PODIUM_ACCENT_BORDER_SOFT[p.rank] ?? "border-border"} ${PODIUM_ACCENT_SURFACE[p.rank] ?? ""} p-3 text-center ${p.id === myId ? "ring-1 ring-volt" : ""}`}>
                <p className="text-xl">{medal}</p>
                <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={40} className="mx-auto my-1" />
                <p className="font-bold text-sm truncate">{p.nickname}</p>
                {p.id === myId && (
                  <p className="font-mono text-[8px] uppercase tracking-widest text-volt">you</p>
                )}
                <p className="font-mono text-xs text-foreground/60">{p.score.toLocaleString()}</p>
                <RankDelta nowRank={p.rank} prevRank={prevRanks.get(p.id)} />
              </div>
            );
          })}
        </div>
        <div className="space-y-1">
          {/* From `ranked`, not the raw array, so the number shown here is the
              same number the podium above uses. Slicing the unsorted list and
              counting up would print a position the server never recorded. */}
          {live.ranked.slice(3, 8).map((p) => (
              <div key={p.id} className={`flex items-center gap-2 py-1.5 px-2 ${p.id === myId ? "bg-volt/10 border border-volt/40" : "bg-background/40"}`}>
                <span className="font-mono text-xs text-foreground/40 w-6">{String(p.rank).padStart(2, "0")}</span>
                <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={20} />
                <span className="font-medium text-sm grow truncate">{p.nickname}</span>
                {p.id === myId && (
                  <span className="font-mono text-[8px] uppercase tracking-widest text-volt shrink-0">you</span>
                )}
                <RankDelta nowRank={p.rank} prevRank={prevRanks.get(p.id)} inline />
                <span className="font-display text-sm italic">{p.score.toLocaleString()}</span>
              </div>
            ))}
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
  standings, participants, myId, myRank, questions, orderedIds, myAnswers, quizTitle,
  authResolved, authFailed, isAuthenticated, seatLinked, seatChecked, identity, onLeave,
}: {
  /** Server-equivalent standing. Drives rank, the podium and placement. */
  standings: Standing<Participant>;
  participants: Participant[];
  myId: string;
  myRank: number;
  questions: Question[];
  orderedIds: string[];
  myAnswers: MyAnswer[];
  quizTitle: string;
  /** False while the session restoration is still unresolved. */
  authResolved: boolean;
  /** The session check ran and failed. Distinct from "not checked yet". */
  authFailed: boolean;
  /** A signed-in user exists. Says nothing about whether THIS seat is saved. */
  isAuthenticated: boolean;
  /** This seat is attached to a profile, so the result is in history. */
  seatLinked: boolean;
  /** The seat ownership check has completed, so absence of a link is meaningful. */
  seatChecked: boolean;
  identity: ParticipantIdentity;
  onLeave: () => void;
}) {

  const [reviewOpen, setReviewOpen] = useState(false);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Celebration moment — one fanfare per final screen mount.
  const fanfarePlayedRef = useRef(false);
  useEffect(() => {
    if (fanfarePlayedRef.current) return;
    fanfarePlayedRef.current = true;
    playSound("fanfare");
    if (myRank <= 3) haptic([40, 60, 80]);
  }, [myRank]);

  // Celebration is motion too. Someone who has asked their OS to reduce
  // animation should not get a confetti burst and a floating card, so the
  // decorative motion is gated on their preference rather than ours.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Measured once per result view, not per render.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    trackResultEvent("result_viewed", { mode: "hosted" });
  }, []);

  const ordered = orderedIds.map((id) => questions.find((q) => q.id === id)).filter(Boolean) as Question[];
  const ansByQ = new Map(myAnswers.map((a) => [a.question_id, a]));
  const scored = ordered.filter((q) => q.question_type !== "feedback");
  const me = participants.find((p) => p.id === myId);

  // Every displayed number comes from here, so "unmeasured" can never be
  // rendered as 0 and a solo run can never acquire a fabricated podium.
  const presentation = presentHosted({
    mode: "hosted",
    quizTitle,
    completed: true,
    participants: standings.ranked,
    myId,
    myRank,
    questions: ordered,
    answers: myAnswers,
    orderedIds,
  });

  // Badges. Restored rather than dropped: the previous inline computation had
  // three, and silently losing two to a rewrite is not a change anyone asked
  // for. Each is only claimed when the underlying number actually supports it.
  const achievement = ((): string | null => {
    if (myRank === 1) return "Champion";
    if (presentation.questionsAnswered.value > 0 && presentation.accuracy.available) {
      if (presentation.accuracy.value === 100) return "Most Accurate";
    }
    // Only meaningful in a real field, not a solo game.
    if (presentation.totalPlayers.available && presentation.totalPlayers.value > 1 && presentation.longestStreak.value >= 3) {
      return "Longest Streak";
    }
    return null;
  })();

  const shareData: ShareResultData = {
    nickname: presentation.nickname,
    // null, not 0: an unresolved seat must not print "0th of 0" on a card the
    // player can download and share.
    rank: presentation.rank.available ? presentation.rank.value : null,
    totalPlayers: presentation.totalPlayers.available ? presentation.totalPlayers.value : null,
    score: presentation.score.available ? presentation.score.value : null,
    correct: presentation.correct.value,
    totalQuestions: scored.length,
    longestStreak: presentation.longestStreak.value,
    quizTitle,
    achievement,
  };

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  /**
   * Share the result as text.
   *
   * Deliberately no link. The only URL this screen could offer is
   * /play/<sessionId>, which is not a public result page: it renders only for a
   * browser that still holds the guest seat, so sending it would produce a dead
   * link for the recipient. Inventing a public share route is out of scope, so
   * the honest share is a sentence. `shareMessage` is built from an allowlist
   * and cannot carry a token, an id or another player's name.
   */
  async function shareResult() {
    trackResultEvent("result_share_clicked", { mode: "hosted" });
    const text = shareMessage(presentation);
    if (detectShareMethod() === "native") {
      try {
        await navigator.share({ title: "Brain Bolt", text });
        trackResultEvent("result_share_completed", { mode: "hosted", shareMethod: "native" });
        return;
      } catch {
        // Dismissed, or the platform refused. Fall back rather than dead-end.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Result copied — paste it anywhere.");
      trackResultEvent("result_share_completed", { mode: "hosted", shareMethod: "copy" });
    } catch {
      toast.error("Could not copy. Long-press the score to copy it.");
    }
  }

  function playAgain() {
    // Does NOT restart or recreate this finished session. The player leaves for
    // the join flow, where a new game can be created or joined.
    trackResultEvent("replay_clicked", { mode: "hosted" });
    void navigate({ to: "/" });
  }

  return (
    <div className={reducedMotion ? "space-y-6" : "space-y-6 animate-float"}>
      {/* A. Completion moment */}
      <div className="relative overflow-hidden">
        {!reducedMotion && <Confetti loop={false} className="opacity-60" />}
        <div className="text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-foreground/60">Final standings</p>
          <h2 className="font-display text-5xl italic uppercase mt-2">Game complete!</h2>
        </div>
      </div>

      {/* B. Personal result — the one thing this screen exists to show */}
      <section aria-labelledby="your-score-heading" className="border border-volt/30 bg-volt/5 p-5 text-center">
        <h3
          id="your-score-heading"
          className="font-mono text-[10px] uppercase tracking-widest text-foreground/60"
        >
          Your score
        </h3>
        <p aria-live="polite" aria-atomic="true" className="font-display text-6xl italic text-volt tabular-nums mt-1">
          {presentation.score.available ? (
            <>
              <span className="sr-only">Final score: </span>
              {presentation.score.value.toLocaleString()}
            </>
          ) : (
            // The seat could not be resolved. Showing 0 here would claim the
            // player scored nothing, which is a different and wrong claim.
            <>
              <span aria-hidden="true" className="text-foreground/25">
                —
              </span>
              <span className="sr-only">Final score unavailable</span>
            </>
          )}
        </p>
        <p className="text-sm text-foreground/70 mt-1">
          {presentation.rank.available && presentation.totalPlayers.available
            ? `You finished #${presentation.rank.value} of ${presentation.totalPlayers.value} players.`
            : "You finished the game."}
        </p>
      </section>

      {/* C. Podium — only what the server actually ranked */}
      {presentation.podium.length > 0 && (
        <section aria-label="Top three" className="space-y-2">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Top three</h3>
          {presentation.podium.map((p) => (
            <div
              key={p.id}
              className={`flex items-center gap-3 sm:gap-4 p-3 border ${
                p.id === myId
                  ? `${PODIUM_ACCENT_BORDER[p.rank]} ${PODIUM_ACCENT_SURFACE[p.rank]}`
                  : "border-border bg-card"
              }`}
            >
              <span className={`font-display text-2xl italic ${accentText(p.rank)} w-9 shrink-0 text-left`}>
                #{p.rank}
              </span>
              <PlayerAvatar avatarId={p.avatarId} seed={p.id} size={32} />
              <span className="font-bold grow text-left truncate">{p.nickname}</span>
              {p.id === myId && (
                <span className="font-mono text-[9px] uppercase tracking-widest text-volt shrink-0">you</span>
              )}
              <span className="font-display text-lg italic tabular-nums shrink-0">
                {p.score.toLocaleString()}
              </span>
            </div>
          ))}
          {!presentation.onPodium && presentation.rank.available && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50 text-left">
              You finished #{presentation.rank.value}. The podium above is someone else's.
            </p>
          )}
        </section>
      )}

      {/* D. Personal performance */}
      <section aria-label="Your performance" className="border border-border bg-card p-5">
        <div className="flex items-center gap-4 mb-4">
          <PlayerAvatar
            avatarId={presentation.avatarId}
            seed={me?.id}
            size={48}
            className={`!border-2 ${accentBorder(myRank)}`}
          />
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Your finish</p>
            <p className="font-display text-xl italic truncate">{presentation.nickname}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <ResultStat
            label="Answered"
            metric={presentation.questionsAnswered}
            format={(v) => `${v}/${scored.length}`}
          />
          <ResultStat
            label="Accuracy"
            metric={presentation.accuracy}
            format={(v) => `${v}%`}
          />
          <ResultStat
            label="Correct"
            metric={presentation.correct}
            format={(v) => `${v}/${scored.length}`}
          />
          <ResultStat
            label="Avg time"
            metric={presentation.avgResponseMs}
            format={(v) => `${(v / 1000).toFixed(1)}s`}
          />
          <ResultStat label="Best streak" metric={presentation.longestStreak} format={(v) => String(v)} />
        </div>
      </section>

      {/* E. Keep-your-result invitation.
          Placed HERE, after the score, podium and performance are visible. It
          used to sit above the podium, which asked a guest to commit to an
          account before they had even seen what they scored. */}
      <SaveResultPanel
        identity={identity}
        quizTitle={quizTitle}
        authResolved={authResolved}
        authFailed={authFailed}
        isAuthenticated={isAuthenticated}
        seatLinked={seatLinked}
        seatChecked={seatChecked}
        returnPath={`/play/${identity.sessionId}`}
      />

      {/* Share card — inline, mobile-first, ~92vw */}
      <div className="flex justify-center">
        <ShareCardPreview data={shareData} cardRef={cardRef} className="w-[min(92vw,420px)]" />
      </div>

      {/* G. Actions — one primary, everything else secondary */}
      <div className="space-y-2">
        <button
          onClick={playAgain}
          className="w-full bg-volt text-background font-display text-xl py-4 skew-cta"
        >
          Play again
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => void shareResult()}
            className="w-full border border-border bg-card text-foreground font-display text-base py-3 skew-cta"
          >
            Share result
          </button>
          <Link
            to="/arena"
            className="w-full border border-border bg-card text-foreground font-display text-base py-3 skew-cta text-center"
          >
            Explore Arena
          </Link>
          {isAuthenticated && (
            <Link
              to="/profile"
              className="w-full border border-border bg-card text-foreground font-display text-base py-3 skew-cta text-center"
            >
              My results
            </Link>
          )}
          <button
            onClick={() => runAction(() => downloadShareCard(cardRef.current, shareData))}
            disabled={busy}
            className="w-full border border-border bg-card text-foreground font-display text-base py-3 skew-cta disabled:opacity-50"
          >
            {busy ? "Preparing…" : "Download image"}
          </button>
          <button
            onClick={onLeave}
            className="w-full border border-border bg-card text-foreground font-display text-base py-3 skew-cta col-span-2 sm:col-span-1"
          >
            Return home
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

/**
 * A single performance statistic.
 *
 * An unavailable metric renders as a dash and is announced as "not measured".
 * It is never rendered as 0: "0% accuracy" and "we never worked that out" are
 * different claims, and collapsing them tells a player they got everything
 * wrong when in fact nothing was ever scored.
 */
function ResultStat({
  label,
  metric,
  format,
}: {
  label: string;
  metric: Metric;
  format: (value: number) => string;
}) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50 truncate">{label}</p>
      {metric.available ? (
        <p className="font-display text-xl italic tabular-nums">{format(metric.value)}</p>
      ) : (
        <>
          <p className="font-display text-xl italic text-foreground/30" aria-hidden="true">
            —
          </p>
          <span className="sr-only">not measured</span>
        </>
      )}
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


