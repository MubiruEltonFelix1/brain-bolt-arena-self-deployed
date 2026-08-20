import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveChannel, type LiveStatus } from "@/hooks/use-live-channel";
import { ConnectionBanner, LiveScreenState } from "@/components/ConnectionState";
import { Confetti } from "@/components/Confetti";

import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useAuthUser } from "@/hooks/use-auth-user";
import { TEAM_COLORS } from "@/lib/game";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import { QRCodeSVG } from "qrcode.react";
import { QuestionIntro } from "@/components/QuestionIntro";
import { getQuestionIntroTiming } from "@/lib/question-intro-timing";
import { getServerAdjustedNow, syncServerClock } from "@/lib/server-clock";
import { BrandBanner } from "@/components/BrandBanner";
import type { BrandingProfile } from "@/lib/branding";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useCoalescedCallback } from "@/hooks/use-coalesced-callback";


export const Route = createFileRoute("/host/$sessionId")({
  component: HostControl,
  errorComponent: () => (
    <LiveScreenState
      spinner={false}
      title="Control room disconnected"
      message="The competition keeps running on our servers. Reconnect to regain the controls."
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
  league_id: string | null;
  quiz_id: string;
  question_order: string[] | null;
  paused_at: string | null;
  time_added_ms: number | null;
  skipped_question_ids: string[] | null;
  quiz: { title: string; time_per_question: number } | null;
  branding_profile_id?: string | null;
};

type Question = {
  id: string; text: string; options: string[]; correct_index: number;
  position: number; time_limit_sec: number | null; point_value: number;
  question_type: string; image_url: string | null; double_points: boolean;
  correct_lat: number | null; correct_lng: number | null;
  correct_number: number | null; number_min: number | null; number_max: number | null;
  max_distance_km: number | null;
  accepted_answers: string[] | null;
  reveal_stages?: number | null;
  audio_url?: string | null;
};
type Participant = { id: string; nickname: string; score: number; team_id: string | null; avatar_id: string | null };
type Team = { id: string; name: string; color: string };
type Answer = { question_id: string; participant_id: string; is_correct: boolean };

type ConnInfo = { status: LiveStatus; recovered: boolean };

/** Thin wrapper so the connection indicator overlays every host screen. */
function HostControl() {
  const [conn, setConn] = useState<ConnInfo>({ status: "connecting", recovered: false });
  return (
    <>
      <HostScreen onConn={setConn} />
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <ConnectionBanner status={conn.status} recovered={conn.recovered} />
      </div>
    </>
  );
}

function HostScreen({ onConn }: { onConn: (c: ConnInfo) => void }) {

  const { sessionId } = Route.useParams();
  const { user: _user } = useAuthUser();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [answersForRound, setAnswersForRound] = useState<Answer[]>([]);
  const [roundStats, setRoundStats] = useState<Array<{ selected_index: number; vote_count: number }>>([]);
  const [prevRanks, setPrevRanks] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(() => getServerAdjustedNow());
  const [qrExpanded, setQrExpanded] = useState(false);
  const [branding, setBranding] = useState<BrandingProfile | null>(null);
  const [confirmEndEarly, setConfirmEndEarly] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // In-flight guard: a reconnect or an impatient double-tap must never fire the
  // same host control twice.
  const controlBusy = useRef(false);
  const [controlPending, setControlPending] = useState(false);
  async function runControl(fn: () => Promise<void>) {
    if (controlBusy.current) return;
    controlBusy.current = true;
    setControlPending(true);
    try {
      await fn();
    } finally {
      controlBusy.current = false;
      setControlPending(false);
    }
  }



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


  // Authoritative read: initial load, every realtime (re)connect and on
  // foreground return. The competition itself keeps running server-side.
  const load = useCallback(async () => {
    const { data: s, error: sErr } = await supabase
      .from("sessions").select("*, quiz:quizzes(title,time_per_question)")
      .eq("id", sessionId).maybeSingle();
    if (sErr) { setLoadFailed(true); return; }
    if (!s) { setLoadFailed(true); return; }
    setLoadFailed(false);
    setSession(s as unknown as Session);
    const bpId = (s as { branding_profile_id?: string | null }).branding_profile_id;
    if (bpId) {
      const { data: b } = await supabase
        .from("branding_profiles")
        .select("id,owner_principal_id,organization_name,logo_url,primary_color,secondary_color")
        .eq("id", bpId).maybeSingle();
      setBranding((b as BrandingProfile | null) ?? null);
    }
    const { data: qs } = await supabase.from("questions").select("id,text,options,correct_index,position,time_limit_sec,point_value,question_type,image_url,double_points,correct_lat,correct_lng,correct_number,number_min,number_max,max_distance_km,accepted_answers,reveal_stages,audio_url").eq("quiz_id", s.quiz_id).order("position");
    if (qs) setQuestions(qs as Question[]);
    const { data: ps } = await supabase.from("participants").select("id,nickname,score,team_id,avatar_id")
      .eq("session_id", sessionId).order("score", { ascending: false });
    if (ps) setParticipants(ps as Participant[]);
    const { data: ts } = await supabase.from("teams").select("id,name,color").eq("session_id", sessionId);
    if (ts) setTeams(ts as Team[]);

    // Rebuild this round's answer tally instead of replaying missed INSERTs.
    const order = (s as unknown as Session).question_order ?? (qs as Question[] | null)?.map((q) => q.id) ?? [];
    const idx = (s as unknown as Session).current_question_index ?? -1;
    const qid = idx >= 0 && idx < order.length ? order[idx] : null;
    if (qid) {
      const { data: as } = await supabase.from("answers")
        .select("question_id,participant_id,is_correct")
        .eq("session_id", sessionId).eq("question_id", qid);
      if (as) setAnswersForRound(as as Answer[]);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime emits one row event per participant; coalesce bursts into a
  // single authoritative refetch instead of one round-trip per row.
  const refetchParticipants = useCallback(async () => {
    const { data } = await supabase.from("participants").select("id,nickname,score,team_id,avatar_id")
      .eq("session_id", sessionId).order("score", { ascending: false });
    if (data) setParticipants(data as Participant[]);
  }, [sessionId]);
  const refetchTeams = useCallback(async () => {
    const { data } = await supabase.from("teams").select("id,name,color").eq("session_id", sessionId);
    if (data) setTeams(data as Team[]);
  }, [sessionId]);
  const onParticipantsChanged = useCoalescedCallback(refetchParticipants);
  const onTeamsChanged = useCoalescedCallback(refetchTeams);

  const { status: connStatus, recovered: connRecovered } = useLiveChannel({
    enabled: true,
    name: `host:${sessionId}`,
    setup: (ch) =>
      ch
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sessionId}` }, (payload) => {
          setSession((prev) => ({ ...(prev as Session), ...(payload.new as Partial<Session>) } as Session));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "participants", filter: `session_id=eq.${sessionId}` }, onParticipantsChanged)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "answers", filter: `session_id=eq.${sessionId}` }, (payload) => {
          const a = payload.new as Answer;
          setAnswersForRound((prev) =>
            prev.some((x) => x.participant_id === a.participant_id && x.question_id === a.question_id) ? prev : [...prev, a]
          );
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "teams", filter: `session_id=eq.${sessionId}` }, onTeamsChanged),
    onResync: load,
  });

  useEffect(() => {
    onConn({ status: connStatus, recovered: connRecovered });
  }, [connStatus, connRecovered, onConn]);



  const orderedIds = session?.question_order ?? questions.map((q) => q.id);
  const currentIndex = session?.current_question_index ?? -1;
  const currentQuestion = currentIndex >= 0 ? questions.find((q) => q.id === orderedIds[currentIndex]) : null;
  const totalRounds = orderedIds.length;
  const revealed = !!session?.current_question_revealed;

  const quizDefaultSec = session?.quiz?.time_per_question ?? 20;
  const timeLimitSec = currentQuestion?.time_limit_sec ?? quizDefaultSec;
  const timeLimitMs = timeLimitSec * 1000;
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
  const startedAt = timing.questionStartTimeMs; // effective start for timer/scoring UI
  const remaining = timing.questionRemainingMs;
  const remainingSec = timing.questionRemainingSec;
  const isPaused = timing.isPaused;


  const answeredThisRound = currentQuestion ? new Set(answersForRound.filter(a => a.question_id === currentQuestion.id).map(a => a.participant_id)).size : 0;
  const correctThisRound = currentQuestion ? answersForRound.filter(a => a.question_id === currentQuestion.id && a.is_correct).length : 0;

  function snapshotRanks() {
    const map = new Map<string, number>();
    participants.forEach((p, i) => map.set(p.id, i + 1));
    setPrevRanks(map);
  }

  async function startGame() {
    if (questions.length === 0) return toast.error("Add questions first");
    await runControl(async () => {
      setAnswersForRound([]);
      setRoundStats([]);
      snapshotRanks();
      // Ensure question_order is populated (feedback/opinion questions always last)
      if (!session?.question_order || (Array.isArray(session.question_order) && session.question_order.length === 0)) {
        const nonFeedback = questions.filter((q) => q.question_type !== "feedback");
        const feedback = questions.filter((q) => q.question_type === "feedback");
        const order = [...nonFeedback, ...feedback].map((q) => q.id);
        await supabase.from("sessions").update({ question_order: order }).eq("id", sessionId);
      }
      // Use DB's now() so host + players share the exact same start timestamp
      // delivered via the same Realtime event.
      const { error } = await supabase.rpc("advance_question", { p_session_id: sessionId });
      if (error) toastError(error, { context: "startGame (advance_question)" });
    });
  }


  async function revealRound() {
    await runControl(async () => {
      const { error } = await supabase.rpc("reveal_current_question", { p_session_id: sessionId });
      if (error) { toastError(error, { context: "revealRound (reveal_current_question)" }); return; }
      // Fetch stats
      if (currentQuestion) {
        const { data } = await supabase.rpc("get_round_stats", { p_session_id: sessionId, p_question_id: currentQuestion.id });
        setRoundStats((data as Array<{ selected_index: number; vote_count: number }> | null) ?? []);
      }
    });
  }

  async function nextRound() {
    await runControl(async () => {
      snapshotRanks();
      setAnswersForRound([]);
      setRoundStats([]);
      const { data, error } = await supabase.rpc("advance_question", { p_session_id: sessionId });
      if (error) { toastError(error, { context: "nextRound (advance_question)" }); return; }
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.ended) {
        await finalizeLeague();
      }
    });
  }

  async function togglePause() {
    if (!session) return;
    await runControl(async () => {
      const rpc = isPaused ? "resume_session" : "pause_session";
      const { error } = await supabase.rpc(rpc, { p_session_id: sessionId });
      if (error) { toastError(error, { context: "togglePause (pause/resume_session)" }); return; }
      toast.success(isPaused ? "Session resumed" : "Session paused");
    });
  }

  async function addTime(seconds: number) {
    await runControl(async () => {
      const { error } = await supabase.rpc("add_question_time", { p_session_id: sessionId, p_seconds: seconds });
      if (error) { toastError(error, { context: "addTime (add_question_time)" }); return; }
      toast.success(`+${seconds}s added to the current question`);
      setMoreOpen(false);
    });
  }

  async function doSkipQuestion() {
    setConfirmSkip(false);
    setMoreOpen(false);
    await runControl(async () => {
      snapshotRanks();
      setAnswersForRound([]);
      setRoundStats([]);
      const { data, error } = await supabase.rpc("skip_current_question", { p_session_id: sessionId });
      if (error) { toastError(error, { context: "doSkipQuestion (skip_current_question)" }); return; }
      const row = Array.isArray(data) ? data[0] : data;
      toast.success("Question skipped — no points awarded");
      if (row?.ended) await finalizeLeague();
    });
  }

  async function doEndEarly() {
    setConfirmEndEarly(false);
    await runControl(async () => {
      if (isPaused) {
        await supabase.rpc("resume_session", { p_session_id: sessionId });
      }
      const { error } = await supabase.rpc("end_question_early", { p_session_id: sessionId });
      if (error) { toastError(error, { context: "doEndEarly (end_question_early)" }); return; }
      if (currentQuestion) {
        const { data } = await supabase.rpc("get_round_stats", { p_session_id: sessionId, p_question_id: currentQuestion.id });
        setRoundStats((data as Array<{ selected_index: number; vote_count: number }> | null) ?? []);
      }
    });
  }




  async function finalizeLeague() {
    if (!session?.league_id) return;
    const leagueId = session.league_id;
    for (const p of participants) {
      const { data: existing } = await supabase
        .from("league_standings").select("id,total_points,sessions_played")
        .eq("league_id", leagueId).eq("nickname", p.nickname).maybeSingle();
      if (existing) {
        await supabase.from("league_standings").update({
          total_points: existing.total_points + p.score,
          sessions_played: existing.sessions_played + 1,
          updated_at: new Date().toISOString(),
        }).eq("id", existing.id);
      } else {
        await supabase.from("league_standings").insert({
          league_id: leagueId, nickname: p.nickname, total_points: p.score, sessions_played: 1,
        });
      }
    }
    toast.success("League standings updated");
  }

  // Auto-reveal: when timer hits zero OR everyone answered (never while paused/intro)
  useEffect(() => {
    if (!session || session.status !== "active" || !currentQuestion || revealed) return;
    if (isPaused || inIntro) return;
    const timedOut = startedAt > 0 && remaining <= 0;
    const everyone = participants.length > 0 && answeredThisRound >= participants.length;
    if (timedOut || everyone) {
      const t = setTimeout(() => { revealRound(); }, 250);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, currentQuestion?.id, revealed, remaining <= 0, answeredThisRound, participants.length, isPaused, inIntro]);


  // When a new question starts (server changes index), refresh round answers list
  useEffect(() => {
    setAnswersForRound([]);
    setRoundStats([]);
  }, [currentIndex]);

  // When round becomes revealed (e.g., by another tab/auto), pull stats
  useEffect(() => {
    if (!revealed || !currentQuestion) return;
    (async () => {
      const { data } = await supabase.rpc("get_round_stats", { p_session_id: sessionId, p_question_id: currentQuestion.id });
      setRoundStats((data as Array<{ selected_index: number; vote_count: number }> | null) ?? []);
    })();
  }, [revealed, currentQuestion?.id, sessionId]);

  useEffect(() => {
    if (!session?.id || !currentQuestion || !session.current_question_started_at) return;
    const localNowMs = Date.now();
    const adjustedNowMs = getServerAdjustedNow();
    const startedAtMs = new Date(session.current_question_started_at).getTime();
    const elapsedMs = adjustedNowMs - startedAtMs;
    console.debug("[question-intro-sync]", {
      screen: "host",
      serverNow: new Date(adjustedNowMs).toISOString(),
      localNow: new Date(localNowMs).toISOString(),
      serverSkewMs: adjustedNowMs - localNowMs,
      adjustedNow: adjustedNowMs,
      elapsedMs,
      remainingMs: Math.max(0, 3600 - elapsedMs),
    });
  }, [session?.id, session?.current_question_started_at, currentQuestion?.id, timeLimitMs, revealed]);



  if (!session) {
    return (
      <HostShell>
        {loadFailed ? (
          <LiveScreenState
            spinner={false}
            title="Can't load this competition"
            message="The competition keeps running on our servers even while this screen is disconnected."
            action={{ label: "RETRY", onClick: () => { setLoadFailed(false); void load(); } }}
          />
        ) : (
          <LiveScreenState
            title={connStatus === "offline" ? "Waiting for connection" : "Loading control room"}
            message={connStatus === "offline" ? "You appear to be offline. We'll reconnect automatically." : undefined}
          />
        )}
      </HostShell>
    );
  }


  async function createTeam() {
    const name = prompt("Team name?");
    if (!name) return;
    const color = TEAM_COLORS[teams.length % TEAM_COLORS.length];
    await supabase.from("teams").insert({ session_id: sessionId, name, color });
  }
  async function autoAssignTeams() {
    if (teams.length === 0) return toast.error("Create teams first");
    let i = 0;
    for (const p of participants) {
      if (p.team_id) continue;
      const target = teams[i % teams.length].id;
      await supabase.from("participants").update({ team_id: target }).eq("id", p.id);
      i++;
    }
  }

  const joinUrl = typeof window !== "undefined" ? `${window.location.origin}/join/${session.code}` : "";
  const totalVotes = roundStats.reduce((s, r) => s + r.vote_count, 0);
  const isLastRound = currentIndex + 1 >= totalRounds;

  return (
    <HostShell title="Host">
      <div className="max-w-5xl mx-auto px-6 py-8 pb-32 space-y-8">
        {branding && <BrandBanner branding={branding} />}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase text-foreground/60">Now hosting</p>
            <h1 className="font-display text-4xl italic uppercase">{session.quiz?.title}</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="font-mono text-[10px] uppercase text-foreground/60">Game code</p>
              <p className="font-display text-4xl italic text-volt tracking-widest">{session.code}</p>
            </div>
            <button
              onClick={() => { navigator.clipboard.writeText(joinUrl); toast.success("Join link copied"); }}
              className="font-mono text-xs uppercase border border-border px-3 py-2 hover:border-volt hover:text-volt"
            >
              Copy link
            </button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="space-y-4">
            {session.status === "lobby" && (
              <div className="bg-card border border-border p-8 space-y-6">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
                  <div>
                    <p className="font-mono text-xs uppercase text-volt">Lobby</p>
                    <h2 className="font-display text-3xl italic uppercase mt-1">Waiting room</h2>
                    <p className="text-foreground/60 text-sm mt-2">
                      Share <span className="text-volt font-mono">{joinUrl}</span> or the 6-digit code.
                    </p>
                  </div>
                  {joinUrl && (
                    <button
                      type="button"
                      onClick={() => setQrExpanded(true)}
                      title="Tap to enlarge"
                      className="flex flex-col items-center gap-2 border border-volt/30 bg-background p-3 rounded-md shrink-0 hover:border-volt transition-colors cursor-zoom-in"
                    >
                      <div className="bg-white p-2 rounded-sm">
                        <QRCodeSVG value={joinUrl} size={128} level="M" bgColor="#ffffff" fgColor="#0A0A0C" />
                      </div>
                      <p className="font-mono text-[10px] uppercase tracking-widest text-volt">Scan · Tap to enlarge</p>
                    </button>
                  )}
                </div>
                {session.team_mode && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="font-mono text-xs uppercase text-foreground/60">Teams ({teams.length})</p>
                      <div className="flex gap-2">
                        <button onClick={createTeam} className="font-mono text-xs uppercase border border-border px-3 py-1 hover:border-volt">+ Team</button>
                        <button onClick={autoAssignTeams} className="font-mono text-xs uppercase border border-border px-3 py-1 hover:border-volt">Auto-balance</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {teams.map((t) => (
                        <div key={t.id} className="border border-border p-3 bg-background">
                          <div className="size-3 mb-1" style={{ background: t.color }} />
                          <p className="font-bold text-sm truncate">{t.name}</p>
                          <p className="font-mono text-[10px] text-foreground/40">
                            {participants.filter((p) => p.team_id === t.id).length} players
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {session.status === "active" && currentQuestion && inIntro && (
              <QuestionIntro
                variant="host"
                questionType={currentQuestion.question_type}
                progress={timing.introProgress}
                roundNumber={currentIndex + 1}
                totalRounds={totalRounds}
                questionText={currentQuestion.text}
                doublePoints={currentQuestion.double_points}
                playersReady={participants.length}
                playersTotal={participants.length}
              />
            )}


            {session.status === "active" && currentQuestion && !revealed && !inIntro && (
              <div className="bg-card border border-border p-8 relative overflow-hidden">
                <div className="absolute top-0 left-0 h-1 bg-volt/20 w-full" />
                <div className="absolute top-0 left-0 h-1 bg-volt"
                  style={{ width: `${(remaining / timeLimitMs) * 100}%`, transition: "width 250ms linear" }} />
                <div className="flex justify-between items-center pt-2 mb-6">
                  <span className="font-mono text-xs uppercase text-foreground/60">ROUND {currentIndex + 1}/{totalRounds}</span>
                  {currentQuestion.double_points && (
                    <span className="font-mono text-xs uppercase text-amber-spark">⚡ DOUBLE POINTS</span>
                  )}
                  <div className="size-16 border-2 border-volt rounded-full grid place-items-center font-display text-3xl text-volt">
                    {String(Math.max(0, remainingSec)).padStart(2, "0")}
                  </div>
                </div>
                {currentQuestion.image_url && currentQuestion.question_type !== "image_reveal" && (
                  <img src={currentQuestion.image_url} alt={`Illustration for the question: ${currentQuestion.text}`} className="w-full max-h-64 object-contain mb-4 bg-background border border-border" />
                )}
                {currentQuestion.question_type === "image_reveal" && currentQuestion.image_url && (() => {
                  const stages = Math.max(2, Math.min(10, currentQuestion.reveal_stages ?? 5));
                  const elapsedMs = Math.max(0, timeLimitMs - remaining);
                  const stageIdx = Math.min(stages - 1, Math.floor((elapsedMs / Math.max(timeLimitMs, 1)) * stages));
                  const frac = stageIdx / (stages - 1);
                  const blurPx = Math.max(0, Math.round((1 - frac) * 32));
                  return (
                    <div className="mb-4 border border-border bg-background">
                      <div className="relative w-full aspect-video overflow-hidden">
                        <img src={currentQuestion.image_url} alt={`Progressively revealed image for the question: ${currentQuestion.text}`}
                          className="absolute inset-0 w-full h-full object-contain"
                          style={{ filter: `blur(${blurPx}px)`, transition: "filter 400ms linear" }} />
                      </div>
                      <div className="px-3 py-2 border-t border-border flex items-center justify-between font-mono text-[10px] uppercase text-foreground/60">
                        <span>🖼️ Reveal stage {stageIdx + 1} / {stages}</span>
                        <span className="text-volt">{answeredThisRound}/{participants.length} submitted</span>
                      </div>
                      <div className="h-1 bg-border/50">
                        <div className="h-full bg-volt" style={{ width: `${((stageIdx + 1) / stages) * 100}%`, transition: "width 400ms linear" }} />
                      </div>
                    </div>
                  );
                })()}
                {currentQuestion.question_type === "audio" && currentQuestion.audio_url && (
                  <div className="mb-4 border border-border bg-background p-3 flex items-center gap-3">
                    <span className="text-2xl">🎧</span>
                    <div className="flex-1">
                      <p className="font-mono text-[10px] uppercase text-foreground/60">Audio question — players hear the clip one time</p>
                      <audio controls src={currentQuestion.audio_url} className="w-full mt-1" />
                    </div>
                  </div>
                )}
                <h3 className="font-display text-3xl uppercase leading-tight mb-6">{currentQuestion.text}</h3>
                <div className="grid sm:grid-cols-2 gap-3">
                  {currentQuestion.question_type === "true_false" ? (
                    <>
                      <div className="p-4 border border-volt/40 bg-volt/5 font-display text-2xl italic text-volt text-center">TRUE</div>
                      <div className="p-4 border border-pink-shock/40 bg-pink-shock/5 font-display text-2xl italic text-pink-shock text-center">FALSE</div>
                    </>
                  ) : currentQuestion.question_type === "map_pin" ? (
                    <div className="sm:col-span-2 p-6 border border-cyan-jolt/40 bg-cyan-jolt/5 text-center">
                      <p className="font-display text-3xl italic text-cyan-jolt">🗺️ MAP PIN CHALLENGE</p>
                      <p className="font-mono text-xs uppercase text-foreground/60 mt-2">Players are dropping pins on the world map</p>
                    </div>
                  ) : currentQuestion.question_type === "number" ? (
                    <div className="sm:col-span-2 p-6 border border-amber-spark/40 bg-amber-spark/5 text-center">
                      <p className="font-display text-3xl italic text-amber-spark">🎯 CLOSEST NUMBER WINS</p>
                      <p className="font-mono text-xs uppercase text-foreground/60 mt-2">
                        Guess between {(currentQuestion.number_min ?? 0).toLocaleString()} — {(currentQuestion.number_max ?? 100).toLocaleString()}
                      </p>
                    </div>
                  ) : currentQuestion.question_type === "type" ? (
                    <div className="sm:col-span-2 p-6 border border-volt/40 bg-volt/5 text-center">
                      <p className="font-display text-3xl italic text-volt">⌨️ TYPE THE ANSWER</p>
                      <p className="font-mono text-xs uppercase text-foreground/60 mt-2">Players are typing their answer</p>
                    </div>
                  ) : currentQuestion.question_type === "feedback" ? (
                    <div className="sm:col-span-2 p-6 border border-cyan-jolt/40 bg-cyan-jolt/5 text-center">
                      <p className="font-display text-3xl italic text-cyan-jolt">💬 OPEN FEEDBACK</p>
                      <p className="font-mono text-xs uppercase text-foreground/60 mt-2">Collecting free-form responses — no scoring</p>
                    </div>
                  ) : currentQuestion.question_type === "ordering" ? (
                    <div className="sm:col-span-2 p-6 border border-pink-shock/40 bg-pink-shock/5 text-center">
                      <p className="font-display text-3xl italic text-pink-shock">🔀 ORDERING CHALLENGE</p>
                      <p className="font-mono text-xs uppercase text-foreground/60 mt-2">{currentQuestion.options.length} items · players drag into order</p>
                    </div>
                  ) : (
                    currentQuestion.options.map((opt, i) => (
                      <div key={i} className="p-4 border border-border bg-background flex items-center gap-3">
                        <span className="font-mono text-xs text-foreground/60 size-6 grid place-items-center bg-foreground/5">
                          {["A","B","C","D","E","F"][i]}
                        </span>
                        <span className="font-medium">{opt}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-6 grid grid-cols-3 gap-4 font-mono text-xs uppercase">
                  <Stat label="Answered" value={`${answeredThisRound}/${participants.length}`} />
                  <Stat label="Correct" value={String(correctThisRound)} />
                  <Stat label="Time left" value={`${remainingSec}s`} />
                </div>
                <p className="mt-6 text-center font-mono text-[10px] uppercase text-foreground/40">
                  Auto-reveals when all answer or timer ends — use REVEAL ANSWER below
                </p>

              </div>
            )}

            {session.status === "active" && currentQuestion && revealed && (
              <RoundResultsView
                question={currentQuestion}
                roundStats={roundStats}
                totalVotes={totalVotes}
                roundNumber={currentIndex + 1}
                totalRounds={totalRounds}
                participants={participants}
                prevRanks={prevRanks}
                onNext={nextRound}
                isLast={isLastRound}
              />
            )}

            {session.status === "ended" && (
              <div className="bg-card border border-border p-8 space-y-6">
                <div className="text-center space-y-2">
                  <p className="font-mono text-xs uppercase text-volt">Match complete</p>
                  <h2 className="font-display text-5xl italic uppercase">GG WP</h2>
                </div>
                <Podium participants={participants} />
                <FinalReview questions={questions} orderedIds={orderedIds} />
              </div>
            )}
          </div>

          <aside className="space-y-6">
            <div className="bg-card border border-border p-4">
              <p className="font-mono text-[10px] uppercase text-foreground/60 mb-3">
                Leaderboard · {participants.length}
              </p>
              <div className="space-y-1 max-h-[400px] overflow-auto">
                {participants.length === 0 && <p className="text-foreground/40 text-xs font-mono">No players yet</p>}
                {participants.map((p, i) => {
                  const team = teams.find((t) => t.id === p.team_id);
                  return (
                    <div key={p.id} className="flex items-center gap-2 py-1.5 px-2 bg-background/40">
                      <span className="font-mono text-xs text-foreground/40 w-6">{String(i + 1).padStart(2, "0")}</span>
                      <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={22} />
                      {team && <span className="size-2.5" style={{ background: team.color }} />}
                      <span className="font-medium text-sm grow truncate">{p.nickname}</span>
                      <span className="font-display text-sm italic">{p.score.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {session.team_mode && teams.length > 0 && (
              <div className="bg-card border border-border p-4">
                <p className="font-mono text-[10px] uppercase text-foreground/60 mb-3">Team scores</p>
                <div className="space-y-1">
                  {teams.map((t) => ({
                    ...t, total: participants.filter((p) => p.team_id === t.id).reduce((s, p) => s + p.score, 0),
                  })).sort((a, b) => b.total - a.total).map((t, i) => (
                    <div key={t.id} className="flex items-center gap-2 py-1.5 px-2 bg-background/40">
                      <span className="font-mono text-xs text-foreground/40 w-6">{String(i + 1).padStart(2, "0")}</span>
                      <span className="size-3" style={{ background: t.color }} />
                      <span className="font-medium text-sm grow truncate">{t.name}</span>
                      <span className="font-display text-sm italic">{t.total.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
      {qrExpanded && joinUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged join QR code"
          onClick={() => setQrExpanded(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setQrExpanded(false); }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
          className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-center justify-center p-6 outline-none"
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setQrExpanded(false); }}
            aria-label="Close"
            className="absolute top-4 right-4 size-12 border border-volt/40 text-volt font-display text-2xl hover:bg-volt hover:text-background transition-colors"
          >
            ✕
          </button>
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col items-center gap-6 border-2 border-volt/40 bg-card p-6 md:p-10 rounded-lg max-w-[95vw]"
          >
            <p className="font-mono text-xs uppercase tracking-widest text-volt">Scan to join</p>
            <div className="bg-white p-4 rounded-md">
              <QRCodeSVG
                value={joinUrl}
                size={Math.min(560, Math.floor(Math.min(typeof window !== "undefined" ? window.innerWidth : 560, typeof window !== "undefined" ? window.innerHeight : 560) * 0.7))}
                level="M"
                bgColor="#ffffff"
                fgColor="#0A0A0C"
              />
            </div>
            <div className="text-center space-y-2">
              <p className="font-display text-4xl md:text-5xl italic text-volt tracking-widest">{session.code}</p>
              <p className="font-mono text-xs md:text-sm text-foreground/70 break-all">{joinUrl}</p>
            </div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">Tap anywhere or press Esc to close</p>
          </div>
        </div>
      )}
      {isPaused && session.status === "active" && (
        <div className="fixed top-14 inset-x-0 z-30 py-2 bg-amber-spark/15 border-y border-amber-spark/50 text-center font-mono text-[11px] uppercase tracking-widest text-amber-spark">
          ⏸ Session paused — players are frozen. Resume to continue.
        </div>
      )}
      {confirmEndEarly && currentQuestion && (
        <ConfirmModal
          title="End question early?"
          onCancel={() => setConfirmEndEarly(false)}
          onConfirm={doEndEarly}
          confirmLabel="End now"
          tone="warn"
        >
          <p className="text-sm text-foreground/80">
            Answered: <span className="text-volt font-bold">{answeredThisRound}</span> · Remaining:{" "}
            <span className="text-pink-shock font-bold">{Math.max(0, participants.length - answeredThisRound)}</span> ·
            Time left: <span className="text-volt font-bold">{Math.max(0, remainingSec)}s</span>
          </p>
          <p className="text-xs text-foreground/60">
            Players who have not submitted will be treated exactly like timer expiry — no answer recorded,
            no points awarded. Submitted answers are still scored normally.
          </p>
        </ConfirmModal>
      )}
      {confirmSkip && currentQuestion && (
        <ConfirmModal
          title="Skip this question?"
          onCancel={() => setConfirmSkip(false)}
          onConfirm={doSkipQuestion}
          confirmLabel="Skip question"
          tone="danger"
        >
          <p className="text-sm text-foreground/80">
            All {answeredThisRound} submitted answer{answeredThisRound === 1 ? "" : "s"} for this question will be voided,
            and any points already awarded for it will be refunded. Unanswered players are not penalised.
          </p>
          <p className="text-xs text-foreground/60">
            The question stays in the session record marked as skipped, so it appears in future reporting.
          </p>
        </ConfirmModal>
      )}
      {(() => {
        const showStart = session.status === "lobby";
        const showActive = session.status === "active" && !!currentQuestion && !revealed && !inIntro;
        const showNext = session.status === "active" && !!currentQuestion && revealed;
        const showEnded = session.status === "ended";
        if (!showStart && !showActive && !showNext && !showEnded) return null;
        return (
          <div className="fixed bottom-0 inset-x-0 z-40 bg-background/95 backdrop-blur border-t border-border">
            <div className="max-w-5xl mx-auto px-6 py-3 flex gap-3 items-center relative">
              {showStart && (
                <button onClick={startGame} disabled={controlPending} className="flex-1 disabled:opacity-60 bg-volt text-background font-display text-xl py-3 skew-cta">
                  START MATCH · {participants.length} {participants.length === 1 ? "PLAYER" : "PLAYERS"}
                </button>
              )}
              {showActive && (
                <>
                  <button
                    onClick={togglePause} disabled={controlPending}
                    className="font-mono text-xs uppercase border border-border px-4 py-3 hover:border-volt hover:text-volt min-w-[110px]"
                    title={isPaused ? "Resume the session" : "Pause the session"}
                  >
                    {isPaused ? "▶ RESUME" : "⏸ PAUSE"}
                  </button>
                  <button
                    onClick={() => setConfirmEndEarly(true)}
                    className="flex-1 bg-volt text-background font-display text-xl py-3 skew-cta"
                  >
                    END QUESTION EARLY
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setMoreOpen((v) => !v)}
                      className="font-mono text-xs uppercase border border-border px-4 py-3 hover:border-volt hover:text-volt"
                      aria-haspopup="menu"
                      aria-expanded={moreOpen}
                    >
                      MORE ▾
                    </button>
                    {moreOpen && (
                      <div
                        role="menu"
                        className="absolute right-0 bottom-full mb-2 w-64 border border-border bg-card shadow-xl divide-y divide-border"
                      >
                        <button
                          role="menuitem"
                          onClick={() => addTime(15)}
                          className="w-full text-left px-4 py-3 hover:bg-background/60 font-mono text-xs uppercase"
                        >
                          ➕ Add 15 seconds
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => addTime(30)}
                          className="w-full text-left px-4 py-3 hover:bg-background/60 font-mono text-xs uppercase"
                        >
                          ➕ Add 30 seconds
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => { setMoreOpen(false); setConfirmSkip(true); }}
                          className="w-full text-left px-4 py-3 hover:bg-background/60 font-mono text-xs uppercase text-pink-shock"
                        >
                          ⏭ Skip question
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
              {showNext && (
                <button onClick={nextRound} disabled={controlPending} className="flex-1 disabled:opacity-60 bg-volt text-background font-display text-xl py-3 skew-cta">
                  {isLastRound ? "END MATCH" : "NEXT QUESTION →"}
                </button>
              )}
              {showEnded && (
                <button onClick={() => navigate({ to: "/dashboard" })} className="flex-1 bg-volt text-background font-display text-xl py-3 skew-cta">
                  BACK TO DASHBOARD
                </button>
              )}
            </div>
          </div>
        );
      })()}

    </HostShell>
  );
}

function ConfirmModal({
  title, children, onCancel, onConfirm, confirmLabel, tone = "warn",
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  tone?: "warn" | "danger";
}) {
  const confirmClass =
    tone === "danger"
      ? "bg-pink-shock text-background hover:brightness-110"
      : "bg-volt text-background hover:brightness-110";
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] bg-background/85 backdrop-blur-sm grid place-items-center p-6"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-border bg-card p-6 space-y-4"
      >
        <h3 className="font-display text-2xl italic uppercase">{title}</h3>
        <div className="space-y-3">{children}</div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 font-mono text-xs uppercase border border-border py-3 hover:border-volt hover:text-volt"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 font-display text-lg italic py-3 skew-cta ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {

  return (
    <div className="border border-border p-3 bg-background">
      <p className="text-[10px] text-foreground/40">{label}</p>
      <p className="font-display text-xl italic text-volt">{value}</p>
    </div>
  );
}

function RoundResultsView({
  question, roundStats, totalVotes, roundNumber, totalRounds, participants, prevRanks, onNext, isLast,
}: {
  question: Question;
  roundStats: Array<{ selected_index: number; vote_count: number }>;
  totalVotes: number;
  roundNumber: number;
  totalRounds: number;
  participants: Participant[];
  prevRanks: Map<string, number>;
  onNext: () => void;
  isLast: boolean;
}) {
  const isTF = question.question_type === "true_false";
  const isMap = question.question_type === "map_pin";
  const isNum = question.question_type === "number";
  const isType = question.question_type === "type";
  const isFeedback = question.question_type === "feedback";
  const isOrdering = question.question_type === "ordering";
  const labels = isTF ? ["TRUE", "FALSE"] : question.options;
  const correctIdx = question.correct_index;
  const correctVotes = roundStats.find((r) => r.selected_index === correctIdx)?.vote_count ?? 0;
  const correctPct = totalVotes > 0 ? Math.round((correctVotes / totalVotes) * 100) : 0;

  return (
    <div className="bg-card border border-border p-8 space-y-6">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-foreground/60">ROUND {roundNumber}/{totalRounds}</span>
        {question.double_points && <span className="font-mono text-xs uppercase text-amber-spark">⚡ DOUBLE POINTS</span>}
      </div>
      <h3 className="font-display text-2xl uppercase leading-tight">{question.text}</h3>

      {isFeedback ? (
        <FeedbackReveal questionId={question.id} />
      ) : isOrdering ? (
        <OrderingReveal question={question} />
      ) : isMap || isNum || isType ? (
        <div className="border-2 border-volt bg-volt/5 p-6 text-center space-y-2">
          <p className="font-mono text-[10px] uppercase text-foreground/60">Correct answer</p>
          {isMap ? (
            <p className="font-display text-3xl italic text-volt">
              🗺️ {question.correct_lat != null ? `${Number(question.correct_lat).toFixed(3)}, ${Number(question.correct_lng).toFixed(3)}` : "—"}
            </p>
          ) : isNum ? (
            <p className="font-display text-4xl italic text-volt">
              🎯 {question.correct_number != null ? Number(question.correct_number).toLocaleString() : "—"}
            </p>
          ) : (
            <TextAnswerReveal
              questionId={question.id}
              acceptedAnswers={question.accepted_answers ?? []}
            />
          )}
          <p className="font-mono text-xs text-foreground/60">{totalVotes} of {totalVotes} players submitted</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase text-foreground/60">Answer distribution · {totalVotes} votes</p>
          {labels.map((label, i) => {
            const count = roundStats.find((r) => r.selected_index === i)?.vote_count ?? 0;
            const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            const isCorrect = i === correctIdx;
            return (
              <div key={i} className={`border ${isCorrect ? "border-volt" : "border-border"} p-2`}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className={`font-medium text-sm ${isCorrect ? "text-volt" : ""}`}>
                    {isCorrect ? "✓ " : ""}{isTF ? label : `${["A","B","C","D","E","F"][i]} — ${label}`}
                  </span>
                  <span className="font-mono text-xs text-foreground/70">{count} ({pct}%)</span>
                </div>
                <div className="h-2 bg-border relative overflow-hidden">
                  <div className={`absolute inset-y-0 left-0 ${isCorrect ? "bg-volt" : "bg-cyan-jolt/60"}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <p className="font-mono text-xs text-foreground/60 pt-1">
            <span className="text-volt">{correctPct}%</span> of players got it right
          </p>
        </div>
      )}


      <div className="border-t border-border pt-4 space-y-2">
        <p className="font-mono text-[10px] uppercase text-foreground/60">Standings movement</p>
        {participants.slice(0, 5).map((p, i) => {
          const rank = i + 1;
          const prev = prevRanks.get(p.id);
          const diff = prev ? prev - rank : 0;
          return (
            <div key={p.id} className="flex items-center gap-2 py-1.5 px-2 bg-background/40">
              <span className="font-mono text-xs text-foreground/40 w-6">{String(rank).padStart(2, "0")}</span>
              <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={22} />
              <span className="font-medium text-sm grow truncate">{p.nickname}</span>
              {diff !== 0 && prev !== undefined && (
                <span className={`font-mono text-[10px] ${diff > 0 ? "text-volt" : "text-pink-shock"}`}>
                  {diff > 0 ? `▲${diff}` : `▼${Math.abs(diff)}`}
                </span>
              )}
              <span className="font-display text-sm italic">{p.score.toLocaleString()}</span>
            </div>
          );
        })}
      </div>

    </div>
  );
}

function PodiumCard({
  p, place, height, delay, medal, colorVar,
}: {
  p: Participant; place: number; height: string; delay: string; medal: string; colorVar: string;
}) {
  const initials = p.nickname.slice(0, 2).toUpperCase();
  return (
    <div className="flex flex-col items-center gap-3" style={{ animation: `podium-rise 0.7s cubic-bezier(0.32,0.72,0,1) ${delay} both` }}>
      <div className="relative">
        <div
          className="size-20 md:size-24 rounded-full grid place-items-center border-2 overflow-hidden"
          style={{ borderColor: colorVar, background: `color-mix(in oklab, ${colorVar} 15%, transparent)`, boxShadow: `0 0 30px color-mix(in oklab, ${colorVar} 40%, transparent)` }}
        >
          <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={92} className="!border-0 !rounded-full" />
        </div>
        <div
          className="absolute -top-2 -right-2 size-9 rounded-full grid place-items-center font-display italic text-background text-sm"
          style={{ background: colorVar, animation: `badge-pop 0.5s cubic-bezier(0.32,0.72,0,1) ${delay} both` }}
        >
          #{place}
        </div>
      </div>
      <div className="text-center max-w-full px-2">
        <p className="font-bold text-base md:text-lg truncate">{p.nickname}</p>
        <p className="font-display text-2xl md:text-3xl italic" style={{ color: colorVar }}>{p.score.toLocaleString()}</p>
      </div>
      <div
        className="w-full border-t-2 rounded-t-md flex items-start justify-center pt-3 relative overflow-hidden"
        style={{ height, background: `linear-gradient(180deg, color-mix(in oklab, ${colorVar} 18%, transparent), color-mix(in oklab, ${colorVar} 4%, transparent))`, borderColor: colorVar, boxShadow: `inset 0 -20px 40px color-mix(in oklab, ${colorVar} 15%, transparent)` }}
      >
        <span className="font-display text-4xl md:text-6xl italic" style={{ color: colorVar }}>{medal}</span>
      </div>
    </div>
  );
}

function Podium({ participants }: { participants: Participant[] }) {
  const sorted = [...participants].sort((a, b) => b.score - a.score);
  const [first, second, third] = sorted;
  const rest = sorted.slice(3);

  const GOLD = "#FFD447";
  const SILVER = "#D8DEE9";
  const BRONZE = "#CD7F32";

  return (
    <div className="space-y-8">
      <div className="relative bg-gradient-to-b from-background/20 to-transparent p-4 md:p-8 rounded-lg overflow-hidden">
        <Confetti />
        <div className="relative grid grid-cols-3 gap-3 md:gap-6 items-end max-w-3xl mx-auto">
          {second ? (
            <PodiumCard p={second} place={2} height="90px" delay="0.25s" medal="🥈" colorVar={SILVER} />
          ) : <div />}
          {first ? (
            <div className="scale-105 md:scale-110">
              <PodiumCard p={first} place={1} height="140px" delay="0.55s" medal="🥇" colorVar={GOLD} />
            </div>
          ) : <div />}
          {third ? (
            <PodiumCard p={third} place={3} height="65px" delay="0.1s" medal="🥉" colorVar={BRONZE} />
          ) : <div />}
        </div>
      </div>

      {rest.length > 0 && (
        <div className="border border-border bg-background/40 rounded-md overflow-hidden">
          <div className="grid grid-cols-[60px_1fr_100px] px-4 py-2 border-b border-border bg-card">
            <p className="font-mono text-[10px] uppercase text-foreground/60">Pos</p>
            <p className="font-mono text-[10px] uppercase text-foreground/60">Player</p>
            <p className="font-mono text-[10px] uppercase text-foreground/60 text-right">Score</p>
          </div>
          <div className="max-h-[300px] overflow-auto">
            {rest.map((p, i) => (
              <div
                key={p.id}
                className={`grid grid-cols-[60px_28px_1fr_100px] gap-2 px-4 py-2 items-center transition-colors hover:bg-volt/10 ${i % 2 === 0 ? "bg-background/20" : "bg-transparent"}`}
              >
                <span className="font-mono text-sm text-foreground/50">#{i + 4}</span>
                <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={24} />
                <span className="font-medium text-sm truncate">{p.nickname}</span>
                <span className="font-display text-base italic text-volt text-right">{p.score.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FinalReview({ questions, orderedIds }: { questions: Question[]; orderedIds: string[] }) {
  const ordered = orderedIds.map((id) => questions.find((q) => q.id === id)).filter(Boolean) as Question[];
  if (ordered.length === 0) return null;
  return (
    <div className="border border-border bg-background/40 p-4 space-y-3 text-left max-h-[400px] overflow-auto">
      <p className="font-mono text-[10px] uppercase text-foreground/60">Answer key</p>
      {ordered.map((q, i) => (
        <div key={q.id} className="border border-border p-3">
          <p className="font-mono text-[10px] text-foreground/40 mb-1">Q{String(i + 1).padStart(2, "0")}</p>
          <p className="font-medium text-sm mb-2">{q.text}</p>
          {q.question_type === "feedback" ? (
            <p className="font-mono text-xs text-cyan-jolt">💬 Open feedback — no correct answer</p>
          ) : (
            <p className="font-mono text-xs">
              <span className="text-foreground/40">CORRECT: </span>
              <span className="text-volt">
                {q.question_type === "true_false"
                  ? (q.correct_index === 0 ? "TRUE" : "FALSE")
                  : q.question_type === "map_pin"
                  ? (q.correct_lat != null ? `🗺️ ${Number(q.correct_lat).toFixed(3)}, ${Number(q.correct_lng).toFixed(3)}` : "—")
                  : q.question_type === "number"
                  ? (q.correct_number != null ? `🎯 ${Number(q.correct_number).toLocaleString()}` : "—")
                  : q.question_type === "type"
                  ? (q.accepted_answers?.[0] ? `⌨️ ${q.accepted_answers[0]}` : "—")
                  : q.question_type === "ordering"
                  ? `🔀 ${q.options.join(" → ")}`
                  : q.options[q.correct_index]}
              </span>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function TextAnswerReveal({
  questionId,
  acceptedAnswers,
}: {
  questionId: string;
  acceptedAnswers: string[];
}) {
  const { sessionId } = Route.useParams();
  const [groups, setGroups] = useState<Array<{ key: string; label: string; count: number; correct: boolean }>>([]);
  const [phase, setPhase] = useState<"loading" | "list" | "reveal">("loading");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("answers")
        .select("text_submission")
        .eq("session_id", sessionId)
        .eq("question_id", questionId);
      if (cancelled) return;
      const map = new Map<string, { label: string; count: number }>();
      const accepted = new Set(acceptedAnswers.map((a) => normalizeText(a)));
      const rows = (data ?? []).filter((r) => (r.text_submission ?? "").trim().length > 0);
      for (const r of rows) {
        const raw = (r.text_submission ?? "").trim();
        const key = raw.toLowerCase();
        const existing = map.get(key);
        if (existing) existing.count += 1;
        else map.set(key, { label: raw, count: 1 });
      }
      const list = Array.from(map.entries()).map(([key, v]) => ({
        key,
        label: v.label,
        count: v.count,
        correct: accepted.has(normalizeText(v.label)),
      }));
      // Ensure the official correct answer appears even if nobody guessed it
      const official = acceptedAnswers[0];
      if (official && !list.some((g) => g.correct)) {
        list.push({ key: `__official_${official}`, label: official, count: 0, correct: true });
      }
      list.sort((a, b) => b.count - a.count);
      setGroups(list);
      setLoaded(true);
      setPhase("list");
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, questionId, acceptedAnswers]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => setPhase("reveal"), 1000);
    return () => clearTimeout(t);
  }, [loaded]);

  const total = groups.reduce((s, g) => s + g.count, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase text-foreground/60">
          Player answers · {total} submitted
        </p>
        <p className="font-mono text-[10px] uppercase text-volt">
          ⌨️ Correct: {acceptedAnswers[0] ?? "—"}
        </p>
      </div>

      {phase === "loading" && (
        <p className="font-mono text-xs text-foreground/50 p-4">Loading answers…</p>
      )}

      {phase !== "loading" && groups.length === 0 && (
        <div className="border-2 border-volt bg-volt/5 rounded-xl p-6 text-center">
          <p className="font-display text-3xl italic text-volt">⌨️ {acceptedAnswers[0] ?? "—"}</p>
          <p className="font-mono text-[10px] uppercase text-foreground/60 mt-2">No submissions</p>
        </div>
      )}

      {phase !== "loading" && groups.length > 0 && (
        <div className="relative">
          <div
            className={`grid gap-3 ${
              phase === "reveal" ? "sm:grid-cols-1" : "sm:grid-cols-2"
            }`}
          >
            {groups.map((g, i) => {
              const isCorrect = g.correct;
              const shouldFall = phase === "reveal" && !isCorrect;
              const rotate = ((i * 37) % 17) - 8; // deterministic -8..+8
              const delay = i * 65; // ms
              return (
                <div
                  key={g.key}
                  className={`rounded-xl border-2 px-5 py-4 flex items-center justify-between gap-4 will-change-transform transition-all duration-300 ${
                    isCorrect
                      ? phase === "reveal"
                        ? "border-volt bg-volt/10 scale-105 shadow-[0_0_30px_rgba(204,255,0,0.35)]"
                        : "border-border bg-background/60"
                      : "border-border bg-background/60"
                  } ${
                    phase === "reveal" && isCorrect ? "mx-auto max-w-md w-full" : ""
                  }`}
                  style={
                    shouldFall
                      ? {
                          animation: `answer-fall 700ms cubic-bezier(0.55, 0.055, 0.675, 0.19) ${delay}ms forwards`,
                          transform: `rotate(${rotate}deg)`,
                        }
                      : undefined
                  }
                >
                  <span className="font-bold text-lg md:text-xl truncate flex items-center gap-2">
                    {phase === "reveal" && isCorrect && (
                      <span className="text-volt">✓</span>
                    )}
                    {g.label}
                  </span>
                  <span
                    className={`font-display text-2xl italic shrink-0 ${
                      phase === "reveal" && isCorrect ? "text-volt" : "text-foreground/80"
                    }`}
                  >
                    {g.count}
                  </span>
                </div>
              );
            })}
          </div>
          {phase === "reveal" && groups.some((g) => g.correct) && (
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <Confetti />
            </div>
          )}
          <style>{`
            @keyframes answer-fall {
              0% { transform: translateY(0) rotate(0deg); opacity: 1; }
              20% { opacity: 1; }
              100% { transform: translateY(600px) rotate(45deg); opacity: 0; }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}

function FeedbackReveal({ questionId }: { questionId: string }) {
  const { sessionId } = Route.useParams();
  const [groups, setGroups] = useState<Array<{ key: string; label: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("answers")
        .select("text_submission")
        .eq("session_id", sessionId)
        .eq("question_id", questionId);
      if (cancelled) return;
      const map = new Map<string, { label: string; count: number }>();
      const rows = (data ?? []).filter((r) => (r.text_submission ?? "").trim().length > 0);
      for (const r of rows) {
        const raw = (r.text_submission ?? "").trim();
        const key = normalizeText(raw);
        const existing = map.get(key);
        if (existing) existing.count += 1;
        else map.set(key, { label: raw, count: 1 });
      }
      const list = Array.from(map.entries())
        .map(([key, v]) => ({ key, label: v.label, count: v.count }))
        .sort((a, b) => b.count - a.count);
      setGroups(list);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [sessionId, questionId]);

  const total = groups.reduce((s, g) => s + g.count, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase text-foreground/60">
          💬 Open feedback · {total} {total === 1 ? "response" : "responses"}
        </p>
        <p className="font-mono text-[10px] uppercase text-cyan-jolt">No scoring</p>
      </div>

      {loading && (
        <p className="font-mono text-xs text-foreground/50 p-4">Loading responses…</p>
      )}

      {!loading && groups.length === 0 && (
        <div className="border-2 border-dashed border-border rounded-xl p-6 text-center">
          <p className="font-mono text-xs uppercase text-foreground/50">No responses submitted</p>
        </div>
      )}

      {!loading && groups.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 max-h-[420px] overflow-auto pr-1">
          {groups.map((g) => (
            <div
              key={g.key}
              className="rounded-xl border-2 border-border bg-background/60 px-5 py-4 flex items-center justify-between gap-4"
            >
              <span className="font-medium text-base md:text-lg text-left break-words min-w-0">
                {g.label}
              </span>
              <span className="font-display text-2xl italic shrink-0 text-cyan-jolt">
                ×{g.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OrderingReveal({ question }: { question: Question }) {
  const { sessionId } = Route.useParams();
  const [rows, setRows] = useState<Array<{ order: number[]; correct_positions: number }>>([]);
  const [loading, setLoading] = useState(true);
  const total = question.options.length;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("answers")
        .select("answer_value")
        .eq("session_id", sessionId)
        .eq("question_id", question.id);
      if (cancelled) return;
      const parsed = (data ?? [])
        .map((r) => (r.answer_value ?? {}) as any)
        .filter((v) => Array.isArray(v?.order))
        .map((v) => ({ order: v.order as number[], correct_positions: Number(v.correct_positions ?? 0) }));
      setRows(parsed);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [sessionId, question.id]);

  const perfect = rows.filter((r) => r.correct_positions === total).length;
  const avg = rows.length ? (rows.reduce((s, r) => s + r.correct_positions, 0) / rows.length) : 0;
  // per-position correctness rate
  const positionCorrect = question.options.map((_, i) =>
    rows.filter((r) => r.order[i] === i).length
  );

  return (
    <div className="space-y-4">
      <div className="border-2 border-volt bg-volt/5 p-4 space-y-2">
        <p className="font-mono text-[10px] uppercase text-foreground/60 text-center">🔀 Correct order (top → bottom)</p>
        <div className="grid gap-1.5">
          {question.options.map((label, i) => {
            const pct = rows.length ? Math.round((positionCorrect[i] / rows.length) * 100) : 0;
            return (
              <div key={i} className="flex items-center gap-3 border border-border bg-background/60 p-2">
                <span className="font-display text-xl italic text-volt w-6 shrink-0">{i + 1}</span>
                <span className="font-medium flex-1 text-sm">{label}</span>
                <span className="font-mono text-[10px] text-foreground/60 shrink-0">{positionCorrect[i]}/{rows.length} · {pct}%</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="border border-border p-3 text-center">
          <p className="font-mono text-[10px] uppercase text-foreground/40">Submissions</p>
          <p className="font-display text-2xl italic text-volt">{loading ? "…" : rows.length}</p>
        </div>
        <div className="border border-border p-3 text-center">
          <p className="font-mono text-[10px] uppercase text-foreground/40">Perfect</p>
          <p className="font-display text-2xl italic text-volt">{perfect}</p>
        </div>
        <div className="border border-border p-3 text-center">
          <p className="font-mono text-[10px] uppercase text-foreground/40">Avg correct</p>
          <p className="font-display text-2xl italic text-volt">{avg.toFixed(1)}<span className="text-foreground/40 text-sm">/{total}</span></p>
        </div>
      </div>
    </div>
  );
}
