// Phase 8B idempotency tests: retries with the same key + payload replay the
// stored result; key reuse with a different payload is rejected; failed runs
// free the key; stale keys expire; pending keys block concurrent duplicates.

import { describe, expect, test } from "bun:test";
import { requestHash, stableStringify, withIdempotency } from "../src/idempotency";
import {
  addQuestions,
  archiveQuiz,
  updateQuiz,
} from "../src/lifecycle";
import { saveQuizWithClient } from "../src/supabase";
import type { BrainBoltQuiz } from "../src/schema";
import { asClient, createFakeDb, FakeSupabase, seedUser } from "./fake-supabase";

const OWNER = "11111111-1111-1111-1111-111111111111";

const QUIZ: BrainBoltQuiz = {
  title: "Solar System Smash",
  questions: [
    { type: "mcq", text: "Red planet?", options: ["Venus", "Mars"], correctIndex: 1 },
    { type: "true_false", text: "Earth is round.", correct: true },
  ],
};

function makeEnv() {
  const db = createFakeDb();
  seedUser(db, OWNER, ["host"]);
  const client = asClient(new FakeSupabase(db));
  return { db, client };
}

describe("stableStringify / requestHash", () => {
  test("equal logical payloads hash identically regardless of key order", () => {
    expect(stableStringify({ a: 1, b: { c: [1, 2] } })).toBe(stableStringify({ b: { c: [1, 2] }, a: 1 }));
    expect(requestHash({ quizId: "x", patch: { title: "T" } })).toBe(
      requestHash({ patch: { title: "T" }, quizId: "x" }),
    );
  });

  test("different payloads hash differently", () => {
    expect(requestHash({ title: "A" })).not.toBe(requestHash({ title: "B" }));
  });
});

describe("save_quiz idempotency", () => {
  test("a repeated call with the same key replays the same quizId — one quiz only", async () => {
    const { db, client } = makeEnv();
    const first = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER, idempotencyKey: "save-1" });
    const second = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER, idempotencyKey: "save-1" });

    expect(second.quizId).toBe(first.quizId);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    expect(db.quizzes).toHaveLength(1);
    expect(db.questions).toHaveLength(2);
    expect(db.mcp_idempotency_keys.find((r) => r.key === "save-1")!.status).toBe("completed");
  });

  test("reusing the key with a different payload is rejected", async () => {
    const { db, client } = makeEnv();
    await saveQuizWithClient(client, QUIZ, { ownerId: OWNER, idempotencyKey: "save-2" });
    await expect(
      saveQuizWithClient(client, { ...QUIZ, title: "Different" }, { ownerId: OWNER, idempotencyKey: "save-2" }),
    ).rejects.toThrow("already used for a different request");
    expect(db.quizzes).toHaveLength(1);
  });

  test("a failed save frees the key so a retry can succeed", async () => {
    const db = createFakeDb();
    seedUser(db, OWNER, ["host"]);
    seedUser(db, "33333333-3333-3333-3333-333333333333"); // no host role
    const bad = asClient(new FakeSupabase(db));
    await expect(
      saveQuizWithClient(bad, QUIZ, { ownerId: "33333333-3333-3333-3333-333333333333", idempotencyKey: "save-3" }),
    ).rejects.toThrow("host capability");
    expect(db.mcp_idempotency_keys.some((r) => r.key === "save-3")).toBe(false);
    expect(db.quizzes).toHaveLength(0);
  });
});

describe("update_quiz idempotency", () => {
  test("a repeated update applies once and replays the stored envelope", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER });

    const first = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch: { title: "Renamed" },
      idempotencyKey: "upd-1",
    });
    const second = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch: { title: "Renamed" },
      idempotencyKey: "upd-1",
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.changed).toEqual({ title: true });
    expect(db.quizzes.find((q) => q.id === quizId)!.title).toBe("Renamed");
  });

  test("a failed update frees the key (no 'different request' on retry)", async () => {
    const { client } = makeEnv();
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER });

    await expect(
      updateQuiz(client, {
        actorId: OWNER,
        quizId,
        patch: { difficulty: "extreme" as never },
        idempotencyKey: "upd-fail",
      }),
    ).rejects.toThrow("difficulty must be easy, medium or hard");

    const retry = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch: { title: "Recovered" },
      idempotencyKey: "upd-fail",
    });
    expect(retry.replayed).toBe(false);
    expect(retry.changed).toEqual({ title: true });
  });

  test("a pending key blocks until the in-flight request finishes", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER });
    const patch = { title: "Concurrent" };
    db.mcp_idempotency_keys.push({
      key: "upd-pending",
      operation: "update_quiz",
      request_hash: requestHash({ actor: OWNER, quizId, patch }),
      status: "pending",
      created_at: new Date().toISOString(),
    });

    await expect(
      updateQuiz(client, { actorId: OWNER, quizId, patch, idempotencyKey: "upd-pending" }),
    ).rejects.toThrow("already being processed");
  });

  test("a stale PENDING key (server died mid-write, older than 24h) is reclaimed — never wedged", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER });
    const patch = { title: "Recovered" };
    // Simulates the exact timeout/retry scenario: the server crashed between
    // the claim insert and the completion update, leaving status='pending'.
    db.mcp_idempotency_keys.push({
      key: "upd-wedged",
      operation: "update_quiz",
      request_hash: requestHash({ actor: OWNER, quizId, patch }),
      status: "pending",
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    const result = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch,
      idempotencyKey: "upd-wedged",
    });
    expect(result.replayed).toBe(false);
    expect(result.changed).toEqual({ title: true });
    expect(db.quizzes.find((q) => q.id === quizId)!.title).toBe("Recovered");
    expect(db.mcp_idempotency_keys.find((r) => r.key === "upd-wedged")!.status).toBe("completed");
  });

  test("an idempotency key is scoped to its actor — another actor's reuse is rejected", async () => {
    const { db, client } = makeEnv();
    seedUser(db, "22222222-2222-2222-2222-222222222222", ["host"]);
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER });

    const first = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch: { title: "Mine" },
      idempotencyKey: "upd-actor",
    });
    expect(first.changed).toEqual({ title: true });

    // The same key + same payload, but a different actor: the hash is
    // actor-scoped, so this is a different logical request — the owner's
    // stored envelope must NOT be replayed to the other actor.
    await expect(
      updateQuiz(client, {
        actorId: "22222222-2222-2222-2222-222222222222",
        quizId,
        patch: { title: "Mine" },
        idempotencyKey: "upd-actor",
      }),
    ).rejects.toThrow("already used for a different request");
    expect(db.quizzes.find((q) => q.id === quizId)!.title).toBe("Mine");
  });

  test("a stale completed key (older than 24h) is re-claimed and executed fresh", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER });
    const patch = { title: "Stale" };
    db.mcp_idempotency_keys.push({
      key: "upd-stale",
      operation: "update_quiz",
      request_hash: requestHash({ actor: OWNER, quizId, patch }),
      status: "completed",
      response: { ok: true, action: "update_quiz", id: quizId, changed: { title: true }, warnings: [], errors: [] },
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    const result = await updateQuiz(client, {
      actorId: OWNER,
      quizId,
      patch,
      idempotencyKey: "upd-stale",
    });
    expect(result.replayed).toBe(false);
    expect(db.quizzes.find((q) => q.id === quizId)!.title).toBe("Stale");
  });

  test("archive and add_questions replay on a repeated key", async () => {
    const { db, client } = makeEnv();
    const { quizId } = await saveQuizWithClient(client, QUIZ, { ownerId: OWNER });

    const a1 = await archiveQuiz(client, { actorId: OWNER, quizId, idempotencyKey: "arc-1" });
    const a2 = await archiveQuiz(client, { actorId: OWNER, quizId, idempotencyKey: "arc-1" });
    expect(a2.replayed).toBe(true);
    expect(a2.changed).toEqual({ archived: true, archivedAt: expect.any(String) });

    const q1 = await addQuestions(client, {
      actorId: OWNER,
      quizId,
      questions: [{ type: "mcq", text: "New", options: ["a", "b"], correctIndex: 0 }],
      idempotencyKey: "add-1",
    });
    const q2 = await addQuestions(client, {
      actorId: OWNER,
      quizId,
      questions: [{ type: "mcq", text: "New", options: ["a", "b"], correctIndex: 0 }],
      idempotencyKey: "add-1",
    });
    expect(q2.replayed).toBe(true);
    expect(q2.changed).toEqual({ added: 1, questionCount: 3 });
    expect(db.questions.filter((q) => q.quiz_id === quizId)).toHaveLength(3);
  });
});

describe("withIdempotency primitives", () => {
  test("run() executes once per key even across two calls", async () => {
    const { db, client } = makeEnv();
    let runs = 0;
    const op = async () => {
      runs++;
      return { n: runs };
    };
    const first = await withIdempotency(client, { key: "k", operation: "op", requestHash: requestHash({}) }, op);
    const second = await withIdempotency(client, { key: "k", operation: "op", requestHash: requestHash({}) }, op);
    expect(first).toEqual({ replay: false, result: { n: 1 } });
    expect(second).toEqual({ replay: true, result: { n: 1 } });
    expect(runs).toBe(1);
  });

  test("an unclaimed key runs, completes and stores the response", async () => {
    const { client } = makeEnv();
    await expect(
      withIdempotency(client, { key: "k", operation: "op", requestHash: "h" }, async () => "x"),
    ).resolves.toEqual({ replay: false, result: "x" });
  });
});
