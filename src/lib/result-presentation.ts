// One presentation model for a finished result.
//
// WHY UNAVAILABLE IS NOT ZERO
// The old results screen computed every stat inline and rendered it
// unconditionally. A player who answered nothing got "Accuracy 0%", which is
// not the same claim as "this player was wrong every time" — for the first
// player, accuracy is undefined, because there was nothing to be right about.
// Showing 0% invented a performance record.
//
// Every number below therefore carries an `available` flag, and the UI is
// required to distinguish "not measured" from "measured as zero". A metric is
// only unavailable when the authoritative source genuinely cannot support it;
// it is 0 when the player really scored 0.
//
// Hosted and Arena are NOT collapsed into one shape. They share this module
// but keep their own semantics: a hosted run is ranked against other players
// and gets a podium; a solo Arena run is not, and fabricating a multiplayer
// podium for it would be the single most misleading thing this screen could
// do.

import type { Ranked } from "@/lib/ranking";

export type Metric = {
  /** False when the authoritative source cannot support this number at all. */
  available: boolean;
  value: number;
};

/** A metric with no authoritative source. Distinct from a measured zero. */
export const UNAVAILABLE: Metric = { available: false, value: 0 };

export function metric(value: number): Metric {
  return { available: true, value };
}

export type ResultMode = "hosted" | "arena";

export type PodiumEntry = {
  id: string;
  nickname: string;
  avatarId: string | null;
  score: number;
  rank: number;
};

export type Presentation = {
  mode: ResultMode;
  quizTitle: string;
  completed: boolean;
  nickname: string;
  avatarId: string | null;
  score: Metric;
  /** Unavailable for a solo run — there is no placing to report. */
  rank: Metric;
  /** Unavailable for a solo run. */
  totalPlayers: Metric;
  questionsAnswered: Metric;
  correct: Metric;
  /** Unavailable when nothing scored was attempted; 0 when attempted and wrong. */
  accuracy: Metric;
  /** Unavailable when no answer carried a timing. */
  avgResponseMs: Metric;
  longestStreak: Metric;
  /** Empty for a solo run. Never synthesised. */
  podium: PodiumEntry[];
  onPodium: boolean;
};

export type ScoredAnswer = {
  question_id: string;
  is_correct: boolean;
  response_ms?: number | null;
};

/**
 * A question counts towards accuracy unless it is ungraded feedback. This
 * mirrors the server's own accuracy calculation in `record_competition_results`
 * and `claim_result`, which both filter `q.question_type <> 'feedback'`.
 */
export type ScoredQuestion = { id: string; question_type: string };

export type HostedInput = {
  mode: "hosted";
  quizTitle: string;
  completed: boolean;
  participants: readonly Ranked<{ id: string; nickname: string; score: number; avatar_id: string | null }>[];
  myId: string;
  myRank: number | null;
  questions: readonly ScoredQuestion[];
  answers: readonly ScoredAnswer[];
  /** Ordered by question position; used for the streak walk. */
  orderedIds: readonly string[];
};

export type ArenaInput = {
  mode: "arena";
  quizTitle: string;
  completed: boolean;
  nickname: string;
  avatarId: string | null;
  score: number;
  questions: readonly ScoredQuestion[];
  answers: readonly ScoredAnswer[];
  orderedIds: readonly string[];
};

/**
 * Longest run of correct answers, in question order.
 *
 * `scoredIds` is required, not optional. A feedback question is never correct
 * and never breaks a streak in the player-facing sense, so walking it would
 * reset a run that the player never actually broke. It was walked before, and
 * with an interleaved feedback question it truncated a legitimate streak.
 */
export function longestCorrectStreak(
  orderedIds: readonly string[],
  answers: readonly ScoredAnswer[],
  scoredIds: ReadonlySet<string>,
): number {
  const byQ = new Map(answers.map((a) => [a.question_id, a]));
  let best = 0;
  let run = 0;
  for (const id of orderedIds) {
    if (!scoredIds.has(id)) continue;
    const a = byQ.get(id);
    if (a?.is_correct) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/** Shared derivation. Ranking is the only part that differs by mode. */
function common(args: {
  quizTitle: string;
  completed: boolean;
  questions: readonly ScoredQuestion[];
  answers: readonly ScoredAnswer[];
  orderedIds: readonly string[];
}): Pick<
  Presentation,
  "quizTitle" | "completed" | "questionsAnswered" | "correct" | "accuracy" | "avgResponseMs" | "longestStreak"
> {
  const { questions, answers, orderedIds } = args;

  const scoredIds = new Set(
    questions.filter((q) => q.question_type !== "feedback").map((q) => q.id),
  );
  const scored = answers.filter((a) => scoredIds.has(a.question_id));
  const correctCount = scored.filter((a) => a.is_correct).length;

  // Accuracy is undefined when nothing scored was attempted. Attempted and
  // wrong is 0 — a real, measured, and very different result.
  const accuracy = scored.length > 0 ? metric(Math.round((correctCount / scored.length) * 100)) : UNAVAILABLE;

  const timed = answers.filter((a) => typeof a.response_ms === "number" && a.response_ms > 0);
  const avgResponseMs =
    timed.length > 0
      ? metric(Math.round(timed.reduce((sum, a) => sum + (a.response_ms ?? 0), 0) / timed.length))
      : UNAVAILABLE;

  return {
    quizTitle: args.quizTitle,
    completed: args.completed,
    questionsAnswered: metric(answers.length),
    correct: metric(correctCount),
    accuracy,
    avgResponseMs,
    longestStreak: metric(longestCorrectStreak(orderedIds, answers, scoredIds)),
  };
}

export function presentHosted(input: HostedInput): Presentation {
  const shared = common(input);
  const me = input.participants.find((p) => p.id === input.myId) ?? null;

  return {
    ...shared,
    mode: "hosted",
    nickname: me?.nickname ?? "Player",
    avatarId: me?.avatar_id ?? null,
    // UNAVAILABLE, not zero, when this seat has no row in the list. That
    // happens when a participant row is deleted under a cached finished
    // session, or the scoreboard read has not landed. Reporting 0 there would
    // claim the player scored nothing, which is a different and wrong claim.
    score: me ? metric(me.score) : UNAVAILABLE,
    // A hosted game with no seat (identity lost) has no placing to report.
    rank: input.myRank && input.myRank > 0 ? metric(input.myRank) : UNAVAILABLE,
    totalPlayers: metric(input.participants.length),
    podium: input.participants
      .filter((p) => p.rank <= 3)
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        avatarId: p.avatar_id,
        score: p.score,
        rank: p.rank,
      })),
    onPodium: me !== null && me.rank <= 3,
  };
}

/**
 * A solo run is ranked against nobody. Rank, total players and podium are all
 * reported as unavailable rather than as 1 / 1 / "you", which would dress a
 * practice round up as a victory.
 */
export function presentArena(input: ArenaInput): Presentation {
  const shared = common(input);
  return {
    ...shared,
    mode: "arena",
    nickname: input.nickname,
    avatarId: input.avatarId,
    score: metric(input.score),
    rank: UNAVAILABLE,
    totalPlayers: UNAVAILABLE,
    podium: [],
    onPodium: false,
  };
}

/**
 * The share message. Whitelist, never blacklist: built only from fields above,
 * so a token, claim secret, internal id or another player's name cannot reach
 * it by accident as the payload grows.
 */
export function shareMessage(p: Presentation): string {
  // A score we could not resolve is not a score of zero. Saying "I just
  // scored 0 points" because the seat row went missing would be a fabricated
  // result, so the sentence drops the number instead.
  const headline = p.score.available
    ? p.rank.available && p.totalPlayers.available
      ? `I just scored ${p.score.value.toLocaleString()} points and finished #${p.rank.value} of ${p.totalPlayers.value} in Brain Bolt!`
      : `I just scored ${p.score.value.toLocaleString()} points in Brain Bolt!`
    : "I just finished a game in Brain Bolt!";

  const extras: string[] = [];
  if (p.accuracy.available) extras.push(`${p.accuracy.value}% accuracy.`);

  const titled = p.quizTitle && p.quizTitle !== "Quiz" ? ` on "${p.quizTitle}"` : "";
  const ask = ` Can you beat me${titled}?`;

  const middle = extras.length > 0 ? ` ${extras.join(" ")}` : "";
  return `${headline}${middle}${ask}`;
}
