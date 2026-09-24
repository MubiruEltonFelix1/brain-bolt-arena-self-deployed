// Arena completion-screen insights.
//
// Everything here is derived from data the server already returned for this
// run — question answers, response times and the per-third accuracy split.
// There is no inference, no prediction and no model involved: if the numbers
// are not in `ArenaRunInsights`, nothing is claimed.
//
// Kept pure so every observation can be unit-tested against a fixed payload.

import type { ArenaRunInsights } from "@/lib/arena";

export type InsightTone = "good" | "neutral" | "hard";

/**
 * `get_arena_run_insights` derives `comeback` from the same run "thirds" it
 * builds with `row_number() OVER (ORDER BY question_id)` — and `question_id` is
 * a uuid, so the `last` third is an arbitrary group rather than the closing
 * questions. A comeback claim built on that grouping is effectively random, so
 * it is deliberately not rendered. Flip this to `true` once the SQL orders the
 * thirds by the question's real position (`position` / `created_at`), not its id.
 */
export const COMEBACK_INSIGHT_ENABLED = false;

/**
 * Exported separately from the gated push so its wording can be asserted even
 * while the insight is disabled — it must never describe a position in the run.
 */
export const COMEBACK_DETAIL =
  "You scored better in one stretch of the run than anywhere else.";

export type RunInsight = {
  id: string;
  label: string;
  detail: string;
  tone: InsightTone;
};

type Third = keyof ArenaRunInsights["thirds"];

function thirdAccuracy(third: { count: number; correct: number }): number {
  return third.count > 0 ? third.correct / third.count : 0;
}

/** Milliseconds → "3.2s". Response times are always sub-minute in practice. */
export function formatResponseMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The strongest third of the run, or null when no third had any graded answer.
 * Ties resolve to the earliest third so the result is deterministic.
 *
 * NOTE: `get_arena_run_insights` builds these thirds with
 * `row_number() OVER (ORDER BY question_id)`, and `question_id` is a uuid — so
 * the grouping is effectively arbitrary and "first" is NOT "the opening
 * questions". Nothing in this module may describe a third by its position.
 */
export function strongestThird(
  thirds: ArenaRunInsights["thirds"],
): { third: Third; count: number; correct: number } | null {
  const order: Third[] = ["first", "middle", "last"];
  let best: { third: Third; count: number; correct: number } | null = null;
  for (const key of order) {
    const t = thirds[key];
    if (!t || t.count === 0) continue;
    if (!best || thirdAccuracy(t) > thirdAccuracy(best)) {
      best = { third: key, count: t.count, correct: t.correct };
    }
  }
  return best;
}

export function deriveRunInsights(args: {
  insights: ArenaRunInsights | null;
  /** Question id → prompt text, for naming the fastest/hardest question. */
  questionPrompts?: Map<string, string>;
  /** The challenge's published average accuracy, when known. */
  quizAvgAccuracy?: number | null;
}): RunInsight[] {
  const { insights, questionPrompts, quizAvgAccuracy } = args;
  if (!insights) return [];

  const out: RunInsight[] = [];
  const promptFor = (id: string | null | undefined) =>
    id ? (questionPrompts?.get(id) ?? null) : null;

  // 1. Strongest stretch of the run.
  const best = strongestThird(insights.thirds);
  if (best && best.count >= 2) {
    out.push({
      id: "strongest-stretch",
      label: "Strongest stretch",
      // Deliberately does not say "opening" or "closing" — see the note on
      // strongestThird: the thirds are not in question order.
      detail: `You got ${best.correct} of ${best.count} right in one stretch of the run.`,
      tone: "good",
    });
  }

  // 2. Fastest answer.
  if (insights.fastest_ms != null) {
    const prompt = promptFor(insights.fastest_question_id);
    out.push({
      id: "fastest-answer",
      label: "Fastest answer",
      detail: prompt
        ? `${formatResponseMs(insights.fastest_ms)} on "${prompt}".`
        : `${formatResponseMs(insights.fastest_ms)} — your quickest of the run.`,
      tone: "neutral",
    });
  }

  // 3. The question the room found hardest.
  //
  // `hardest_sample_size` is NOT a count — `get_arena_run_insights` already
  // applies `HAVING count(*) >= 3` before picking a hardest question and then
  // reports `CASE WHEN hardest_acc IS NULL THEN 0 ELSE 1 END`. It is a
  // "did the server find one?" flag, so the only correct client gate is >= 1.
  // The real sample size is not exposed to the client, so we never quote one.
  if (insights.hardest_sample_size >= 1 && insights.hardest_question_id) {
    const prompt = promptFor(insights.hardest_question_id);
    const pct = Math.round(insights.hardest_accuracy_pct);
    out.push({
      id: "hardest-question",
      label: "Toughest question",
      detail: prompt
        ? `Only ${pct}% of players got "${prompt}" right.`
        : `Only ${pct}% of players got this one right.`,
      tone: "hard",
    });
  }

  // 4. Comeback.
  if (COMEBACK_INSIGHT_ENABLED && insights.comeback) {
    out.push({
      id: "comeback",
      label: "Comeback finish",
      detail: COMEBACK_DETAIL,
      tone: "good",
    });
  }

  // 5. Accuracy measured against the challenge's own average.
  if (
    quizAvgAccuracy != null &&
    insights.total > 0 &&
    Number.isFinite(quizAvgAccuracy)
  ) {
    const runAccuracy = Math.round((insights.correct / insights.total) * 100);
    const delta = runAccuracy - Math.round(quizAvgAccuracy);
    if (Math.abs(delta) >= 5) {
      out.push({
        id: "accuracy-vs-field",
        label: delta > 0 ? "Above the average" : "Below the average",
        detail:
          delta > 0
            ? `You were ${delta} points more accurate than most players on this challenge.`
            : `${Math.abs(delta)} points under the average for this challenge — plenty of room to climb.`,
        tone: delta > 0 ? "good" : "neutral",
      });
    }
  }

  return out;
}

/**
 * One-line summary of this run's score against the player's previous best.
 * Returns null when there is nothing to compare against.
 */
export function personalBestVerdict(
  score: number,
  previousBest: number | null,
): { isNewBest: boolean; isFirstRun: boolean; delta: number } {
  if (previousBest == null) return { isNewBest: true, isFirstRun: true, delta: score };
  return { isNewBest: score > previousBest, isFirstRun: false, delta: score - previousBest };
}

/**
 * Whether a "new personal best" claim may be shown.
 *
 * `gradeSettled` must be true first. For a signed-in run the score on screen is
 * the local accumulator until the server re-grades it, and the two graders
 * genuinely differ (the server omits the streak multiplier for partial-credit
 * types and applies a tighter tolerance to Closest Number). Announcing a best
 * off the preview makes the badge appear and then retract, so the claim waits.
 */
export function canAnnounceBest(
  gradeSettled: boolean,
  score: number,
  previousBest: number | null,
): boolean {
  return gradeSettled && personalBestVerdict(score, previousBest).isNewBest;
}
