// Player statistics computed from existing competition history.
// No new tables: everything is derived from `competition_results`
// (one row per finished session a signed-in player took part in) plus
// answer counts from `participants` + `answers`.

export type CompetitionRow = {
  id: string;
  session_id: string;
  quiz_id: string;
  final_score: number;
  final_rank: number;
  total_participants: number;
  accuracy_percentage: number;
  completed_at: string;
  quiz_title: string;
};

export type PlayerStats = {
  played: number;
  won: number;
  podiums: number;
  avgAccuracy: number;
  avgScore: number;
  bestScore: number;
  questionsAnswered: number;
  correctAnswers: number;
};

export function computeStats(
  rows: CompetitionRow[],
  answers: { answered: number; correct: number }
): PlayerStats {
  const played = rows.length;
  // Solo Arena runs are stored with final_rank 0 (no opponents) and never
  // count as wins or podiums.
  const ranked = rows.filter((r) => r.final_rank >= 1);
  const won = ranked.filter((r) => r.final_rank === 1).length;
  const podiums = ranked.filter((r) => r.final_rank <= 3).length;
  const sum = (fn: (r: CompetitionRow) => number) => rows.reduce((a, r) => a + fn(r), 0);
  return {
    played,
    won,
    podiums,
    avgAccuracy: played ? Math.round((sum((r) => Number(r.accuracy_percentage)) / played) * 10) / 10 : 0,
    avgScore: played ? Math.round(sum((r) => r.final_score) / played) : 0,
    bestScore: played ? Math.max(...rows.map((r) => r.final_score)) : 0,
    questionsAnswered: answers.answered,
    correctAnswers: answers.correct,
  };
}

export function personalBest(rows: CompetitionRow[]): CompetitionRow | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, r) => (r.final_score > best.final_score ? r : best), rows[0]);
}

/** Solo Arena results have no ranking. */
export function isSoloRun(r: { final_rank: number; total_participants: number }): boolean {
  return r.final_rank < 1 || r.total_participants < 1;
}

export function placementLabel(r: { final_rank: number; total_participants: number }): string {
  return isSoloRun(r) ? "Solo" : ordinal(r.final_rank);
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
