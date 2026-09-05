// Phase 21 — Host route static-analysis tests.
//
// Verify the host route (`src/routes/host.$sessionId.tsx`) wires the
// bounded `runControl` timeout, the identity-key short-circuits on
// `revealRound` and `doEndEarly`, and passes `p_expected_started_at`
// to the two RPCs. Runtime behaviour (race conditions, retry logic) is
// exercised by the integration load test and the migration wiring tests.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOST_ROUTE = readFileSync(
  join(import.meta.dir, "..", "..", "routes", "host.$sessionId.tsx"),
  "utf8",
);

describe("Phase 21 — host route runControl bounded timeout", () => {
  test("declares CONTROL_TIMEOUT_MS = 8000", () => {
    expect(HOST_ROUTE).toMatch(/CONTROL_TIMEOUT_MS\s*=\s*8000\b/);
  });

  test("runControl uses Promise.race with a setTimeout rejector", () => {
    // The bounded busy must release `controlBusy` even when an RPC hangs.
    // The fix: track the underlying `work` promise separately so the finally
    // block awaits its settlement before releasing controlBusy. Without this
    // a follow-up `runControl` could race with a stale in-flight RPC for
    // non-idempotent actions like advance_question / skip_current_question.
    const runControlBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function runControl"),
      HOST_ROUTE.indexOf("useEffect", HOST_ROUTE.indexOf("async function runControl")),
    );
    expect(runControlBlock).toMatch(/Promise\.race\(\[/);
    expect(runControlBlock).toMatch(/setTimeout\(\s*\(\s*\)\s*=>/);
    expect(runControlBlock).toMatch(
      /reject\s*\(\s*new Error\("runControl: hard timeout exceeded"\)/,
    );
    expect(runControlBlock).toMatch(/CONTROL_TIMEOUT_MS/);
    expect(runControlBlock).toMatch(/await work\.catch\(\(\)\s*=>\s*\{\}\)/);
  });

  test("runControl catches the timeout error and toasts it", () => {
    // The catch block distinguishes timeout-side rejections (toast with
    // `(timeout)` context) from genuine RPC errors (toast with plain
    // `runControl` context). Both go through toastError; neither re-throws.
    const runControlBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function runControl"),
      HOST_ROUTE.indexOf("useEffect", HOST_ROUTE.indexOf("async function runControl")),
    );
    expect(runControlBlock).toMatch(/catch\s*\(err\)/);
    expect(runControlBlock).toMatch(/if\s*\(!timedOut\)/);
    expect(runControlBlock).toMatch(/toastError\(err,\s*\{\s*context:\s*"runControl"\s*\}\)/);
    expect(runControlBlock).toMatch(
      /toastError\(err,\s*\{\s*context:\s*"runControl \(timeout\)"\s*\}\)/,
    );
  });

  test("runControl finally-block releases the busy flag and controlPending", () => {
    const runControlBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function runControl"),
      HOST_ROUTE.indexOf("useEffect", HOST_ROUTE.indexOf("async function runControl")),
    );
    expect(runControlBlock).toMatch(/finally\s*\{[\s\S]*?controlBusy\.current\s*=\s*false/);
    expect(runControlBlock).toMatch(/setControlPending\(false\)/);
  });

  test("runControl does NOT carry the identity-key short-circuit", () => {
    // Per plan Decision 2 (revised): the short-circuit must live in
    // `revealRound` and `doEndEarly`, NOT in `runControl`. Otherwise
    // startGame / nextRound / togglePause / addTime / doSkipQuestion would
    // be silently blocked by the reveal-key dedupe.
    const runControlBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function runControl"),
      HOST_ROUTE.indexOf("useEffect", HOST_ROUTE.indexOf("async function runControl")),
    );
    expect(runControlBlock).not.toMatch(/lastRevealKey/);
    expect(runControlBlock).not.toMatch(/lastEndEarlyKey/);
  });
});

describe("Phase 21 — revealRound identity-key + stale protection", () => {
  test("maintains a useRef<string | null>(null) for lastRevealKey", () => {
    expect(HOST_ROUTE).toMatch(/const lastRevealKey = useRef<string \| null>\(null\);/);
  });

  test("revealRound short-circuits when key matches and revealed", () => {
    const revealBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function revealRound"),
      HOST_ROUTE.indexOf("async function nextRound"),
    );
    expect(revealBlock).toMatch(/lastRevealKey\.current === key && revealed/);
    expect(revealBlock).toMatch(/return;/);
  });

  test("revealRound passes p_expected_started_at to the RPC", () => {
    const revealBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function revealRound"),
      HOST_ROUTE.indexOf("async function nextRound"),
    );
    expect(revealBlock).toMatch(
      /p_expected_started_at:\s*session\?\.current_question_started_at\s*\?\?\s*null/,
    );
  });

  test("revealRound catches phase21.stale_started_at and silently resyncs", () => {
    const revealBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function revealRound"),
      HOST_ROUTE.indexOf("async function nextRound"),
    );
    expect(revealBlock).toMatch(/phase21\.stale_started_at:/);
    expect(revealBlock).toMatch(/void load\(\)/);
    // No toast for the stale path.
    expect(revealBlock).not.toMatch(/toastError.*stale_started_at/);
  });

  test("revealRound updates lastRevealKey only on success", () => {
    const revealBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function revealRound"),
      HOST_ROUTE.indexOf("async function nextRound"),
    );
    expect(revealBlock).toMatch(/lastRevealKey\.current = key/);
  });
});

describe("Phase 21 — doEndEarly identity-key + expected_started_at", () => {
  test("maintains a useRef<string | null>(null) for lastEndEarlyKey", () => {
    expect(HOST_ROUTE).toMatch(/const lastEndEarlyKey = useRef<string \| null>\(null\);/);
  });

  test("doEndEarly short-circuits when key matches and revealed", () => {
    const endEarlyBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function doEndEarly"),
      HOST_ROUTE.indexOf("async function finalizeLeague"),
    );
    expect(endEarlyBlock).toMatch(/lastEndEarlyKey\.current === key && revealed/);
  });

  test("doEndEarly passes p_expected_started_at to the RPC", () => {
    const endEarlyBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("async function doEndEarly"),
      HOST_ROUTE.indexOf("async function finalizeLeague"),
    );
    expect(endEarlyBlock).toMatch(
      /p_expected_started_at:\s*session\?\.current_question_started_at\s*\?\?\s*null/,
    );
  });
});

describe("Phase 21 — invariants preserved", () => {
  test("auto-reveal useEffect at lines 510-531 unchanged in logic", () => {
    // The 250ms debounce + dependency-list re-arm behavior is preserved.
    // Phase 21 widens the server-side fallback; the client effect keeps
    // firing in the happy path for low latency.
    const effectBlock = HOST_ROUTE.slice(
      HOST_ROUTE.indexOf("// Auto-reveal: when timer hits zero"),
      HOST_ROUTE.indexOf("}, [", HOST_ROUTE.indexOf("// Auto-reveal: when timer hits zero")) + 200,
    );
    expect(effectBlock).toMatch(/timedOut = startedAt > 0 && remaining <= 0/);
    expect(effectBlock).toMatch(/const t = setTimeout\(\(\) => \{\s*revealRound\(\);?\s*\}, 250\)/);
  });

  test("scoring semantics untouched (no submit_answer or score mutations)", () => {
    // The Plan §17 freezes scoring, timing semantics, Arena, autonomous
    // competitions, guest claiming, league standings, competition result
    // recording, question rendering, shared question registry, AI, MCP,
    // principal architecture. None of those surfaces are mutated here.
    // A focused grep: this file does NOT import or mutate the scoring
    // constants/helpers from src/lib/game.ts (which owns BASE_POINTS etc.).
    expect(HOST_ROUTE).not.toMatch(/submit_answer/);
    expect(HOST_ROUTE).not.toMatch(/participants\.score\s*\+=/);
    // BASE_POINTS lives in src/lib/game.ts and is NOT touched by Phase 21.
    expect(HOST_ROUTE).not.toMatch(/BASE_POINTS/);
  });
});
