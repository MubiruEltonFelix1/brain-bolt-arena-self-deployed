# Phase 9F — Results, Podium, Guest-to-Account Conversion & End-of-Game UX

**Status:** complete for hosted results. Arena result persistence is **blocked by a pre-existing
migration defect** (§ Known Limitations) and is explicitly out of scope this phase.

Verification at time of writing: `tsc --noEmit` clean · `bun test` **662 pass / 0 fail** (31 files) ·
`bunx playwright test` **12/12 pass** (desktop + mobile) · `bun run build` exit 0.

---

## Executive Summary

The reported failure — players finish a game, sign in, and the result is not saved — was **real, and
was already fixed by Phase 9E**. The 9E migration repaired a `pgcrypto` defect that made
`create_session_claim` throw `42883 function gen_random_bytes(integer) does not exist` on every call,
so a claim ticket had never once been minted in production.

What I could not establish by reading code was whether anything was *still* broken, because the
production database showed **448 guests had completed games and `result_claims` contained 0 rows
ever**. That is equally consistent with "the click silently failed" and with "nobody ever clicked it".
Rather than invent a defect, I built the end-to-end test that answers the question. **The journey
works.** The 9E fix is live and effective; the path had simply never been exercised since.

So this phase is not a rescue. It is: make the results screen honest about what the server actually
recorded, remove the parts that were fabricating numbers, and close the test gap that let all of this
go unverified in the first place.

Seven real defects were found and fixed, all of the same family — *the screen claiming something the
authoritative source does not support*.

---

## Root Cause of the Failed Save Journey

**Phase 9E's `pgcrypto` defect, already repaired.** No new root cause was manufactured.

The chain, in order:

1. `create_session_claim` and `create_arena_claim` mint tickets with
   `encode(gen_random_bytes(32), 'hex')`. `gen_random_bytes` lives in `pgcrypto`, installed in the
   `extensions` schema. Both functions are `SECURITY DEFINER` with `search_path` pinned to `public`,
   so the call was unresolvable and **every claim-ticket mint failed at runtime**.
2. The guest saw a generic "Could not prepare this result". No ticket, no claim, no
   `competition_results` row.
3. Phase 9E (`20260927090000_phase_9e_claim_token_pgcrypto.sql`) schema-qualified the call as
   `extensions.gen_random_bytes` and I confirmed the migration marker is **APPLIED** live.

**Why it was invisible:** no test executed the RPC against the real database. `guest-flow.test.ts`
asserted the claim path *by reading the source text*. A function that cannot execute looks
identical to a function that works if nobody calls it.

**What the live data shows after the fix:** 0 claim tickets. Not "some failed" — zero attempts, ever.
Combined with 448 completed guest games, the honest conclusion is that **Save Result has not been
exercised since 9E shipped**, not that it is failing. The Playwright suite now exercises it, and it
passes.

### The tooling bug that hid the migration state

`migration-markers.mjs` interpolated a needle containing single quotes into a single-quoted SQL
literal:

```js
fnBodyLike("run_autonomous_tick", "c.mode = 'scheduled'")
// → LIKE '%c.mode = 'scheduled'%'   ← unparseable
```

That marker reported `probe failed` forever despite the migration being applied, so the drift report
was permanently amber and nobody could trust it as a signal. Fixed with a `sqlLiteral` escaper applied
to all three needle helpers. **Probe errors: 1 → 0.**

---

## Existing Result/Claim Architecture Reused

Nothing was replaced. The entire path is the Phase 9E / pre-9E machinery:

| Concern | Existing mechanism | Preserved |
|---|---|---|
| Ticket minting | `create_session_claim` / `create_arena_claim` (SECURITY DEFINER) | Yes |
| Redemption | `claim_result` — one-time via `SELECT … FOR UPDATE`, 24h expiry | Yes |
| Ownership proof | `participant_secrets` + `search_path`-pinned SECURITY DEFINER | Yes |
| Permanent store | `competition_results`, `UNIQUE (profile_id, session_id)` | Yes |
| RLS | `result_claims` has **zero** policies; `competition_results` has one SELECT policy | Untouched |
| Client honesty | `claimPanelView` reports "saved" only on server confirmation or a completed seat read | Extended, not replaced |

No new result table. No parallel claim path. No service-role credentials in the browser.

---

## Defects Found and Fixed

All seven are the same failure: **the screen stated something the authoritative source does not
support.**

1. **Client rank disagreed with stored rank.** `myRank = participants.findIndex(…) + 1` over a list
   ordered by `score DESC` **with no tie-break**, and `podium = participants.slice(0, 3)`. The server
   writes `rank() OVER (ORDER BY score DESC, joined_at ASC)`. On any tie the screen could display a
   position `competition_results.final_rank` never recorded. Fixed with a tested module
   (`lib/ranking.ts`) replicating the server contract exactly, including `rank()`'s skip-after-tie.
2. **The in-game round reveal computed rank a second, different way.** `findIndex` + `slice(0,3)`
   alongside the results screen's computation. Two rank implementations in one file is exactly the
   divergence the new module exists to remove. Now unified, including the previous-rank snapshot used
   for movement arrows.
3. **`authResolved` bypassed the auth store's own contract.** `status !== "loading"` was passed where
   `isAuthResolved()` is `initialized && status !== "error"`. A **failed** session check was reported
   as resolved, letting the panel assert a save verdict for a player whose session was never verified.
4. **Podium accents silently did not exist.** `text-${accent}`, `border-${rankAccent}/40`,
   `bg-${accent}/5` — Tailwind cannot see interpolated class names, and `styles.css`'s
   `@source inline(...)` does **not** list `border-*/40`, `border-cyan-jolt`, `border-amber-spark` or
   `bg-cyan-jolt/5`. The round-reveal podium rendered with **no coloured border or background for any
   place**. Replaced with static literal maps.
5. **A dead claim phase.** `awaiting-auth` was declared and branched on but never assigned. Assigning
   it would have been *worse*: the panel would claim "Saving your result…" for a ticket sitting
   untouched. Removed.
6. **"Already claimed" was reported as a failure.** The server raises one error for "this account
   claimed it" and "another account claimed it" and deliberately will not say which. Neither `saved`
   (asserts this profile) nor `problem` (asserts failure) was honest. Now a distinct `already-saved`
   state that asserts only what is provable.
7. **A failed session check stranded the player.** There was no way to distinguish "not checked yet"
   from "checked and failed", so a dropped connection rendered "Checking your result…" indefinitely.
   Added `authFailed`, a distinct recoverable state, plus a working **Try again** on failure.

### Caught by adversarial review after the first pass

I had a reviewer re-read the diff cold. It found two more of the same family that I had missed:

- **`"You finished #0"` and a share card reading `"0th of 3"`.** When a seat cannot be resolved
  (deleted row, or a scoreboard read that has not landed), `rank` was correctly `UNAVAILABLE` but the
  string printed `rank.value` regardless, and `shareData.rank` was coerced to `0`.
- **`score` was a fabricated zero.** `metric(me?.score ?? 0)` claimed a player "scored 0" when the
  seat simply could not be resolved — a different and wrong claim.

Both are now `UNAVAILABLE` end to end, through the hero, the podium line, the share text, the share
card, the download filename, and the Web Share payload. This also fixed a **pre-existing** bug: a solo
Arena share card previously reported `"1st of 1"`, dressing a practice round up as a victory.

---

## Files and Components Changed

**New**
- `src/lib/ranking.ts` + `ranking.test.ts` — server-equivalent ranking (15 tests)
- `src/lib/result-presentation.ts` + `result-presentation.test.ts` — presentation model (22 tests)
- `src/lib/result-analytics.ts` + `result-analytics.test.ts` — privacy-bounded event emitter (9 tests)
- `src/lib/podium-accents.ts` — static accent classes
- `playwright.config.ts`, `e2e/seed.ts`, `e2e/guest-claim.e2e.ts` — E2E harness

**Modified**
- `play.$sessionId.tsx` — authoritative rank, results screen rewrite, reduced-motion, share, hierarchy
- `SaveResultPanel.tsx` — guest-first copy, honoured "Not now", retry, `already-saved`, funnel events
- `ShareResultCard.tsx` — `placementOf()` gate; no more `0th` / `rank0.png`
- `claim-panel.ts` / `claim-handoff.ts` — `already-saved`, `authFailed`, dead phase removed
- `arena.ts`, `arena.$quizId.play.tsx` — no more `"1st of 1"` or fabricated `0%`
- `auth.tsx` — sign-up / auth-complete funnel events
- `migration-markers.mjs` — SQL literal escaping
- `tsconfig.json`, `package.json`, `.gitignore`, `bunfig.toml`, `bun.lock`

---

## Database and RPC Changes

**None.** No migration was authored and no schema was altered.

`20260823120000_phase_9b_arena_publication_platform` **could not be applied** and is unrelated to
results: it redefines `get_arena_quizzes()` with a different `RETURNS TABLE` signature, which Postgres
cannot do with `CREATE OR REPLACE` (needs `DROP FUNCTION` first). It fails at line 222.

Worse, the live database is **half-applied**: `submit_arena_run` and `score_arena_run` exist, but all
7 of 9B's tables/columns are absent, so a signed-in Arena run fails at the INSERT. Repairing this
means adding `DROP FUNCTION` to a 1224-line platform migration — a separate piece of work, taken
deliberately out of scope per instruction rather than absorbed silently.

---

## Authentication Handoff

Unchanged in design, verified in practice. `SaveResultPanel` → `rememberReturnIntent` →
`markClaimReturnTrip` (sessionStorage, 15 min) → `/auth?next=…&reason=save-result` → on success
`consumeReturnIntent` → return to `/play/:id` → `ClaimRedeemer` redeems.

`sanitizeReturnPath` still validates against a strict shape allowlist and rejects any query string or
fragment, so no claim material can enter a URL. **The E2E asserts the auth URL contains no token.**

---

## Guest-to-Account Claim Flow

Verified end to end by a real run, not by inspection. The test asserts:

- `create_session_claim` returns **200** (not swallowed into a toast)
- a `result_claims` row exists with `claimed_at IS NULL`
- sign-in returns to the **same** `/play/:sessionId`
- "Saved to your competition history" appears **only after** the server confirms
- exactly **one** `competition_results` row: `profile_id` = the test user, `final_score` 1500,
  `final_rank` 2, `total_players` 3, `accuracy_percentage` 50
- a second visit creates **no** second row

---

## Podium and Ranking Presentation

Podium is `standings.ranked.filter(rank <= 3)` — **by server rank, not the first three rows**. Because
`rank()` skips after a tie, a tied game can have no third place; the screen then shows no third place
rather than dressing a 4th-place player as bronze. The player's own rank is always shown separately
when they are off the podium, and the "You finished #N" line is suppressed entirely when rank is
unavailable.

**Solo Arena runs get no multiplayer podium.** `presentArena` reports rank and total as `UNAVAILABLE`
and podium as `[]`.

---

## Personal Performance Statistics

Every stat carries `{ available, value }`. An unavailable metric renders as a dash with an
`sr-only` "not measured" — **never as 0**. Accuracy is `UNAVAILABLE` when nothing scored was
attempted, and a real `0` when something was attempted and wrong. Feedback questions are excluded
from accuracy and from the streak walk, matching the server's own filter. `response_ms` is read from
stored answers; optimistic rows without a server timing are excluded rather than guessed.

---

## Save Result UX

Moved **below** the score, podium and performance. It previously sat above the podium, asking a guest
to commit to an account before seeing what they scored. Copy is "KEEP YOUR RESULT" / "SIGN IN & SAVE
RESULT" / "NOT NOW"; declining hides only the invitation and leaves the result untouched (E2E-asserted).

---

## Share and Replay UX

Native `navigator.share` with a clipboard-copy fallback, plus the existing share card image.
**No URL is included** — `/play/:id` renders only for a browser still holding the guest seat, so
sharing it would send a dead link. No public share route exists and inventing one is out of scope, so
the honest share is a sentence. Payloads carry title, score and placement only; `shareMessage` is built
from a whitelist and a test asserts no token, id, or rival's name can appear.

**PLAY AGAIN** is the single primary action and navigates to the join flow — it does **not** restart
or recreate the finished host session. Fixed: the hosted screen's exit button said "EXIT ARENA".

---

## Privacy and Security Verification

- No RLS policy, grant, or function was changed. `result_claims` still has **zero** policies.
- `claim_result` untouched — still single-use, `FOR UPDATE`, `auth.uid()`-derived.
- Claim tokens never enter a URL, an analytics event, a log, or a share payload.
- The analytics emitter is a closed union with a per-event property allowlist; unknown events are
  dropped and non-allowlisted properties are stripped **at the call boundary**, so a future edit
  cannot widen the payload by accident.
- "Already claimed" reveals nothing about *whose* account claimed it.

---

## Conversion Analytics Added

A closed event union (11 events) with an in-memory bounded buffer and a `setResultAnalyticsSink` that
**nothing calls**. There is no analytics SDK in this project, so **no downstream sink is wired and no
funnel is actually being measured** — this module only makes the funnel measurable when someone
deliberately installs a transport. No metrics are fabricated. No tokens, secrets, emails, names,
scores, ids or answer content are ever recorded; modes and outcomes are coarse buckets.

---

## Tests Added and Total Test Count

| Suite | Before | After |
|---|---|---|
| `bun test` (unit + mcp) | 627 | **662 pass / 0 fail** (31 files) |
| Playwright (desktop + mobile) | none | **12/12 pass** |

New: 15 ranking · 22 presentation · 9 analytics · 6 E2E scenarios × 2 viewports, plus the widened
`claim-panel` property test (now covering the previously-omitted `available` phase).

---

## TypeScript / Production Build

- `bunx tsc --noEmit` → **exit 0** (now also covering `e2e/**` and `playwright.config.ts`, which were
  outside `include` and therefore never typechecked)
- `bun run build` → **exit 0**
- Scoped ESLint on every changed file: clean, except **pre-existing** `no-explicit-any` /
  `exhaustive-deps` in untouched code and a long-standing `react-refresh` warning in
  `ShareResultCard`. Repo-wide `bun run lint` remains separately broken on CRLF/Prettier noise —
  unrelated to this change and not touched.

---

## Manual End-to-End Results

Performed by **automated real-browser runs** (Playwright, Chromium, against the live app and the live
database) — not by hand in a browser. 12/12, covering desktop Chrome and a mobile viewport (Pixel 7):

- guest reaches a full result **with no authentication request of any kind**
- result survives a full page reload (recovered from the database)
- declining the invitation leaves the result intact
- Save Result mints, signs in, returns to the correct result, and **is really persisted** (asserted
  against the database, not the UI alone)
- a repeat visit creates no duplicate result
- a player with no seat is told so and is not pushed to sign in

**Fixture hygiene:** verified live after the final run — 0 e2e quizzes, 0 sessions, 0 auth users, 0
stray `host` grants, and `competition_results`/`result_claims` back at their original 17/0. A
prefix-based sweep now also cleans up after a run that was killed mid-seed.

**Not verified in a real browser:** live competition start-to-finish (a host clicking through a real
session), Google OAuth, and Safari/Firefox. The E2E drives a seeded *finished* session rather than
the live session engine, so the gameplay path itself was not re-exercised.

---

## Known Limitations

1. **Arena persistence is broken in production and is not fixed here.** `submit_arena_run` is
   deployed but `arena_run_answers` is missing, so signed-in Arena runs fail at the INSERT. Root
   cause is the un-appliable 9B migration. Highest-priority follow-up.
2. **A refresh destroys an in-progress Arena run** (`arena.$quizId.play.tsx` holds run state in React
   refs). Pre-existing, outside 9F's stated scope, touches the Arena run model the brief forbids
   redesigning.
3. **No analytics sink is wired.** Events are recorded to an in-memory buffer and nowhere else.
4. **No public share link.** Deliberate: none exists, and inventing one was out of scope. Sharing is
   text plus an image.
5. **`presentArena` is exported and tested but not used by the Arena screen**, which reads its own
   server-authoritative grading. Arena therefore gets the `—` treatment and no fabricated podium via
   the call-site fix, not via the shared model.
6. **Two migrations remain pending** — 9B (above) and `20260926150000_phase_9d2_broadcast_transport`
   (gameplay transport, not a 9F concern). Both were left unapplied deliberately.
7. **League standings** were not touched; existing tie-breaks and rules are unchanged.

---

## Recommended Next Phase

**9G — Arena result integrity.** Fix the 9B migration (add `DROP FUNCTION` for the conflicting
`RETURNS TABLE` signatures, re-apply, verify `arena_run_answers` and `quizzes.arena_category` exist),
then confirm a signed-in Arena run persists. Followed by making an Arena run survive a refresh. Until
9B is applied, the Arena half of the product cannot be trusted to store a result, and that is a
bigger problem than anything remaining in this phase.
