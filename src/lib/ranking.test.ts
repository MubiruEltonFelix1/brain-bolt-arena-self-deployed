// The results screen must show the SAME rank the database stored.
//
// The bug: rank came from `participants.findIndex(...) + 1` over a list
// ordered by `score` descending only. With no tie-break in the ORDER BY,
// Postgres may return tied rows in any order, so a player's displayed position
// could disagree with `competition_results.final_rank`. The podium was
// `participants.slice(0, 3)` on top of that, with no notion of ties at all.
//
// The rule under test: replicate `rank() OVER (ORDER BY score DESC,
// joined_at ASC)` exactly, including `rank()`'s skip-after-tie behaviour, so
// the screen can never imply a placement the server did not record.

import { describe, expect, test } from "bun:test";
import { compareForRanking, rankPlayers, standingsFor } from "@/lib/ranking";

type P = { id: string; score: number; joined_at: string };

const at = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-01T10:00:00.000Z");

const p = (id: string, score: number, offsetMs = 0): P => ({
  id,
  score,
  joined_at: at(T0 + offsetMs),
});

describe("rankPlayers", () => {
  test("orders by score descending", () => {
    const ranked = rankPlayers([p("a", 10, 0), p("b", 30, 10), p("c", 20, 20)]);
    expect(ranked.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  test("breaks a score tie by joined_at ascending, matching the server", () => {
    // Same score: the earlier join wins, exactly like `joined_at ASC`.
    const ranked = rankPlayers([p("late", 50, 5000), p("early", 50, 1000)]);
    expect(ranked.map((r) => r.id)).toEqual(["early", "late"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  test("an exact tie shares a rank and the next rank SKIPS (rank(), not dense_rank())", () => {
    // A real tie needs an identical score AND an identical join instant, since
    // joined_at is the server's tie-break. rank() then gives 1, 2, 2, 4.
    const same = at(T0);
    const ranked = rankPlayers([
      { id: "d", score: 10, joined_at: same },
      { id: "b", score: 30, joined_at: same },
      { id: "c", score: 20, joined_at: same },
      { id: "a", score: 20, joined_at: same },
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
  });

  test("equal scores with DIFFERENT join times are not a tie", () => {
    // joined_at is the tie-break, so these are 2nd and 3rd, not joint second.
    const ranked = rankPlayers([p("late", 20, 5000), p("early", 20, 1000)]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  test("is deterministic for identical input", () => {
    const input = [p("x", 5, 0), p("y", 5, 0), p("z", 5, 0)];
    expect(rankPlayers(input).map((r) => r.id)).toEqual(rankPlayers(input).map((r) => r.id));
  });

  test("does not mutate the caller's array", () => {
    const input = [p("a", 10, 0), p("b", 30, 10)];
    rankPlayers(input);
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("an unparseable joined_at loses the tie instead of winning it", () => {
    const ranked = rankPlayers([p("bad", 50, 0), { id: "good", score: 50, joined_at: "nonsense" }]);
    expect(ranked[0].id).toBe("bad");
  });

  test("an empty game ranks nothing rather than throwing", () => {
    expect(rankPlayers([])).toEqual([]);
  });
});

describe("standingsFor", () => {
  test("reports the player's own rank and total", () => {
    const s = standingsFor([p("a", 10, 0), p("b", 30, 10), p("c", 20, 20)], "c");
    expect(s.me?.rank).toBe(2);
    expect(s.total).toBe(3);
  });

  test("returns null for a player who is not in the list", () => {
    const s = standingsFor([p("a", 10, 0)], "nobody");
    expect(s.me).toBeNull();
  });

  test("podium is the top three BY RANK, not the first three rows", () => {
    // 1, 2, 2, 4 -> rank 3 does not exist, so the podium holds three players
    // but no one is shown in "3rd". Slicing rows would have dressed the
    // 4th-place player as third.
    const same = at(T0);
    const s = standingsFor(
      [
        { id: "a", score: 40, joined_at: same },
        { id: "b", score: 30, joined_at: same },
        { id: "c", score: 30, joined_at: same },
        { id: "d", score: 10, joined_at: same },
      ],
      "d",
    );    expect(s.podium.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(s.podium.map((x) => x.rank)).toEqual([1, 2, 2]);
    expect(s.me?.rank).toBe(4);
  });

  test("fewer than three players yields only the players that exist", () => {
    expect(standingsFor([p("a", 10, 0)], "a").podium.map((x) => x.id)).toEqual(["a"]);
    expect(standingsFor([p("a", 10, 0), p("b", 5, 10)], "a").podium).toHaveLength(2);
  });

  test("a solo run has a rank of 1 and a one-player podium", () => {
    const s = standingsFor([p("solo", 900, 0)], "solo");
    expect(s.me?.rank).toBe(1);
    expect(s.total).toBe(1);
  });
});

describe("compareForRanking", () => {
  test("higher score sorts first", () => {
    expect(compareForRanking(p("a", 10, 0), p("b", 20, 0))).toBeGreaterThan(0);
  });

  test("equal inputs compare equal", () => {
    const x = { id: "same", score: 10, joined_at: at(T0) };
    expect(compareForRanking(x, { ...x })).toBe(0);
  });
});
