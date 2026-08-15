import { INTRO_DURATION_MS } from "@/lib/question-meta";

type QuestionIntroTimingInput = {
  startedAtIso: string | null | undefined;
  nowMs: number;
  timeLimitMs: number;
  hasQuestion: boolean;
  revealed: boolean;
  pausedAtIso?: string | null | undefined;
  timeAddedMs?: number | null | undefined;
};

export type QuestionIntroTiming = ReturnType<typeof getQuestionIntroTiming>;

export function getQuestionIntroTiming({
  startedAtIso,
  nowMs,
  timeLimitMs,
  hasQuestion,
  revealed,
  pausedAtIso,
  timeAddedMs,
}: QuestionIntroTimingInput) {
  const sessionStartedAtMs = startedAtIso ? new Date(startedAtIso).getTime() : 0;
  const validStartedAt = Number.isFinite(sessionStartedAtMs) ? sessionStartedAtMs : 0;
  // While paused, freeze the effective "now" at the pause moment so both intro
  // and question timers stop ticking for host and player alike.
  const pausedAtMs = pausedAtIso ? new Date(pausedAtIso).getTime() : 0;
  const effectiveNowMs = pausedAtMs > 0 && Number.isFinite(pausedAtMs) ? pausedAtMs : nowMs;
  const isPaused = pausedAtMs > 0;
  const effectiveTimeLimitMs = timeLimitMs + Math.max(0, timeAddedMs ?? 0);
  const questionStartTimeMs = validStartedAt ? validStartedAt + INTRO_DURATION_MS : 0;
  const introRemainingMs = questionStartTimeMs ? Math.max(0, questionStartTimeMs - effectiveNowMs) : 0;
  const introElapsedMs = validStartedAt
    ? Math.max(0, Math.min(INTRO_DURATION_MS, effectiveNowMs - validStartedAt))
    : 0;
  // The intro/reveal window is defined purely by the server timeline
  // (validStartedAt + INTRO_DURATION_MS). It must NOT depend on when a
  // given client finishes loading question metadata, otherwise a slow
  // client would render intro from render-time and drift vs the host.
  const inIntroWindow = !revealed && validStartedAt > 0 && introRemainingMs > 0;
  const inIntro = inIntroWindow && hasQuestion;
  const questionElapsedMs = questionStartTimeMs ? Math.max(0, effectiveNowMs - questionStartTimeMs) : 0;
  const questionRemainingMs = questionStartTimeMs
    ? Math.max(0, effectiveTimeLimitMs - questionElapsedMs)
    : effectiveTimeLimitMs;

  return {
    sessionStartedAtMs: validStartedAt,
    questionStartTimeMs,
    introRemainingMs,
    introElapsedMs,
    introProgress: INTRO_DURATION_MS > 0 ? introElapsedMs / INTRO_DURATION_MS : 1,
    introCountdown: Math.max(1, Math.min(3, Math.ceil(introRemainingMs / 1000))),
    showIntroGo: introRemainingMs > 0 && introRemainingMs <= 350,
    inIntro,
    isPaused,
    questionElapsedMs,
    questionRemainingMs,
    questionRemainingSec: Math.ceil(questionRemainingMs / 1000),
  };
}
