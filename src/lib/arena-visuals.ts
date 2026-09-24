import { AVATARS } from "@/assets/avatars";

/**
 * Arena visual language — single source of truth for difficulty colors,
 * artwork resolution and official/featured treatment.
 *
 * Extension points (no redesign required later):
 *  - `artworkUrl` on a quiz row → pass as `artwork` to override the fallback.
 *  - sponsored / seasonal themes → add a theme entry here and read it in the
 *    same components; layout stays identical.
 */

export type DifficultyTheme = {
  key: "easy" | "medium" | "hard";
  label: string;
  /** CSS color value, safe to use inline (no dynamic Tailwind classes). */
  color: string;
  /** Soft background tint for chips and panels. */
  tint: string;
  /** Premium gradient used behind artwork. */
  gradient: string;
};

const THEMES: Record<DifficultyTheme["key"], DifficultyTheme> = {
  easy: {
    key: "easy",
    label: "Easy",
    color: "var(--cyan-jolt)",
    tint: "color-mix(in oklab, var(--cyan-jolt) 12%, transparent)",
    gradient:
      "linear-gradient(135deg, color-mix(in oklab, var(--cyan-jolt) 26%, transparent), transparent 70%)",
  },
  medium: {
    key: "medium",
    label: "Medium",
    color: "var(--volt)",
    tint: "color-mix(in oklab, var(--volt) 12%, transparent)",
    gradient:
      "linear-gradient(135deg, color-mix(in oklab, var(--volt) 26%, transparent), transparent 70%)",
  },
  hard: {
    key: "hard",
    label: "Hard",
    color: "var(--pink-shock)",
    tint: "color-mix(in oklab, var(--pink-shock) 14%, transparent)",
    gradient:
      "linear-gradient(135deg, color-mix(in oklab, var(--pink-shock) 28%, transparent), transparent 70%)",
  },
};

export function difficultyTheme(difficulty?: string | null): DifficultyTheme {
  const key = (difficulty ?? "medium").toLowerCase();
  return THEMES[key as DifficultyTheme["key"]] ?? THEMES.medium;
}

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Deterministic competition artwork. Reuses the prepared Brain Bolt avatar
 * artwork so every challenge has a stable visual identity, with a graceful
 * fallback when no dedicated artwork exists.
 */
export function arenaArtwork(quizId: string, artwork?: string | null): string {
  if (artwork) return artwork;
  return AVATARS[hash(quizId) % AVATARS.length].url;
}

/** Official Brain Bolt competitions get a subtle badge. */
export function isOfficial(creatorName?: string | null): boolean {
  const n = (creatorName ?? "").trim().toLowerCase();
  return n === "" || n === "brain bolt" || n === "brainbolt";
}

/* ---------------- Category accent ---------------- */

/** The four Brain Bolt accents, in the order the hash cycles through them. */
export const BRAND_ACCENTS = ["volt", "pink-shock", "cyan-jolt", "amber-spark"] as const;

export type BrandAccent = (typeof BRAND_ACCENTS)[number];

/**
 * Stable, deterministic accent for a free-text category. The same category
 * always gets the same colour (case- and whitespace-insensitively) so a
 * challenge's identity does not shift between renders or sessions. Uncategorised
 * content falls back to volt — the primary brand accent.
 */
export function arenaCategoryAccent(category?: string | null): BrandAccent {
  const key = (category ?? "").trim().toLowerCase();
  if (!key) return "volt";
  return BRAND_ACCENTS[hash(key) % BRAND_ACCENTS.length];
}

/** The same accent as a CSS custom-property reference, for inline styles. */
export function categoryAccentVar(category?: string | null): string {
  return `var(--${arenaCategoryAccent(category)})`;
}
