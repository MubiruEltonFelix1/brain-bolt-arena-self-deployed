# Brain Bolt — Phase 9D.2: 50+ Player Scalability P0 Fixes

Date: 2026-09-26 · Project: `yzjdaoelllemcvymsffp` · Baseline: `docs/PHASE_9D1_LIVE_ENGINE_SCALABILITY_AUDIT.md`

## Executive Summary

The four P0 workstreams were implemented and applied to the live project:

| Workstream | Status | Evidence |
|---|---|---|
| **P0-C — RLS read/write split** | ✅ Done, verified | `scripts/rls-probe.mjs` 6/6 (signed-in non-host now reads sessions + quiz embeds; write gate intact) |
| **P0-B — server transition authority** | ✅ Done, verified | pg_cron running every minute (~25 ms transactions), stale backlog 30→2, `tick-expiry-test.mjs` PASS with **no host action** |
| **P0-D — N+1 → single RPCs** | ✅ Done, verified | `finalize_league` + `auto_assign_teams` functional test 6/6 (idempotent; 2×N + N round trips → 1 + 1) |
| **P0-A — broadcast transport** | ⚠️ Server side ✅ · real-browser delivery **BLOCKED** · **transitional fallback ACTIVE** | Ladder shows **100 % delivery at every level 10→100 with Node realtime-js clients using the app's exact join config** (30 000/30 000 events @100 vs 33 % before). The real Chromium page receives the broadcast frames but realtime-js does not dispatch them — so, per adversarial review, the pre-9D.2 WAL publication was **restored** and the clients now bind to **both** transports (duplicate delivery is idempotent). Nothing regressed: ≤40 players work as before via WAL; broadcast is the verified successor, gated on the browser decode fix |

**Measured scaling change (bot clients replicating the app's subscription exactly):**

| Players | 9D.1 delivery | 9D.2 delivery | Result |
| ------: | ------------: | ------------: | ------ |
|      10 |          100% |          100% | no regression |
|      20 |          100% |          100% | no regression |
|      30 |          100% |          100% | no regression |
|      40 |          100% |          100% | no regression |
|      50 |      **67%** |      **100%** | collapse removed |
|      75 |      **33%** |      **100%** | stream no longer dies |
|     100 |      **33%** |      **100%** | bounded; 3 questions × 100 answers × 100 subscribers = 30 000 events, 0 dropped |

Per-question in 9D.2: every subscriber received exactly N/N `game:answer_row` events, all session transitions, join p95 ≤ 2 ms, answer p95 ≤ 2 ms server-side, score-update lag p50 0–1 ms. **No claim of production readiness at 100 is made** — the real-browser decode blocker gates the rollout.

`tsc --noEmit` and `bun run build` both pass.

---

## Changes Implemented

**Migrations (applied, marker-verified via `scripts/migration-markers.mjs`):**
- `20260926120000_phase_9d2_rls_read_split.sql` — P0-C
- `20260926130000_phase_9d2_rpc_batching.sql` — P0-D
- `20260926140000_phase_9d2_scheduler.sql` — P0-B
- `20260926150000_phase_9d2_broadcast_transport.sql` — P0-A
- `20260926160000_phase_9d2_scheduler_same_tick_advance.sql` — P0-B follow-up

**Application code:**
- `src/hooks/use-live-channel.ts` — `private?: boolean` channel option (`config: { private: true }`).
- `src/routes/host.$sessionId.tsx` — channel `session:<id>` (private); gameplay bindings moved to broadcast (`game:join`, `game:answer`, `game:answer_row`, `game:team`); only `sessions` transitions remain on `postgres_changes`; `finalizeLeague`/`autoAssignTeams` call the new RPCs.
- `src/routes/play.$sessionId.tsx` — same transport swap; answered-counter rides `game:answer_row`; participants refetch rides `game:answer`/`game:join`.
- `package.json` / `bun.lock` — `@supabase/supabase-js` 2.108.2 → 2.117.1.

**Tooling:** `scripts/rls-probe.mjs` (new regression probe, 6+1 checks incl. broadcast spoofing), `scripts/scale-audit/{runner,load-test,README}` updated to the new transport, `scripts/scale-audit/{create-auth-user,tick-expiry-test,private-broadcast-probe}.mjs` (new).

## Broadcast Architecture

```
player answer → submit_answer RPC (authoritative, unchanged)
             → Postgres commit: answers INSERT + participants UPDATE
             → AFTER triggers (definer) → realtime.send(payload, event, 'session:<id>', private=true)
             → Realtime Broadcast → subscribers of the private session topic
```

- **Postgres remains the only source of truth.** Broadcasts carry only ids/changed values (`{participant_id}`, `{participant_id,question_id,is_correct}`, `{participant_id,score,streak}`, `{team_id}`).
- **Server-published only.** Trigger functions are `SECURITY DEFINER`; `realtime.messages` has exactly one policy (SELECT for `anon, authenticated` on `session:%`), **no client INSERT policy**. Verified end-to-end: a forged `channel.send` from an anon client and from an authenticated player delivered **0 events** to a listening subscriber; `realtime.send` is not reachable via PostgREST ("Invalid schema: realtime").
- **Publication diet:** `answers`, `participants`, `teams` are OUT of `supabase_realtime` (no more per-row WAL fan-out — the measured 9D.1 collapse mechanism). `sessions` stays on `postgres_changes` (1–3 transitions per question; the existing resync path already covers a missed one).
- **Event taxonomy (4 events):** `game:join` (participants INSERT), `game:answer` (participants UPDATE **only when score/streak changed** — no-op writes send nothing), `game:answer_row` (one per accepted answer — drives the answered counter), `game:team` (teams writes).
- **Reconnect safety unchanged:** missed broadcasts are recovered by the existing authoritative `load()` / `loadState()` resync on every (re)subscribe (brief §10). Triggers swallow their own errors so a broadcast failure can never break a write (§18).
- Rollback: `SELECT public.restore_gameplay_publication();` restores the WAL publication; client bindings revert via git.

### Open blocker (P0-A rollout gate)

Reproduced precisely: with the production build served locally and the real `/play` page open in Chromium (headless shell, `visibilityState: visible`), triggering 3 score updates produced **3 binary frames (ArrayBuffer, 246 bytes each) at the page's WebSocket — confirmed by in-page `WebSocket` instrumentation — and `0` dispatches to `on("broadcast")` handlers**. A Node/Bun client with the **same library version and the identical `phx_join` payload** (`{"config":{...,"private":true}}`) dispatches all of them. Both 2.108.2 and 2.117.1 behave identically (the version bump was a **false lead**). Session transitions (text frames) still work on the same channel.

**Concrete root-cause lead (adversarial review):** `@supabase/realtime-js`'s `_binaryDecode` handles only `KINDS.userBroadcast` (4) with **no default case** — an unknown kind byte returns `undefined` and the frame is silently dropped (`node_modules/@supabase/realtime-js/dist/module/lib/serializer.js:118-126`). Phoenix correctly sets `binaryType = "arraybuffer"` (`node_modules/@supabase/phoenix/priv/static/phoenix.mjs:1198,1482`), consistent with the observed ArrayBuffers. Hypothesis: the server's push for DB-published broadcasts carries a kind byte ≠ 4. **Next step:** log the first bytes of the ArrayBuffer in the in-page wrapper to identify the kind, compare against the server's push format, then patch/pin the client (or adjust the publish path).

**Transitional state (what is live right now):** the WAL publication was restored (`20260926170000_phase_9d2_transitional_fallback.sql`) and both route components bind to **both** transports — broadcast *and* the pre-9D.2 `postgres_changes` bindings. Every handler feeds coalesced refetches and de-duplicated appends, so double delivery is harmless. Real users therefore keep working live updates exactly as before 9D.2 while the browser decode is closed. Once verified, re-apply the publication diet (20260926150000) and remove the WAL bindings from both routes.

## Scheduler Architecture

- **`pg_cron` installed**; job `brainbolt-autonomous-scheduler` runs `SELECT public.run_autonomous_tick()` at `* * * * *` — **one short transaction per minute** (runs observed: `succeeded`, ~25 ms each). The original 58-second in-transaction loop is deliberately NOT scheduled: every row lock it takes would be held for ~58 s of every minute and would make host controls (`reveal_current_question`, `advance_question`, `pause_session`, `add_question_time`) wait on it.
- **Lock-light progression:** candidate scan takes no row locks; reveal is an idempotent guarded UPDATE (same `current_question_started_at`, `revealed = false`, past deadline); advances go through new `advance_question_if_unadvanced(session, expected_started_at, mode)` which takes a statement-scoped row lock, re-verifies the question is still the same/active/revealed/past-deadline, and only then calls the existing `advance_question_internal`. A concurrent host action makes it a no-op → **no Q4→5→6 double advance** (brief §16).
- **Same-tick advance (follow-up migration):** a late tick that reveals after the 8 s hold window has already elapsed advances in the same invocation — a dead-host game needs one cadence, not two.
- **Stale recovery:** sessions abandoned >24 h were ended once (30 → 2 active); anything younger is drained by the tick through the normal authoritative path.
- **Observability:** `cron.job_run_details` (status/start/end/return_message) — documented in the migration header.
- Rollback: `SELECT cron.unschedule('brainbolt-autonomous-scheduler');` returns to the pre-9D.2 host-only authority.

## RLS Changes

`FOR ALL TO authenticated` RESTRICTIVE policies on `sessions`, `quizzes`, `questions`, `leagues` (created together in 20260718000327) also gated **SELECT**, so a signed-in non-host could not read a single session row — the "Game not found" join bug from the audit. They are replaced by per-command RESTRICTIVE policies (INSERT / UPDATE / DELETE) with the identical predicate; SELECT now falls back to the intended permissive read policies (documented MVP design). **No write gate was weakened** — verified live: non-host UPDATE → 0 rows; host UPDATE → 1 row.

## RPC Batching Changes

| Operation | Before | After |
|---|---|---|
| League finalize | 2×N sequential REST calls from the host browser (~100 @50 players) | 1 RPC, one upsert statement, one transaction; `sessions.league_finalized_at` single-claim makes double-taps/reconnects idempotent (`finalized=false`) |
| Team auto-balance | N sequential UPDATEs | 1 RPC, single statement, deterministic round-robin (score DESC order preserved) |

Measured functional test: 4 participants + 2 teams → one call assigns 4 (2/2 split), second call returns 0; two finalize calls → `(true, 4)` then `(false, 0)`; standings rows written exactly once.

## Before vs After Scaling

See Executive Summary table. Raw evidence: `scripts/scale-audit/metrics-p{10,20,30,40,50,75,100}-*.json` (9D.2) vs the 9D.1 metrics files.

## Realtime Delivery Metrics (9D.2, bot clients w/ app's exact join config)

| Players | events delivered / expected | session events | join p95 | answer p95 | score-lag p95 |
|-------:|---------------------------:|---------------:|---------:|-----------:|--------------:|
| 10 | 300/300 | 60/60 | 1 ms | ≤1 ms | ≤1 ms |
| 50 | 7500/7500 | 300/300 | 1 ms | ≤1 ms | ≤1 ms |
| 100 | 30000/30000 | 600/600 | 2 ms | ≤2 ms | ≤1 ms |

Zero join failures, zero channel failures, zero answer errors at every level.

## Answer Latency / Question Transition Latency

- Answer RPC: p95 ≤ 2 ms server-side through 100 players (sub-ms RTT test vantage; real-user RTT adds on top).
- Transitions (advance → event at all subscribers): advProp p50 1 ms, p95 1 ms at 100 players; revealProp p50 1 ms, all 100/100 subscribers saw each transition.

## Scheduler Reliability

- 2 consecutive minute runs observed: `succeeded`, ~25 ms each, `return_message` shows the tick's action rows.
- `tick-expiry-test.mjs --players 50`: server revealed AND advanced an expired question with **no host action**, bounded within one cadence; second run showed reveal+advance inside a single tick transaction (threshold +24.7 s).
- Zero tuple locks on `sessions` sampled while active sessions existed.

## Database Metrics

- No lock contention introduced: 0 lock-wait samples during bursts (lockwatch in `runner.mjs`); the tick holds locks for milliseconds.
- New index still outstanding from 9D.1 (`answers(session_id, question_id)`, `participants(session_id, score DESC)`) — not required at these volumes, still recommended as P1.
- 5 migrations applied atomically per file; markers added; **note:** `scripts/migrate.mjs` currently stops on a pre-existing pending migration (`20260822120000_phase_8e_ai_question_builder.sql` — psql exits 0 but its marker probes false) and on `20260823120000_phase_9b_arena_publication_platform.sql`; the 9D.2 migrations were applied directly with identical psql semantics. This pre-existing blockage is unrelated to 9D.2 but will block future automated migration runs.

## Browser Metrics (host + player pages, 50-player burst, production build)

- Pages load, login, render lobby, receive transitions: reveal→host UI 730 ms, →player UI 2 481 ms; host timer still revealed its own question under load (`--timer-test`: reveal=true, 15.5 s from wait start).
- Long tasks: 3 × 230 ms total on the host in the burst window (0 in the second), player ≤42 ms lag; heap steady ~12 MB; REST unchanged (1 coalesced `participants` refetch + 3 `get_server_time` per question).
- **Broadcast frames reached both pages but were not dispatched (the open blocker above)** — 1 counted WS message per burst window.

## Security Verification

`scripts/rls-probe.mjs` → **7/7**: guest reads ✅, signed-in non-host reads ✅ (fixed), session+quiz embed ✅, non-host write denied (0 rows) ✅, host read+write ✅, **forged broadcasts deliver 0** ✅ (anon + authenticated publish attempts; PostgREST `realtime.send` unreachable). The RPCs are `SECURITY DEFINER` with `is_session_host` checks; no client can mutate another player's state, advance a question, or change a score.

## Remaining Bottlenecks

1. **P0-A browser delivery (blocker, above).** Highest priority; nothing else about P0-A ships until this is understood.
2. **Tick cadence is 1/minute by design** — a dead host delays reveal/advance by ≤1 cadence (bounded, self-healing). If sub-minute authority is ever required, it needs a scheduler outside pg_cron (external trigger) rather than an in-transaction loop.
3. Host-side render work from 9D.1 (`O(P·T)` leaderboard, global 200 ms tick, no memoization) — unchanged; not the current bottleneck on desktop-class hardware.
4. Reconnect resync waterfalls (6 / 4–5 queries) — unchanged P1.
5. The two missing indexes — unchanged P1.
6. Pre-existing migration-runner blockage (AI-builder / Arena-publication markers) — needs attention before the next automated migration run.

### Adversarial review outcomes (all findings addressed or explicitly accepted)

- **BORKED (fixed):** P0-A removed a working transport before its replacement was proven → **transitional fallback applied** (publication restored + clients bind both transports), see the Open blocker section.
- **LIKELY BORKED (fixed):** the P0-B marker probed `cron.job` directly, which is a parse-time error on a database without pg_cron (and the probe helper throws on SQL errors) → marker is now catalog-only (`pg_namespace`/`pg_class`).
- **Credential hygiene (fixed):** `scripts/scale-audit/auth-user.json` + `chrome-profile/` were untracked-but-not-ignored (a stray `git add -A` could commit throwaway credentials / a browser profile holding an auth token) → `chrome-profile/` deleted and `.gitignore` now covers `fixture.json`, `auth-user.json`, `chrome-profile/`, `metrics-*.json`, `browser-*.json`.
- **Accepted (documented):** the migration's one-time `>24h stale session` cleanup is intentionally destructive but bounded (only abandoned lobby/active rows); enabling pg_cron makes the Phase-21 tick advance hosted sessions after reveal+8 s (reviewer verified the double-advance guard is sound — this is the designed behaviour); host-side player changes (team/avatar) still reach players only via the next event (host compensates explicitly) — a `game:player_update` event is a P2 follow-up; the two `(supabase.rpc as any)` casts are the repo's existing precedent until DB types regenerate; the `realtime.send` REVOKE hard-codes arity (no-op on this project, noted for other environments).
- **Verified clean by the reviewer:** the RLS split preserves write gating verbatim; no client path counts answers from `game:answer`; no double-advance window in the guarded helper; `use-live-channel` dependency array correct; no straggler `host:`/`play:` channel names; `phase21-host-wiring.test.ts` still passes.

## Next Recommended Phase

**Phase 9D.2b — close the browser broadcast decode blocker, then re-run the ladder with real browser pages.** Concretely: reproduce outside headless shell; trace the ArrayBuffer → handler path in the browser bundle of `@supabase/phoenix`/realtime-js; if a client-side fix is not possible quickly, adopt the documented fallback (throttled host-published scoreboard snapshot + retain `participants` in the publication as a stop-gap) rather than shipping a transport real players cannot see. Only after real-browser delivery is confirmed: P1 items (host summary broadcast, one-RPC hydration, memoization pass, the two indexes), then a 100-player soak with representative client devices.
