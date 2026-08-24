// Phase 8B lifecycle tests: list/get/update/archive + question management,
// exercised against the in-memory fake Supabase client (principal resolution,
// can() capability checks, ownership, archive state, positions, validation).

import { describe, expect, test } from "bun:test";
import { saveQuizWithClient } from "../src/supabase";
import {
  addQuestions,
  archiveQuiz,
  getQuiz,
  listQuizzes,
  removeQuestion,
  reorderQuestions,
  updateQuestion,
  updateQuiz,
} from "../src/lifecycle";
import {
  dbQuestionRowToCamel,
  questionToDbRow,
  type BrainBoltQuestion,
  type BrainBoltQuiz,
} from "../src/schema";
import { asClient, createFakeDb, FakeSupabase, seedUser, type FakeDb } from "./fake-supabase";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_HOST = "22222222-2222-2222-2222-222222222222";
const NO_ROLE_USER = "33333333-3333-3333-3333-333333333333";
const GHOST = "44444444-4444-4444-4444-444444444444";
const ADMIN = "55555555-5555-5555-5555-555555555555";
const MISSING = "99999999-9999-9999-9999-999999999999";

const QUIZ: BrainBoltQuiz = {
  title: "Solar System Smash",
  description: "Planets",
  timePerQuestionSec: 20,
  difficulty: "medium",
  questions: [
    {
      type: "mcq",
      text: "Which planet is the Red Planet?",
      options: ["Venus", "Mars"],
      correctIndex: 1,
    },
    { type: "true_false", text: "The Earth is round.", correct: true },
  ],
};

function makeEnv() {
  const db = createFakeDb();
  seedUser(db, OWNER, ["host"]);
  seedUser(db, OTHER_HOST, ["host"]);
  seedUser(db, NO_ROLE_USER);
  const client = asClient(new FakeSupabase(db));
  return { db, client };
}

async function saveOwnedQuiz(
  client: ReturnType<typeof asClient>,
  title = QUIZ.title,
  questions: BrainBoltQuestion[] = QUIZ.questions,
) {
  return saveQuizWithClient(client, { ...QUIZ, title, questions }, { ownerId: OWNER });
}

function questionIdsOf(db: FakeDb, quizId: string): string[] {
  return db.questions
    .filter((q) => q.quiz_id === quizId)
    .sort((a, b) => (a.position as number) - (b.position as number))
    .map((q) => q.id as string);
}

/* ------------------------------------------------------------------ */
/* save_quiz against the fake (principal + host gate + trigger)         */
/* ------------------------------------------------------------------ */

describe("save_quiz lifecycle gate", () => {
  test("saves a quiz with owner_principal_id (principal-first; legacy mirror derived)", async () => {
    const { db, client } = makeEnv();
    const result = await saveOwnedQuiz(client);
    expect(result.quizId).toBeTruthy();
    expect(result.questionCount).toBe(2);
    const quiz = db.quizzes[0]!;
    expect(quiz.owner_id).toBe(OWNER);
    expect(quiz.owner_principal_id).toBe(OWNER);
    expect(db.questions.filter((q) => q.quiz_id === result.quizId)).toHaveLength(2);
  });

  test("rejects an owner without the host capability — nothing written", async () => {
    const { db, client } = makeEnv();
    await expect(saveQuizWithClient(client, QUIZ, { ownerId: NO_ROLE_USER })).rejects.toThrow(
      "host capability",
    );
    expect(db.quizzes).toHaveLength(0);
  });

  test("rejects an owner without a user principal", async () => {
    const { db, client } = makeEnv();
    await expect(saveQuizWithClient(client, QUIZ, { ownerId: GHOST })).rejects.toThrow(
      "no user principal",
    );
    expect(db.quizzes).toHaveLength(0);
  });

  test("saves 30 questions but rejects 31", async () => {
    const { client } = makeEnv();
    const many = Array.from({ length: 31 }, (_, i): BrainBoltQuestion => ({
      type: "mcq",
      text: `q${i}`,
      options: ["a", "b"],
      correctIndex: 0,
    }));
    await expect(
      saveQuizWithClient(client, { title: "big", questions: many }, { ownerId: OWNER }),
    ).rejects.toThrow("validation errors");
    const ok = many.slice(0, 30);
    const res = await saveQuizWithClient(
      client,
      { title: "big", questions: ok },
      { ownerId: OWNER },
    );
    expect(res.questionCount).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* list_quizzes                                                         */
/* ------------------------------------------------------------------ */

describe("list_quizzes", () => {
  test("lists only the acting principal's quizzes with question counts", async () => {
    const { client } = makeEnv();
    await saveOwnedQuiz(client, "One");
    await saveOwnedQuiz(client, "Two");
    await saveQuizWithClient(client, { ...QUIZ, title: "Other's" }, { ownerId: OTHER_HOST });

    const mine = await listQuizzes(client, { actorId: OWNER });
    expect(mine.count).toBe(2);
    expect(mine.items.map((i) => i.title).sort()).toEqual(["One", "Two"]);
    expect(mine.items.every((i) => i.questionCount === 2)).toBe(true);

    const theirs = await listQuizzes(client, { actorId: OTHER_HOST });
    expect(theirs.items.map((i) => i.title)).toEqual(["Other's"]);
  });

  test("search filters by title substring (case-insensitive)", async () => {
    const { client } = makeEnv();
    await saveOwnedQuiz(client, "Solar System Smash");
    await saveOwnedQuiz(client, "Deep Sea Dive");
    const result = await listQuizzes(client, { actorId: OWNER, search: "solar" });
    expect(result.items.map((i) => i.title)).toEqual(["Solar System Smash"]);
  });

  test("archived filter separates archived from live quizzes", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client, "Live");
    await saveOwnedQuiz(client, "Doomed");
    await archiveQuiz(client, { actorId: OWNER, quizId });

    const live = await listQuizzes(client, { actorId: OWNER, archived: false });
    const archived = await listQuizzes(client, { actorId: OWNER, archived: true });
    const both = await listQuizzes(client, { actorId: OWNER });
    expect(live.items.map((i) => i.title)).toEqual(["Doomed"]);
    expect(archived.items.map((i) => i.title)).toEqual(["Live"]);
    expect(both.count).toBe(2);
  });

  test("difficulty and isArena filters", async () => {
    const { client } = makeEnv();
    await saveOwnedQuiz(client, "Easy One");
    await saveOwnedQuiz(client, "Hard One");
    await client.from("quizzes").update({ difficulty: "hard" }).eq("title", "Hard One");
    await client.from("quizzes").update({ is_arena: true }).eq("title", "Easy One");

    const hard = await listQuizzes(client, { actorId: OWNER, difficulty: "hard" });
    expect(hard.items.map((i) => i.title)).toEqual(["Hard One"]);
    const arena = await listQuizzes(client, { actorId: OWNER, isArena: true });
    expect(arena.items.map((i) => i.title)).toEqual(["Easy One"]);
  });

  test("respects limit", async () => {
    const { client } = makeEnv();
    await saveOwnedQuiz(client, "A");
    await saveOwnedQuiz(client, "B");
    await saveOwnedQuiz(client, "C");
    const result = await listQuizzes(client, { actorId: OWNER, limit: 2 });
    expect(result.items).toHaveLength(2);
  });

  test("rejects an actor without a principal", async () => {
    const { client } = makeEnv();
    await expect(listQuizzes(client, { actorId: GHOST })).rejects.toThrow("no user principal");
  });
});

/* ------------------------------------------------------------------ */
/* get_quiz                                                             */
/* ------------------------------------------------------------------ */

describe("get_quiz", () => {
  test("owner reads the full quiz with questions round-tripped to camelCase", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const { quiz, questions } = await getQuiz(client, { actorId: OWNER, quizId });

    expect(quiz.id).toBe(quizId);
    expect(quiz.title).toBe("Solar System Smash");
    expect(quiz.difficulty).toBe("medium");
    expect(quiz.archived).toBe(false);
    expect(quiz.questionCount).toBe(2);
    expect(questions).toHaveLength(2);
    const first = questions[0] as Extract<BrainBoltQuestion, { type: "mcq" }>;
    expect(first.type).toBe("mcq");
    expect(first.options).toEqual(["Venus", "Mars"]);
    expect(first.correctIndex).toBe(1);
    const second = questions[1] as Extract<BrainBoltQuestion, { type: "true_false" }>;
    expect(second.type).toBe("true_false");
    expect(second.correct).toBe(true);
  });

  test("non-owner is denied even with host capability", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(getQuiz(client, { actorId: OTHER_HOST, quizId })).rejects.toThrow(
      "not authorized to read",
    );
  });

  test("missing quiz reports existence, not a generic denial", async () => {
    const { client } = makeEnv();
    await expect(getQuiz(client, { actorId: OWNER, quizId: MISSING })).rejects.toThrow(
      "does not exist",
    );
  });

  test("includeAnswers=false strips answer keys", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const { questions, includeAnswers } = await getQuiz(client, {
      actorId: OWNER,
      quizId,
      includeAnswers: false,
    });
    expect(includeAnswers).toBe(false);
    const mcq = questions[0] as Record<string, unknown>;
    expect(mcq.options).toEqual(["Venus", "Mars"]);
    expect(mcq.correctIndex).toBeUndefined();
    const tf = questions[1] as Record<string, unknown>;
    expect(tf.correct).toBeUndefined();
  });

  test("archived quizzes stay readable by the owner", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await archiveQuiz(client, { actorId: OWNER, quizId });
    const { quiz } = await getQuiz(client, { actorId: OWNER, quizId });
    expect(quiz.archived).toBe(true);
    expect(quiz.archivedAt).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* update_quiz                                                          */
/* ------------------------------------------------------------------ */

describe("update_quiz", () => {
  test("patches only the supplied fields", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const result = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch: { title: "Renamed" },
    });
    expect(result.changed).toEqual({ title: true });
    const row = db.quizzes.find((q) => q.id === quizId)!;
    expect(row.title).toBe("Renamed");
    expect(row.description).toBe("Planets");
    expect(row.time_per_question).toBe(20);
    expect(row.difficulty).toBe("medium");
  });

  test("updates every supported field and reports changed flags", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const result = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch: { description: null, difficulty: "hard", timePerQuestionSec: 45 },
    });
    expect(result.changed).toEqual({
      description: true,
      difficulty: true,
      timePerQuestionSec: true,
    });
    const row = db.quizzes.find((q) => q.id === quizId)!;
    expect(row.description).toBeNull();
    expect(row.difficulty).toBe("hard");
    expect(row.time_per_question).toBe(45);
  });

  test("rejects an empty patch", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(updateQuiz(client, { actorId: OWNER, quizId, patch: {} })).rejects.toThrow(
      "at least one field",
    );
  });

  test("rejects out-of-range values with field-level errors", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(
      updateQuiz(client, { actorId: OWNER, quizId, patch: { timePerQuestionSec: 121 } }),
    ).rejects.toThrow("timePerQuestionSec must be an integer between 5 and 120");
    await expect(
      updateQuiz(client, {
        actorId: OWNER,
        quizId,
        patch: { difficulty: "impossible" as never },
      }),
    ).rejects.toThrow("difficulty must be easy, medium or hard");
    await expect(
      updateQuiz(client, { actorId: OWNER, quizId, patch: { title: "   " } }),
    ).rejects.toThrow("title must be a non-empty string");
  });

  test("a no-op patch reports a warning and writes nothing", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const result = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch: { title: QUIZ.title },
    });
    expect(result.changed).toEqual({ title: false });
    expect(result.warnings[0]).toContain("nothing changed");
  });

  test("non-owner is denied", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(
      updateQuiz(client, { actorId: OTHER_HOST, quizId, patch: { title: "Hijack" } }),
    ).rejects.toThrow("not authorized to update");
  });
});

/* ------------------------------------------------------------------ */
/* archive_quiz                                                         */
/* ------------------------------------------------------------------ */

describe("archive_quiz", () => {
  test("archives and hides from live lists", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const result = await archiveQuiz(client, { actorId: OWNER, quizId });
    expect(result.changed).toEqual({ archived: true, archivedAt: expect.any(String) });
    expect(db.quizzes.find((q) => q.id === quizId)!.archived_at as string | null).toBeTruthy();
    const live = await listQuizzes(client, { actorId: OWNER, archived: false });
    expect(live.items).toHaveLength(0);
    const archived = await listQuizzes(client, { actorId: OWNER, archived: true });
    expect(archived.items.map((i) => i.id)).toEqual([quizId]);
  });

  test("re-archiving is a harmless no-op with a warning", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await archiveQuiz(client, { actorId: OWNER, quizId });
    const again = await archiveQuiz(client, { actorId: OWNER, quizId });
    expect(again.changed).toEqual({ archived: false });
    expect(again.warnings[0]).toContain("already archived");
  });

  test("non-owner cannot archive", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(archiveQuiz(client, { actorId: OTHER_HOST, quizId })).rejects.toThrow(
      "not authorized to archive",
    );
  });
});

/* ------------------------------------------------------------------ */
/* add_questions                                                        */
/* ------------------------------------------------------------------ */

describe("add_questions", () => {
  test("appends validated questions at the end", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const result = await addQuestions(client, {
      actorId: OWNER,
      quizId,
      questions: [
        {
          type: "number",
          text: "How many moons does Mars have?",
          correctNumber: 2,
          min: 0,
          max: 10,
        },
        { type: "ordering", text: "Order these", items: ["a", "b", "c"] },
      ],
    });
    expect(result.changed).toEqual({ added: 2, questionCount: 4 });
    const ids = questionIdsOf(db, quizId);
    expect(ids).toHaveLength(4);
    const rows = db.questions
      .filter((q) => q.quiz_id === quizId)
      .sort((a, b) => (a.position as number) - (b.position as number));
    expect(rows[2]!.question_type).toBe("number");
    expect(rows[2]!.position).toBe(2);
    expect(rows[3]!.question_type).toBe("ordering");
    expect(rows[3]!.options).toEqual(["a", "b", "c"]);
  });

  test("rejects invalid question data — nothing written", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(
      addQuestions(client, {
        actorId: OWNER,
        quizId,
        questions: [{ type: "mcq", text: "bad", options: ["a", "b"], correctIndex: 9 }],
      }),
    ).rejects.toThrow("correctIndex");
    expect(db.questions.filter((q) => q.quiz_id === quizId)).toHaveLength(2);
  });

  test("rejects invalid media URLs", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(
      addQuestions(client, {
        actorId: OWNER,
        quizId,
        questions: [{ type: "image_mcq", text: "pic", options: ["a", "b"], correctIndex: 0 }],
      }),
    ).rejects.toThrow("media");
    expect(db.questions.filter((q) => q.quiz_id === quizId)).toHaveLength(2);
  });

  test("refuses to exceed the 30-question cap", async () => {
    const { client } = makeEnv();
    const many = Array.from({ length: 29 }, (_, i): BrainBoltQuestion => ({
      type: "mcq",
      text: `q${i}`,
      options: ["a", "b"],
      correctIndex: 0,
    }));
    const { quizId } = await saveOwnedQuiz(client, "Big", many);
    await expect(
      addQuestions(client, {
        actorId: OWNER,
        quizId,
        questions: [
          { type: "mcq", text: "x", options: ["a", "b"], correctIndex: 0 },
          { type: "mcq", text: "y", options: ["a", "b"], correctIndex: 0 },
        ],
      }),
    ).rejects.toThrow("exceed the 30");
  });

  test("non-owner is denied", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    await expect(
      addQuestions(client, {
        actorId: OTHER_HOST,
        quizId,
        questions: [{ type: "mcq", text: "x", options: ["a", "b"], correctIndex: 0 }],
      }),
    ).rejects.toThrow("not authorized");
  });
});

/* ------------------------------------------------------------------ */
/* update_question                                                      */
/* ------------------------------------------------------------------ */

describe("update_question", () => {
  test("patches a question and persists the merged row", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const questionId = questionIdsOf(db, quizId)[0]!;
    const result = await updateQuestion(client, {
      actorId: OWNER,
      quizId,
      questionId,
      patch: { text: "Renamed question?", options: ["Mars", "Venus"], correctIndex: 0 },
    });
    expect(result.changed).toEqual({ text: true, options: true, correctIndex: true });
    const row = db.questions.find((q) => q.id === questionId)!;
    expect(row.text).toBe("Renamed question?");
    expect(row.options).toEqual(["Mars", "Venus"]);
    expect(row.correct_index).toBe(0);
  });

  test("rejects a type change — types are immutable", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const questionId = questionIdsOf(db, quizId)[0]!;
    await expect(
      updateQuestion(client, {
        actorId: OWNER,
        quizId,
        questionId,
        patch: { type: "number" },
      }),
    ).rejects.toThrow("immutable");
  });

  test("rejects a merged question that fails validation", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const questionId = questionIdsOf(db, quizId)[0]!;
    await expect(
      updateQuestion(client, {
        actorId: OWNER,
        quizId,
        questionId,
        patch: { options: ["only-one"] },
      }),
    ).rejects.toThrow("would be invalid");
  });

  test("rejects invalid media on an existing image question", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const { data } = await client
      .from("questions")
      .insert({
        quiz_id: quizId,
        text: "pic",
        question_type: "image_mcq",
        options: ["a", "b"],
        correct_index: 0,
        position: 2,
        point_value: 1000,
      })
      .select("id")
      .single();
    await expect(
      updateQuestion(client, {
        actorId: OWNER,
        quizId,
        questionId: data!.id as string,
        patch: { imageUrl: "http://insecure.example/x.jpg" },
      }),
    ).rejects.toThrow("would be invalid");
  });

  test("ignores fields that do not apply to the type, with a warning", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const questionId = questionIdsOf(db, quizId)[1]!; // true_false
    const result = await updateQuestion(client, {
      actorId: OWNER,
      quizId,
      questionId,
      patch: { text: "Still true.", correctIndex: 0 },
    });
    expect(result.changed).toEqual({ text: true });
    expect(result.warnings[0]).toContain("correctIndex");
    expect(result.warnings[0]).toContain("ignored");
  });

  test("refuses a question that belongs to another quiz", async () => {
    const { client } = makeEnv();
    const a = await saveOwnedQuiz(client, "A");
    const b = await saveOwnedQuiz(client, "B");
    const { data } = await client.from("questions").select("id").eq("quiz_id", a.quizId).limit(1);
    await expect(
      updateQuestion(client, {
        actorId: OWNER,
        quizId: b.quizId,
        questionId: (data![0] as { id: string }).id,
        patch: { text: "crossing" },
      }),
    ).rejects.toThrow("belongs to quiz");
  });

  test("warns and ignores unit on a number question — no unit column exists in the DB", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const { data } = await client
      .from("questions")
      .insert({
        quiz_id: quizId,
        text: "How old?",
        question_type: "number",
        options: ["general"],
        correct_index: -1,
        correct_number: 5,
        number_min: 0,
        number_max: 10,
        position: 2,
        point_value: 1000,
      })
      .select("id")
      .single();
    const result = await updateQuestion(client, {
      actorId: OWNER,
      quizId,
      questionId: data!.id as string,
      patch: { unit: "years", text: "How old (updated)?" },
    });
    expect(result.changed).toEqual({ text: true });
    expect(result.warnings[0]).toContain("unit");
    expect(result.warnings[0]).toContain("ignored");
    const row = db.questions.find((q) => q.id === data!.id)!;
    expect(row.unit).toBeUndefined();
  });

  test("patches isPlayable=false and persists the playable flag", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const questionId = questionIdsOf(db, quizId)[0]!;
    const result = await updateQuestion(client, {
      actorId: OWNER,
      quizId,
      questionId,
      patch: { isPlayable: false },
    });
    expect(result.changed).toEqual({ isPlayable: true });
    const row = db.questions.find((q) => q.id === questionId)!;
    expect(row.is_playable).toBe(false);
  });

  test("non-owner is denied", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const questionId = questionIdsOf(db, quizId)[0]!;
    await expect(
      updateQuestion(client, {
        actorId: OTHER_HOST,
        quizId,
        questionId,
        patch: { text: "hijack" },
      }),
    ).rejects.toThrow("not authorized");
  });
});

/* ------------------------------------------------------------------ */
/* remove_question                                                      */
/* ------------------------------------------------------------------ */

describe("remove_question", () => {
  test("removes a question and renumbers positions", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const first = questionIdsOf(db, quizId)[0]!;
    const result = await removeQuestion(client, { actorId: OWNER, quizId, questionId: first });
    expect(result.changed).toEqual({ removed: true, questionCount: 1 });
    const remaining = questionIdsOf(db, quizId);
    expect(remaining).toHaveLength(1);
    expect(db.questions.find((q) => q.id === remaining[0])!.position).toBe(0);
  });

  test("refuses to remove the last question", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const ids = questionIdsOf(db, quizId);
    await removeQuestion(client, { actorId: OWNER, quizId, questionId: ids[0]! });
    await expect(
      removeQuestion(client, { actorId: OWNER, quizId, questionId: ids[1]! }),
    ).rejects.toThrow("last question");
  });

  test("non-owner is denied", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const first = questionIdsOf(db, quizId)[0]!;
    await expect(
      removeQuestion(client, { actorId: OTHER_HOST, quizId, questionId: first }),
    ).rejects.toThrow("not authorized");
  });
});

/* ------------------------------------------------------------------ */
/* reorder_questions                                                    */
/* ------------------------------------------------------------------ */

describe("reorder_questions", () => {
  test("rewrites positions to the given order", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const ids = questionIdsOf(db, quizId);
    const result = await reorderQuestions(client, {
      actorId: OWNER,
      quizId,
      questionIds: [ids[1]!, ids[0]!],
    });
    expect(result.changed).toEqual({ order: [ids[1]!, ids[0]!], changed: true });
    expect(questionIdsOf(db, quizId)).toEqual([ids[1]!, ids[0]!]);
  });

  test("rejects a partial or mismatched id set", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const ids = questionIdsOf(db, quizId);
    await expect(
      reorderQuestions(client, { actorId: OWNER, quizId, questionIds: [ids[0]!] }),
    ).rejects.toThrow("exactly 2 question ids");
    await expect(
      reorderQuestions(client, {
        actorId: OWNER,
        quizId,
        questionIds: [ids[0]!, MISSING],
      }),
    ).rejects.toThrow("does not match");
    await expect(
      reorderQuestions(client, {
        actorId: OWNER,
        quizId,
        questionIds: [ids[0]!, ids[0]!],
      }),
    ).rejects.toThrow("duplicates");
  });

  test("a same-order call is a no-op with a warning", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const ids = questionIdsOf(db, quizId);
    const result = await reorderQuestions(client, { actorId: OWNER, quizId, questionIds: ids });
    expect(result.changed).toEqual({ order: ids, changed: false });
    expect(result.warnings[0]).toContain("nothing changed");
  });

  test("non-owner is denied", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveOwnedQuiz(client);
    const ids = questionIdsOf(db, quizId);
    await expect(
      reorderQuestions(client, { actorId: OTHER_HOST, quizId, questionIds: ids }),
    ).rejects.toThrow("not authorized");
  });
});

/* ------------------------------------------------------------------ */
/* admin principal (Phase 8B §14: admin retains capabilities)           */
/* ------------------------------------------------------------------ */

describe("admin principal", () => {
  test("an admin who owns a quiz retains full lifecycle capability", async () => {
    const { db, client } = makeEnv();
    seedUser(db, ADMIN, ["admin"]);

    // save_quiz: admin holds the host capability (admin implies host in can()).
    const { quizId } = await saveQuizWithClient(
      client,
      { ...QUIZ, title: "Admin's quiz" },
      { ownerId: ADMIN },
    );

    // list + get
    const list = await listQuizzes(client, { actorId: ADMIN });
    expect(list.items.map((i) => i.id)).toEqual([quizId]);
    const { quiz, questions } = await getQuiz(client, { actorId: ADMIN, quizId });
    expect(quiz.title).toBe("Admin's quiz");
    expect(questions).toHaveLength(2);

    // update
    const upd = await updateQuiz(client, { actorId: ADMIN, quizId, patch: { difficulty: "hard" } });
    expect(upd.changed).toEqual({ difficulty: true });

    // question management: add → update → reorder
    const added = await addQuestions(client, {
      actorId: ADMIN,
      quizId,
      questions: [{ type: "mcq", text: "Extra", options: ["a", "b"], correctIndex: 0 }],
    });
    expect(added.changed).toEqual({ added: 1, questionCount: 3 });
    const extraId = questionIdsOf(db, quizId)[2]!;
    const updated = await updateQuestion(client, {
      actorId: ADMIN,
      quizId,
      questionId: extraId,
      patch: { text: "Extra (edited)" },
    });
    expect(updated.changed).toEqual({ text: true });
    const reordered = await reorderQuestions(client, {
      actorId: ADMIN,
      quizId,
      questionIds: [...questionIdsOf(db, quizId).reverse()],
    });
    expect(reordered.changed).toEqual(expect.objectContaining({ changed: true }));

    // archive + archived read
    const archived = await archiveQuiz(client, { actorId: ADMIN, quizId });
    expect(archived.changed).toEqual({ archived: true, archivedAt: expect.any(String) });
    const after = await getQuiz(client, { actorId: ADMIN, quizId });
    expect(after.quiz.archived).toBe(true);
  });

  test("admin capability does not bypass quiz ownership", async () => {
    const { db, client } = makeEnv();
    seedUser(db, ADMIN, ["admin"]);
    const { quizId } = await saveOwnedQuiz(client); // owned by OWNER, not ADMIN

    await expect(
      updateQuiz(client, { actorId: ADMIN, quizId, patch: { title: "Hijack" } }),
    ).rejects.toThrow("not authorized to update");
    await expect(archiveQuiz(client, { actorId: ADMIN, quizId })).rejects.toThrow(
      "not authorized to archive",
    );
    await expect(getQuiz(client, { actorId: ADMIN, quizId })).rejects.toThrow(
      "not authorized to read",
    );

    // The owner's quiz is untouched.
    const { quiz } = await getQuiz(client, { actorId: OWNER, quizId });
    expect(quiz.title).toBe(QUIZ.title);
  });
});

/* ------------------------------------------------------------------ */
/* db row ↔ camel round-trip for every question type                    */
/* ------------------------------------------------------------------ */

describe("question row round-trip (all types)", () => {
  const ALL_TYPES: BrainBoltQuestion[] = [
    { type: "mcq", text: "m", options: ["a", "b"], correctIndex: 1, pointValue: 1000 },
    {
      type: "image_mcq",
      text: "im",
      options: ["a", "b"],
      correctIndex: 0,
      imageUrl: "https://img.fakecdn.dev/x.jpg",
    },
    { type: "true_false", text: "tf", correct: false, timeLimitSec: 30 },
    {
      type: "number",
      text: "n",
      correctNumber: 5,
      min: 0,
      max: 10,
      tolerance: 1,
      format: "year",
    },
    {
      type: "image_reveal",
      text: "ir",
      options: ["a", "b"],
      correctIndex: 1,
      imageUrl: "https://img.fakecdn.dev/r.jpg",
      revealStages: 5,
    },
    {
      type: "audio",
      text: "au",
      options: ["a", "b"],
      correctIndex: 0,
      audioUrl: "https://audio.fakecdn.dev/s.mp3",
    },
    { type: "ordering", text: "o", items: ["one", "two", "three"], doublePoints: true },
    { type: "type", text: "t", acceptedAnswers: ["apple", "an apple"] },
    { type: "feedback", text: "f" },
    { type: "map_pin", text: "mp", lat: 35.6, lng: 139.6, maxDistanceKm: 400 },
  ];

  test.each(ALL_TYPES.map((q) => [q.type, q] as const))("round-trips %s", (_type, q) => {
    const row = questionToDbRow(q, 3);
    expect(row.position).toBe(3);
    const back = dbQuestionRowToCamel(row);
    const b = back as Record<string, unknown>;

    expect(back.type).toBe(q.type);
    expect(back.text).toBe(q.text);
    expect(back.pointValue).toBe(q.type === "feedback" ? 0 : (q.pointValue ?? 1000));
    if (q.type !== "feedback") {
      expect(back.timeLimitSec).toBe(q.timeLimitSec);
      expect(back.doublePoints).toBe(q.doublePoints);
    }
    switch (q.type) {
      case "mcq":
      case "image_mcq":
      case "image_reveal":
      case "audio":
        expect(b.options).toEqual(q.options);
        expect(b.correctIndex).toBe(q.correctIndex);
        expect(b.imageUrl).toBe("imageUrl" in q ? q.imageUrl : undefined);
        if (q.type === "image_reveal") expect(b.revealStages).toBe(5);
        if (q.type === "audio") expect(b.audioUrl).toBe(q.audioUrl);
        break;
      case "true_false":
        expect(b.correct).toBe(false);
        break;
      case "number":
        expect(b.correctNumber).toBe(5);
        expect(b.min).toBe(0);
        expect(b.max).toBe(10);
        expect(b.tolerance).toBe(1);
        expect(b.format).toBe("year");
        break;
      case "map_pin":
        expect(b.lat).toBe(35.6);
        expect(b.lng).toBe(139.6);
        expect(b.maxDistanceKm).toBe(400);
        break;
      case "type":
        expect(b.acceptedAnswers).toEqual(["apple", "an apple"]);
        break;
      case "ordering":
        expect(b.items).toEqual(["one", "two", "three"]);
        break;
      case "feedback":
        break;
    }
  });

  test("saved questions survive a get → save round-trip", async () => {
    const { client } = makeEnv();
    const first = await saveQuizWithClient(
      client,
      { title: "rt", questions: ALL_TYPES },
      { ownerId: OWNER },
    );
    const { questions } = await getQuiz(client, { actorId: OWNER, quizId: first.quizId });
    expect(questions).toHaveLength(ALL_TYPES.length);

    const second = await saveQuizWithClient(
      client,
      { title: "rt2", questions: questions as BrainBoltQuestion[] },
      { ownerId: OWNER },
    );
    const { questions: again } = await getQuiz(client, { actorId: OWNER, quizId: second.quizId });
    expect(again).toHaveLength(ALL_TYPES.length);
    expect((again[0] as Extract<BrainBoltQuestion, { type: "mcq" }>).correctIndex).toBe(1);
    expect((again[6] as BrainBoltQuestion).type).toBe("ordering");
    expect((again[6] as BrainBoltQuestion).doublePoints).toBe(true);
  });
});
