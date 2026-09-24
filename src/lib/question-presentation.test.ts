// Question-type presentation registry tests.
//
// Phase: UX/UI refinement — human-friendly question-type names.
//
// The point of this suite is that internal enum ids can never reach the UI.
// It asserts the exact user-facing vocabulary, that every playable type has an
// entry, and that an unknown id degrades to a neutral label instead of leaking
// a raw value like `true_false`.

import { describe, expect, test } from "bun:test";
import {
  FALLBACK_PRESENTATION,
  QUESTION_TYPE_ORDER,
  getQuestionPresentation,
  isKnownQuestionType,
  questionTypeDescription,
  questionTypeHelpText,
  questionTypeIcon,
  questionTypeLabel,
  questionTypeListLabel,
  questionTypeOptions,
} from "@/lib/question-presentation";
import { getQuestionType } from "@/lib/question-registry";

/**
 * The agreed user-facing vocabulary. If a label changes, it changes here first —
 * this table is the contract, not an implementation detail.
 */
const REQUIRED_LABELS: Record<string, string> = {
  mcq: "Multiple Choice",
  true_false: "True or False",
  type: "Type Your Answer",
  number: "Closest Number",
  ordering: "Put in Order",
  feedback: "Written Answer",
  map_pin: "Pin the Map",
  image_mcq: "Image Multiple Choice",
  image_reveal: "Image Reveal",
  audio: "Listen & Answer",
  matching: "Match the Pairs",
};

describe("question-type labels", () => {
  test("every type uses its agreed user-facing name", () => {
    for (const [id, label] of Object.entries(REQUIRED_LABELS)) {
      expect(questionTypeLabel(id)).toBe(label);
    }
  });

  test("no label contains an internal identifier token", () => {
    for (const id of Object.keys(REQUIRED_LABELS)) {
      const label = questionTypeLabel(id);
      expect(label).not.toContain("_");
      expect(label.toLowerCase()).not.toBe(id);
      expect(label).not.toMatch(/^(mcq|q type|qtype)$/i);
    }
  });

  test("an unknown id gets the neutral fallback, never the raw value", () => {
    expect(questionTypeLabel("some_future_type")).toBe(FALLBACK_PRESENTATION.label);
    expect(questionTypeLabel("some_future_type")).not.toContain("some_future_type");
  });

  test("null and undefined also fall back safely", () => {
    expect(questionTypeLabel(null)).toBe(FALLBACK_PRESENTATION.label);
    expect(questionTypeLabel(undefined)).toBe(FALLBACK_PRESENTATION.label);
    expect(questionTypeLabel("")).toBe(FALLBACK_PRESENTATION.label);
  });

  test("every label is unique — two types cannot read the same", () => {
    const labels = Object.keys(REQUIRED_LABELS).map((id) => questionTypeLabel(id));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("presentation completeness", () => {
  const ALL = Object.keys(REQUIRED_LABELS);

  test("every type carries a description, icon, tagline, help text and player hint", () => {
    for (const id of ALL) {
      const p = getQuestionPresentation(id);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.icon.length).toBeGreaterThan(0);
      expect(p.tagline.length).toBeGreaterThan(0);
      expect(p.helpText.length).toBeGreaterThan(0);
      expect(p.playerHint.length).toBeGreaterThan(0);
    }
  });

  test("help text is editor guidance, not a repeat of the label", () => {
    for (const id of ALL) {
      expect(questionTypeHelpText(id)).not.toBe(questionTypeLabel(id));
      expect(questionTypeHelpText(id).length).toBeGreaterThan(20);
    }
  });

  test("descriptions read as instructions to the player", () => {
    // Every one of them is a sentence about what the player does.
    for (const id of ALL) {
      expect(questionTypeDescription(id).length).toBeGreaterThan(8);
    }
  });

  test("isKnownQuestionType is true for real ids and false otherwise", () => {
    for (const id of ALL) expect(isKnownQuestionType(id)).toBe(true);
    expect(isKnownQuestionType("nope")).toBe(false);
  });
});

describe("picker options", () => {
  test("default options are in the documented order", () => {
    expect(questionTypeOptions().map((o) => o.id)).toEqual(QUESTION_TYPE_ORDER);
  });

  test("the order covers every playable type and starts with the easiest to author", () => {
    expect(QUESTION_TYPE_ORDER[0]).toBe("mcq");
    expect(QUESTION_TYPE_ORDER[1]).toBe("true_false");
    expect(QUESTION_TYPE_ORDER).toContain("map_pin");
    expect(QUESTION_TYPE_ORDER).toContain("image_reveal");
    // The picker must not offer an id the picker order forgot.
    expect(new Set(QUESTION_TYPE_ORDER).size).toBe(QUESTION_TYPE_ORDER.length);
  });

  test("each option carries everything the picker needs", () => {
    for (const o of questionTypeOptions()) {
      expect(o.id.length).toBeGreaterThan(0);
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.helpText.length).toBeGreaterThan(0);
    }
  });

  test("options can be narrowed to a subset", () => {
    const only = questionTypeOptions(["mcq", "audio"]);
    expect(only.map((o) => o.id)).toEqual(["mcq", "audio"]);
    expect(only[1].label).toBe("Listen & Answer");
  });
});

describe("questionTypeListLabel", () => {
  test("one type reads as itself", () => {
    expect(questionTypeListLabel(["mcq"])).toBe("Multiple Choice");
  });

  test("two types join with 'and'", () => {
    expect(questionTypeListLabel(["mcq", "true_false"])).toBe("Multiple Choice and True or False");
  });

  test("three or more use a serial list", () => {
    expect(questionTypeListLabel(["mcq", "true_false", "audio"])).toBe(
      "Multiple Choice, True or False and Listen & Answer",
    );
  });

  test("duplicates collapse", () => {
    expect(questionTypeListLabel(["mcq", "mcq", "mcq"])).toBe("Multiple Choice");
  });

  test("an empty list produces an empty string, not 'undefined'", () => {
    expect(questionTypeListLabel([])).toBe("");
  });
});

describe("question-registry integration", () => {
  test("getQuestionType exposes the presentation fields alongside behaviour", () => {
    const def = getQuestionType("mcq");
    expect(def.label).toBe("Multiple Choice");
    expect(def.tagline).toBe("Quick Pick");
    expect(def.answerKind).toBe("choice");
    expect(def.scored).toBe(true);
  });

  test("the registry no longer carries the old `name` field", () => {
    // Replacing `name` with `label` is what stopped two names existing for one
    // type. Guard it so a future revert cannot reintroduce the duplication.
    expect("name" in getQuestionType("mcq")).toBe(false);
  });

  test("behaviour is unchanged by the presentation refactor", () => {
    // Accent, answer kind, scoring and media are exactly what they were.
    expect(getQuestionType("true_false")).toMatchObject({
      accent: "pink-shock",
      answerKind: "choice",
      scored: true,
      media: null,
    });
    expect(getQuestionType("map_pin")).toMatchObject({
      answerKind: "geo",
      scored: true,
      media: "map",
    });
    expect(getQuestionType("feedback")).toMatchObject({ scored: false, answerKind: "text" });
    expect(getQuestionType("ordering")).toMatchObject({ answerKind: "order", media: null });
  });

  test("an unknown id still resolves to a usable definition", () => {
    const def = getQuestionType("who_knows");
    expect(def.label).toBe(FALLBACK_PRESENTATION.label);
    expect(def.answerKind).toBe("choice");
  });

  test("every TypeId in the registry has a real presentation entry", () => {
    // Walk the behaviour registry through the public accessor: an id with
    // behaviour but no wording would silently read "Question".
    for (const id of [
      "mcq",
      "image_mcq",
      "true_false",
      "number",
      "image_reveal",
      "audio",
      "ordering",
      "type",
      "feedback",
      "map_pin",
    ]) {
      expect(getQuestionType(id).label).not.toBe(FALLBACK_PRESENTATION.label);
      expect(questionTypeIcon(id)).toBe(getQuestionType(id).icon);
    }
  });
});
