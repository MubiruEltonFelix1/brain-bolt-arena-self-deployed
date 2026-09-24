/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase 9B adds a number of new RPC wrappers. Each casts `supabase as any`
// to access `.rpc(name, args)` without forcing every RPC payload into the
// generated Supabase types — the same pattern used by the pre-Phase-9B
// functions in this file. Drift between RPC names and TS calls is caught
// at runtime (the RPC 404s); the cast keeps the wrapper surface narrow.

import { supabase } from "@/integrations/supabase/client";
import type { GeoRegion } from "@/lib/question-registry";
import type { ShareResultData } from "@/components/ShareResultCard";

/* ============================================================================
 * Phase 9B — Arena product, governance & UI/UX redesign
 *
 * This file is the client-facing Arena surface. It re-exports every existing
 * type and RPC wrapper the Arena routes already use, and adds the new
 * discovery / governance / insights surface. The TS layer is the
 * boundary between the Supabase RPCs and the React routes.
 *
 * Server functions that mutate Arena state (admin and creator actions) live
 * in `src/lib/api/arena-admin.functions.ts` and `arena-creator.functions.ts`
 * to keep the createServerFn + middleware pattern consistent with the
 * existing AI functions (src/lib/api/ai.functions.ts).
 * ============================================================================ */

export type ArenaQuizDetail = {
  id: string;
  title: string;
  description: string | null;
  difficulty: string | null;
  estimated_duration_minutes: number | null;
  play_count: number;
  time_per_question: number;
  created_at: string;
  last_updated: string;
  question_count: number;
  avg_accuracy: number | null;
  creator_name: string | null;
  /** Phase 9B — free-text category; null for un-quizzed-or-unspecified. */
  arena_category: string | null;
  /** Phase 9B — semicolon-separated tags (CSV style). */
  tags: string;
  /** Phase 9B — Arena runs in the last 30 days. */
  plays_30d: number;
  /** Phase 9B — most recent Arena run timestamp. */
  last_played_at: string | null;
};

export type ArenaQuestion = {
  q_id: string;
  q_position: number;
  q_text: string;
  q_options: unknown;
  q_correct_index: number;
  q_time_limit_sec: number | null;
  q_point_value: number;
  q_question_type: string;
  q_image_url: string | null;
  q_audio_url: string | null;
  q_double_points: boolean;
  q_reveal_stages: number | null;
  q_correct_lat: number | null;
  q_correct_lng: number | null;
  q_max_distance_km: number | null;
  q_geo_region: GeoRegion | null;
  q_geo_region_label: string | null;
  q_correct_number: number | null;
  q_number_min: number | null;
  q_number_max: number | null;
  q_number_tolerance: number | null;
  q_accepted_answers: string[] | null;
};

export async function fetchArenaDetail(quizId: string): Promise<ArenaQuizDetail | null> {
  const { data, error } = await (supabase as any).rpc("get_arena_quiz_detail", {
    p_quiz_id: quizId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ArenaQuizDetail) ?? null;
}

export async function fetchArenaQuestions(quizId: string): Promise<ArenaQuestion[]> {
  const { data, error } = await (supabase as any).rpc("get_arena_questions", {
    p_quiz_id: quizId,
  });
  if (error) throw error;
  return ((data as ArenaQuestion[] | null) ?? []).map((q) => ({
    ...q,
    q_accepted_answers: q.q_accepted_answers ?? null,
  }));
}

export function optionList(options: unknown): string[] {
  if (Array.isArray(options)) return options.map((o) => String(o));
  return [];
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------- Personal best (local cache + authoritative server read) ---------------- */

const BEST_KEY = (quizId: string) => `bb_arena_best_${quizId}`;

export function readPersonalBest(quizId: string): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(BEST_KEY(quizId));
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function writePersonalBest(quizId: string, score: number): boolean {
  if (typeof window === "undefined") return false;
  const prev = readPersonalBest(quizId);
  if (prev != null && prev >= score) return false;
  window.localStorage.setItem(BEST_KEY(quizId), String(score));
  return prev != null;
}

/**
 * Authoritative personal best for a signed-in player.
 *
 * `session_id IS NULL` scopes this to Arena runs. `competition_results` also
 * holds hosted-game results (session_id set), and the server's own `your_best`
 * section applies exactly the same filter — without it the badge and the
 * "Crush your record" section would disagree about the same number.
 */
export async function fetchPersonalBest(quizId: string, profileId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("competition_results")
    .select("final_score")
    .eq("profile_id", profileId)
    .eq("quiz_id", quizId)
    .is("session_id", null)
    .order("final_score", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { final_score: number }).final_score;
}

export type ArenaPlayerHistory = {
  /** Highest score this player has recorded on the challenge. */
  best: number;
  /** How many completed runs are on record. */
  attempts: number;
  /** Score of the most recent run. */
  lastScore: number;
  /** When the most recent run finished, ISO string. */
  lastPlayedAt: string;
  /** Best accuracy across the player's runs on this challenge, 0-100. */
  bestAccuracy: number | null;
};

/**
 * Everything the pre-game and result screens need to talk about "your history
 * on this challenge" — one query, so the two screens cannot disagree about
 * what the player's best is. Scoped to Arena runs (`session_id IS NULL`), the
 * same filter the server's `your_best` section uses.
 */
export async function fetchArenaHistory(
  quizId: string,
  profileId: string,
): Promise<ArenaPlayerHistory | null> {
  const { data, error } = await supabase
    .from("competition_results")
    .select("final_score, accuracy_percentage, completed_at")
    .eq("profile_id", profileId)
    .eq("quiz_id", quizId)
    .is("session_id", null)
    .order("completed_at", { ascending: false });
  if (error || !data || data.length === 0) return null;

  const rows = data as Array<{
    final_score: number;
    accuracy_percentage: number | null;
    completed_at: string;
  }>;

  let best = rows[0];
  let bestAccuracy = rows[0].accuracy_percentage;
  for (const row of rows) {
    if (row.final_score > best.final_score) best = row;
    if (row.accuracy_percentage != null && (bestAccuracy == null || row.accuracy_percentage > bestAccuracy)) {
      bestAccuracy = row.accuracy_percentage;
    }
  }

  return {
    best: best.final_score,
    attempts: rows.length,
    lastScore: rows[0].final_score,
    lastPlayedAt: rows[0].completed_at,
    bestAccuracy,
  };
}

/* ---------------- Arena listing ---------------- */

export type ArenaListItem = {
  id: string;
  title: string;
  description: string | null;
  difficulty: string | null;
  estimated_duration_minutes: number | null;
  play_count: number;
  time_per_question: number;
  /** Phase 9B — `arena_featured_rank`; null = not featured. */
  arena_featured_rank: number | null;
  last_updated: string;
  question_count: number;
  avg_accuracy: number | null;
  creator_name: string | null;
  /** Phase 9B — free-text category. */
  arena_category: string | null;
  /** Phase 9B — semicolon-separated tags. */
  tags: string;
  /** Phase 9B — Arena runs in the last 14 days. */
  trend_score: number;
  /** Phase 9B — true if `arena_featured_rank IS NOT NULL`. */
  is_featured: boolean;
};

export async function fetchArenaList(): Promise<ArenaListItem[]> {
  const { data, error } = await (supabase as any).rpc("get_arena_quizzes");
  if (error) throw error;
  return (data as ArenaListItem[] | null) ?? [];
}

/**
 * Quiz ids the signed-in player already has a result for. Scoped to Arena runs
 * (`session_id IS NULL`) so it means the same thing as the other Arena reads.
 */
export async function fetchCompletedArenaQuizIds(profileId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("competition_results")
    .select("quiz_id")
    .eq("profile_id", profileId)
    .is("session_id", null);
  if (error) return [];
  return Array.from(new Set(((data as { quiz_id: string }[] | null) ?? []).map((r) => r.quiz_id)));
}

/**
 * Best score per challenge for the signed-in player, keyed by quiz id. One
 * query backs every "Your best" badge on the Arena home instead of one per
 * card. Scoped to Arena runs, matching the server's `your_best` section.
 */
export async function fetchPersonalBests(profileId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("competition_results")
    .select("quiz_id, final_score")
    .eq("profile_id", profileId)
    .is("session_id", null);
  const out = new Map<string, number>();
  if (error) return out;
  for (const row of (data as { quiz_id: string; final_score: number }[] | null) ?? []) {
    const prev = out.get(row.quiz_id);
    if (prev == null || row.final_score > prev) out.set(row.quiz_id, row.final_score);
  }
  return out;
}

/**
 * "Next Bolt" target: the first challenge in a list the player has not already
 * finished, excluding the one they just played. Falls back to the first
 * different challenge, then to the Arena home. Deterministic — no shuffling,
 * so the button does not point somewhere new on every render.
 */
export function pickNextBolt(
  candidates: readonly ArenaListItem[],
  currentQuizId: string,
  played: ReadonlySet<string> | readonly string[] = [],
): ArenaListItem | null {
  const playedSet = played instanceof Set ? played : new Set(played);
  const others = candidates.filter((c) => c.id !== currentQuizId);
  return others.find((c) => !playedSet.has(c.id)) ?? others[0] ?? null;
}

/* ---------------- Arena run submission ---------------- */

export type ArenaAnswer = {
  question_id: string;
  response_ms: number;
  selected_index?: number;
  text?: string;
  value?: number;
  lat?: number;
  lng?: number;
  order?: number[];
};

export type ArenaRunResult = {
  score: number;
  accuracy: number;
  correct_count: number;
  graded_count: number;
};

/**
 * Persist a solo Arena run. The client sends raw answers only; the score and
 * accuracy stored in history are computed server-side. Idempotent by run id.
 * The server-side `submit_arena_run` also writes per-question rows to
 * `arena_run_answers` (Phase 9B) and gates on `platform_settings.arena_open`.
 */
export async function submitArenaRun(args: {
  runId: string;
  quizId: string;
  answers: ArenaAnswer[];
}): Promise<ArenaRunResult | null> {
  const { data, error } = await (supabase as any).rpc("submit_arena_run", {
    p_run_id: args.runId,
    p_quiz_id: args.quizId,
    p_answers: args.answers,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ArenaRunResult) ?? null;
}

/* ---------------- Metadata formatting ---------------- */

export function estimatedMinutes(item: {
  estimated_duration_minutes: number | null;
  question_count: number;
  time_per_question: number;
}): number {
  return (
    item.estimated_duration_minutes ??
    Math.max(1, Math.round((item.question_count * (item.time_per_question || 20)) / 60))
  );
}

/* ============================================================================
 * Phase 9B — discovery / governance / insights
 * ============================================================================ */

export type ArenaPlatformState = {
  arena_open: boolean;
  arena_closed_message: string;
};

export async function fetchArenaPlatformState(): Promise<ArenaPlatformState> {
  const { data, error } = await (supabase as any).rpc("get_arena_platform_state");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (
    (row as ArenaPlatformState) ?? {
      arena_open: true,
      arena_closed_message: "The Arena is temporarily closed. Please check back soon.",
    }
  );
}

/* ---------------- Sections (home page uses one fetch per section) ---------------- */

export type ArenaSection =
  | "featured"
  | "trending"
  | "new"
  | "quick_bolts"
  | "hard_mode"
  | "continue_exploring"
  | "your_best";

export async function fetchArenaSection(
  section: ArenaSection,
  profileId?: string | null,
): Promise<ArenaListItem[]> {
  const { data, error } = await (supabase as any).rpc("get_arena_quizzes_by_section", {
    p_section: section,
    p_profile_id: profileId ?? null,
  });
  if (error) throw error;
  return (data as ArenaListItem[] | null) ?? [];
}

/* ---------------- Search + filter ---------------- */

export type ArenaSearchFilters = {
  difficulty?: "easy" | "medium" | "hard";
  duration_max?: number;
  category?: string;
  sort?: "newest" | "most_played" | "trending" | "featured";
};

export type ArenaSearchResult = ArenaListItem & { total_count: number };

export async function searchArenaQuizzes(args: {
  query?: string;
  filters?: ArenaSearchFilters;
  limit?: number;
  offset?: number;
}): Promise<ArenaSearchResult[]> {
  const { data, error } = await (supabase as any).rpc("search_arena_quizzes", {
    p_query: args.query ?? "",
    p_filters: args.filters ?? {},
    p_limit: args.limit ?? 24,
    p_offset: args.offset ?? 0,
  });
  if (error) throw error;
  return (data as ArenaSearchResult[] | null) ?? [];
}

/* ---------------- Completion-screen insights ---------------- */

export type ArenaRunInsights = {
  total: number;
  correct: number;
  fastest_ms: number | null;
  fastest_question_id: string | null;
  thirds: {
    first: { count: number; correct: number };
    middle: { count: number; correct: number };
    last: { count: number; correct: number };
  };
  comeback: boolean;
  hardest_question_id: string | null;
  hardest_accuracy_pct: number;
  /**
   * NOT a count. `get_arena_run_insights` applies `HAVING count(*) >= 3` before
   * choosing a hardest question and then reports 1 when it found one, 0 when it
   * did not. Treat it as a "found one" flag; the real sample size is not
   * exposed to the client.
   */
  hardest_sample_size: number;
  avg_response_ms: number | null;
  error?: string;
};

export async function fetchArenaRunInsights(runId: string): Promise<ArenaRunInsights | null> {
  const { data, error } = await (supabase as any).rpc("get_arena_run_insights", {
    p_run_id: runId,
  });
  if (error) throw error;
  return (data as ArenaRunInsights) ?? null;
}

/** "The score immediately before this run." Authoritative server read. */
export async function fetchPreviousBest(args: {
  quizId: string;
  profileId: string;
  beforeRunId: string;
}): Promise<number | null> {
  const { data, error } = await (supabase as any).rpc("get_previous_best_for_profile", {
    p_quiz_id: args.quizId,
    p_profile_id: args.profileId,
    p_before_run_id: args.beforeRunId,
  });
  if (error) return null;
  if (data == null) return null;
  return Number(data);
}

/* ---------------- Editor publication state (validation + RPC wrappers) ---------------- */

export type ArenaPublicationState = {
  current_status: "draft" | "published" | "hidden" | "archived";
  current_admin_status: "visible" | "hidden";
  archived: boolean;
  is_eligible: boolean;
  errors: Array<{ field: string; message: string }>;
  warnings: Array<{ field: string; message: string }>;
  playable_question_count: number;
  supported_types: string[];
  arena_category: string | null;
  tags: string;
  error?: string;
};

export async function fetchArenaPublicationState(quizId: string): Promise<ArenaPublicationState | null> {
  const { data, error } = await (supabase as any).rpc("get_arena_publication_state", {
    p_quiz_id: quizId,
  });
  if (error) throw error;
  return (data as ArenaPublicationState) ?? null;
}

export async function fetchValidateArenaQuiz(quizId: string): Promise<{
  is_eligible: boolean;
  errors: Array<{ field: string; message: string }>;
  warnings: Array<{ field: string; message: string }>;
  playable_question_count: number;
  supported_types: string[];
} | null> {
  const { data, error } = await (supabase as any).rpc("validate_arena_quiz", {
    p_quiz_id: quizId,
  });
  if (error) throw error;
  return (data as {
    is_eligible: boolean;
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
    playable_question_count: number;
    supported_types: string[];
  }) ?? null;
}

/* ============================================================================
 * Phase 9B — client-side validation mirror
 *
 * Mirrors the SQL `get_arena_publication_state` rules so the Quiz Editor can
 * show validation feedback instantly without a round-trip. Drift between this
 * mirror and the SQL function is guarded by `src/lib/arena/arena-validation-drift.test.ts`.
 * ============================================================================ */

export const ARENA_ELIGIBLE_TYPES = new Set([
  "mcq",
  "image_mcq",
  "true_false",
  "number",
  "image_reveal",
  "audio",
  "ordering",
  "type",
  "map_pin",
]);

export const ARENA_MIN_PLAYABLE_QUESTIONS = 3;

export type ArenaQuizForValidation = {
  title: string;
  description: string | null;
  arena_category: string | null;
  tags?: string | null;
  questions: Array<{
    is_playable: boolean;
    question_type: string;
    accepted_answers: string[] | null;
    geo_region: unknown;
    correct_lat: number | null;
    correct_lng: number | null;
  }>;
};

export type ArenaValidation = {
  is_eligible: boolean;
  errors: Array<{ field: string; message: string }>;
  warnings: Array<{ field: string; message: string }>;
  playable_question_count: number;
  supported_types: string[];
};

export function validateArenaQuizLocal(quiz: ArenaQuizForValidation | null): ArenaValidation {
  const errors: Array<{ field: string; message: string }> = [];
  const warnings: Array<{ field: string; message: string }> = [];
  const playable = (quiz?.questions ?? []).filter(
    (q) => q.is_playable && q.question_type !== "feedback" && ARENA_ELIGIBLE_TYPES.has(q.question_type),
  );
  const supportedTypes = Array.from(new Set(playable.map((q) => q.question_type))).sort();

  if (!quiz || !quiz.title || quiz.title.trim() === "") {
    errors.push({ field: "title", message: "Title is required" });
  }
  if (!quiz || !quiz.description || quiz.description.trim() === "") {
    errors.push({ field: "description", message: "Description is required" });
  }
  if (!quiz || !quiz.arena_category || quiz.arena_category.trim() === "") {
    errors.push({ field: "arena_category", message: "Category is required" });
  }
  if (playable.length < ARENA_MIN_PLAYABLE_QUESTIONS) {
    errors.push({
      field: "playable_questions",
      message: `At least ${ARENA_MIN_PLAYABLE_QUESTIONS} playable questions are required for a meaningful Arena run`,
    });
  }

  for (const q of playable) {
    if (
      q.question_type === "type" &&
      (!q.accepted_answers || q.accepted_answers.length === 0)
    ) {
      errors.push({
        field: "type_questions",
        message: "One or more text-answer questions have no accepted answers",
      });
      break;
    }
  }
  for (const q of playable) {
    if (
      q.question_type === "map_pin" &&
      !q.geo_region &&
      (q.correct_lat == null || q.correct_lng == null)
    ) {
      errors.push({
        field: "map_pin_questions",
        message: "Map-pin questions need either a region or coordinates",
      });
      break;
    }
  }

  if (!quiz || !quiz.tags || quiz.tags.trim() === "") {
    warnings.push({ field: "tags", message: "Add tags to make the quiz easier to discover" });
  }

  return {
    is_eligible: errors.length === 0,
    errors,
    warnings,
    playable_question_count: playable.length,
    supported_types: supportedTypes,
  };
}

/* ---------------- Phase 9B — share-card adapter ---------------- */

export function arenaShareDataFromRun(args: {
  quizTitle: string;
  identityName: string;
  score: number;
  correct: number;
  totalQuestions: number;
  longestStreak?: number | null;
}): ShareResultData {
  return {
    nickname: args.identityName || "Arena player",
    rank: 1,
    totalPlayers: 1,
    score: args.score,
    correct: args.correct,
    totalQuestions: args.totalQuestions,
    longestStreak: args.longestStreak ?? 0,
    quizTitle: args.quizTitle,
    leagueName: null,
    achievement: null,
  };
}
