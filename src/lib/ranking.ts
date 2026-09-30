// Ranking that matches the database exactly.
//
// THE BUG THIS REPLACES
// The results screen derived rank in the browser: it fetched participants
// ordered by `score` descending and took the array index
// (`participants.findIndex(p => p.id === me.id) + 1`). With no tie-break in the
// ORDER BY, Postgres is free to return tied rows in any order, so two players
// on the same score could be shown in a different order than the rank the
// server persisted in `competition_results.final_rank`.
//
// The authoritative contract, used identically by both the end-of-session
// trigger (`record_competition_results`) and the guest claim path
// (`claim_result`), is:
//
//     rank() OVER (ORDER BY score DESC, joined_at ASC)
//
// Reproducing that in one tested place is cheaper and safer than adding a new
// server RPC to re-expose data the client already reads under existing RLS.
// If either server-side definition ever changes its tie-break, change it here
// too and `ranking.test.ts` is the canary.
//
// `rank()` (not `dense_rank()`) assigns equal ranks to tied rows and then
// SKIPS, so equal scores produce 1, 2, 2, 4. Because `joined_at` breaks ties
// first, true ties require an identical score AND an identical join instant,
// which is why they are rare in practice - but the skip behaviour is modelled
// exactly anyway, because a displayed "3rd place" that the server never
// recorded is exactly the class of bug this phase exists to remove.

export type Rankable = {
  id: string;
  score: number;
  /** ISO timestamp of when the player took their seat. */
  joined_at: string;
};

export type Ranked<T> = T & { rank: number };

function joinTime(iso: string): number {
  const t = Date.parse(iso);
  // An unparseable timestamp must not silently become "oldest ever" and win
  // every tie. Fall back to the end of the line so it loses instead.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Order exactly as `ORDER BY score DESC, joined_at ASC`, then assign
 * `rank()` semantics. `id` is a final deterministic tiebreak so the browser
 * never renders two runs differently for identical input; the server has no
 * such tiebreak, but that case is unobservable because it requires a
 * same-microsecond join with a same-point score.
 */
export function compareForRanking(a: Rankable, b: Rankable): number {
  if (b.score !== a.score) return b.score - a.score;
  const at = joinTime(a.joined_at);
  const bt = joinTime(b.joined_at);
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Tie detection compares ONLY the server's sort keys. `id` is deliberately
 * excluded: it exists to make the browser's own order deterministic, and
 * including it here would make every comparison distinct, so a genuine tie
 * would never be recognised as one.
 */
function sameSortKey(a: Rankable, b: Rankable): boolean {
  return a.score === b.score && joinTime(a.joined_at) === joinTime(b.joined_at);
}

/** Every player with their authoritative rank, best first. */
export function rankPlayers<T extends Rankable>(players: readonly T[]): Array<Ranked<T>> {
  const ordered = [...players].sort(compareForRanking);
  const out: Array<Ranked<T>> = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const player = ordered[i];
    const prev = ordered[i - 1];
    // rank() gives tied rows the same rank; the following rank skips.
    const tied = prev !== undefined && sameSortKey(prev, player);
    out.push({ ...player, rank: tied ? out[i - 1].rank : i + 1 });
  }
  return out;
}

export type Standing<T> = {
  /** Best-first, carrying the server's rank for each. */
  ranked: Array<Ranked<T>>;
  /**
   * The top three BY RANK, not the first three rows. With a skip-producing
   * rank() a tie can leave fewer than three distinct places on the podium, and
   * slicing rows would then show a 4th-place player wearing a "3rd" badge.
   */
  podium: Array<Ranked<T>>;
  /** This player's entry, or null when they are not in the list. */
  me: Ranked<T> | null;
  /** Total players who have a result. */
  total: number;
};

/** Podium and personal placement for one completed game. */
export function standingsFor<T extends Rankable>(players: readonly T[], myId: string): Standing<T> {
  const ranked = rankPlayers(players);
  const podium = ranked.filter((p) => p.rank <= 3);
  const me = ranked.find((p) => p.id === myId) ?? null;
  return { ranked, podium, me, total: ranked.length };
}
