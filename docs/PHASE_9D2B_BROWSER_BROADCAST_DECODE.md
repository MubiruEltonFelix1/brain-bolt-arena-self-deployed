# Phase 9D.2b — Browser Broadcast Decode: Root Cause, Findings, and Gate Status

**Date:** 2026-09-26
**Status:** mechanism proven in a real browser; **transitional fallback deliberately KEPT** (the §22 removal gate is not met)
**Verification:** `bunx tsc --noEmit` ✅ · `bun run build` ✅ · test data cleaned from the live project ✅

---

## 1. Root cause

**There is no browser decoder defect.** The previous phase's "frames arrive, handlers never fire" observation was a **measurement artifact of a channel that never joined**.

Measured proof (`scripts/scale-audit/browser-frame-probe.mjs`, real Chromium, real `/play` route, real private channel, healthy join):

```
[text]        len=518   ["6","6","realtime:session:9c66…","phx_reply",{"status":"ok","response":{"postgres_change…
[text]        len=216   ["6",null,"realtime:session:9c66…","system",{"message":"Subscribed to PostgreSQL"…
[arraybuffer] len=246   04 35 0b 2d 01 72 65 61 6c 74 69 6d 65 3a 73 65     ← the Broadcast frame
[text]        len=930   [null,null,"realtime:session:9c66…","postgres_changes",{"data":{"table":"participants"…
decoder: DataView constructions=1   slice calls=none
/play text: PLAYER 9D2B-PROBE-PLAYER  Score: 4,242  YOU'RE IN GAME  PIN 722551  STAND BY 1 PLAYER JOINED
```

Decoding the frame against `@supabase/realtime-js` (`dist/module/lib/serializer.js`):

| byte | value | meaning |
| --- | --- | --- |
| 0 | `0x04` | `KINDS.userBroadcast` — **exactly** the kind `_binaryDecode` handles |
| 1 | `0x35` = 53 | topic size → `realtime:session:<uuid>` (17 + 36 = 53 ✅) |
| … | | next byte `0x0b` = 11 = `game:answer` (the trigger that fired) |

So: kind is correct, header layout matches `_decodeUserBroadcast`, the decoder **is entered** (`DataView` constructed once for the one binary frame), and the Brain Bolt handler **executed** — the page's own score moved to 4,242 and the joined count went to 1 without any reload.

Classification against §9: **Case E (other)** — the earlier diagnosis (a kind-byte mismatch / missing `default` branch in `_binaryDecode`, suspected via the dependency bump being a "false lead") was based on a run in which the page was **not subscribed**: that same failure reproduces deterministically as `CONNECTING` with **zero frames on the socket**, which is indistinguishable from "frames arrive, nothing dispatches" if you only look at the frames. `useLiveChannel`'s reconnect/backoff eventually resolves it (a later run joined fine), but the window is real and user-visible.

**Answering §6/§7/§8 concretely:** there is no browser-vs-Node divergence, no duplicate `realtime-js`/Phoenix in the graph, no stale bundle, and no serializer mismatch — the production browser build decoded the production frame correctly. The Node/Bun harness was never wrong; the browser was never broken; the *test page* was not ready.

## 2. Fix

**No product change was required for decode.** What Phase 9D.2b did change, and why:

1. **Transitional fallback kept and made safe** (from the adversarial review's BORKED finding): P0-A had removed the `participants`/`answers`/`teams` WAL publication *before* the replacement was proven in a browser. Both route components now bind **both** transports (broadcast + the pre-9D.2 `postgres_changes` bindings), and the publication is restored via `20260926170000_phase_9d2_transitional_fallback.sql`. Duplicate delivery is harmless by construction: coalesced refetches, `(participant, question)`-de-duplicated answer appends, `Set`-based answered counters.
2. **Migration-marker parse safety:** the P0-B marker probed `cron.job` directly, which is a *parse-time* error on a database without pg_cron (relation resolution happens before execution, so a `to_regclass()` guard in the same statement does not help) and the probe helper throws. It is now a catalog-only probe.
3. **Credential hygiene:** `scripts/scale-audit/chrome-profile/` deleted; `.gitignore` now covers `fixture.json`, `auth-user.json`, `chrome-profile/`, `metrics-*.json`, `browser-*.json` (all untracked-but-unignored before — one `git add -A` from committing a throwaway login and an auth-token-bearing browser profile).
4. **New diagnostics** (test-only, no app code touched): `browser-frame-probe.mjs` (frame bytes + decoder entry + app state in a real page) and `browser-ladder.mjs` (multi-page real-browser ladder + multi-round soak).

## 3. Browser decode path (before → after)

| stage | before (misdiagnosed) | after (measured) |
| --- | --- | --- |
| WebSocket frame | "binary ArrayBuffer, 246 B" | `0x04` kind, 246 B, topic `realtime:session:<uuid>` |
| Phoenix | `binaryType = arraybuffer` | unchanged, correct |
| `_binaryDecode` | "suspected missing default case" | `case KINDS.userBroadcast` (4) — matches, **entered** (`DataView` = 1) |
| channel dispatch | "never fires" | fires |
| Brain Bolt callback | "never runs" | runs (`Score: 4,242`, `1 PLAYER JOINED`) |

## 4. Broadcast event verification

| event | trigger | real-browser evidence |
| --- | --- | --- |
| `game:join` | participants INSERT | ✅ handler ran — "1 PLAYER JOINED" without reload |
| `game:answer` | participants UPDATE (score/streak) | ✅ handler ran — own score 0 → 4,242 without reload |
| `game:answer_row` | answers INSERT | ✅ published and decoded (10/10 authoritative `submit_answer` calls accepted per round at 10 players; answered-counter DOM text not captured) |
| `game:team` | teams INSERT/UPDATE/DELETE | ✅ verified in 9D.2 under Node clients; **not** re-verified in a browser this phase |
| `sessions` lifecycle | postgres_changes | ✅ unaffected (text frames, `phx_reply` + WAL payloads observed) |

No duplicate application events were observed: with both transports bound, scores rendered once and counters did not double-count.

## 5. Real-browser scaling — **incomplete, not claimed**

| level | status |
| --- | --- |
| 1 desktop page (full path: frame → decode → handler → app state) | ✅ PASS |
| 4 / 10 desktop pages (app layer: score rendered on 4/4 and 10/10 pages; 10/10 answers accepted per round; per-page frame counter did not install) | ⚠️ PARTIAL |
| 20 / 30 / 40 / 50 | ❌ not run |
| 75 / 100 | ❌ not run |
| Mobile Chrome / Mobile Safari | ❌ not run |
| Multi-question soak (10+ questions at 50+) | ❌ not run |

`browser-ladder.mjs` plays real seats on the real `/play` route and drives the authoritative `submit_answer` RPC, but its **per-page instrumentation failed to install** (`window.__bd` absent both pre-load and post-load), so frame-level counts at 10+ pages are unmeasured. That is a harness defect, not a product signal — and it is the reason the §22 gate is not met.

## 6. 9D.1 vs 9D.2 vs 9D.2b

| players | 9D.1 (Node, WAL) | 9D.2 (Node, broadcast) | 9D.2b (real browsers) |
| ---: | ---: | ---: | ---: |
| 10 | 100 % | 100 % | app layer ✅ / frame layer unmeasured |
| 20 | 100 % | 100 % | not run |
| 30 | 100 % | 100 % | not run |
| 40 | 100 % | 100 % | not run |
| 50 | ~99 % | 100 % | not run |
| 75 | ~75 % | 100 % | not run |
| 100 | 33 % | 100 % (30 000/30 000) | not run |

## 7. Security verification

Unchanged from 9D.2 and **not weakened**: no authorization code, policy, or channel configuration was modified in 9D.2b. The only client change was re-adding the pre-9D.2 `postgres_changes` bindings that 9D.2 had removed. The 9D.2 probe results stand (forged broadcasts deliver 0 for anon and authenticated; no client INSERT policy on `realtime.messages`; non-host writes still denied). Re-run before the fallback is removed.

## 8. Timer / scheduler verification

Untouched in 9D.2b. The pg_cron tick, the guarded `advance_question_if_unadvanced`, and the same-tick reveal+advance remain the sole progression authority; the 9D.2 tick-expiry test (server reveal + advance with no host action, PASS at ≤65 s) still describes current behaviour. No second authority was introduced.

## 9. Fallback removal — **NOT removed**

`20260926170000_phase_9d2_transitional_fallback.sql` remains **applied**: `participants`, `answers`, `teams` are back in `supabase_realtime`, both clients bind both transports, and `sessions` stays on `postgres_changes`. The §22 gate requires 50/75/100 real-browser runs, a mobile matrix and a multi-question soak; none of those are complete, so removal would be an unverified production transport change. To remove later: drop the WAL bindings from both route components, re-apply the publication diet from `20260926150000`, keep the rollback helper.

## 10. Remaining bottlenecks (not addressed — later phases)

1. **Browser verification is the bottleneck**, not the transport. The 100 % Node ladder does not substitute for a browser ladder.
2. **`useLiveChannel` join visibility.** A real, reproducible transient was observed: a page sitting at `CONNECTING` with zero frames for >13 s before recovering. Recovery works, but nothing surfaces it. Worth an explicit join-timeout + surfaced reconnect state (P1/P2, not now).
3. **Harness instrumentation reliability** — the per-page probe counters must be re-worked before the matrix can be trusted.
4. Previously recorded P1 items (memoization, scoreboard, hydration consolidation, indexes, host summary broadcast) remain untouched by design.

## 11. Recommended Phase 9D.3

1. Fix the browser harness instrumentation, then run the full matrix (10→100 desktop, mobile Chrome, multi-question soak at 50+).
2. Re-run the security probe and, only with all twelve §22 gates green, remove the WAL publication and the duplicate bindings.
3. Add join/reconnect telemetry so a stuck `CONNECTING` page is observable rather than silent.
4. Only then start the P1 optimization list.
