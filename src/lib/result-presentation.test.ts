// The finished-game screen must not invent a result.
//
// Two failure modes this guards against, both of which the previous inline
// computation allowed:
//   1. Reporting "unmeasured" as "0". A player who answered nothing got an
//      Accuracy of 0%, which reads as "wrong every time" rather than "there was
//      nothing to be right about".
//   2. Fabricating a multiplayer result for a solo Arena run — rank 1 of 1 and
//      a one-person podium. That is the single most misleading thing this
//      screen could show.
//
// And the share payload must be built from a whitelist, so no claim token,
// internal id or rival's name can reach it as the payload grows.

import { describe, expect, test } from "bun:test";
import {
  presentArena,
  presentHosted,
  shareMessage,
  UNAVAILABLE,
  type ScoredAnswer,
} from "@/lib/result-presentation";
import { rankPlayers } from "@/lib/ranking";

const at = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-01T10:00:00.000Z");

const players = (...specs: Array<[string, string, number, number]>) =>
  rankPlayers(
    specs.map(([id, nickname, score, offset]) => ({
      id,
      nickname,
      score,
      avatar_id: null,
      joined_at: at(T0 + offset),
    })),
  );

const MC = { id: "q1", question_type: "mcq" };
const MC2 = { id: "q2", question_type: "mcq" };
const FB = { id: "f1", question_type: "feedback" };

const answer = (question_id: string, is_correct: boolean, response_ms?: number): ScoredAnswer => ({
  question_id,
  is_correct,
  response_ms,
});

const hosted = (over: Partial<Parameters<typeof presentHosted>[0]> = {}) =>
  presentHosted({
    mode: "hosted",
    quizTitle: "Flags of the World",
    completed: true,
    participants: players(["a", "Ada", 900, 0], ["b", "Ben", 700, 1000], ["c", "Cal", 500, 2000]),
    myId: "a",
    myRank: 1,
    questions: [MC, MC2],
    answers: [answer("q1", true, 3000), answer("q2", true, 5000)],
    orderedIds: ["q1", "q2"],
    ...over,
  });

describe("presentHosted", () => {
  test("reports the player's own score, rank and placing", () => {
    const p = hosted();
    expect(p.score).toEqual({ available: true, value: 900 });
    expect(p.rank).toEqual({ available: true, value: 1 });
    expect(p.totalPlayers).toEqual({ available: true, value: 3 });
    expect(p.nickname).toBe("Ada");
    expect(p.onPodium).toBe(true);
  });

  test("accuracy is undefined when nothing scored was attempted", () => {
    const p = hosted({ answers: [], orderedIds: ["q1", "q2"] });
    expect(p.accuracy).toEqual(UNAVAILABLE);
    expect(p.questionsAnswered).toEqual({ available: true, value: 0 });
  });

  test("accuracy is a real zero when attempted and wrong", () => {
    // The distinction the whole module exists for.
    const p = hosted({ answers: [answer("q1", false, 3000)], orderedIds: ["q1", "q2"] });
    expect(p.accuracy).toEqual({ available: true, value: 0 });
    expect(p.correct).toEqual({ available: true, value: 0 });
  });

  test("feedback questions never count towards accuracy", () => {
    const p = hosted({
      questions: [MC, MC2, FB],
      answers: [answer("q1", true, 1000), answer("f1", false, 2000)],
      orderedIds: ["q1", "f1"],
    });
    // One scored question, one correct. A submitted feedback answer must not
    // drag accuracy to 50%.
    expect(p.accuracy).toEqual({ available: true, value: 100 });
    expect(p.questionsAnswered).toEqual({ available: true, value: 2 });
  });

  test("average response time is unavailable when no answer carried a timing", () => {
    expect(hosted({ answers: [answer("q1", true)], orderedIds: ["q1"] }).avgResponseMs).toEqual(UNAVAILABLE);
    expect(hosted().avgResponseMs).toEqual({ available: true, value: 4000 });
  });

  test("the podium is top three BY RANK, and never includes a 4th", () => {
    const p = hosted({ myId: "c", myRank: 3 });
    expect(p.podium.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(p.onPodium).toBe(true);
  });

  test("a player outside the top three is off the podium but still ranked", () => {
    const four = players(
      ["a", "Ada", 900, 0],
      ["b", "Ben", 700, 1000],
      ["c", "Cal", 500, 2000],
      ["d", "Dee", 100, 3000],
    );
    const p = hosted({ participants: four, myId: "d", myRank: 4 });
    expect(p.onPodium).toBe(false);
    expect(p.rank).toEqual({ available: true, value: 4 });
    expect(p.podium).toHaveLength(3);
    expect(p.podium.some((e) => e.id === "d")).toBe(false);
  });

  test("a two-way tie for first shares the podium rather than awarding a false 2nd", () => {
    const tied = rankPlayers([
      { id: "a", nickname: "Ada", score: 500, avatar_id: null, joined_at: at(T0) },
      { id: "b", nickname: "Ben", score: 500, avatar_id: null, joined_at: at(T0) },
      { id: "c", nickname: "Cal", score: 100, avatar_id: null, joined_at: at(T0) },
    ]);
    const p = hosted({ participants: tied, myId: "a", myRank: 1 });
    // rank() shares 1st and skips: 1, 1, 3. Nobody is shown a 2nd place the
    // server never awarded, and the third player is genuinely third.
    expect(p.podium.map((e) => e.rank)).toEqual([1, 1, 3]);
    expect(p.podium.map((e) => e.nickname)).toEqual(["Ada", "Ben", "Cal"]);
  });

  test("a tie for second leaves no third place, and nobody is dressed as third", () => {
    // 1, 2, 2, 4 -> rank 3 does not exist.
    const tied = rankPlayers([
      { id: "a", nickname: "Ada", score: 400, avatar_id: null, joined_at: at(T0) },
      { id: "b", nickname: "Ben", score: 300, avatar_id: null, joined_at: at(T0) },
      { id: "c", nickname: "Cal", score: 300, avatar_id: null, joined_at: at(T0) },
      { id: "d", nickname: "Dee", score: 100, avatar_id: null, joined_at: at(T0) },
    ]);
    const p = hosted({ participants: tied, myId: "a", myRank: 1 });
    expect(p.podium.map((e) => e.rank)).toEqual([1, 2, 2]);
    expect(p.podium.some((e) => e.rank === 3)).toBe(false);
  });

  test("a solo game still ranks, with a one-player podium", () => {
    const p = hosted({
      participants: players(["solo", "Only", 10, 0]),
      myId: "solo",
      myRank: 1,
    });
    expect(p.rank).toEqual({ available: true, value: 1 });
    expect(p.totalPlayers).toEqual({ available: true, value: 1 });
    expect(p.podium).toHaveLength(1);
  });

  test("longest streak walks question order, not answer order", () => {
    const p = hosted({
      questions: [MC, MC2, { id: "q3", question_type: "mcq" }],
      answers: [answer("q1", true, 1000), answer("q2", false, 1000), answer("q3", true, 1000)],
      orderedIds: ["q1", "q2", "q3"],
    });
    expect(p.longestStreak).toEqual({ available: true, value: 1 });
  });

  test("a feedback question does not break a streak", () => {
    // The host's question_order can interleave a feedback slide. It is never
    // correct and never breaks a run, so a player who answered two in a row
    // around it still has a streak of 2 - not 1.
    const p = hosted({
      questions: [MC, MC2, FB],
      answers: [answer("q1", true, 1000), answer("q2", true, 1000), answer("f1", false, 1000)],
      orderedIds: ["q1", "f1", "q2"],
    });
    expect(p.longestStreak).toEqual({ available: true, value: 2 });
  });

  test("a seat missing from the list reports NO score, not a zero", () => {
    // Reachable when a participant row is deleted under a cached finished
    // session, or the scoreboard read has not landed. Reporting 0 would claim
    // the player scored nothing, which is a different and wrong claim.
    const p = hosted({ participants: players(["a", "Ada", 900, 0]), myId: "ghost", myRank: 0 });
    expect(p.score).toEqual(UNAVAILABLE);
    expect(p.rank).toEqual(UNAVAILABLE);
    expect(p.nickname).toBe("Player");
  });
});

describe("presentArena", () => {
  const arena = (over: Partial<Parameters<typeof presentArena>[0]> = {}) =>
    presentArena({
      mode: "arena",
      quizTitle: "Capital Cities",
      completed: true,
      nickname: "Solo",
      avatarId: "fox",
      score: 4200,
      questions: [MC, MC2],
      answers: [answer("q1", true, 2000), answer("q2", true, 4000)],
      orderedIds: ["q1", "q2"],
      ...over,
    });

  test("never fabricates a multiplayer podium", () => {
    const p = arena();
    expect(p.podium).toEqual([]);
    expect(p.onPodium).toBe(false);
  });

  test("rank and total players are unavailable, not 1 and 1", () => {
    const p = arena();
    expect(p.rank).toEqual(UNAVAILABLE);
    expect(p.totalPlayers).toEqual(UNAVAILABLE);
  });

  test("still reports real personal performance", () => {
    const p = arena();
    expect(p.score).toEqual({ available: true, value: 4200 });
    expect(p.accuracy).toEqual({ available: true, value: 100 });
    expect(p.avgResponseMs).toEqual({ available: true, value: 3000 });
  });

  test("a zero-score run is a real zero, not an unavailable metric", () => {
    const p = arena({ score: 0, answers: [], orderedIds: ["q1", "q2"] });
    expect(p.score).toEqual({ available: true, value: 0 });
    expect(p.accuracy).toEqual(UNAVAILABLE);
  });
});

describe("shareMessage", () => {
  test("includes placing for a ranked hosted result", () => {
    const msg = shareMessage(hosted());
    expect(msg).toContain("#1 of 3");
    expect(msg).toContain("900");
    expect(msg).toContain("Flags of the World");
  });

  test("omits placing for a solo Arena run", () => {
    const msg = shareMessage(
      presentArena({
        mode: "arena",
        quizTitle: "Capital Cities",
        completed: true,
        nickname: "Solo",
        avatarId: null,
        score: 4200,
        questions: [MC],
        answers: [answer("q1", true, 1000)],
        orderedIds: ["q1"],
      }),
    );
    expect(msg).not.toMatch(/#[0-9]+ of/);
    expect(msg).toContain("4,200");
  });

  test("omits accuracy entirely when it was never measured", () => {
    const msg = shareMessage(hosted({ answers: [], orderedIds: [] }));
    expect(msg).not.toContain("accuracy");
    expect(msg).not.toContain("%");
  });

  test("carries no token, claim secret, internal id or rival name", () => {
    const msg = shareMessage(hosted({ myId: "a", myRank: 1 }));
    // The other two players are on the podium but must never be named.
    expect(msg).not.toContain("Ben");
    expect(msg).not.toContain("Cal");
    // And nothing that looks like claim material or a raw uuid.
    expect(msg).not.toMatch(/[0-9a-f]{16,}/i);
    expect(msg).not.toMatch(/token|claim|secret/i);
  });

  test("falls back to a generic prompt when the title is unknown", () => {
    const msg = shareMessage(hosted({ quizTitle: "Quiz" }));
    expect(msg).toContain("Can you beat me?");
    expect(msg).not.toContain('""');
  });

  test("never claims a score of zero when the score is unavailable", () => {
    const msg = shareMessage(hosted({ participants: players(["a", "Ada", 900, 0]), myId: "ghost", myRank: 0 }));
    expect(msg).not.toContain("0 points");
    expect(msg).not.toMatch(/#[0-9]+ of/);
    expect(msg).toContain("finished a game");
  });
});
