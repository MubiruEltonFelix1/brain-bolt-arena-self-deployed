// The result funnel must be measurable without becoming a data leak.
//
// These tests pin the two properties that matter: only known events are
// recorded, and only allowlisted coarse properties survive. That is what stops
// a future "just add the nickname for better segmentation" edit from quietly
// turning this into a personal-data stream.

import { afterEach, describe, expect, test } from "bun:test";
import {
  clearResultEventBuffer,
  detectShareMethod,
  resultEventBuffer,
  setResultAnalyticsSink,
  trackResultEvent,
  type ResultEvent,
} from "@/lib/result-analytics";

afterEach(() => {
  setResultAnalyticsSink(null);
  clearResultEventBuffer();
});

describe("trackResultEvent", () => {
  test("records a known event with its mode", () => {
    trackResultEvent("result_viewed", { mode: "hosted" });
    expect(resultEventBuffer()).toEqual([{ event: "result_viewed", props: { mode: "hosted" } }]);
  });

  test("drops an unknown event rather than forwarding it", () => {
    trackResultEvent("mystery_event" as never, { mode: "hosted" });
    expect(resultEventBuffer()).toHaveLength(0);
  });

  test("strips any property that is not allowlisted", () => {
    trackResultEvent("result_claim_failed", {
      mode: "arena",
      outcome: "failed",
      // Every one of these is an attempt to attach something sensitive.
      nickname: "Ada",
      email: "ada@example.com",
      token: "deadbeef",
      sessionId: "3f2b1c4d-0000-4000-8000-000000000000",
      answerText: "Paris",
      score: 900,
    } as never);

    const [e] = resultEventBuffer();
    expect(Object.keys(e.props).sort()).toEqual(["mode", "outcome"]);
    expect(JSON.stringify(e)).not.toContain("Ada");
    expect(JSON.stringify(e)).not.toContain("deadbeef");
    expect(JSON.stringify(e)).not.toContain("Paris");
  });

  test("forwards only the sanitised payload to an installed sink", () => {
    const seen: ResultEvent[] = [];
    setResultAnalyticsSink((e) => seen.push(e));
    trackResultEvent("result_share_completed", { mode: "hosted", shareMethod: "native", score: 1 } as never);
    expect(seen).toEqual([
      { event: "result_share_completed", props: { mode: "hosted", shareMethod: "native" } },
    ]);
  });

  test("a throwing sink never breaks the results screen", () => {
    setResultAnalyticsSink(() => {
      throw new Error("sink exploded");
    });
    expect(() => trackResultEvent("replay_clicked", { mode: "hosted" })).not.toThrow();
    // The event is still buffered for debugging.
    expect(resultEventBuffer()).toHaveLength(1);
  });

  test("with no sink installed nothing leaves the browser", () => {
    setResultAnalyticsSink(null);
    expect(() => trackResultEvent("result_viewed", { mode: "arena" })).not.toThrow();
  });

  test("the buffer is bounded so a long session cannot grow without limit", () => {
    for (let i = 0; i < 250; i += 1) trackResultEvent("result_viewed", { mode: "hosted" });
    expect(resultEventBuffer().length).toBeLessThanOrEqual(100);
  });

  test("covers every event named in the phase brief", () => {
    const expected = [
      "result_viewed",
      "save_result_clicked",
      "sign_in_started_from_result",
      "sign_up_started_from_result",
      "authentication_completed_from_result",
      "result_claim_started",
      "result_claim_succeeded",
      "result_claim_failed",
      "result_share_clicked",
      "result_share_completed",
      "replay_clicked",
    ];
    for (const name of expected) {
      clearResultEventBuffer();
      trackResultEvent(name as never, { mode: "hosted" });
      expect(resultEventBuffer()).toHaveLength(1);
    }
  });
});

describe("detectShareMethod", () => {
  test("returns a coarse bucket, never a device or platform identifier", () => {
    expect(["native", "copy", "image"]).toContain(detectShareMethod());
  });
});
