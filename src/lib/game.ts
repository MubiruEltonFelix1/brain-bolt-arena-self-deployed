// Scoring constants and helpers (shared between host + client)
export const BASE_POINTS = 1000;

export type PointsBreakdown = {
  base: number;
  speedBonus: number;
  streakBonus: number;
  total: number;
};

export function computePointsBreakdown(opts: {
  isCorrect: boolean;
  responseMs: number;
  timeLimitMs: number;
  streak: number;
  basePoints?: number;
}): PointsBreakdown {
  if (!opts.isCorrect) return { base: 0, speedBonus: 0, streakBonus: 0, total: 0 };
  const max = opts.basePoints ?? BASE_POINTS;
  const ratio = Math.max(0, 1 - opts.responseMs / opts.timeLimitMs);
  const base = Math.round(max * 0.5);
  const speedBonus = Math.round(max * 0.5 * ratio);
  const subtotal = base + speedBonus;
  const streakMult = 1 + Math.min(opts.streak, 5) * 0.1; // up to +50%
  const total = Math.round(subtotal * streakMult);
  return { base, speedBonus, streakBonus: total - subtotal, total };
}

export function computePoints(opts: {
  isCorrect: boolean;
  responseMs: number;
  timeLimitMs: number;
  streak: number;
  basePoints?: number;
}) {
  return computePointsBreakdown(opts).total;
}

export function generateGameCode(): string {
  // 6-digit numeric code
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function generateToken(): string {
  return crypto.randomUUID() + "-" + Math.random().toString(36).slice(2, 10);
}

// Deterministic shuffle using a seed (Mulberry32) so each participant gets a
// stable per-session randomization.
export function seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  const rand = () => {
    state |= 0; state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const TEAM_COLORS = [
  "#CCFF00",
  "#FF2D55",
  "#22D3EE",
  "#FBBF24",
  "#A78BFA",
  "#34D399",
];
