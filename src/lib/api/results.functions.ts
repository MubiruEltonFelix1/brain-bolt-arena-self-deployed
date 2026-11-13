// Phase 13 — Server-side access to completed-session section results.
//
// `getSessionResults` is the single entry point the host route calls to load
// results data. It runs server-only, so answer records are never exposed to
// the browser unless the caller is authorized, and all aggregation happens
// server-side in one round of queries (no N+1).
//
// Authorization: only the session's host may view its results. This mirrors
// the existing "sessions host manage" RLS predicate (auth.uid() = host_id).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeSessionSectionResults,
  type ParticipantSectionResult,
  type QuestionReview,
  type ResultAnswer,
  type ResultParticipant,
  type ResultQuestion,
  type SectionResult,
} from "@/lib/quiz/results";
import type { QuestionFlow } from "@/lib/quiz/sections";

type SessionRow = {
  id: string;
  code: string;
  status: string;
  presentation_mode: string | null;
  section_snapshot: unknown;
  question_order: unknown;
  quiz_id: string;
  host_id: string;
};

type QuestionRow = {
  id: string;
  text: string;
  options: unknown;
  correct_index: number;
  position: number;
  time_limit_sec: number | null;
  point_value: number;
  question_type: string;
  image_url: string | null;
  double_points: boolean;
  is_playable: boolean;
  correct_number: number | null;
  max_distance_km: number | null;
  number_min: number | null;
  number_max: number | null;
  reveal_stages: number | null;
  audio_url: string | null;
  geo_region_label: string | null;
  accepted_answers: string[] | null;
};

type AnswerRow = {
  question_id: string;
  participant_id: string;
  is_correct: boolean;
  points: number;
  response_ms: number | null;
};

type ParticipantRow = {
  id: string;
  nickname: string;
  score: number;
  joined_at: string;
  avatar_id: string | null;
  team_id: string | null;
};

type Snapshot = {
  presentation_mode: QuestionFlow;
  sections: Array<{
    id: string;
    title: string;
    position: number;
    question_ids: string[];
  }>;
};

type ServerContext = {
  supabase: import("@supabase/supabase-js").SupabaseClient;
  userId: string;
};

export type SessionResults = {
  error: null | "not_found" | "not_authorized" | "query_failed";
  session: {
    id: string;
    code: string;
    status: string;
    presentationMode: string | null;
    quizId: string;
  } | null;
  sections: SectionResult[];
  participantSections: ParticipantSectionResult[];
  questions: QuestionReview[];
};

function asResultQuestion(row: QuestionRow): ResultQuestion {
  return {
    id: row.id,
    text: row.text,
    question_type: row.question_type,
    point_value: row.point_value,
    double_points: row.double_points,
    correct_index: row.correct_index,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    correct_number: row.correct_number,
    geo_region_label: row.geo_region_label,
    accepted_answers: row.accepted_answers,
  };
}

export const getSessionResults = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ sessionId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as unknown as ServerContext;
    const { sessionId } = data;

    const { data: session, error: sErr } = await supabase
      .from("sessions")
      .select("id,code,status,presentation_mode,section_snapshot,question_order,quiz_id,host_id")
      .eq("id", sessionId)
      .maybeSingle<SessionRow>();
    if (sErr || !session) {
      return { error: "not_found" } as SessionResults;
    }

    // Only the session's host may view its results.
    if (session.host_id !== userId) {
      return {
        error: "not_authorized",
        session: null,
        sections: [],
        participantSections: [],
        questions: [],
      } as SessionResults;
    }

    const { data: questions, error: qErr } = await supabase
      .from("questions")
      .select(
        "id,text,options,correct_index,position,time_limit_sec,point_value,question_type,image_url,double_points,is_playable,correct_number,max_distance_km,number_min,number_max,reveal_stages,audio_url,geo_region_label,accepted_answers",
      )
      .eq("quiz_id", session.quiz_id);
    if (qErr) {
      return {
        error: "query_failed",
        session: null,
        sections: [],
        participantSections: [],
        questions: [],
      } as SessionResults;
    }

    const { data: answers, error: aErr } = await supabase
      .from("answers")
      .select("question_id,participant_id,is_correct,points,response_ms")
      .eq("session_id", sessionId);
    if (aErr) {
      return {
        error: "query_failed",
        session: null,
        sections: [],
        participantSections: [],
        questions: [],
      } as SessionResults;
    }

    const { data: participants, error: pErr } = await supabase
      .from("participants")
      .select("id,nickname,score,joined_at,avatar_id,team_id")
      .eq("session_id", sessionId);
    if (pErr) {
      return {
        error: "query_failed",
        session: null,
        sections: [],
        participantSections: [],
        questions: [],
      } as SessionResults;
    }

    const snapshot = (session.section_snapshot as Snapshot | null) ?? null;
    const result = computeSessionSectionResults({
      snapshot,
      questions: (questions ?? []).map(asResultQuestion),
      answers: (answers ?? []) as unknown as readonly ResultAnswer[],
      participants: (participants ?? []) as unknown as readonly ResultParticipant[],
    });

    return {
      error: null,
      session: {
        id: session.id,
        code: session.code,
        status: session.status,
        presentationMode: session.presentation_mode,
        quizId: session.quiz_id,
      },
      sections: result.sections,
      participantSections: result.participantSections,
      questions: result.questions,
    } as SessionResults;
  });
