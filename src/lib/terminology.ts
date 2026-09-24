// Human-friendly terminology.
//
// One place that turns internal state into the words a player or host actually
// reads. Nothing here changes behaviour — it only decides what a concept is
// called. Rules of thumb, in priority order:
//
//   1. Never show a database value, an enum, an RPC name or a status code.
//   2. Prefer the player's language: "Game", "Player", "Round" — not
//      "Session", "Participant", "Question index".
//   3. Say what state we are in AND what happens next.
//
// The raw values stay in the database and in the branching logic; only the
// presentation crosses this boundary.

/* ------------------------------------------------------------------ */
/* Live game state                                                     */
/* ------------------------------------------------------------------ */

export type LiveGameStatus = "lobby" | "active" | "ended" | string;

export type GameStateTone = "waiting" | "live" | "paused" | "done";

export type GameStateCopy = {
  /** Short label for a status badge. */
  label: string;
  /** One line telling the host what is happening and what comes next. */
  detail: string;
  tone: GameStateTone;
};

/**
 * The single source for "what state is this game in". `paused` overrides the
 * active state — a paused game is *not* the same as a running one and the host
 * must be able to tell them apart at a glance.
 */
export function gameState(status: LiveGameStatus, paused = false): GameStateCopy {
  if (status === "lobby") {
    return {
      label: "Waiting for players",
      detail: "Players are joining now. Start when you're ready.",
      tone: "waiting",
    };
  }
  if (status === "active" && paused) {
    return {
      label: "Paused",
      detail: "Everyone is frozen. Resume to carry on from where you stopped.",
      tone: "paused",
    };
  }
  if (status === "active") {
    return {
      label: "In progress",
      detail: "The game is live. Players are answering right now.",
      tone: "live",
    };
  }
  if (status === "ended") {
    return {
      label: "Finished",
      detail: "Final scores are in. Everyone can see the results.",
      tone: "done",
    };
  }
  return {
    label: "Not started",
    detail: "This game hasn't started yet.",
    tone: "waiting",
  };
}

/* ------------------------------------------------------------------ */
/* Players                                                             */
/* ------------------------------------------------------------------ */

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** e.g. "24 players joined" — the lobby headline count. */
export function playerCountLabel(n: number): string {
  return `${n.toLocaleString()} ${plural(n, "player", "players")} joined`;
}

/** e.g. "24 PLAYERS" — compact, for badges and control bars. */
export function playerCountShort(n: number): string {
  return `${n.toLocaleString()} ${plural(n, "PLAYER", "PLAYERS")}`;
}

/** e.g. "3 of 24 answered" — live progress in a round. */
export function answeredLabel(answered: number, total: number): string {
  return `${answered} of ${total} answered`;
}

/** e.g. "6 waiting" — who we are still waiting on. */
export function waitingLabel(remaining: number): string {
  if (remaining <= 0) return "Everyone answered";
  return `${remaining} still to answer`;
}

/* ------------------------------------------------------------------ */
/* Actions & async states                                              */
/* ------------------------------------------------------------------ */

/**
 * Present-progressive copy for an in-flight action. Every button that kicks
 * off async work should be able to say what it is doing — an unlabelled
 * spinner is a dead end for the person waiting.
 */
export const LOADING = {
  joining: "Joining game…",
  generating: "Generating questions…",
  starting: "Starting game…",
  loadingArena: "Loading Arena…",
  loadingChallenge: "Loading challenge…",
  loadingGame: "Loading game…",
  saving: "Saving…",
  publishing: "Publishing…",
  searching: "Searching…",
  submitting: "Sending your answers…",
  connecting: "Connecting…",
} as const;

/* ------------------------------------------------------------------ */
/* Availability (never expose `is_playable` / `arena_enabled`)          */
/* ------------------------------------------------------------------ */

/** A question's included/excluded state, in the creator's language. */
export function questionAvailabilityLabel(included: boolean): string {
  return included ? "Included in the game" : "Excluded — stored but never asked";
}

/** A quiz's Arena publication state, in the creator's language. */
export function arenaAvailabilityLabel(availableInArena: boolean): string {
  return availableInArena ? "Available in Arena" : "Not in Arena";
}

/* ------------------------------------------------------------------ */
/* Arena discovery vocabulary                                          */
/* ------------------------------------------------------------------ */

/** Difficulty as a plain word. Never the raw `easy` / `medium` / `hard`. */
export function difficultyLabel(difficulty?: string | null): string {
  switch ((difficulty ?? "").trim().toLowerCase()) {
    case "easy":
      return "Easy";
    case "hard":
      return "Hard";
    case "medium":
      return "Medium";
    default:
      return "Mixed";
  }
}

export type ArenaLengthBucket = "quick" | "standard" | "long";

/** Bucket a duration into the three length bands players choose between. */
export function arenaLengthBucket(minutes: number): ArenaLengthBucket {
  if (minutes <= 8) return "quick";
  if (minutes <= 20) return "standard";
  return "long";
}

/** e.g. "Quick · ~6 min" — the length filter's label for a given duration. */
export function arenaLengthLabel(minutes: number): string {
  const bucket = arenaLengthBucket(minutes);
  const word = bucket === "quick" ? "Quick" : bucket === "standard" ? "Standard" : "Long";
  return `${word} · ~${minutes} min`;
}

/**
 * Length filter chips. The server filter is a *maximum* duration, so each chip
 * carries both the human word and the exact bound it applies — the word keeps
 * the list readable, the hint keeps it honest.
 */
export const ARENA_LENGTH_FILTERS = [
  { value: "any", label: "Any length", hint: "No limit", max: undefined },
  { value: "quick", label: "Quick", hint: "8 minutes or less", max: 8 },
  { value: "standard", label: "Standard", hint: "Up to 20 minutes", max: 20 },
  { value: "long", label: "Long", hint: "Up to 60 minutes", max: 60 },
] as const;

export type ArenaLengthFilterValue = (typeof ARENA_LENGTH_FILTERS)[number]["value"];

/** Human label for a sort option. */
export function arenaSortLabel(sort?: string | null): string {
  switch (sort) {
    case "most_played":
      return "Most played";
    case "newest":
      return "Newest";
    case "trending":
      return "Trending";
    case "featured":
    default:
      return "Recommended";
  }
}

/** e.g. "12 questions · ~6 min · 480 plays" — card/detail metadata line. */
export function challengeMetaLine(args: {
  questionCount: number;
  minutes: number;
  playCount?: number | null;
}): string {
  const parts = [
    `${args.questionCount} ${plural(args.questionCount, "question", "questions")}`,
    `~${args.minutes} min`,
  ];
  if (args.playCount != null) {
    parts.push(`${args.playCount.toLocaleString()} ${plural(args.playCount, "play", "plays")}`);
  }
  return parts.join(" · ");
}

/** e.g. "+740 from your previous best" / "Your first score on this challenge". */
export function bestComparisonLabel(score: number, previousBest: number | null): string {
  if (previousBest == null) return "Your first score on this challenge";
  const delta = score - previousBest;
  if (delta > 0) return `+${delta.toLocaleString()} from your previous best`;
  if (delta === 0) return "Exactly matched your previous best";
  return `${Math.abs(delta).toLocaleString()} short of your previous best`;
}
