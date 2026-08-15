import { supabase } from "@/integrations/supabase/client";

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

/**
 * Personal best.
 * Signed-in players: derived from `competition_results`, the single authoritative
 * store for every finished run. Guests: local cache only, never used for stats.
 */
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

/** Authoritative personal best for a signed-in player. */
export async function fetchPersonalBest(quizId: string, profileId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("competition_results")
    .select("final_score")
    .eq("profile_id", profileId)
    .eq("quiz_id", quizId)
    .order("final_score", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { final_score: number }).final_score;
}


/* ---------------- Arena listing + engagement helpers ---------------- */

export type ArenaListItem = {
  id: string;
  title: string;
  description: string | null;
  difficulty: string | null;
  estimated_duration_minutes: number | null;
  play_count: number;
  time_per_question: number;
  featured_rank: number | null;
  last_updated: string;
  question_count: number;
  avg_accuracy: number | null;
  creator_name: string | null;
};

export async function fetchArenaList(): Promise<ArenaListItem[]> {
  const { data, error } = await (supabase as any).rpc("get_arena_quizzes");
  if (error) throw error;
  return (data as ArenaListItem[] | null) ?? [];
}

/** Quiz ids the signed-in player already has a result for. */
export async function fetchCompletedArenaQuizIds(profileId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("competition_results")
    .select("quiz_id")
    .eq("profile_id", profileId);
  if (error) return [];
  return Array.from(new Set(((data as { quiz_id: string }[] | null) ?? []).map((r) => r.quiz_id)));
}

/** Raw answer as submitted by the player — the server does all the grading. */
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


/** Shared metadata formatting so listing, detail and completion agree. */
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

export function formatUpdated(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
