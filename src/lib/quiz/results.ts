// Phase 13 — Section-based results and analytics (reporting only).
//
// This module is PURE: it takes existing records (session snapshot, questions,
// answers, participants) and derives section-level and participant-level
// metrics. It never mutates data, never re-scores, and never reconstructs
// historical grouping from the current quiz. Section membership, titles and
// order come exclusively from the immutable `sessions.section_snapshot`.
//
// Every metric is `available` only when the authoritative records genuinely
// support it; a genuine zero is still `available: true`. This mirrors the
// convention in src/lib/result-presentation.ts ("unavailable is not zero").

import { metric, type Metric, UNAVAILABLE } from "@/lib/result-presentation";
import type { SessionSnapshot } from "./sections";

/** Minimal question shape needed for results reporting. */
export interface ResultQuestion {
  id: string;
  text: string;
  question_type: string;
  point_value: number;
  double_points: boolean;
  correct_index: number;
  options: string[];
  correct_number: number | null;
  geo_region_label: string | null;
  accepted_answers: string[] | null;
}

/** Minimal answer shape needed for results reporting. */
export interface ResultAnswer {
  question_id: string;
  participant_id: string;
  is_correct: boolean;
  points: number;
  response_ms: number | null;
}

/** Minimal participant shape needed for results reporting. */
export interface ResultParticipant {
  id: string;
  nickname: string;
  score: number;
  joined_at: string;
  avatar_id: string | null;
  team_id: string | null;
}

/** Aggregate metrics for one section of one session. */
export interface SectionResult {
  id: string;
  title: string;
  position: number;
  /** Every question id captured in the snapshot for this section (incl. feedback). */
  questionIds: string[];
  /** Scored (non-feedback) question ids from the snapshot. */
  scoredQuestionIds: string[];
  totalScoredQuestions: number;
  /** Total answer submissions for scored questions in this section (all participants). */
  totalAnswers: number;
  totalCorrect: number;
  totalIncorrect: number;
  /** Scored questions in this section that received zero answers from anyone. */
  questionsWithNoAnswers: number;
  /** Sum of `answers.points` actually awarded for scored questions in this section. */
  pointsEarned: number;
  /** Accuracy = correct / submissions. Unavailable when nothing was answered. */
  accuracy: Metric;
}

/** One participant's metrics within one section of one session. */
export interface ParticipantSectionResult {
  participantId: string;
  sectionId: string;
  answered: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  accuracy: Metric;
  pointsEarned: number;
}

/** Per-question review data for a session's questions, grouped by section. */
export interface QuestionReview {
  id: string;
  text: string;
  questionType: string;
  correctIndex: number;
  options: string[];
  correctNumber: number | null;
  geoRegionLabel: string | null;
  acceptedAnswers: string[] | null;
  doublePoints: boolean;
  answered: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  pointsEarned: number;
}

export interface SessionSectionResults {
  presentationMode: "flat" | "categorized" | null;
  sections: SectionResult[];
  participantSections: ParticipantSectionResult[];
  questions: QuestionReview[];
}

type SectionRef = { id: string; title: string; position: number };

function key(pid: string, sid: string): string {
  return `${pid}\0${sid}`;
}

/**
 * Derives section-level and participant-level section results from existing
 * records. Throws nothing; missing or malformed input degrades to empty /
 * unavailable metrics rather than fabricating data.
 */
export function computeSessionSectionResults(input: {
  snapshot: SessionSnapshot | null;
  questions: readonly ResultQuestion[];
  answers: readonly ResultAnswer[];
  participants: readonly ResultParticipant[];
}): SessionSectionResults {
  const { snapshot, questions, answers, participants } = input;
  const presentationMode = snapshot?.presentation_mode ?? "flat";

  const sections: SectionResult[] = [];
  const participantSections: ParticipantSectionResult[] = [];
  const questionsOut: QuestionReview[] = [];

  // Flat sessions carry no snapshot; there is no section-based reporting.
  if (presentationMode !== "categorized" || !snapshot) {
    return { presentationMode, sections: [], participantSections: [], questions: [] };
  }

  // question.id -> its type, so feedback slides can be excluded from scored metrics.
  const typeById = new Map<string, string>();
  for (const q of questions) typeById.set(q.id, q.question_type);

  // question.id -> the section (from the snapshot) that contains it. Each
  // playable question appears in at most one section of an immutable snapshot.
  const sectionByQuestion = new Map<string, SectionRef>();
  for (const section of snapshot.sections) {
    for (const qid of section.question_ids) {
      sectionByQuestion.set(qid, {
        id: section.id,
        title: section.title,
        position: section.position,
      });
    }
  }

  const questionsById = new Map<string, ResultQuestion>();
  for (const q of questions) questionsById.set(q.id, q);

  // Index answers by question id for per-question distribution and aggregation.
  const answersByQuestion = new Map<string, ResultAnswer[]>();
  for (const a of answers) {
    const list = answersByQuestion.get(a.question_id) ?? [];
    list.push(a);
    answersByQuestion.set(a.question_id, list);
  }

  // Accumulate per (participant, section): answered / correct / points.
  const partSectionMap = new Map<string, { answered: number; correct: number; points: number }>();

  for (const section of snapshot.sections) {
    const scoredQuestionIds = section.question_ids.filter(
      (qid) => typeById.get(qid) !== "feedback",
    );
    const scoredSet = new Set(scoredQuestionIds);

    let totalAnswers = 0;
    let totalCorrect = 0;
    let totalIncorrect = 0;
    let pointsEarned = 0;
    const answeredQuestionIds = new Set<string>();

    for (const qid of scoredQuestionIds) {
      const ans = answersByQuestion.get(qid);
      if (!ans || ans.length === 0) continue;
      answeredQuestionIds.add(qid);

      // Per-question review entry (built once per scored question).
      const q = questionsById.get(qid);
      let qCorrect = 0;
      let qIncorrect = 0;
      let qPoints = 0;
      for (const a of ans) {
        totalAnswers += 1;
        if (a.is_correct) {
          totalCorrect += 1;
          qCorrect += 1;
        } else {
          totalIncorrect += 1;
          qIncorrect += 1;
        }
        qPoints += a.points;
        pointsEarned += a.points;

        const pKey = key(a.participant_id, section.id);
        const cur = partSectionMap.get(pKey) ?? { answered: 0, correct: 0, points: 0 };
        cur.answered += 1;
        if (a.is_correct) cur.correct += 1;
        cur.points += a.points;
        partSectionMap.set(pKey, cur);
      }

      questionsOut.push({
        id: qid,
        text: q?.text ?? "",
        questionType: q?.question_type ?? "unknown",
        correctIndex: q?.correct_index ?? -1,
        options: q?.options ?? [],
        correctNumber: q?.correct_number ?? null,
        geoRegionLabel: q?.geo_region_label ?? null,
        acceptedAnswers: q?.accepted_answers ?? null,
        doublePoints: !!q?.double_points,
        answered: ans.length,
        correct: qCorrect,
        incorrect: qIncorrect,
        // Participants present minus those who answered. An approximation when
        // participants joined late or left early; presence is not recorded per
        // question, so this is the best available signal.
        unanswered: participants.length - ans.length,
        pointsEarned: qPoints,
      });
    }

    sections.push({
      id: section.id,
      title: section.title,
      position: section.position,
      questionIds: section.question_ids,
      scoredQuestionIds,
      totalScoredQuestions: scoredQuestionIds.length,
      totalAnswers,
      totalCorrect,
      totalIncorrect,
      questionsWithNoAnswers: scoredQuestionIds.length - answeredQuestionIds.size,
      pointsEarned,
      accuracy:
        totalAnswers > 0 ? metric(Math.round((totalCorrect / totalAnswers) * 100)) : UNAVAILABLE,
    });
  }

  // Every participant gets a row for every section, including untouched ones.
  for (const p of participants) {
    for (const section of snapshot.sections) {
      const scoredCount = section.question_ids.filter(
        (qid) => typeById.get(qid) !== "feedback",
      ).length;
      const cur = partSectionMap.get(key(p.id, section.id)) ?? {
        answered: 0,
        correct: 0,
        points: 0,
      };
      const answered = cur.answered;
      const correct = cur.correct;
      participantSections.push({
        participantId: p.id,
        sectionId: section.id,
        answered,
        correct,
        incorrect: answered - correct,
        unanswered: scoredCount - answered,
        accuracy: answered > 0 ? metric(Math.round((correct / answered) * 100)) : UNAVAILABLE,
        pointsEarned: cur.points,
      });
    }
  }

  return { presentationMode, sections, participantSections, questions: questionsOut };
}
