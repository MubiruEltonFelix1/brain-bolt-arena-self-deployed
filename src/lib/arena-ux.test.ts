// Arena completion-screen + discovery logic tests.
//
// Phase: UX/UI refinement — Arena result screen, personal best, Next Bolt.
//
// Every insight asserted here is derived from data the server already returned
// for the run. There is no inference involved, so these tests pin both what is
// claimed AND what is deliberately not claimed when the data is too thin.

import { describe, expect, test } from "bun:test";
import {
  COMEBACK_DETAIL,
  COMEBACK_INSIGHT_ENABLED,
  canAnnounceBest,
  deriveRunInsights,
  formatResponseMs,
  personalBestVerdict,
  strongestThird,
} from "@/lib/arena-insights";
import { pickNextBolt, type ArenaListItem, type ArenaRunInsights } from "@/lib/arena";

function insights(overrides: Partial<ArenaRunInsights> = {}): ArenaRunInsights {
  return {
    total: 10,
    correct: 7,
    fastest_ms: null,
    fastest_question_id: null,
    thirds: {
      first: { count: 0, correct: 0 },
      middle: { count: 0, correct: 0 },
      last: { count: 0, correct: 0 },
    },
    comeback: false,
    hardest_question_id: null,
    hardest_accuracy_pct: 0,
    hardest_sample_size: 0,
    avg_response_ms: null,
    ...overrides,
  };
}

describe("formatResponseMs", () => {
  test("formats a response time to one decimal place", () => {
    expect(formatResponseMs(3200)).toBe("3.2s");
    expect(formatResponseMs(450)).toBe("0.5s");
    expect(formatResponseMs(0)).toBe("0.0s");
  });

  test("never prints NaN or a negative duration", () => {
    expect(formatResponseMs(Number.NaN)).toBe("—");
    expect(formatResponseMs(-5)).toBe("—");
    expect(formatResponseMs(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("strongestThird", () => {
  test("picks the highest-accuracy third", () => {
    const t = strongestThird({
      first: { count: 2, correct: 1 },
      middle: { count: 2, correct: 2 },
      last: { count: 2, correct: 0 },
    });
    expect(t?.third).toBe("middle");
  });

  test("a tie resolves to the earliest third, deterministically", () => {
    const t = strongestThird({
      first: { count: 3, correct: 2 },
      middle: { count: 3, correct: 2 },
      last: { count: 3, correct: 0 },
    });
    expect(t?.third).toBe("first");
  });

  test("thirds with no graded answers are skipped", () => {
    const t = strongestThird({
      first: { count: 0, correct: 0 },
      middle: { count: 0, correct: 0 },
      last: { count: 4, correct: 1 },
    });
    expect(t?.third).toBe("last");
  });

  test("returns null when nothing was graded", () => {
    expect(
      strongestThird({
        first: { count: 0, correct: 0 },
        middle: { count: 0, correct: 0 },
        last: { count: 0, correct: 0 },
      }),
    ).toBeNull();
  });
});

describe("deriveRunInsights — what is claimed", () => {
  test("no insights payload produces no insights, not an empty card", () => {
    expect(deriveRunInsights({ insights: null })).toEqual([]);
  });

  test("a clearly strongest stretch is called out", () => {
    const out = deriveRunInsights({
      insights: insights({
        thirds: {
          first: { count: 3, correct: 3 },
          middle: { count: 3, correct: 1 },
          last: { count: 3, correct: 0 },
        },
      }),
    });
    const stretch = out.find((i) => i.id === "strongest-stretch");
    expect(stretch).toBeTruthy();
    expect(stretch!.label).toBe("Strongest stretch");
    expect(stretch!.detail).toBe("You got 3 of 3 right in one stretch of the run.");
    expect(stretch!.tone).toBe("good");
  });

  test("no insight claims a position in the run", () => {
    // get_arena_run_insights builds the thirds with
    // row_number() OVER (ORDER BY question_id), and question_id is a uuid — so
    // "first" is not "the opening questions". Nothing may be described by its
    // position.
    const out = deriveRunInsights({
      insights: insights({
        thirds: {
          first: { count: 3, correct: 1 },
          middle: { count: 3, correct: 3 },
          last: { count: 3, correct: 0 },
        },
      }),
    });
    for (const i of out) {
      expect(i.detail).not.toMatch(/opening|closing|final questions|first few|last few/i);
    }
  });

  test("a stretch of a single answer is not enough to call it a strength", () => {
    const out = deriveRunInsights({
      insights: insights({ thirds: { first: { count: 1, correct: 1 }, middle: { count: 0, correct: 0 }, last: { count: 0, correct: 0 } } }),
    });
    expect(out.find((i) => i.id === "strongest-stretch")).toBeUndefined();
  });

  test("the fastest answer is named when the prompt is known", () => {
    const prompts = new Map([["q1", "Capital of Kenya?"]]);
    const out = deriveRunInsights({
      insights: insights({ fastest_ms: 2100, fastest_question_id: "q1" }),
      questionPrompts: prompts,
    });
    const fastest = out.find((i) => i.id === "fastest-answer");
    expect(fastest!.detail).toBe('2.1s on "Capital of Kenya?".');
  });

  test("the fastest answer still reads well when the prompt is unknown", () => {
    const out = deriveRunInsights({
      insights: insights({ fastest_ms: 2100, fastest_question_id: "gone" }),
    });
    const fastest = out.find((i) => i.id === "fastest-answer");
    expect(fastest!.detail).toBe("2.1s — your quickest of the run.");
  });

  test("no fastest answer on record means no fastest-answer claim", () => {
    const out = deriveRunInsights({ insights: insights({ fastest_ms: null }) });
    expect(out.find((i) => i.id === "fastest-answer")).toBeUndefined();
  });

  test("the toughest question is reported once the server has found one", () => {
    const out = deriveRunInsights({
      insights: insights({
        hardest_question_id: "q9",
        hardest_accuracy_pct: 12.4,
        hardest_sample_size: 1,
      }),
      questionPrompts: new Map([["q9", "Which year?"]]),
    });
    const hardest = out.find((i) => i.id === "hardest-question");
    expect(hardest!.detail).toBe('Only 12% of players got "Which year?" right.');
    expect(hardest!.tone).toBe("hard");
  });

  test("hardest_sample_size is a found-one flag, not a count", () => {
    // Regression guard. get_arena_run_insights applies `HAVING count(*) >= 3`
    // itself and then reports 1 when a hardest question was chosen, 0 when it
    // was not. A client-side `>= 2` gate would make this insight unreachable.
    for (const flag of [1, 3, 8]) {
      const out = deriveRunInsights({
        insights: insights({
          hardest_question_id: "q9",
          hardest_accuracy_pct: 20,
          hardest_sample_size: flag,
        }),
      });
      expect(out.find((i) => i.id === "hardest-question")).toBeTruthy();
    }
  });

  test("flag 0 means the server found no hardest question, so nothing is claimed", () => {
    const out = deriveRunInsights({
      insights: insights({
        hardest_question_id: null,
        hardest_accuracy_pct: 0,
        hardest_sample_size: 0,
      }),
    });
    expect(out.find((i) => i.id === "hardest-question")).toBeUndefined();
  });

  test("a found-flag with no question id is not reported either", () => {
    const out = deriveRunInsights({
      insights: insights({
        hardest_question_id: null,
        hardest_accuracy_pct: 30,
        hardest_sample_size: 1,
      }),
    });
    expect(out.find((i) => i.id === "hardest-question")).toBeUndefined();
  });

  test("no sample size is ever quoted to the player — only the accuracy", () => {
    const out = deriveRunInsights({
      insights: insights({
        hardest_question_id: "q9",
        hardest_accuracy_pct: 25,
        hardest_sample_size: 1,
      }),
    });
    const hardest = out.find((i) => i.id === "hardest-question");
    expect(hardest!.detail).not.toMatch(/\bplayers (answered|tried)\b/);
    expect(hardest!.detail).toContain("25%");
  });

  test("the comeback insight is deliberately disabled until the SQL orders the thirds", () => {
    // get_arena_run_insights builds the thirds with
    // row_number() OVER (ORDER BY question_id) and question_id is a uuid, so
    // `comeback` is computed from an arbitrary grouping. Rendering it would put
    // a random claim in front of the player. This test is the reminder to
    // re-enable it in the same change that fixes the SQL ordering.
    expect(COMEBACK_INSIGHT_ENABLED).toBe(false);
    expect(
      deriveRunInsights({ insights: insights({ comeback: true }) }).find(
        (i) => i.id === "comeback",
      ),
    ).toBeUndefined();
  });

  test("the comeback copy is position-free even while disabled", () => {
    // Asserted on the exported string, not on the rendered insight, so the
    // wording cannot silently regress to "closing questions" while the insight
    // is switched off.
    expect(COMEBACK_DETAIL).not.toMatch(/opening|closing|final|first|last/i);
    expect(COMEBACK_DETAIL.length).toBeGreaterThan(20);
  });

  test("accuracy is compared against the challenge average once the gap is real", () => {
    const out = deriveRunInsights({
      insights: insights({ total: 10, correct: 8 }),
      quizAvgAccuracy: 60,
    });
    const vs = out.find((i) => i.id === "accuracy-vs-field");
    expect(vs!.label).toBe("Above the average");
    expect(vs!.tone).toBe("good");
  });

  test("being under the average is stated without judgement", () => {
    const out = deriveRunInsights({
      insights: insights({ total: 10, correct: 5 }),
      quizAvgAccuracy: 70,
    });
    const vs = out.find((i) => i.id === "accuracy-vs-field");
    expect(vs!.label).toBe("Below the average");
    expect(vs!.tone).toBe("neutral");
  });

  test("a difference smaller than the noise floor is not reported", () => {
    const out = deriveRunInsights({
      insights: insights({ total: 10, correct: 6 }),
      quizAvgAccuracy: 62,
    });
    expect(out.find((i) => i.id === "accuracy-vs-field")).toBeUndefined();
  });

  test("no challenge average means no comparison is invented", () => {
    const out = deriveRunInsights({ insights: insights({ total: 10, correct: 10 }) });
    expect(out.find((i) => i.id === "accuracy-vs-field")).toBeUndefined();
  });

  test("every insight is complete and uniquely identified", () => {
    const out = deriveRunInsights({
      insights: insights({
        thirds: {
          first: { count: 3, correct: 3 },
          middle: { count: 3, correct: 2 },
          last: { count: 3, correct: 1 },
        },
        fastest_ms: 1800,
        fastest_question_id: "q1",
        comeback: true,
        hardest_question_id: "q4",
        hardest_accuracy_pct: 20,
        hardest_sample_size: 1,
        avg_response_ms: 4200,
      }),
      questionPrompts: new Map([
        ["q1", "First"],
        ["q4", "Fourth"],
      ]),
      quizAvgAccuracy: 40,
    });
    expect(out.length).toBeGreaterThanOrEqual(4);
    for (const i of out) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.detail.length).toBeGreaterThan(10);
      expect(["good", "neutral", "hard"]).toContain(i.tone);
    }
    expect(new Set(out.map((i) => i.id)).size).toBe(out.length);
  });
});

describe("canAnnounceBest — the badge must not retract", () => {
  test("a best is not announced while the grade is still settling", () => {
    // The local preview can exceed the previous best and then be revised down by
    // the server, so the claim waits. This is the regression guard for the
    // badge that appeared and then vanished.
    expect(canAnnounceBest(false, 1300, 1000)).toBe(false);
  });

  test("once the grade settles a genuine best is announced", () => {
    expect(canAnnounceBest(true, 1300, 1000)).toBe(true);
  });

  test("a settled run that did not beat the best announces nothing", () => {
    expect(canAnnounceBest(true, 1000, 1000)).toBe(false);
    expect(canAnnounceBest(true, 900, 1000)).toBe(false);
  });

  test("a settled first run is announced", () => {
    expect(canAnnounceBest(true, 0, null)).toBe(true);
  });

  test("the pre-grade preview never drives the verdict, even on a first run", () => {
    expect(canAnnounceBest(false, 5000, null)).toBe(false);
  });
});

describe("personalBestVerdict", () => {
  test("a first run is a new best by definition, with no comparison", () => {
    expect(personalBestVerdict(1200, null)).toEqual({
      isNewBest: true,
      isFirstRun: true,
      delta: 1200,
    });
  });

  test("beating the previous best reports the gain", () => {
    expect(personalBestVerdict(8420, 7680)).toEqual({
      isNewBest: true,
      isFirstRun: false,
      delta: 740,
    });
  });

  test("equalling the previous best is not an improvement", () => {
    const v = personalBestVerdict(700, 700);
    expect(v.isNewBest).toBe(false);
    expect(v.delta).toBe(0);
  });

  test("falling short reports a negative delta", () => {
    expect(personalBestVerdict(500, 900)).toEqual({
      isNewBest: false,
      isFirstRun: false,
      delta: -400,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Next Bolt                                                           */
/* ------------------------------------------------------------------ */

function item(id: string, title = id): ArenaListItem {
  return {
    id,
    title,
    description: null,
    difficulty: "medium",
    estimated_duration_minutes: 5,
    play_count: 0,
    time_per_question: 20,
    arena_featured_rank: null,
    last_updated: "2026-01-01T00:00:00.000Z",
    question_count: 5,
    avg_accuracy: null,
    creator_name: null,
    arena_category: null,
    tags: "",
    trend_score: 0,
    is_featured: false,
  };
}

describe("pickNextBolt", () => {
  test("prefers a challenge the player has not finished yet", () => {
    const list = [item("a"), item("b"), item("c")];
    expect(pickNextBolt(list, "a", ["b"])!.id).toBe("c");
  });

  test("never points back at the challenge just played", () => {
    const list = [item("a"), item("b")];
    expect(pickNextBolt(list, "a", [])!.id).toBe("b");
  });

  test("falls back to a repeat rather than showing nothing", () => {
    const list = [item("a"), item("b")];
    expect(pickNextBolt(list, "a", ["b"])!.id).toBe("b");
  });

  test("accepts a Set as well as an array of played ids", () => {
    const list = [item("a"), item("b"), item("c")];
    expect(pickNextBolt(list, "a", new Set(["b"]))!.id).toBe("c");
  });

  test("a catalog containing only the current challenge has no next target", () => {
    expect(pickNextBolt([item("a")], "a")).toBeNull();
  });

  test("an empty catalog has no next target", () => {
    expect(pickNextBolt([], "a")).toBeNull();
  });

  test("is deterministic — the same inputs always give the same target", () => {
    const list = [item("a"), item("b"), item("c")];
    expect(pickNextBolt(list, "a", [])!.id).toBe(pickNextBolt(list, "a", [])!.id);
  });
});
