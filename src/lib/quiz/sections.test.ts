// Unit tests for the quiz-section rules (Phase 12).
//
// These lock the invariants the requirement calls out explicitly:
//   * a flat quiz is never validated, so every existing quiz stays startable;
//   * an existing question with no section stays valid;
//   * ungrouped SCORED questions block a start, ungrouped FEEDBACK does not;
//   * feedback slides are never forced into an invented section;
//   * section order is deterministic even with duplicate ranks;
//   * empty sections are permitted and reported, not fatal.
import { describe, expect, test } from "bun:test";
import {
  groupQuestions,
  formatQuestionNumbers,
  isValidSectionTitle,
  nextSectionPosition,
  normalizeSectionTitle,
  sectionTitleKey,
  sortSections,
  validateQuizSections,
  type QuizSection,
  type SectionableQuestion,
} from "./sections";

function section(
  id: string,
  title: string,
  position: number,
  createdAt = "2026-01-01T00:00:00.000Z",
): QuizSection {
  return { id, quiz_id: "quiz-1", title, position, created_at: createdAt };
}

function q(
  id: string,
  position: number,
  overrides: Partial<SectionableQuestion> = {},
): SectionableQuestion {
  return {
    id,
    position,
    question_type: "mcq",
    is_playable: true,
    section_id: null,
    ...overrides,
  };
}

describe("title normalisation", () => {
  test("trims and collapses internal whitespace", () => {
    expect(normalizeSectionTitle("  Round   1  ")).toBe("Round 1");
    expect(normalizeSectionTitle("Round\n\t1")).toBe("Round 1");
    expect(normalizeSectionTitle(null)).toBe("");
  });

  test("matching keys are case- and whitespace-insensitive", () => {
    expect(sectionTitleKey(" ROUND  1 ")).toBe(sectionTitleKey("round 1"));
    expect(sectionTitleKey("Round 1")).not.toBe(sectionTitleKey("Round 2"));
  });

  test("blank and over-long titles are invalid", () => {
    expect(isValidSectionTitle("")).toBe(false);
    expect(isValidSectionTitle("   ")).toBe(false);
    expect(isValidSectionTitle("Round 1")).toBe(true);
    expect(isValidSectionTitle("x".repeat(81))).toBe(false);
  });
});

describe("section ordering", () => {
  test("sorts by position, then created_at, then id", () => {
    const a = section("c", "Third", 2, "2026-01-01T00:00:00.000Z");
    const b = section("a", "First", 0, "2026-01-01T00:00:00.000Z");
    const c = section("b", "Second", 1, "2026-01-01T00:00:00.000Z");
    expect(sortSections([a, b, c]).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("duplicate positions tie-break deterministically by created_at then id", () => {
    const later = section("z", "Later", 0, "2026-02-01T00:00:00.000Z");
    const earlier = section("y", "Earlier", 0, "2026-01-01T00:00:00.000Z");
    const sameTimeA = section("a", "A", 0, "2026-01-15T00:00:00.000Z");
    const sameTimeB = section("b", "B", 0, "2026-01-15T00:00:00.000Z");
    const once = sortSections([later, earlier, sameTimeB, sameTimeA]).map((s) => s.id);
    const again = sortSections([sameTimeA, later, sameTimeB, earlier]).map((s) => s.id);
    expect(once).toEqual(["y", "a", "b", "z"]);
    expect(again).toEqual(once); // order is stable regardless of input order
  });

  test("nextSectionPosition appends after the current maximum", () => {
    expect(nextSectionPosition([])).toBe(0);
    expect(nextSectionPosition([section("a", "A", 0), section("b", "B", 4)])).toBe(5);
  });
});

describe("grouping", () => {
  const sections = [section("s2", "Second", 1), section("s1", "First", 0)];

  test("buckets follow section order and question position order", () => {
    const grouping = groupQuestions(sections, [
      q("q3", 2, { section_id: "s2" }),
      q("q1", 0, { section_id: "s1" }),
      q("q2", 1, { section_id: "s1" }),
    ]);
    expect(grouping.buckets.map((b) => b.section?.id)).toEqual(["s1", "s2"]);
    expect(grouping.buckets[0].questions.map((x) => x.id)).toEqual(["q1", "q2"]);
    expect(grouping.buckets[1].questions.map((x) => x.id)).toEqual(["q3"]);
    expect(grouping.ungrouped).toBeNull();
  });

  test("empty sections still appear, with no questions", () => {
    const grouping = groupQuestions(sections, [q("q1", 0, { section_id: "s1" })]);
    expect(grouping.buckets).toHaveLength(2);
    expect(grouping.buckets[1].questions).toEqual([]);
  });

  test("ungrouped questions are collected and sorted last in flatOrder", () => {
    const grouping = groupQuestions(sections, [
      q("loose", 0),
      q("grouped", 1, { section_id: "s1" }),
    ]);
    expect(grouping.ungrouped?.questions.map((x) => x.id)).toEqual(["loose"]);
    expect(grouping.flatOrder.map((x) => x.id)).toEqual(["grouped", "loose"]);
  });

  test("a dangling section reference is treated as ungrouped and reported", () => {
    const grouping = groupQuestions(sections, [q("q1", 0, { section_id: "gone" })]);
    expect(grouping.ungrouped?.questions.map((x) => x.id)).toEqual(["q1"]);
    expect(grouping.orphanedSectionIds.get("q1")).toBe("gone");
  });

  test("preserves the concrete question type for callers", () => {
    type FullQuestion = SectionableQuestion & { text: string };
    const full: FullQuestion = { ...q("q1", 0, { section_id: "s1" }), text: "Hi?" };
    const grouping = groupQuestions(sections, [full]);
    // Compile-time check: this is a FullQuestion, not the narrowed base type.
    const text: string = grouping.buckets[0].questions[0].text;
    expect(text).toBe("Hi?");
  });
});

describe("validation", () => {
  const sections = [section("s1", "Round 1", 0), section("s2", "Round 2", 1)];

  test("a flat quiz is never validated", () => {
    const result = validateQuizSections({
      flow: "flat",
      sections: [],
      // Deliberately nonsense for a categorized quiz — a flat quiz must ignore it.
      questions: [q("a", 0), q("b", 1, { section_id: "nope" })],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a flat quiz with zero questions is still not validated", () => {
    expect(validateQuizSections({ flow: "flat", sections: [], questions: [] }).ok).toBe(true);
  });

  test("a fully grouped categorized quiz passes", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections,
      questions: [q("a", 0, { section_id: "s1" }), q("b", 1, { section_id: "s2" })],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.groupedPlayableCount).toBe(2);
  });

  test("a playable scored question with no section blocks the start", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections,
      questions: [q("a", 0, { section_id: "s1" }), q("b", 1)],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["question_without_section"]);
    // Actionable: the message names the affected question by its 1-based number.
    expect(result.errors[0].message).toContain("Question 2");
  });

  test("an ungrouped feedback slide is a warning, not an error", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections,
      questions: [
        q("a", 0, { section_id: "s1" }),
        q("fb", 1, { question_type: "feedback" }),
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual([
      "ungrouped_feedback",
      "empty_section",
    ]);
    expect(result.ungroupedPlayableCount).toBe(1);
  });

  test("an excluded question with no section is ignored entirely", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections,
      questions: [
        q("a", 0, { section_id: "s1" }),
        q("off", 1, { is_playable: false }),
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["empty_section"]);
  });

  test("a dangling section reference blocks the start", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections,
      questions: [q("a", 0, { section_id: "gone" })],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["invalid_section_reference"]);
  });

  test("a blank section title blocks the start", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections: [section("s1", "   ", 0)],
      questions: [q("a", 0, { section_id: "s1" })],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("blank_section_title");
  });

  test("no playable questions blocks the start", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections,
      questions: [q("a", 0, { is_playable: false })],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["no_playable_questions"]);
  });

  test("empty sections are permitted but reported", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections,
      questions: [q("a", 0, { section_id: "s1" })],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(["empty_section"]);
    expect(result.warnings[0].message).toContain("Round 2");
  });

  test("duplicate section titles and ranks are warnings, not errors", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections: [section("s1", "Round", 0), section("s2", " round ", 0)],
      questions: [q("a", 0, { section_id: "s1" }), q("b", 1, { section_id: "s2" })],
    });
    expect(result.ok).toBe(true);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("duplicate_section_title");
    expect(codes).toContain("duplicate_section_position");
  });

  test("classification respects the section list, not just non-nullness", () => {
    const result = validateQuizSections({
      flow: "categorized",
      sections: [section("s1", "Round 1", 0)],
      questions: [
        q("a", 0, { section_id: "s1" }),
        q("b", 1, { section_id: "elsewhere" }),
      ],
    });
    expect(result.groupedPlayableCount).toBe(1);
    expect(result.ok).toBe(false);
  });
});

describe("formatQuestionNumbers", () => {
  test("singular, pair, range and mixed forms", () => {
    expect(formatQuestionNumbers([4])).toBe("Question 4");
    expect(formatQuestionNumbers([9, 4])).toBe("Questions 4 and 9");
    expect(formatQuestionNumbers([4, 5, 6])).toBe("Questions 4-6");
    expect(formatQuestionNumbers([1, 2, 5, 9])).toBe("Questions 1, 2, 5 and 9");
    expect(formatQuestionNumbers([])).toBe("No questions");
  });

  test("de-duplicates and sorts", () => {
    expect(formatQuestionNumbers([5, 5, 2])).toBe("Questions 2 and 5");
  });
});
