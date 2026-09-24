// Human-friendly terminology tests.
//
// Phase: UX/UI refinement — terminology audit.
//
// Locks the vocabulary the product is allowed to show. If a label regresses to
// jargon ("Session", "Participant", "is_playable") these fail.

import { describe, expect, test } from "bun:test";
import {
  ARENA_LENGTH_FILTERS,
  LOADING,
  answeredLabel,
  arenaAvailabilityLabel,
  arenaLengthBucket,
  arenaLengthLabel,
  arenaSortLabel,
  bestComparisonLabel,
  challengeMetaLine,
  difficultyLabel,
  gameState,
  playerCountLabel,
  playerCountShort,
  questionAvailabilityLabel,
  waitingLabel,
} from "@/lib/terminology";

/** Jargon that must never reach the UI, checked across every string below. */
const FORBIDDEN = [/\bsession\b/i, /\bparticipant\b/i, /\bis_playable\b/i, /\barena_enabled\b/i];

describe("gameState — host and player confidence", () => {
  test("lobby tells the host players are still joining", () => {
    const s = gameState("lobby");
    expect(s.label).toBe("Waiting for players");
    expect(s.tone).toBe("waiting");
  });

  test("a paused active game is distinct from a running one", () => {
    expect(gameState("active", false).label).toBe("In progress");
    expect(gameState("active", false).tone).toBe("live");
    expect(gameState("active", true).label).toBe("Paused");
    expect(gameState("active", true).tone).toBe("paused");
  });

  test("ended reads as finished", () => {
    const s = gameState("ended");
    expect(s.label).toBe("Finished");
    expect(s.tone).toBe("done");
  });

  test("an unrecognised status degrades instead of exposing the raw value", () => {
    const s = gameState("some_new_status");
    expect(s.label).toBe("Not started");
    expect(s.label).not.toContain("some_new_status");
  });

  test("every state explains what happens next, not just what it is", () => {
    const states = [
      gameState("lobby"),
      gameState("active"),
      gameState("active", true),
      gameState("ended"),
      gameState("mystery"),
    ];
    for (const s of states) {
      expect(s.label.length).toBeGreaterThan(0);
      // A detail line that is a full sentence, so the host always knows the next move.
      expect(s.detail.length).toBeGreaterThan(20);
      expect(s.detail.endsWith(".")).toBe(true);
    }
  });

  test("no state copy leaks internal terminology", () => {
    for (const s of [gameState("lobby"), gameState("active"), gameState("ended")]) {
      for (const bad of FORBIDDEN) {
        expect(s.label).not.toMatch(bad);
        expect(s.detail).not.toMatch(bad);
      }
    }
  });
});

describe("player counts", () => {
  test("the lobby headline reads naturally at any size", () => {
    expect(playerCountLabel(0)).toBe("0 players joined");
    expect(playerCountLabel(1)).toBe("1 player joined");
    expect(playerCountLabel(24)).toBe("24 players joined");
    expect(playerCountLabel(1000)).toBe("1,000 players joined");
  });

  test("singular and plural are both correct in the compact form", () => {
    expect(playerCountShort(1)).toBe("1 PLAYER");
    expect(playerCountShort(30)).toBe("30 PLAYERS");
    expect(playerCountShort(100)).toBe("100 PLAYERS");
  });

  test("round progress is phrased from the host's point of view", () => {
    expect(answeredLabel(3, 24)).toBe("3 of 24 answered");
    expect(waitingLabel(21)).toBe("21 still to answer");
    expect(waitingLabel(1)).toBe("1 still to answer");
    expect(waitingLabel(0)).toBe("Everyone answered");
    expect(waitingLabel(-1)).toBe("Everyone answered");
  });
});

describe("loading states", () => {
  test("the named states the acceptance criteria call out exist and are sentences", () => {
    expect(LOADING.joining).toBe("Joining game…");
    expect(LOADING.generating).toBe("Generating questions…");
    expect(LOADING.starting).toBe("Starting game…");
    expect(LOADING.loadingArena).toBe("Loading Arena…");
  });

  test("every loading label is present-progressive and never empty", () => {
    for (const value of Object.values(LOADING)) {
      expect(value.length).toBeGreaterThan(3);
      expect(value.endsWith("…")).toBe(true);
    }
  });
});

describe("availability copy — internal flags never surface", () => {
  test("a question's included state is described in the creator's language", () => {
    expect(questionAvailabilityLabel(true)).toBe("Included in the game");
    expect(questionAvailabilityLabel(false)).toContain("Excluded");
    for (const bad of FORBIDDEN) {
      expect(questionAvailabilityLabel(true)).not.toMatch(bad);
      expect(questionAvailabilityLabel(false)).not.toMatch(bad);
    }
  });

  test("Arena publication is described as availability, not as a flag", () => {
    expect(arenaAvailabilityLabel(true)).toBe("Available in Arena");
    expect(arenaAvailabilityLabel(false)).toBe("Not in Arena");
  });
});

describe("Arena vocabulary", () => {
  test("difficulty always reads as a word, never the raw enum", () => {
    expect(difficultyLabel("easy")).toBe("Easy");
    expect(difficultyLabel("medium")).toBe("Medium");
    expect(difficultyLabel("hard")).toBe("Hard");
    expect(difficultyLabel("EASY")).toBe("Easy");
    expect(difficultyLabel(null)).toBe("Mixed");
    expect(difficultyLabel("")).toBe("Mixed");
  });

  test("length buckets match the documented boundaries", () => {
    expect(arenaLengthBucket(1)).toBe("quick");
    expect(arenaLengthBucket(8)).toBe("quick");
    expect(arenaLengthBucket(9)).toBe("standard");
    expect(arenaLengthBucket(20)).toBe("standard");
    expect(arenaLengthBucket(21)).toBe("long");
    expect(arenaLengthBucket(90)).toBe("long");
  });

  test("a length reads as a friendly word plus the real duration", () => {
    expect(arenaLengthLabel(6)).toBe("Quick · ~6 min");
    expect(arenaLengthLabel(12)).toBe("Standard · ~12 min");
    expect(arenaLengthLabel(40)).toBe("Long · ~40 min");
  });

  test("length filter chips are human words that carry their own exact bound", () => {
    expect(ARENA_LENGTH_FILTERS.map((f) => f.label)).toEqual([
      "Any length",
      "Quick",
      "Standard",
      "Long",
    ]);
    const byValue = new Map(ARENA_LENGTH_FILTERS.map((f) => [f.value, f]));
    expect(byValue.get("any")!.max).toBeUndefined();
    expect(byValue.get("quick")!.max).toBe(8);
    expect(byValue.get("standard")!.max).toBe(20);
    expect(byValue.get("long")!.max).toBe(60);
    // The friendly word and the exact bound are never allowed to disagree.
    for (const f of ARENA_LENGTH_FILTERS) {
      if (f.max != null) expect(f.hint.toLowerCase()).toContain(String(f.max));
    }
  });

  test("sort options never expose the raw enum", () => {
    expect(arenaSortLabel("featured")).toBe("Recommended");
    expect(arenaSortLabel("most_played")).toBe("Most played");
    expect(arenaSortLabel("newest")).toBe("Newest");
    expect(arenaSortLabel("trending")).toBe("Trending");
    expect(arenaSortLabel(null)).toBe("Recommended");
    expect(arenaSortLabel(undefined)).toBe("Recommended");
  });

  test("a challenge metadata line stays readable at the singular", () => {
    expect(challengeMetaLine({ questionCount: 1, minutes: 6, playCount: 1 })).toBe(
      "1 question · ~6 min · 1 play",
    );
    expect(challengeMetaLine({ questionCount: 12, minutes: 6, playCount: 480 })).toBe(
      "12 questions · ~6 min · 480 plays",
    );
    expect(challengeMetaLine({ questionCount: 5, minutes: 3 })).toBe("5 questions · ~3 min");
    expect(challengeMetaLine({ questionCount: 5, minutes: 3, playCount: 0 })).toBe(
      "5 questions · ~3 min · 0 plays",
    );
  });
});

describe("personal-best framing", () => {
  test("an improvement is shown as a gain", () => {
    expect(bestComparisonLabel(8420, 7680)).toBe("+740 from your previous best");
  });

  test("a first run is not framed as a failure", () => {
    expect(bestComparisonLabel(900, null)).toBe("Your first score on this challenge");
  });

  test("matching the previous best is stated plainly", () => {
    expect(bestComparisonLabel(700, 700)).toBe("Exactly matched your previous best");
  });

  test("falling short is described, not punished", () => {
    expect(bestComparisonLabel(500, 900)).toBe("400 short of your previous best");
  });

  test("numbers are thousands-separated", () => {
    expect(bestComparisonLabel(15000, 12000)).toBe("+3,000 from your previous best");
  });
});
