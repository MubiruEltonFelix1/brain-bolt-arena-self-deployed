// Quiz sections — shared pure helpers for categorized quizzes (Phase 12).
//
// Scope: AUTHORING ONLY. Nothing here is imported by the host or player routes
// yet, and nothing here changes gameplay. Sessions still consume the existing
// flattened `sessions.question_order` jsonb array of question ids.
//
// Why a separate module: the editor UI, the CSV importer/exporter, the
// pre-start validation gate and the Phase-2 session snapshot all need to agree
// on three things, and they must agree *exactly*:
//
//   1. what "section order" means          -> sortSections / compareSections
//   2. how questions bucket into sections  -> groupQuestions
//   3. when a categorized quiz is startable -> validateQuizSections
//
// Duplicating those rules per call site is how the "empty section is fine on
// one screen but blocks play on another" class of bug happens.

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

/** Authoring layout of a quiz. Mirrors `quizzes.question_flow`. */
export type QuestionFlow = "flat" | "categorized";

export const QUESTION_FLOWS: readonly QuestionFlow[] = ["flat", "categorized"] as const;

export function isQuestionFlow(value: unknown): value is QuestionFlow {
  return value === "flat" || value === "categorized";
}

/** Row shape of `public.quiz_sections`. */
export type QuizSection = {
  id: string;
  quiz_id: string;
  title: string;
  position: number;
  created_at: string;
};

/**
 * The only question fields the sectioning rules look at. Deliberately narrow so
 * callers can pass full `Question` rows, minimal select results, or fixtures.
 */
export type SectionableQuestion = {
  id: string;
  position: number;
  /** `false` = stored but excluded from play. Missing/undefined reads as included. */
  is_playable?: boolean | null;
  question_type: string;
  section_id?: string | null;
};

/** A question row is treated as included unless explicitly excluded. */
export function isPlayable(q: SectionableQuestion): boolean {
  return q.is_playable !== false;
}

/** Feedback/opinion slides are shown during play but never scored. */
export function isFeedback(q: SectionableQuestion): boolean {
  return q.question_type === "feedback";
}

/* ------------------------------------------------------------------ */
/* Titles                                                             */
/* ------------------------------------------------------------------ */

export const SECTION_TITLE_MAX = 80;
export const SECTION_TITLE_FALLBACK = "Untitled section";

/**
 * Canonical stored form: trimmed, with internal whitespace runs collapsed to a
 * single space. Collapsing matters beyond tidiness — CSV rows are matched to
 * sections by title, so "Round  1" and " Round 1 " must land in one section
 * rather than silently creating two.
 */
export function normalizeSectionTitle(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/** Case-insensitive identity used for de-duplicating / CSV matching. */
export function sectionTitleKey(raw: string | null | undefined): string {
  return normalizeSectionTitle(raw).toLowerCase();
}

/** True when the title would satisfy the DB CHECK constraint. */
export function isValidSectionTitle(raw: string | null | undefined): boolean {
  const t = normalizeSectionTitle(raw);
  return t.length >= 1 && t.length <= SECTION_TITLE_MAX;
}

/* ------------------------------------------------------------------ */
/* Ordering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Deterministic section order: `position`, then `created_at`, then `id`.
 *
 * `position` is intentionally NOT unique in the schema (mirroring
 * `questions.position`, which has no UNIQUE(quiz_id, position) either). Two
 * sections can therefore transiently share a rank while the client reorders
 * them, and the read order must still be stable rather than
 * whatever-the-planner-returns. `id` is the final tiebreaker so the order is
 * total, not merely a partial preorder.
 */
export function compareSections(
  a: Pick<QuizSection, "position" | "created_at" | "id">,
  b: Pick<QuizSection, "position" | "created_at" | "id">,
): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortSections<T extends Pick<QuizSection, "position" | "created_at" | "id">>(
  sections: readonly T[],
): T[] {
  return [...sections].sort(compareSections);
}

/** Next free section rank — max(position) + 1, or 0 for the first section. */
export function nextSectionPosition(sections: readonly Pick<QuizSection, "position">[]): number {
  return sections.reduce((max, s) => (s.position > max ? s.position : max), -1) + 1;
}

/* ------------------------------------------------------------------ */
/* Grouping                                                           */
/* ------------------------------------------------------------------ */

export type QuestionBucketOf<Q extends SectionableQuestion> = {
  /** `null` = the "Ungrouped" bucket. */
  section: QuizSection | null;
  /** Ascending by the question's global `position`. */
  questions: Q[];
};

export type QuestionGroupingOf<Q extends SectionableQuestion> = {
  /** Every section in canonical order, each with its questions (possibly empty). */
  buckets: QuestionBucketOf<Q>[];
  /** Bucket for questions with no section, or null when nothing is ungrouped. */
  ungrouped: QuestionBucketOf<Q> | null;
  /** The same questions in one flat list in categorized presentation order. */
  flatOrder: Q[];
  /** question.id -> its section, for questions whose section_id is dangling. */
  orphanedSectionIds: Map<string, string>;
};

export type QuestionBucket = QuestionBucketOf<SectionableQuestion>;
export type QuestionGrouping = QuestionGroupingOf<SectionableQuestion>;

/**
 * Buckets questions under their sections.
 *
 * Generic over the question type, so a caller holding full `Question` rows gets
 * `Question` rows back and can render them without a cast.
 *
 * Ordering inside a bucket is the question's global `position`, so
 * `questions.position` stays the single source of intra-section order and the
 * existing ▲/▼ reorder controls keep working untouched.
 *
 * A question whose `section_id` does not resolve to one of this quiz's sections
 * is treated as ungrouped AND reported in `orphanedSectionIds`. The composite
 * FK makes that state unreachable in the database; this is defence against a
 * stale client cache, not a supported state.
 */
export function groupQuestions<Q extends SectionableQuestion>(
  sections: readonly QuizSection[],
  questions: readonly Q[],
): QuestionGroupingOf<Q> {
  const ordered = sortSections(sections);
  const buckets = new Map<string, Q[]>(ordered.map((s) => [s.id, []] as const));
  const ungroupedQuestions: Q[] = [];
  const orphanedSectionIds = new Map<string, string>();

  const byPosition = [...questions].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const q of byPosition) {
    const sectionId = q.section_id ?? null;
    if (sectionId === null) {
      ungroupedQuestions.push(q);
      continue;
    }
    const bucket = buckets.get(sectionId);
    if (!bucket) {
      orphanedSectionIds.set(q.id, sectionId);
      ungroupedQuestions.push(q);
      continue;
    }
    bucket.push(q);
  }

  const groupedBuckets: QuestionBucketOf<Q>[] = ordered.map((s) => ({
    section: s,
    questions: buckets.get(s.id) ?? [],
  }));

  const ungrouped: QuestionBucketOf<Q> | null = ungroupedQuestions.length
    ? { section: null, questions: ungroupedQuestions }
    : null;

  // Categorized presentation order: sections in rank order, questions within a
  // section by global position, then anything ungrouped last.
  //
  // Ungrouped-last is not an invention of this feature — it is what the host
  // already does for feedback slides when it lazily backfills a missing
  // `question_order` (host.$sessionId.tsx "feedback/opinion questions always
  // last"). Keeping the same placement means a categorized quiz with ungrouped
  // feedback behaves the way hosts already expect.
  const flatOrder = [
    ...groupedBuckets.flatMap((b) => b.questions),
    ...(ungrouped?.questions ?? []),
  ];

  return { buckets: groupedBuckets, ungrouped, flatOrder, orphanedSectionIds };
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

export type SectionIssueCode =
  | "no_playable_questions"
  | "blank_section_title"
  | "duplicate_section_title"
  | "duplicate_section_position"
  | "empty_section"
  | "question_without_section"
  | "invalid_section_reference"
  | "ungrouped_feedback";

export type SectionIssue = {
  code: SectionIssueCode;
  /** Ready-to-render sentence — the editor shows these verbatim. */
  message: string;
  sectionId?: string;
  questionIds?: string[];
  /** 1-based numbers as they appear in the editor's flat question list. */
  questionNumbers?: number[];
};

export type SectionValidation = {
  /** True when the categorized quiz may be started. */
  ok: boolean;
  errors: SectionIssue[];
  warnings: SectionIssue[];
  /** Playable questions belonging to a valid section. */
  groupedPlayableCount: number;
  /** Playable questions with no section (feedback only, by design). */
  ungroupedPlayableCount: number;
};

export type SectionValidationInput = {
  flow: QuestionFlow;
  sections: readonly QuizSection[];
  /** Pass the editor's flat question list; order defines the displayed numbers. */
  questions: readonly SectionableQuestion[];
};

/**
 * Format 1-based question numbers for a message: "Question 4", "Questions 4
 * and 9", "Questions 4-7".
 */
export function formatQuestionNumbers(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return "No questions";
  if (sorted.length === 1) return `Question ${sorted[0]}`;

  // Collapse runs of 3+ consecutive numbers to "a–c".
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) {
      parts.push(`${sorted[i]}-${sorted[j]}`);
      i = j + 1;
    } else {
      parts.push(String(sorted[i]));
      i++;
    }
  }

  if (parts.length === 1) return `Questions ${parts[0]}`;
  return `Questions ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Validates a quiz for grouped play.
 *
 * FLAT QUIZZES ARE NEVER VALIDATED. The first branch returns a clean pass for
 * `flow === 'flat'`, which is what keeps every pre-existing quiz startable
 * exactly as before — no section data, no new blocking condition.
 *
 * Documented rules (each surfaced as an actionable message, never as a silent
 * fix):
 *
 *   R1  A quiz needs at least one playable question.                          [error]
 *   R2  Section titles must be non-blank after whitespace normalization.      [error]
 *   R3  Every playable SCORED question must belong to one of this quiz's
 *       sections.                                                             [error]
 *   R4  A question's section must exist in this quiz (dangling reference).    [error]
 *   R5  Playable FEEDBACK slides may be left ungrouped. They are not forced
 *       into an invented section; they play after the last section.           [warning]
 *   R6  EMPTY SECTIONS ARE PERMITTED. A section with no questions contributes
 *       no rounds; it is kept so an owner can build a quiz in stages.         [warning]
 *   R7  Duplicate section titles are permitted (titles are labels, not keys)
 *       but make CSV `section` matching ambiguous.                            [warning]
 *   R8  Duplicate section positions are permitted; canonical order breaks the
 *       tie by created_at then id, so ordering stays deterministic.           [warning]
 *
 * Excluded questions (`is_playable === false`) are ignored entirely: they are
 * stored content that never reaches play, so they never block a start and never
 * need a section.
 */
export function validateQuizSections(input: SectionValidationInput): SectionValidation {
  const { flow, sections, questions } = input;
  const pass: SectionValidation = {
    ok: true,
    errors: [],
    warnings: [],
    groupedPlayableCount: 0,
    ungroupedPlayableCount: 0,
  };

  if (flow === "flat") return pass;

  const errors: SectionIssue[] = [];
  const warnings: SectionIssue[] = [];

  const orderedSections = sortSections(sections);
  const sectionIds = new Set(orderedSections.map((s) => s.id));

  // Number questions the way the editor displays them: 1-based, flat order.
  const numberById = new Map<string, number>();
  questions.forEach((q, i) => numberById.set(q.id, i + 1));

  const playable = questions.filter(isPlayable);

  // R1
  if (playable.length === 0) {
    errors.push({
      code: "no_playable_questions",
      message:
        "This categorized quiz has no playable questions. Include at least one question before starting.",
    });
  }

  // R2
  const blankSections = orderedSections.filter((s) => !isValidSectionTitle(s.title));
  if (blankSections.length > 0) {
    errors.push({
      code: "blank_section_title",
      message:
        blankSections.length === 1
          ? `Section ${orderedSections.indexOf(blankSections[0]) + 1} has no name. Give every section a name.`
          : `${blankSections.length} sections have no name. Give every section a name.`,
      sectionId: blankSections[0].id,
    });
  }

  // R7 — duplicate titles (ignoring blank ones, already reported).
  const seenTitles = new Map<string, QuizSection[]>();
  for (const s of orderedSections) {
    const key = sectionTitleKey(s.title);
    if (!key) continue;
    const list = seenTitles.get(key) ?? [];
    list.push(s);
    seenTitles.set(key, list);
  }
  for (const [, dupes] of seenTitles) {
    if (dupes.length < 2) continue;
    const names = dupes.map((s) => `#${orderedSections.indexOf(s) + 1}`).join(", ");
    warnings.push({
      code: "duplicate_section_title",
      message: `Sections ${names} share the name “${normalizeSectionTitle(dupes[0].title)}”. That is allowed, but a CSV \`section\` column cannot tell them apart.`,
      sectionId: dupes[0].id,
    });
  }

  // R8 — duplicate positions.
  const positions = new Map<number, number>();
  for (const s of orderedSections) positions.set(s.position, (positions.get(s.position) ?? 0) + 1);
  const sharedPositions = [...positions.entries()].filter(([, n]) => n > 1).map(([p]) => p);
  if (sharedPositions.length > 0) {
    warnings.push({
      code: "duplicate_section_position",
      message: `Some sections share an order rank (${sharedPositions.join(", ")}). They still sort deterministically, but reordering one may look like it "didn't move" next to the other.`,
    });
  }

  // R3 / R4 / R5 — question assignment.
  const missingSection: number[] = [];
  const danglingSection: Array<{ number: number; sectionId: string; id: string }> = [];
  const ungroupedFeedback: number[] = [];
  let groupedPlayableCount = 0;

  for (const q of playable) {
    const number = numberById.get(q.id) ?? 0;
    const sectionId = q.section_id ?? null;

    if (sectionId === null) {
      if (isFeedback(q)) ungroupedFeedback.push(number);
      else missingSection.push(number);
      continue;
    }
    if (!sectionIds.has(sectionId)) {
      danglingSection.push({ number, sectionId, id: q.id });
      continue;
    }
    groupedPlayableCount += 1;
  }

  if (missingSection.length > 0) {
    errors.push({
      code: "question_without_section",
      message: `${formatQuestionNumbers(missingSection)} ${
        missingSection.length === 1 ? "is" : "are"
      } included in play but not in any section. Assign ${missingSection.length === 1 ? "it" : "them"} to a section, or exclude ${missingSection.length === 1 ? "it" : "them"} from play.`,
      questionNumbers: missingSection,
    });
  }

  if (danglingSection.length > 0) {
    errors.push({
      code: "invalid_section_reference",
      message: `${formatQuestionNumbers(danglingSection.map((d) => d.number))} ${
        danglingSection.length === 1 ? "points" : "point"
      } at a section that no longer exists in this quiz. Re-assign ${
        danglingSection.length === 1 ? "it" : "them"
      } to an existing section.`,
      questionIds: danglingSection.map((d) => d.id),
      questionNumbers: danglingSection.map((d) => d.number),
    });
  }

  if (ungroupedFeedback.length > 0) {
    warnings.push({
      code: "ungrouped_feedback",
      message: `${formatQuestionNumbers(ungroupedFeedback)} ${
        ungroupedFeedback.length === 1 ? "is a" : "are"
      } feedback slide with no section. ${
        ungroupedFeedback.length === 1 ? "It plays" : "They play"
      } after the last section. Assign a section to place ${
        ungroupedFeedback.length === 1 ? "it" : "them"
      } inside the running order.`,
      questionNumbers: ungroupedFeedback,
    });
  }

  // R6 — empty sections (allowed, reported so the owner can see the effect).
  const grouping = groupQuestions(orderedSections, questions);
  for (const bucket of grouping.buckets) {
    if (!bucket.section) continue;
    if (bucket.questions.length > 0) continue;
    warnings.push({
      code: "empty_section",
      message: `Section “${normalizeSectionTitle(bucket.section.title)}” has no questions and will be skipped during play.`,
      sectionId: bucket.section.id,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    groupedPlayableCount,
    ungroupedPlayableCount: ungroupedFeedback.length,
  };
}

/* ------------------------------------------------------------------ */
/* Pre-start gate                                                     */
/* ------------------------------------------------------------------ */

/**
 * `null` when the quiz may be started, otherwise the first blocking sentence.
 *
 * Used by the session-creation path so a categorized quiz cannot be silently
 * flattened into an arbitrary question order by starting it with ungrouped or
 * mis-referenced questions.
 */
export function firstBlockingSectionError(validation: SectionValidation): string | null {
  return validation.errors.length > 0 ? validation.errors[0].message : null;
}

/** Convenience wrapper: returns the blocking message, or null when startable. */
export function blockReasonForStart(input: SectionValidationInput): string | null {
  return firstBlockingSectionError(validateQuizSections(input));
}

/* ------------------------------------------------------------------ */
/* Session snapshot                                                   */
/* ------------------------------------------------------------------ */

/**
 * A single section as captured in an immutable session snapshot.
 */
export interface SectionSnapshotEntry {
  id: string;
  title: string;
  position: number;
  question_ids: string[];
}

/**
 * The immutable section structure captured at session creation. Stored as
 * `sessions.section_snapshot` and used by host/player clients to reproduce
 * the original section presentation for the life of the session.
 */
export interface SessionSnapshot {
  presentation_mode: QuestionFlow;
  sections: SectionSnapshotEntry[];
}

/** Result of building a session snapshot and its flat question order. */
export type BuildSessionSnapshotResult = {
  /** `null` for flat quizzes; the full section structure for categorized. */
  snapshot: SessionSnapshot | null;
  /** Flat array of playable question ids in presentation order. */
  questionOrder: string[];
};

/**
 * Builds the immutable session snapshot and the flat `question_order` array
 * from a categorized quiz's sections and questions.
 *
 * For flat quizzes the snapshot is `null` and the question order is the
 * questions in position order (the caller applies `seededShuffle` separately,
 * preserving existing flat-quiz behaviour).
 *
 * For categorized quizzes:
 *   * sections are emitted in canonical order (position, created_at, id);
 *   * questions within each section are emitted by `position`, then `id`;
 *   * all playable questions appear exactly once in `questionOrder`;
 *   * playable questions not belonging to any section (scored ones should not
 *     exist here because validation runs first, but feedback can be ungrouped)
 *     are appended at the end so nothing is silently dropped.
 *
 * This is the single authoritative ordering rule. Dashboard-created and
 * competition-created sessions must both use it (via this function or its
 * SQL equivalent) so the two paths never diverge.
 */
export function buildSessionSnapshot(
  flow: QuestionFlow,
  sections: readonly QuizSection[],
  questions: readonly SectionableQuestion[],
): BuildSessionSnapshotResult {
  const playable = questions.filter(isPlayable);

  if (flow === "flat") {
    return {
      snapshot: null,
      questionOrder: playable
        .slice()
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map((q) => q.id),
    };
  }

  const ordered = sortSections(sections);
  const sectionEntries: SectionSnapshotEntry[] = [];
  const questionOrder: string[] = [];
  const assignedIds = new Set<string>();

  for (const section of ordered) {
    const bucket = playable
      .filter((q) => q.section_id === section.id)
      .slice()
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const questionIds = bucket.map((q) => q.id);
    sectionEntries.push({
      id: section.id,
      title: normalizeSectionTitle(section.title),
      position: section.position,
      question_ids: questionIds,
    });
    questionOrder.push(...questionIds);
    for (const id of questionIds) assignedIds.add(id);
  }

  // Ungrouped playable questions (scored ones should not reach here because
  // validateQuizSections runs first, but feedback may be ungrouped). Append at
  // the end so no playable question is silently dropped.
  const ungrouped = playable
    .filter((q) => !assignedIds.has(q.id))
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  questionOrder.push(...ungrouped.map((q) => q.id));

  const snapshot: SessionSnapshot = {
    presentation_mode: "categorized",
    sections: sectionEntries,
  };

  return { snapshot, questionOrder };
}
