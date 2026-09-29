# Phase 9D.3 — Real-Browser Scalability Verification, Fallback Removal & Join Telemetry

**Date:** 2026-09-27
**Status:** goals A, B and D complete · **goal C (fallback removal) BLOCKED by measurement, not by effort**
**Verification:** `bunx tsc --noEmit` ✅ · `bun run build` ✅ · eslint clean on changed files (see §15 for the pre-existing repo-wide CRLF failure) · adversarial review run and all BORKED / LIKELY BORKED / AT RISK findings addressed ✅ · live project purged of all 9D.2b/9D.3 scratch data (125 participants, 2 sessions, 320 answers, 35 teams and every `ZZZ%` fixture quiz and question) ✅

---

## 1. Executive Summary

The browser harness is fixed and was scaled to **75 simultaneous real Chromium pages** against the production build, all levels passing. Broadcast delivery is proven in a real browser at every level tested.

The headline finding is a **measured blocker on fallback removal**. Phase 9D.2's premise was that the high-frequency WAL path could be retired once broadcast was proven. An A/B run on the live database shows that premise is wrong for players: with the publication diet applied, a player receives no `sessions` postgres_changes event, so the game never advances past question 1, even though every gameplay broadcast arrives and every score updates. The `participants` WAL binding is what actually delivers a transition to an anonymous player, through the coalesced refetch in `onParticipantsChanged()`. The fallback is therefore **kept**, and the code comments that invited the regression were corrected.

Two defects were also root-caused and fixed: the missing `window.__bd` (never an instrumentation problem) and a false "migration not applied" report for Phase 8E caused by function-overload ambiguity in the marker probe.

## 2. Harness fix (Goal A)

**The instrumentation was never the defect.** The probe installed correctly on every page. Three real bugs stacked up to make it look broken:

1. **Identity stored as a raw object.** `localStorage.setItem(KEY, obj)` coerces to the literal string `[object Object]`. `readAll()` then threw on `JSON.parse`, `getParticipant()` returned `null`, and `/play` rendered the "You're not in a game" gate — so no channel was ever opened. A run that never subscribes is indistinguishable from a run whose frames don't dispatch.
2. **Unquoted key when inlining the identity.** Building the injected source as `{<uuid>:{...}}` is a `SyntaxError` (bare UUID key), so the whole probe silently failed to parse — `window.__bd` absent *and* no `__bdError`, which is the signature of a parse failure rather than a runtime one.
3. **A swallowed execution-context error.** TanStack Router's `pushState` after first paint destroys the execution context for a few hundred ms; `page.evaluate` rejects, and the `.catch` reported it as a missing probe.

Fixes, none of which weaken the measurement:

| fix | detail |
| --- | --- |
| identity | `JSON.stringify` performed **inside** the page, with the session key `JSON.stringify`-quoted |
| installation | probe installed as a source **string** via `evaluateOnNewDocument`, so it is immune to function-serialization edge cases and is re-installed on every document |
| instrumentation marker | `__bd.gen = performance.timeOrigin` (per-document) and `__bdError`; a page is only counted if both read back |
| readback | 5 retries × 400 ms; a page that still cannot be read is **TEST INVALID** (`binary: -1`), never "0 events" |
| app layer | DOM parsing shares the same retry policy, and the in-game gate waits for real mount instead of a fixed sleep |
| attribution | `docreq` / `nav` / `pageerror` listeners distinguish a document load from a same-document navigation |
| stale-build detection | `ensureServer` now pulls the entry asset out of the served HTML and requires it to resolve; a live-but-stale server is reported, its listener killed, and a fresh one started |

That last row cost two runs and is worth calling out: `bun run build` replaces the hashed asset filenames, and a preview server started *before* the build keeps serving HTML that points at the old hash. The client bundle 404s, the app never hydrates, and every page reports **zero frames** — indistinguishable from a total transport outage. The pageerror listener is what finally named it (`Failed to fetch dynamically imported module`), and the fix turns that class of failure from a silent 0/N verdict into a one-line diagnosis.

## 3. Browser Join Findings

- **Join is the slowest part of a cold start, not delivery.** Pages reach the play UI in 1-3 s; a full 50/50 in-game sweep was required at 50 players, and one 50-player run had 39 pages still not mounted after 60 s. At 50+ the harness must wait for mount plus a subscribe settle or it measures the join, not the transport.
- **Round 0 measures the join, rounds 1+ measure the transport.** Without the settle, round 0 showed a spread of 0-12 binary frames per page at 10 players; with it, every level is exactly 2 frames per answering player.
- **This is the evidence behind the join-health threshold** (§13): a page that is slow to subscribe is a real, reproducible condition, and it was previously invisible.

## 4. Real Browser Architecture — what was measured

Four layers, independently, per page:

| layer | instrument | result |
| --- | --- | --- |
| WebSocket | in-page `onmessage` + `addEventListener` wrap | every gameplay frame is an `ArrayBuffer` |
| binary kind | first byte of each frame | **`0x04` only** — `userBroadcast`, at every level from 10 to 75 |
| realtime-js | `DataView` construction count | equals the binary frame count on every page — the decoder is entered for every frame |
| application | `/play` DOM (score, round, answered) | score rendered on N/N pages every round |

Exactly **2 broadcast frames per answering player per round** (`game:answer_row` + `game:answer`), which is the contract the Phase 9D.2 triggers were written to. No other kind byte ever appears, which is why the 9D.2b `_binaryDecode` "missing default case" theory was wrong: the server only ever sends kind 4.

**Client library version — a co-variable worth stating plainly.** All browser decode evidence in 9D.2b and 9D.3 was collected on `@supabase/supabase-js` 2.117.1 / `realtime-js` 2.117.1 / `phoenix` 0.4.5, bumped from 2.108.2 / 2.108.2 / 0.4.2 earlier in this phase while investigating whether the decode failure was a client-library one. The transport conclusion does not rest on that bump (the trigger publishes kind 4 by construction, and the byte layout is verified on the wire), but the decode result cannot be *attributed* to 9D.2 alone until the ladder is re-run pinned to 2.108.2. That is the check that would isolate the variable, and it is cheap: revert the pin and re-run `--players=50`.

## 5. Scaling Matrix

Desktop Chromium, real production build, real `/play` route, 3 rounds, answers driven through the authoritative `submit_answer` RPC. The frame column is the per-page counter **as of the end of round 0** — exactly 2 × players, which is the contract; the same counter reads 6 × players by the end of round 3:

| players | in-game | valid pages | frames/page (cumulative, 3 rounds) | kinds | score rendered | verdict |
| ---: | ---: | ---: | ---: | --- | ---: | --- |
| 10 | 10/10 | 10 | 20 | `0x04` | 10/10 | **PASS** |
| 20 | 20/20 | 20 | 40 | `0x04` | 20/20 | **PASS** |
| 30 | 30/30 | 30 | 60 | `0x04` | 30/30 | **PASS** |
| 40 | 40/40 | 40 | 80 | `0x04` | 40/40 | **PASS** |
| 50 | 50/50 | 50 | 100 | `0x04` | 50/50 | **PASS** |
| 75 | 75/75 | 75 | 150 | `0x04` | 75/75 | **PASS** |
| 100 | — | — | — | — | — | not run (see §15) |

Zero invalid pages at every level. `answerRms` (10.6-24.8 s at 50 players) is the **harness's own** submit time — 50 RPCs through one service-role client in chunks of 10 — and is not a measure of player answer latency.

## 6. Multi-Question Soak

50 browsers × **12 questions**, run with the publication diet applied: 60,000 broadcast frames, 1,200 per page, `0x04` throughout, answered counter at 50/50 in every round, zero invalid pages, 50/50 answers accepted in every round.

The fixture was raised from 8 to 12 questions and ordered by `position`, and rounds now walk the session's actual `question_order`, because `submit_answer` de-duplicates per (participant, question) — a repeated question is rejected, not re-answered.

**Honest limit:** the soak predates the round assertion added in §11, so it proves sustained broadcast delivery across 12 questions but does **not** assert that a player followed the transitions. The transition assertion was validated separately at 10 players in both directions.

## 7. Desktop Results

See §5. Everything is the production build served by `scripts/scale-audit/serve.mjs`; no dev server, no fixture shortcuts in the client.

## 8. Mobile Results

**Not run.** Chrome mobile emulation (Pixel 8 viewport/UA) is wired into the harness behind `--mobile` but was not executed in this phase. The engine has no browser-specific code path, so the Chrome desktop result is strong but not a substitute. Safari is untested on any platform: `chrome-headless-shell` is the only engine available here, and WebKit differs in binary frame handling enough that the `0x04` decode should be re-confirmed there before trusting Safari.

## 9. Security Results

Re-run in the **broadcast-only** state, which is the stricter posture:

- `scripts/rls-probe.mjs`: **7/7 PASS** — guest and player can read a session by code, player cannot mutate a session (0 rows), host can, and **clients cannot forge gameplay broadcasts** (spoofed events received by subscriber: 0).
- `scripts/scale-audit/private-broadcast-probe.mjs`: anon subscriber received the forged/delivered broadcast 1/1 as expected, and — critically — **`postgres_changes sessions received: 0`**, independently corroborating §11.
- The probe's `[authed]` variant fails on `Invalid login credentials`: its test credential no longer exists. That is probe-fixture rot, not a product finding; the authed authorization paths are covered by the 7/7 above.

## 10. Duplicate-Delivery Results

With both transports bound, each gameplay change is delivered twice (broadcast + WAL). No duplication was observable: scores rendered once, the answered counter never exceeded the true number of answers (50/50 exactly), and the leaderboard showed no double entries. The handlers remain idempotent by construction — coalesced refetches, `(participant, question)`-de-duplicated answer appends, `Set`-based counters.

Note the dual-shape `countAnsweredEvent` in `play.$sessionId.tsx` is retained deliberately: it handles the WAL `new`/`old` payload shape that only exists while the fallback is active, so the rollback path keeps working.

## 11. Fallback Removal Decision — **NOT removed** (Goal C)

Gate applied, then removed anyway because the A/B run failed it. The publication diet was applied via the Phase 9D.2 migration and verified (`sessions` only; all three `answers`/`participants`/`teams` broadcast triggers present).

| | diet ON (broadcast only) | diet OFF (fallback restored) |
| --- | --- | --- |
| gameplay broadcasts | 200 / 400 / 600 / 800 frames, scores live | identical |
| player question after server advanced to rounds 2-4 | **stuck on question 1** | **1 → 2 → 3 → 4** |
| ladder verdict | FAIL (`qAdvanced=false`) | PASS |

**Root cause:** an anonymous player receives no `sessions` postgres_changes event on this private channel. Broadcast reaches them (the topic RLS allows it), but the WAL payload does not. Transitions therefore only ever arrived via the `participants` WAL binding and the coalesced refetch it triggers. Removing the WAL binding is not a redundant-subscriber cleanup; it is the removal of a player's only transition signal.

**State left behind:** publication restored to `answers, participants, sessions, teams`; both route components keep both transports; `20260926170000_phase_9d2_transitional_fallback.sql` remains the applied source of truth, so `public.restore_gameplay_publication()` is the one-command rollback.

**What would unblock it** (deliberately not started — out of 9D.3 scope): publish the transition on the broadcast transport (a `game:question` broadcast from the scheduler/advance path), verify an anonymous player follows it at 50 players, and only then re-apply the diet.

The stale comment in `host.$sessionId.tsx` that described the split as "only authoritative `sessions` transitions still ride postgres_changes" is corrected, because that sentence is precisely what would invite this regression again.

## 12. Post-Removal Verification

Not applicable — removal was blocked, so there is no post-removal state to verify. The equivalent assurance was obtained in the other direction instead: a full 12-question soak at 50 browsers with the diet applied, which proves the gameplay layer is broadcast-capable and isolates the failure to transitions alone.

## 13. Join/Reconnect Telemetry (Goal D)

- `src/lib/join-telemetry.ts` — counters plus one compact event per transition: `subscribe_started`, `join_attempt`, `reconnect_attempt`, `join_success`, `reconnect_success`, `join_failure`, `backoff` (with `delayMs`), and `connectMs` for every attempt. Channel names are FNV-1a hashed so a line can be correlated without exposing a session id, nickname or token. No polling, no per-frame work, no PII. An optional `window.__brainboltJoinTelemetry` sink lets a host app ship the lines off-box; a throwing sink cannot break the join path.
- `src/hooks/use-live-channel.ts` — `JOIN_HEALTH_MS = 6000`. A single timer per attempt escalates the UI from a quiet "CONNECTING" pill to **"Reconnecting to game…"**, and is cleared by the same `clearTimer()` on success, failure and teardown. It is a UI signal only: the existing backoff loop remains the single connection authority, and gameplay authority is untouched (the server stays authoritative throughout, exactly as before).
- Recovery shows **"Connected"** for the existing 2.5 s window. `stalled` is threaded through `play.$sessionId.tsx` and `host.$sessionId.tsx`.
- `joinTelemetryCounters()` is exported for diagnostics; the browser harness can read it without touching app internals.

## 14. Migration Runner Status (9D.2 §24)

| migration | before | finding |
| --- | --- | --- |
| `20260822120000_phase_8e_ai_question_builder.sql` | PENDING, "marker absent" | **False negative, fixed.** The marker existed; its probe read `pg_get_functiondef` with `LIMIT 1` and no overload disambiguation. `can` has two overloads and only the 3-arg one carries the 8E `ai.*` branch, so the probe read the wrong overload. The probe is now overload-agnostic and the 8E needle is the unambiguous `Phase 8E AI Builder`. No other marker changed state. |
| `20260823120000_phase_9b_arena_publication_platform.sql` | PENDING | **Genuinely not applied.** `arena_run_answers`, `platform_settings` and `quizzes.arena_category` are all absent from the live database. The migration was committed but never applied here. Applying it is an Arena change, which 9D.3 explicitly forbids — recorded as a separate infrastructure issue, not fixed here. |
| `20260926150000_phase_9d2_broadcast_transport.sql` | PENDING | **Expected while the fallback is active.** Its marker asserts a `sessions`-only publication, which the transitional fallback intentionally reverses. It will pass again the moment removal is unblocked. |
| `20260718000327_…sql` (host-write policies) | PENDING | **Landed fix (adversarial review).** The marker probes the *final* split-policy state and its own comment said re-applying the file would re-add the four `FOR ALL` restrictive policies — but it was missing `chain: true`, the only flag `migrate.mjs` and `check-migrations.mjs` consult to mean "never auto-apply". On any database without the 9D.2 split, `bun scripts/migrate.mjs` would have applied it, re-probed, found its own post-condition false and exited 3 — having just reinstated the read-path regression the marker exists to prevent. |

No historical migration was modified.

## 15. Remaining Bottlenecks & Next Phase

Bottlenecks, none of them transport at this point:

1. **Transitions are the last WAL dependency** (§11). This is the only thing standing between the current architecture and a `sessions`-only publication.
2. **100-player real-browser run not executed.** 75 is the ceiling measured; the machine ran 75 pages but 100 was not attempted.
3. **Mobile Safari entirely unmeasured**, and mobile Chrome emulated but not run. Re-confirm the `0x04` decode on WebKit.
4. **Cold-join mount time degrades at 50+ pages** (§3), both for the harness and, presumably, for a real room full of players on one host.
5. **The harness deleted only part of what it created, and one failed delete stranded the rest.** Each ladder run created a fixture quiz with its questions and left them behind, so the live project accumulated `ZZZ SCALE AUDIT` rows; it now deletes answers, teams, participants, session, questions and quiz, each delete independent and reporting its own failure (a single rejected delete used to abort the remainder and leave a live, active session behind — 10 participants and a quiz survived one run this way). The accumulated fixtures were purged, and a verification run finished with **0 scratch quizzes and 0 scratch participants**. It still has no `try/finally`, so a run that dies after the session goes active leaves one scratch session and quiz; `bun scripts/scale-audit/fixture.mjs cleanup` removes those. The question query also had a hard `.limit(20)` that would have silently capped a larger `QUESTION_COUNT` soak and failed the gate on de-duplication rather than transport.
6. **`bun run lint` fails repo-wide on this Windows checkout** — thousands of `Delete ␍` prettier errors, on files untouched by this phase (`join.$code.tsx`, `game.ts`, `question-registry.ts` produce 555 of them on their own). The files changed here are clean apart from the same noise, and `join-telemetry.ts` is clean outright. Fixing it is a repo-wide reformat and out of scope; flagging it because it hides real lint signal.
7. The previously recorded P1 list (memoization, scoreboard, hydration consolidation, indexes, host summary broadcast) is untouched by design.

**Recommended next phase:** land a `game:question` broadcast on the advance path, prove an anonymous player follows it at 50 browsers, re-apply the diet, then re-run this whole matrix plus the 100-player and Safari cases before considering the P1 list.
