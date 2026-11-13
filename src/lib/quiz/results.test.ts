// Phase 13 — Section-based results calculation tests.
//
// These cover the required scenarios for computing section metrics from saved
// session snapshots, preserving historical grouping, excluding feedback from
// scored metrics, using actual recorded points, and degrading gracefully on
// missing/malformed snapshots.
import { describe, expect, test } from "bun:test";
import {
  computeSessionSectionResults,
  type SectionResult,
} from "@/lib/quiz/results";
import type { SessionSnapshot } from "@/lib/quiz/sections";

function section(
  id: string,
  title: string,
  position: number,
  questionIds: string[],
): SessionSnapshot["sections"][number] {
  return { id, title, position, question_ids: questionIds };
}

function snapshot(
  presentation_mode: SessionSnapshot["presentation_mode"] = "categorized",
  sections: SessionSnapshot["sections"] = [],
): SessionSnapshot {
  return { presentation_mode, sections };
}

function question(
  id: string,
  overrides: {
    question_type?: string;
    point_value?: number;
    double_points?: boolean;
  } = {},
): import("@/lib/quiz/results").ResultQuestion {
  return {
    id,
    text: `Question ${id}`,
    question_type: overrides.question_type ?? "mcq",
    point_value: overrides.point_value ?? 1000,
    double_points: overrides.double_points ?? false,
    correct_index: 0,
    options: ["A", "B", "C", "D"],
    correct_number: null,
    geo_region_label: null,
    accepted_answers: null,
  };
}

function answer(
  question_id: string,
  participant_id: string,
  overrides: { is_correct?: boolean; points?: number } = {},
): import("@/lib/quiz/results").ResultAnswer {
  return {
    question_id,
    participant_id,
    is_correct: overrides.is_correct ?? true,
    points: overrides.points ?? 1000,
    response_ms: 1000,
  };
}

function participant(id: string, nickname = "Player"): import("@/lib/quiz/results").ResultParticipant {
  return { id, nickname, score: 0, joined_at: new Date().toISOString(), avatar_id: null, team_id: null };
}

const Q1 = question("q1");          // mcq, 1000 pts
const Q2 = question("q2");          // mcq, 1000 pts
const Q3 = question("q3", { point_value: 2000, double_points: true });
const FB = question("fb", { question_type: "feedback", point_value: 0 });

describe("categorized results grouped from saved snapshot", () => {
  test("groups questions by section from snapshot, not current quiz", () => {
    const snap = snapshot("categorized", [
      section("s1", "History", 0, ["q1", "q2"]),
      section("s2", "Sports", 1, ["q3"]),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, Q2, Q3],
      answers: [answer("q1", "p1"), answer("q2", "p1"), answer("q3", "p2")],
      participants: [participant("p1"), participant("p2")],
    });

    expect(result.presentationMode).toBe("categorized");
    expect(result.sections.map((s) => ({ id: s.id, title: s.title }))).toEqual([
      { id: "s1", title: "History" },
      { id: "s2", title: "Sports" },
    ]);
    expect(result.sections[0].questionIds).toEqual(["q1", "q2"]);
    expect(result.sections[1].questionIds).toEqual(["q3"]);
  });

  test("preserves section order captured at session start", () => {
    const snap = snapshot("categorized", [
      section("s2", "Sports", 1, ["q3"]),
      section("s1", "History", 0, ["q1", "q2"]),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, Q2, Q3],
      answers: [],
      participants: [],
    });
    expect(result.sections.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  test("preserves original section titles (already normalized at build time)", () => {
    const snap = snapshot("categorized", [
      section("s1", "Round 1", 0, ["q1"]),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1],
      answers: [],
      participants: [],
    });
    expect(result.sections[0].title).toBe("Round 1");
  });

  test("question membership preserved even if the quiz was edited later", () => {
    // q3 belongs to s2 in the snapshot, even though current quiz lists it in s1.
    const snap = snapshot("categorized", [
      section("s1", "History", 0, ["q1", "q2"]),
      section("s2", "Sports", 1, ["q3"]),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, Q2, Q3],
      answers: [answer("q3", "p1")],
      participants: [participant("p1")],
    });
    expect(result.sections[0].scoredQuestionIds).toEqual(["q1", "q2"]);
    expect(result.sections[1].scoredQuestionIds).toEqual(["q3"]);
    // q3 is not reported under History.
    expect(result.sections[0].scoredQuestionIds).not.toContain("q3");
  });
});

describe("flat sessions retain existing behaviour", () => {
  test("flat sessions have no section-based reporting", () => {
    const result = computeSessionSectionResults({
      snapshot: snapshot("flat"),
      questions: [Q1, Q2],
      answers: [answer("q1", "p1")],
      participants: [participant("p1")],
    });
    expect(result.presentationMode).toBe("flat");
    expect(result.sections).toEqual([]);
    expect(result.participantSections).toEqual([]);
    expect(result.questions).toEqual([]);
  });

  test("session with no snapshot degrades to empty sections", () => {
    const result = computeSessionSectionResults({
      snapshot: null,
      questions: [Q1],
      answers: [],
      participants: [],
    });
    expect(result.presentationMode).toBe("flat");
    expect(result.sections).toEqual([]);
  });
});

describe("empty sections", () => {
  test("keeps empty sections visible with zero metrics", () => {
    const snap = snapshot("categorized", [
      section("s1", "History", 0, ["q1"]),
      section("s2", "Empty", 1, []),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1],
      answers: [],
      participants: [participant("p1")],
    });
    expect(result.sections).toHaveLength(2);
    const empty = result.sections.find((s) => s.id === "s2");
    expect(empty?.totalScoredQuestions).toBe(0);
    expect(empty?.pointsEarned).toBe(0);
    expect(empty?.accuracy).toEqual({ available: false, value: 0 });
    expect(empty?.questionsWithNoAnswers).toBe(0);
  });

  test("participant rows still exist for every section including empty ones", () => {
    const snap = snapshot("categorized", [
      section("s1", "History", 0, ["q1"]),
      section("s2", "Empty", 1, []),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1],
      answers: [answer("q1", "p1")],
      participants: [participant("p1")],
    });
    const rows = result.participantSections.filter((r) => r.participantId === "p1");
    expect(rows.map((r) => r.sectionId)).toEqual(["s1", "s2"]);
    expect(rows.find((r) => r.sectionId === "s2")?.answered).toBe(0);
  });
});

describe("unanswered questions", () => {
  test("counts unanswered when nobody answers a scored question", () => {
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q1"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1],
      answers: [],
      participants: [participant("p1"), participant("p2")],
    });
    const s = result.sections[0];
    expect(s.questionsWithNoAnswers).toBe(1);
    expect(s.totalAnswers).toBe(0);
    expect(s.totalCorrect).toBe(0);
    expect(s.totalIncorrect).toBe(0);
    expect(s.accuracy).toEqual({ available: false, value: 0 });
  });

  test("participant unanswered count reflects answered questions", () => {
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q1", "q2"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, Q2],
      answers: [answer("q1", "p1")],
      participants: [participant("p1")],
    });
    const r = result.participantSections.find((x) => x.sectionId === "s1" && x.participantId === "p1");
    expect(r?.answered).toBe(1);
    expect(r?.unanswered).toBe(1);
    expect(r?.accuracy).toEqual({ available: true, value: 100 });
  });
});

describe("feedback questions excluded from scored metrics", () => {
  test("excludes feedback from scored-question totals and accuracy", () => {
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q1", "fb"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, FB],
      answers: [answer("q1", "p1", { is_correct: false }), answer("fb", "p1")],
      participants: [participant("p1")],
    });
    const s = result.sections[0];
    expect(s.totalScoredQuestions).toBe(1);
    expect(s.totalAnswers).toBe(1);
    expect(s.totalCorrect).toBe(0);
    expect(s.totalIncorrect).toBe(1);
    expect(s.accuracy).toEqual({ available: true, value: 0 });
  });

  test("feedback answers do not count as correct or incorrect", () => {
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q1", "fb"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, FB],
      answers: [answer("q1", "p1", { is_correct: true }), answer("fb", "p1", { is_correct: true })],
      participants: [participant("p1")],
    });
    const s = result.sections[0];
    expect(s.totalCorrect).toBe(1);
    expect(s.totalIncorrect).toBe(0);
  });
});

describe("double-points questions", () => {
  test("uses actual recorded points for double-points questions", () => {
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q3"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q3],
      answers: [answer("q3", "p1", { points: 1800 })],
      participants: [participant("p1")],
    });
    const s = result.sections[0];
    expect(s.pointsEarned).toBe(1800);
    const r = result.participantSections.find((x) => x.participantId === "p1");
    expect(r?.pointsEarned).toBe(1800);
  });
});

describe("actual recorded points used in reporting", () => {
  test("sums recorded points across participants and sections", () => {
    const snap = snapshot("categorized", [
      section("s1", "History", 0, ["q1", "q2"]),
      section("s2", "Sports", 1, ["q3"]),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, Q2, Q3],
      answers: [
        answer("q1", "p1", { points: 800 }),
        answer("q2", "p1", { points: 900 }),
        answer("q3", "p2", { points: 1500 }),
      ],
      participants: [participant("p1"), participant("p2")],
    });
    expect(result.sections[0].pointsEarned).toBe(1700);
    expect(result.sections[1].pointsEarned).toBe(1500);
    const r1 = result.participantSections.find((x) => x.participantId === "p1" && x.sectionId === "s1");
    expect(r1?.pointsEarned).toBe(1700);
    const r2 = result.participantSections.find((x) => x.participantId === "p2" && x.sectionId === "s2");
    expect(r2?.pointsEarned).toBe(1500);
  });

  test("does not recalculate points using today's scoring rules", () => {
    // The recorded `points` column value is used verbatim, never recomputed.
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q1"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1],
      answers: [answer("q1", "p1", { points: 42 })],
      participants: [participant("p1")],
    });
    expect(result.sections[0].pointsEarned).toBe(42);
  });
});

describe("missing or malformed snapshots", () => {
  test("null snapshot yields empty sections", () => {
    const result = computeSessionSectionResults({
      snapshot: null,
      questions: [Q1],
      answers: [],
      participants: [],
    });
    expect(result.sections).toEqual([]);
  });

  test("categorized with an empty sections array yields no sections", () => {
    const result = computeSessionSectionResults({
      snapshot: snapshot("categorized", []),
      questions: [Q1],
      answers: [],
      participants: [],
    });
    expect(result.sections).toEqual([]);
  });
});

describe("participant-level section calculations", () => {
  test("reports answered, correct, incorrect, unanswered, accuracy and points per section", () => {
    const snap = snapshot("categorized", [
      section("s1", "History", 0, ["q1", "q2"]),
      section("s2", "Sports", 1, ["q3"]),
    ]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1, Q2, Q3],
      answers: [
        answer("q1", "p1", { is_correct: true, points: 800 }),
        answer("q2", "p1", { is_correct: false, points: 0 }),
        answer("q3", "p1", { is_correct: true, points: 1800 }),
      ],
      participants: [participant("p1")],
    });
    const rows = result.participantSections.filter((r) => r.participantId === "p1");
    const h = rows.find((r) => r.sectionId === "s1");
    expect(h?.answered).toBe(2);
    expect(h?.correct).toBe(1);
    expect(h?.incorrect).toBe(1);
    expect(h?.unanswered).toBe(0);
    expect(h?.accuracy).toEqual({ available: true, value: 50 });
    expect(h?.pointsEarned).toBe(800);

    const s = rows.find((r) => r.sectionId === "s2");
    expect(s?.answered).toBe(1);
    expect(s?.correct).toBe(1);
    expect(s?.incorrect).toBe(0);
    expect(s?.unanswered).toBe(0);
    expect(s?.accuracy).toEqual({ available: true, value: 100 });
    expect(s?.pointsEarned).toBe(1800);
  });

  test("unanswered participant accuracy is unavailable, not zero", () => {
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q1"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1],
      answers: [],
      participants: [participant("p1")],
    });
    const r = result.participantSections.find((x) => x.participantId === "p1" && x.sectionId === "s1");
    expect(r?.answered).toBe(0);
    expect(r?.accuracy).toEqual({ available: false, value: 0 });
  });
});

describe("host authorization / data types", () => {
  test("SectionResult exposes section metadata and aggregates", () => {
    const snap = snapshot("categorized", [section("s1", "History", 0, ["q1"])]);
    const result = computeSessionSectionResults({
      snapshot: snap,
      questions: [Q1],
      answers: [answer("q1", "p1")],
      participants: [participant("p1")],
    });
    const s: SectionResult = result.sections[0];
    expect(s.id).toBe("s1");
    expect(s.title).toBe("History");
    expect(s.position).toBe(0);
    expect(s.totalScoredQuestions).toBe(1);
    expect(s.totalAnswers).toBe(1);
  });
});
