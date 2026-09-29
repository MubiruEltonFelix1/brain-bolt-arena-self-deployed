# Phase 9D.1 — Live Engine Scalability Audit (50+ player readiness)

Status: **audit complete — optimization NOT started (deliberately)**
Date: 2026-09-25
Scope: full live-game critical path — join → lobby → question start → timer → answer submission →
server grading → score update → leaderboard/state → realtime propagation → client update →
reveal → next question → completion → results.

Method: static code audit of this repo + **live measurement against the production Supabase project
(`yzjdaoelllemcvymsffp`)** using the exact RPCs, realtime channels, and real browser clients the app
ships. Harness: `scripts/scale-audit/` (fixture, load ladder, official-harness driver, browser profiler).
No production game was disturbed; all test data was created in a scratch fixture and deleted afterwards
(verified: 0 leftover rows).

Environment note that colors every absolute number: the test machine sits ~300 ms RTT from the Supabase
region. Absolute latencies therefore include a ~300 ms floor. The **relative** scaling behavior — what
changes between 10 and 100 players — is the signal, and it is unambiguous.

---

## Executive Summary

**The single highest-impact bottleneck is Supabase Realtime fan-out through Postgres CDC
(`postgres_changes`). It collapses between 40 and 50 concurrent subscribers per session, while the
database, RPC, and browser layers stay healthy.** Everything else found is secondary.

Measured, reproducible progression (N subscribers = N players, one full realtime channel each,
3 questions × 1 simultaneous burst of N answers per question):

| Players (subscribers) | Participant events delivered to a client | Session (advance/reveal) events delivered | Verdict |
|---|---|---|---|
| 10 | 30/30 (100%) | 6/6 | healthy |
| 20 | 60/60 (100%) | 6/6 | healthy |
| 30 | 90/90 (100%) | 6/6 | healthy |
| 40 | 120/120 (100%) | 6/6 | healthy |
| **50** | **100/150 (67%)** — entire question's events missing | **2/6** | degraded |
| **75** | **75/225 (33%)** — only the first burst arrives | **1/6** | broken |
| **100** | **100/300 (33%)** — only the first burst arrives | **1/6** | broken |

Cross-checked with the repo's own `scripts/load-test.mjs` at 100 players: participate-events delivered
100/100 per channel (single question) **but no channel received the reveal transition event**. At 50
players the official harness passes a *single-question* run cleanly — the collapse is cumulative across
a multi-question game, which is exactly a real game's shape.

Meanwhile at 100 players: answer RPC p95 = 611 ms, join p95 = 1 099 ms (≈RTT floor of ~300 ms + modest
server time), zero DB lock waits sampled during every burst, and real browser pages showed **0 long
tasks, ≤16 ms event-loop lag, ~380 ms reveal→UI latency**. The bottleneck is not Postgres, not the RPC
layer, not React rendering, and not the player's device — it is per-subscriber WAL fan-out.

Compounding reliability finding: **the Phase 21 server-side scheduler is not running in production**
(`pg_cron` is not installed on the live database; 28–30 stale `active` sessions sit unadvanced as proof).
The only transition authority in practice is the **host browser**. That is the exact mechanism behind
the documented ~50-player production incident (timer reaches 0, question does not transition, host must
hammer End-Early) — and the promised Phase 21 safety net is inert today.

Also found along the way (real, verified, separate from scaling):
1. **RLS blocks every signed-in non-host user from joining or playing a game.** The `sessions`
   restrictive policy `host only write` is `FOR ALL TO authenticated` and therefore also gates SELECT;
   a signed-in user without a host role/grant reads zero session rows (`/join/<code>` → "Game not
   found"). Verified with two independent JWT probes (anon sees the row; authed non-host sees null).
2. **`brain-bolt-arena.lovable.app` (README "Live Demo") points at a dead Supabase project**
   (`gmtddgaupquditwokmuh.supabase.co` — DNS does not resolve). The app loads but every data call fails.
3. Cosmetic-but-real hot path waste: duplicate `reveal_current_question` calls, N+1 league finalize,
   6-query hydration waterfalls on every reconnect, zero memoization under a 200 ms global tick.

---

## Live Game Architecture Map

```
                    HOST BROWSER                        PLAYER BROWSER (per player)
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ /host/$sessionId (react component)       │   │ /play/$sessionId                         │
│  ─ useLiveChannel("host:<id>")           │   │  ─ useLiveChannel("play:<id>")           │
│      · postgres_changes sessions UPDATE  │   │      · postgres_changes sessions UPDATE  │
│      · postgres_changes participants *   │   │      · postgres_changes participants *   │
│      · postgres_changes answers INSERT   │   │      · postgres_changes participants UPD │
│      · postgres_changes teams *          │   │        (2nd local handler, same event)   │
│  ─ 200 ms clock tick (setNow)            │   │  ─ 200 ms clock tick (setNow)            │
│  ─ timer expiry → revealRound()          │   │  ─ submit_answer / submit_geo_…  (RPC)   │
│  ─ controls → RPCs (advance/reveal/…)    │   │  ─ get_round_progress (per question)     │
└───────────────┬──────────────────────────┘   └───────────────┬──────────────────────────┘
                │ supabase-js (REST + one WS)                  │
                ▼                                              ▼
     PostgREST ──► Postgres (RLS, SECURITY DEFINER RPCs) ◄── PostgREST
                │                                              │
                └──── WAL → publication {sessions, participants, answers, teams}
                                     │
                        Supabase Realtime (per-subscriber fan-out, RLS per event)
```

**Critical path, step by step (with measured facts):**

1. **Join** — `/join/<code>`: 1 `lookup_game_code` RPC + sessions select + optional teams select +
   `join_session` RPC (SECURITY DEFINER; participant + participant_secrets inserts; 4 statements).
   Then `/play/$sessionId` hydrates: sessions select, `get_session_questions` RPC, participants select,
   own-answers select (4–5 sequential round trips), opens one WS channel, syncs server clock (3 RPCs),
   seeds `get_round_progress` (1 RPC).
2. **Lobby** — players appear via `participants` INSERT (one WAL event each) → every host/player list
   is refreshed through a **250 ms trailing-coalesced full refetch** (`useCoalescedCallback`).
3. **Question start** — host `advance_question` RPC (or auto on autonomous) sets
   `current_question_started_at = now()` in the session row → one WAL event → **every** client fans out.
4. **Timer** — purely client-side math (`getQuestionIntroTiming`) over the server timestamp; an
   authoritative server tick exists (`run_autonomous_tick`) but **does not run** (pg_cron missing).
5. **Answer** — one `submit_answer` RPC per player (~8 statements in one transaction:
   token check → participant row lock → session⋈quiz read → order validation → dedupe EXISTS →
   question read → `answers` INSERT → `participants` UPDATE score/streak).
6. **Score/leaderboard** — one `participants` UPDATE = one WAL row per answer. Host additionally
   receives the `answers` INSERT row. Players re-derive rank from a coalesced full participants refetch.
7. **Reveal** — host (or `end_question_early`) sets `current_question_revealed = true` → one WAL event;
   each player then calls `get_my_round_result`; host calls `get_round_stats`.
8. **Advance** — `advance_question_internal`: `FOR UPDATE` session row, index+1, new `started_at`.
9. **Completion** — `status='ended'` → trigger `record_competition_results` (per participant rank +
   LATERAL accuracy scan). If `league_id` is set, the host client then runs `finalizeLeague`:
   **a 2×N sequential REST loop** (SELECT + INSERT/UPDATE per participant).

**Fan-out accounting per answer (N = players, all subscribed):**

| | DB writes | Realtime deliveries |
|---|---|---|
| 1 answer | 2 rows (`answers` INSERT, `participants` UPDATE) | participants → host + N players = **N+1** messages; answers → host = **1** ⇒ **N+2 messages/answer** |

Per question: N(N+2) ⇒ **2 600 messages @50**, **10 200 messages @100**. Plus each client's coalesced
refetch (measured: 1–3 per page per question, not N).

---

## Current Scaling Behavior

Exactly what the measurement ladder showed (clean machine; 3 questions; burst = all players at once):

```
subscribers   10    20    30    40    50     75     100
delivery %   100   100   100   100    67*    33     33     (*2 of 3 questions)
session evts  6/6   6/6   6/6   6/6    2/6    1/6    1/6
answer p95   ~0.6s ~0.6s ~0.6s ~0.6s  0.6s   0.6s   0.6s   (≈RTT-bound; flat)
```

- **≤40 subscribers: fully reliable.** All events delivered, lag 0.5–2 s, DB/RPC healthy.
- **50 subscribers: first failure point.** One of three questions' participant events never arrived at
  any client during that question's lifetime; only 2 of 6 session events arrived.
- **75–100 subscribers: effectively broken for gameplay.** Every client received exactly **one
  question's worth** of participant events (75 and 100 per client respectively) and then the stream
  went silent for the rest of the run — including all subsequent advance/reveal events.
  Session events: 1 of 6 delivered.
- The **DB write path never degrades**: 0 lock-wait samples during every burst; answer RPC latency
  stays ≈RTT-bound (p95 598 ms @50, 611 ms @100).
- The **browser never saturates** on this class of machine: 0 long tasks at 50 and 100 answer events
  per burst, ≤16 ms max event-loop lag, ~10 MB heap, reveal→UI ≤ 621 ms.
- The strongest claim we can make today: **≤40 concurrent players is measured-safe; 50 is unreliable;
  75+ is not playable without fixes.** No claim of 100-player support is made.

---

## Measured Bottlenecks

1. **Realtime fan-out collapse ≥50 subscribers (primary).** Evidence: two independent harnesses, per-bot
   event logs, exactly-quantized loss (one question's worth), silent stream afterward, healthy DB.
   Classified: **Realtime-bound + architecture/fan-out-bound**.
2. **No server-side transition authority in production (reliability, P0).** `pg_cron` absent; the
   Phase 21 tick never runs; stale active sessions prove it. Classified: **Architecture/availability**
   (turns bottleneck #1 from "late UI" into "game stuck at 50+").
3. **RLS authz bug for signed-in players (correctness, P0).** Restrictive `FOR ALL TO authenticated`
   policy on `sessions` gates SELECT. Verified null vs row with two tokens.
4. **Host client does ≥2 WAL subscriptions' worth of work per answer** (participants + answers INSERT)
   plus O(A²) `answersForRound` appends. At 200 WS messages per question @100, this is the largest
   per-client cost in the system. Classified: **client work amplification** (survivable now, and a
   factor in the historical host-freeze incident).
5. **Reconnect resync waterfalls** — host 6 queries, player 4–5 + 3 clock RPCs + 1–3
   `get_round_progress` (measured 13 REST calls per player reconnect). A 50-player reconnect storm
   ≈ 300–650 requests. Classified: **DB/REST churn** (secondary).
6. **N+1 host loops** — `finalizeLeague` (2×N round trips; ~100 sequential calls ≈ 30–60 s at real RTT
   @50 players) and `autoAssignTeams` (N updates). League sessions only. Classified: **fan-out N+1**.

---

## Database Analysis

- Live path uses `SECURITY DEFINER` RPCs for all gameplay writes; **RLS is not on the write path**
  (no `can()`/principal lookups per answer). Reads of `sessions`/`participants`/`answers` are governed
  by permissive `USING (true)` policies — no expensive predicates.
- **One exception with real cost:** the RESTRICTIVE policy `sessions host only write`
  (`FOR ALL TO authenticated`, `is_authorized_host() OR has_active_host_authorization(auth.uid())`)
  applies to SELECT too. Besides breaking signed-in players (P0 above), it makes every authenticated
  row evaluation on `sessions` run the authorization predicate — including during realtime RLS checks.
- **Indexes verified in production:** `sessions(code)` unique (+ a redundant `sessions_code_idx`),
  `participants(session_id)` + `(session_id,nickname)` unique, `answers(session_id)` +
  `(participant_id,question_id)` unique, `questions(quiz_id,position)`.
  **Missing:** `answers(session_id, question_id)` — used by `get_round_progress` (called by *every
  player every question*: 50×/question at 50 players), `get_round_stats`, and skip refunds;
  `participants(session_id, score DESC)` — the leaderboard/fetch ordering. Neither is the current
  bottleneck at ≤100 (tables are tiny), but both are cheap, low-risk wins before higher counts.
- **Triggers:** none on `answers`/`participants` (no per-answer trigger overhead). Session end fires
  `record_competition_results` (rank window + per-participant LATERAL accuracy scan) — O(P·answers),
  acceptable at 100, revisit beyond.
- **Lock behavior:** measured zero lock waits during all bursts (sampled every 250 ms); per-answer
  locks are on the player's own participant row. No contention identified.
- **Orphan/stale state found:** 28–30 sessions left in `active` (unpaused) from past games — direct
  proof that nothing server-side advances them.

## RPC Analysis

| RPC | Caller / frequency | Rows touched | Measured cost | Notes |
|---|---|---|---|---|
| `join_session` | per player, once | sessions read, participants+secrets insert | p95 899 ms @50 (official) | wall time 0.9–1.3 s for 50–100 simultaneous joins |
| `submit_answer` (+geo/number/text/ordering) | per player per question | 8 statements, 1 txn | p95 598–611 ms @50–100 | single round trip; token-authenticated; dedupe via unique index |
| `advance_question(_internal)` | host, per question | session `FOR UPDATE` + update | sub-RTT | idempotency via index; also used by (dormant) tick |
| `reveal_current_question` | host, per question | session update | sub-RTT | observed firing **twice** per question from the host UI |
| `get_round_progress` | per player per question (+ per reconnect) | count over answers | grows with answers/question | needs the missing composite index |
| `get_round_stats` | host per reveal | aggregate over answers | fine @100 | called 3× in the 50-player browser run (reveal effect + duplicates) |
| `get_my_round_result` | per player per reveal | 1 answer row | fine | |
| `get_server_time` | every client every 30 s + on question start (×3 calls) | — | ~300–700 ms | small but constant; batching possible |
| `finalizeLeague` (client loop) | host at session end (league only) | 2×N REST calls | ≈100 sequential calls @50 | replace with one RPC |

All live RPCs bypass `can()`/principal machinery entirely (verified: `can()` is granted to
`service_role` only). **RLS/principal overhead is NOT a measurable cost on the live write path.**

## Realtime Analysis

- **No `broadcast` anywhere.** All fan-out is Postgres CDC (`postgres_changes`) over the publication
  `{sessions, participants, answers, teams}`.
- **Channels per browser: 1.** Host: 4 bindings (sessions UPDATE, participants *, answers INSERT,
  teams *). Player: 3 bindings — two of them on `participants` (a refetch handler **and** an answer
  counter) so the same wire event runs two local handlers.
- **Message volume, measured on real pages:** per question at 50 players: host 100–102 messages
  (50 participants + 50 answers + transitions), player 50–56. At 100 players: host **200**, player
  **100** per question. The host receiving every `answers` row is pure overhead for a board that only
  needs counts.
- **Latency of score updates (measured, per receiving client):** ~1–2 s at ≤40 subscribers;
  2.5–3.5 s at 50 (first burst); 1.5–2.5 s at 100 (first burst). Session transitions, when delivered,
  land in 0.5–2.5 s at ≤40; **not delivered at all** for whole questions at 75–100.
- **Delivery failure is permanent for the game:** the client design deliberately never replays missed
  events (resync only on reconnect/visibility), so a dropped transition leaves clients stale until the
  next reconnect or the next delivered event.
- **Amplification:** 1 answer ⇒ **N+2 messages**; one question ⇒ N(N+2) messages. This is the cost
  model that breaks at ~50 subscribers.
- Coalescing (250 ms trailing refetch) works and is the reason ≤40 players is comfortable: measured
  1–3 REST refetches per client per question instead of N.
- The publication includes `answers` (host only) and `teams` (rarely changes) — both are avoidable
  fan-out surface.

---

(Part 2 continued below.)

## Network Analysis

- Per answer (N subscribers): websocket messages ≈ N+2 total; per client ≈ 1 (player) to 2 (host).
  At 50 players: 2 600 channel messages per question, 10 200 at 100 players.
- REST per answer: **0** (no client refetches per answer thanks to the 250 ms coalescer); measured
  1–3 participants refetches per client per question.
- Reconnect: 13 REST requests per player (sessions, questions RPC, participants ×7 from repeated
  coalesced bursts, answers, get_round_progress ×3, get_server_time ×3) — a 50-player simultaneous
  reconnect ≈ 650 requests concentrated in a few seconds; DB handles it, but it is wasted work.
- No polling of live state exists anywhere (the 200 ms tick is local-only; clock sync every 30 s).
- Payloads: `postgres_changes` payloads are whole rows (all columns). The host's `answers` INSERT
  stream and the `participants` *(all columns: nickname, scores, avatar, team)* stream are the big
  repeat senders; no delta/trimmed variant exists.
- Client is **not** network-bound at tested volumes (no queuing observed on real pages; WS delivery
  itself is the failure mode, not bandwidth).

## Client/React Analysis

Static: **zero `React.memo`/`memo()` in the codebase**; both live routes re-render their full tree on a
**200 ms `setNow` tick (5×/s)** plus every realtime event. Host-specific hotspots:
`participants.map` leaderboard with `teams.find` per row per render (O(P·T), unmemoized);
`answeredThisRound`/`correctThisRound` recompute an O(A) filter+Set per render;
`answersForRound` append does an O(A) dedupe scan **per answer** (O(A²) per question);
team-total aggregation is O(T·P) + sort per render; `PlayerWall` receives a freshly built array with
per-player object allocation every host render (DOM itself is capped at ≤16 nodes — good);
`Confetti` re-randomizes 60 pieces per render; `FinalReview` is O(Q²). Player route derives
`myRank` by `findIndex` (O(P)) and re-runs `seededShuffle` per render for MCQ.

Measured on real production-build pages (headless Chromium, 1600×900 host / 390×844 player):
- 50 players: **0 long tasks** on a clean question (host lagMax 4 ms, player 6 ms), heap steady ~10 MB.
- 100 players (200 messages host-side per question): **0 long tasks**, lagMax 6–16 ms, heap ~10 MB.
- Reconnect storm at 50 players: player page took a **731 ms event-loop stall** during recovery
  (resubscribe + 7 participants refetches + 3 progress seeds). Host 146 ms in the same window.
- Reveal → UI latency: 367–384 ms (50 and 100 players).
- Verdict: **rendering is not the current bottleneck on desktop-class hardware**, but the code has no
  headroom-protection for low-end devices (no memoization, global 200 ms re-render, O(P·T) leaderboard),
  and the reconnect path produces measurable jank. This is where the historical "host freeze" hazard
  lives, not in the steady state.

## Timer & Question Transition Analysis

- Authority: `current_question_started_at` on the session row is the single server timestamp; both
  clients compute intro/remaining locally (frozen timing engine, untouched).
- Transition paths observed in code: (a) host auto-reveal effect (timer expiry OR all-answered) →
  `reveal_current_question`; (b) host controls (End-Early/Skip/Next) → RPCs; (c) the server tick
  (`run_autonomous_tick`) — **inert, pg_cron absent**; (d) autonomous competitions — same tick, inert.
- Measured on a real host page at 50 players: with the tick absent, the **host browser alone** revealed
  the expired question, ≈1.9 s after the deadline (works on a healthy machine). Under the historical
  incident conditions (host tab saturated/throttled) this path is the single point of failure.
- Duplicate work observed: the host's auto-reveal called `reveal_current_question` **twice** in one
  question (the identity-key guard requires the `revealed` closure value, which is stale in the second
  invocation) and `get_round_stats` 3× — each duplicate is a wasted RPC and, worse, an extra session
  WAL event fanned out to every client.
- Stale-state guards (`p_expected_started_at`, idempotent updates, `SKIP LOCKED`) are sound; no
  double-advance corruption was observed.

## Reconnect & Recovery Analysis

- `useLiveChannel` guarantees one channel per mount, teardown-first reconnects, backoff 1→15 s, and a
  **full authoritative resync on every SUBSCRIBED**. No duplicate channels or leaked listeners found.
- Measured (50 players, mid-question offline 5 s): first WS frame within <100 ms of coming online;
  question UI restored (`ROUND n` visible again) with no duplicate-answer risk (server dedupes;
  the client re-reads state, never replays events).
- Cost per player reconnect: 13 REST calls (above). Host reconnect: 6 sequential queries + clock.
- Residual risks: reconnect storms (Scenario F) produce a thundering herd on `participants` reads;
  tab-background/sleep on mobile throttles the 200 ms tick, and with the cron absent the host's
  transition duties degrade silently first.

## 50+ Player Findings

1. **Realtime fan-out collapses at ≥50 subscribers** (primary). Reproduced twice, on two harnesses,
   with per-bot logs; quantized loss pattern; stream silence after the first burst at 75/100; session
   transitions dropped entirely for whole questions.
2. **DB and RPC layers stay healthy** at 100 players (0 lock waits; p95 611 ms ≈ network floor).
3. **Browsers stay healthy** with 2 subscribers at 100-answer bursts, but the **host receives 2× the
   message volume of any player** (200 vs 100 per question at 100 players) — the host is the most
   loaded client by design, and the host is also the sole transition authority (see #5).
4. **The join phase at 100 simultaneous joins** takes ~0.9–1.3 s wall and p95 1.1 s per join — healthy,
   but it is the second-largest burst load after answers.
5. **Reliability cliff at 50 players is not just latency**: with transitions dropped and no server
   tick, a real 50+ game can reach "timer at 0, nothing happens" exactly as the Phase 21 postmortem
   described — the fix shipped in code, but the scheduler that powers it never runs.
6. **Signed-in players can't play at all** (RLS) — independent of scale, verified live.

## Bottleneck Classification

| Area | Class | Evidence |
|---|---|---|
| Participants/session event fan-out ≥50 subscribers | **Realtime-bound + architecture/fan-out-bound** | delivery 67%→33%; exactly one question's worth per client; two harnesses agree; stream silence |
| Question transitions | **Architecture/availability** (single caller + inert scheduler) | pg_cron absent; stale active sessions; host-only reveal path; ~1.9 s host-driven reveal under load |
| Per-answer client work (host) | Client-work amplification | host 2 messages/answer; O(A²) appends; O(P·T) leaderboard; 0 long tasks today = headroom, not immunity |
| Reconnect resync | DB/REST churn (secondary) | 13 requests/player; 731 ms player stall during storm |
| League finalize / team assign | N+1 fan-out (secondary) | 2×N and N sequential REST loops in the host browser |
| Answer/join RPC latency | **Not a bottleneck** (RTT-bound) | p95 598–611 ms at 50–100 ≈ 2× ~300 ms RTT |
| DB locks/triggers | **Not a bottleneck** | 0 lock waits sampled; no triggers on hot tables |
| React rendering | **Not a bottleneck (desktop-class)** | 0 long tasks at 100-player message volume |
| Memory | No leak observed (short games) | steady ~10 MB heap; long-game soak still recommended |

### Bottleneck map (ranked by measured impact × production risk)

| Rank | Area | Current behavior | Scaling behavior | Evidence | Severity | Recommended fix |
|---|---|---|---|---|---|---|
| 1 | Realtime fan-out | Full delivery ≤40 subs; cliff at 50 | O(N²) messages/question; pipeline never catches up ≥75 | Ladder + official harness + per-bot logs | **Critical** | P0-1: move scoreboard/answer sync to coalesced **broadcast**; trim subscriptions |
| 2 | Transition authority | Host browser only (cron inert) | Host saturation = game stuck | pg_cron absent; stale sessions; Phase 21 postmortem | **Critical** | P0-2: run a server tick (pg_cron or scheduler) + keep host path |
| 3 | Signed-in player RLS | sessions SELECT blocked for authed non-hosts | Constant failure | JWT probes (null vs row) + live policy DDL | **Critical** | P0-3: split restrictive policy by command; allow SELECT |
| 4 | Host per-answer work | 2 messages/answer; O(A²) state append | Grows with answers + players | Browser WS counts; code audit | High | P1-2: broadcast summary instead of raw answers stream; cap/replace append |
| 5 | League finalize / team assign | 2×N / N sequential REST | ~30–60 s @50 (league games) | Code audit; measured RTT | High (league path) | P0-4: single RPC per operation |
| 6 | Reconnect resync | 6 / 4–5 query waterfalls ×N clients | Storm = 13×N requests | Browser REST counts + stall | Medium | P1-3: one `get_live_state` RPC |
| 7 | Client re-render structure | Unmemoized, 200 ms global tick | O(P·T)/O(A²) per render ×5/s | Code audit; 0 long tasks today | Medium (device-dependent) | P1-4: memoize + isolate ticking |
| 8 | Missing indexes | `answers(session,q)`, `participants(session,score)` absent | Per-player-per-question scans of session answers | Live `pg_indexes` + RPC audit | Low–Medium | P1-5: add both |
| 9 | Duplicate reveal/stats calls | reveal ×2, stats ×3 in one question | Wasted RPCs + extra WAL fan-out | Browser REST counts | Low | P2-1 |

---

## P0 Fixes (before any 50+ production use)

**P0-1 — Replace per-row scoreboard fan-out with coalesced broadcast.**
Keep Postgres as the only source of truth; change only the *transport*. Split the realtime surface:
- `sessions` transitions (rare, critical): keep `postgres_changes` **or** move to broadcast from the host
  action (1 message per transition instead of N subscribers × 1 WAL delivery).
- `participants` per-answer stream: replace with a **throttled broadcast snapshot** (≤2 Hz per session):
  sender (host client after its coalesced refetch, or a tiny server route/RPC) emits the top-K + the
  player's own row/progress on one session topic. Players then receive ≤2 messages/second instead of N
  per question; the host stops receiving N `participants` rows **and** N `answers` rows per question.
- Meanwhile add a **subscription diet** (safe on its own): drop `answers` INSERT from the publication
  for hosts (counts can ride the snapshot), drop `teams` unless team mode is on.
- Correctness preserved: same DB writes, same RPCs, same grading; clients re-read authoritative state
  on reconnect; snapshots are derived data, rebuildable from the DB (no second source of truth).

**P0-2 — Restore a server-side transition safety net.**
Install/enable `pg_cron` on the project (or, if unavailable on the plan, a scheduled HTTP trigger) and
verify `run_autonomous_scheduler` actually executes; confirm the Phase 21 tick advances hosted sessions
(2-arg reveal + widened tick are already deployed). Add a `cron.job` presence check to
`scripts/check-migrations.mjs`. Until this is live, a saturated host browser can stall any game ≥50.

**P0-3 — Fix the RLS join/play blocker for signed-in users.**
`ALTER POLICY "sessions host only write"` is `FOR ALL TO authenticated` AND-ed with `read all`, so it
gates SELECT. Split it: keep restrictive gating on INSERT/UPDATE/DELETE; leave SELECT to the permissive
`read all` policy (or add a permissive `SELECT ... USING (true)` carve-out). Then re-verify with the
JWT-probe technique (anon row vs authed-non-host row) and re-run `/join` + `/play` as a signed-in
non-host user. Do NOT weaken write gating — only stop it from blinding reads.

**P0-4 — Kill the host-side N+1 loops.**
`finalizeLeague` → one SECURITY DEFINER RPC doing the upsert loop in a single transaction
(owner-authorized). `autoAssignTeams` → one RPC. At 50 players the current loop is ~100 sequential
round-trips (~30–60 s at real RTT) stacked on the end-of-game path.

## P1 Fixes (high-value scalability)

1. **Re-measure after P0-1**: rerun `scripts/scale-audit/runner.mjs` at 50/75/100; target = 100%
   delivery with session events ≤2 s. Do not add capacity remedies before this proves the transport fix.
2. **Host state diet**: host should subscribe to a single `session summary` broadcast (player count,
   answered count, correctness split) instead of raw rows. Removes ~50% of host messages at 100 players.
3. **One-RPC hydration**: `get_live_state(session, participant)` returning session + ordered question
   row + trimmed participants + own answers + progress in a single round trip; use on initial load,
   reconnect, and visibility-regain for both routes (kills 6-query and 4–5-query waterfalls ×N clients).
4. **Client headroom**: `React.memo` the leaderboard row/PlayerWall/Question view; `useMemo` the
   derived counters; isolate the 200 ms tick into a small timer component so it stops re-rendering the
   whole tree; replace `answersForRound` array-scan appends with a Map keyed by participant+question;
   precompute Confetti once. (No behavior change; pure render-cost reduction — protects low-end devices.)
5. **Add the two indexes** (`answers(session_id, question_id)`,
   `participants(session_id, score DESC)`); drop the redundant `sessions_code_idx`.

## P2 Improvements

- Merge the player route's two `participants` bindings into one handler (the same event currently runs
  two callbacks); dedupe the duplicate `reveal_current_question`/`get_round_stats` calls (host effect).
- Trim reconnect bursts: debounce `get_round_progress` re-seeds (observed ×3 per reconnect).
- Send only deltas on the leaderboard broadcast (top-K + shift markers) instead of full lists.
- Pre-randomize `Confetti`; fix `FinalReview` O(Q²) via a Map lookup.
- Add a lightweight "realtime degraded" indicator (client-side dropped-event detector: expected vs
  received sequence per question) so hosts see trouble before players do.
- Documentation: fix the dead `lovable.app` demo link / stale Supabase ref so nobody profiles the wrong
  backend again (`gmtddgaupquditwokmuh` no longer resolves; the live project is `yzjdaoelllemcvymsffp`).

## Future Architecture (not now)

- Server-authoritative game engine function (edge/scheduled) owning transitions and broadcasting state
  at a fixed cadence — clients become thin renderers; the host becomes a *controller*, not the engine.
  The current broadcast change (P0-1) is the stepping stone, not a rewrite trigger.
- Presence for lobby counts (avoid participants WAL entirely in the lobby).
- Backpressure: answer-burst coalescing server-side (grade in batches per session tick) — only if
  measurement after P0-1/P1 shows the RPC path becoming the limit (it is not, today).

---

## Method & Reproducibility

- Harness: `scripts/scale-audit/` (see its README): `fixture.mjs` (scratch quiz/session/auth-user),
  `runner.mjs` (N-subscriber ladder with per-bot event logs + lock sampling), `run-official-lt.mjs`
  (drives the repo's own `scripts/load-test.mjs` unattended), `profile.mjs` + `serve.mjs` (real browser
  pages against the production build, served locally on the live project).
- Measurements run against project `yzjdaoelllemcvymsffp`; test machine RTT ≈300 ms; Chromium
  headless-shell, desktop-class; **low-end mobile devices were not tested** (recorded as an open item).
- Known confound handled: the first 40/50 ladder runs overlapped a large browser download on the test
  machine; those runs were discarded and all numbers quoted here come from clean re-runs.
- Unit erratum for the record: the ladder's first console outputs printed seconds as "ms"; every number
  in this report uses corrected (×1000) values or ms-based official-harness numbers.

## Acceptance Criteria Check (per phase brief §34)

1. Critical path mapped — ✅ (this document, §Architecture Map)
2. Database measured — ✅ (0 lock waits; p95s; index audit against live `pg_indexes`)
3. RPC audited — ✅ (callers, internals, measured latencies, duplication)
4. Realtime subscriptions/fan-out measured — ✅ (per-subscriber delivery, both harnesses)
5. Client rendering profiled — ✅ **desktop-class only**
6. Network/payload behavior measured — ✅ (WS counts, REST counts, reconnect cost)
7. Memory/reconnect examined — ✅ (steady heap; reconnect measured; long-session soak still open)
8. 30+ reproduced — ✅ 9. 50 measured — ✅ 10. 75/100 tested — ✅
11. Primary bottleneck identified with evidence — ✅ (Realtime fan-out; see classification)
12. No major rewrite performed — ✅ (audit only + harness)
13. Prioritized roadmap delivered — ✅ (P0/P1/P2 above)
14. Gameplay correctness preserved — ✅ (no engine code changed; fixture cleaned; verified 0 leftover rows)

**Recommended next phase: Phase 9D.2 — implement P0-1 (broadcast transport) + P0-2 (scheduler) + P0-3
(RLS), then re-run the ladder at 10/40/50/75/100 and only then decide on P1 scope.** Do not start with
capacity upgrades or client refactors: the evidence says the transport is the wall, and the scheduler
is the seatbelt.

