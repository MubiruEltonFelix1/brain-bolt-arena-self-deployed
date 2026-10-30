// Tests for the topic-based AI quiz preparation server functions.
//
// We test the input validators and the slugify helper directly, mirroring
// the pattern in src/lib/api/ai.functions.test.ts (which avoids importing
// createServerFn handlers that are tightly coupled to the request context).

import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Mirror the input schemas from prep-topic.functions.ts so we don't import
// the module (which would pull in @tanstack/react-start deps we don't want
// in the unit test). Keep these in sync with prep-topic.functions.ts.

const prepCreateTopicJobInput = z.object({
  topic: z.string().trim().min(1).max(200),
  quizId: z.string().uuid().optional(),
});

const prepGenerateTopicBatchInput = z.object({
  jobId: z.string().uuid(),
});

// Copied from prep-topic.functions.ts — keep in sync.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

describe("prep / topic: create topic job input validator", () => {
  test("accepts a valid minimal request", () => {
    const parsed = prepCreateTopicJobInput.safeParse({
      topic: "Genetics",
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts a request with an optional quizId", () => {
    const parsed = prepCreateTopicJobInput.safeParse({
      topic: "Genetics",
      quizId: "11111111-1111-1111-1111-111111111111",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an empty topic", () => {
    const parsed = prepCreateTopicJobInput.safeParse({
      topic: "",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects a topic longer than 200 chars", () => {
    const parsed = prepCreateTopicJobInput.safeParse({
      topic: "x".repeat(201),
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects a non-uuid quizId", () => {
    const parsed = prepCreateTopicJobInput.safeParse({
      topic: "Genetics",
      quizId: "not-a-uuid",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects a missing topic", () => {
    const parsed = prepCreateTopicJobInput.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

describe("prep / topic: generate topic batch input validator", () => {
  test("accepts a valid jobId", () => {
    const parsed = prepGenerateTopicBatchInput.safeParse({
      jobId: "11111111-1111-1111-1111-111111111111",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects a non-uuid jobId", () => {
    const parsed = prepGenerateTopicBatchInput.safeParse({
      jobId: "not-a-uuid",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects a missing jobId", () => {
    const parsed = prepGenerateTopicBatchInput.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

describe("prep / topic: slugify helper", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Genetics 101")).toBe("genetics-101");
  });

  test("removes non-alphanumeric characters", () => {
    expect(slugify("Mendelian Inheritance! (Part 2)")).toBe(
      "mendelian-inheritance-part-2",
    );
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugify("---Hello World---")).toBe("hello-world");
  });

  test("truncates to 80 characters", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});
