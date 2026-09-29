# scripts/scale-audit — live-engine scalability harness (Phase 9D.1 + 9D.2)

Measurement tooling created for the Phase 9D.1 audit (see
`docs/PHASE_9D1_LIVE_ENGINE_SCALABILITY_AUDIT.md`) and extended for the Phase
9D.2 verification (see `docs/PHASE_9D2_P0_SCALABILITY_FIXES.md`). It measures
the live engine end-to-end against the **real Supabase project**: join → lobby
→ question → answer → grade → realtime fan-out → reveal → transition.

> **Transport note (Phase 9D.2 P0-A).** Answer/join/team activity is now a
> DATABASE-PUBLISHED broadcast (`game:answer_row`, `game:answer`, `game:join`,
> `game:team`) on the private topic `session:<id>`; only `sessions` transitions
> still ride `postgres_changes`. The runner counts `game:answer_row` (one per
> accepted answer) so delivery percentages stay comparable with the 9D.1
> baseline. Subscribers must join with `{ config: { private: true } }`.

> Run every level against a **scratch quiz + session**, never a launch quiz.
> Never run while a real game is live (check for `status in (lobby, active)`
> sessions first).

## 1. Create / clean the scratch fixture

```bash
bun scripts/scale-audit/fixture.mjs create     # writes fixture.json (session code, ids)
bun scripts/scale-audit/fixture.mjs cleanup    # deletes session, quiz, questions, auth user, grant
```

Creates: 8-question MCQ scratch quiz (`ZZZ SCALE AUDIT — DELETE ME`), a lobby
session, and (for the browser profiler only) a throwaway host auth user with a
`host` role + an active `time` host_authorization grant — the same combination
a real host has. `fixture.json` / `auth-user.json` are written next to these
scripts and are local-only scratch state — do not commit them.

## 2. Headless load ladder (N subscribers + N answerers)

```bash
bun scripts/scale-audit/runner.mjs --players 50 --questions 3 --burst 50
```

Joins N bots, opens one realtime channel per bot (exactly like a real client),
answers each question in one simultaneous burst, and measures per question:

- join / channel / answer RPC latency (p50/p95/max)
- **participants-event delivery per subscriber** (received vs expected N per question)
- **per-answer score-update lag** (event receipt − that answerer's RPC ack)
- advance/reveal propagation per subscriber (session UPDATE events)
- DB lock-wait samples during the burst (via psql)

Metrics JSON: `metrics-p<N>-<run>.json` (includes per-bot event logs).
Bots are cleaned up automatically at the end.

## 3. Official harness replication (single-question, independent numbers)

```bash
bun scripts/scale-audit/run-official-lt.mjs --players 100
```

Wraps `scripts/load-test.mjs` and drives host state (START + reveal) through the
service role so the official harness runs unattended.

## 4. Browser profiling (real host + player pages under load)

Needs a production build served locally + puppeteer-core + a Chromium binary:

```bash
bun run build
bun scripts/scale-audit/serve.mjs                      # serves .vercel/output on :3000
bun scripts/scale-audit/create-auth-user.mjs           # once: throwaway host user (needs fixture.json)
bun scripts/scale-audit/profile.mjs --players 50 --questions 3 --timer-test --reconnect
```

`create-auth-user.mjs` writes `auth-user.json` and re-owns the fixture quiz to
that user (the profiler logs in through the real `/auth` form). Requires
`puppeteer-core` installed and Chromium available (the script's `--exe` flag
defaults to a Playwright-downloaded chrome-headless-shell path — point it at any
Chrome/Chromium binary, e.g. via `bunx playwright install chromium`).

Measures on BOTH pages: WS messages received per question, REST calls during the
burst (coalesced refetch behaviour), long tasks, event-loop lag, heap,
reveal→UI latency, reconnect storm recovery (`--reconnect`), and whether the
host's own timer still drives the reveal under load (`--timer-test`).

## 5. Server-tick question expiry (P0-B verification)

```bash
bun scripts/scale-audit/tick-expiry-test.mjs --players 50
```

Starts an expired-bound question with NO host/browser action and waits for the
database itself to reveal and advance it. PASS requires both transitions within
the one-tick-per-minute cadence budget.

## Notes

- The test machine's RTT to Supabase (~300 ms) is part of every absolute latency.
  Use **relative** comparisons between levels, not absolute thresholds.
- `runner.mjs` per-bot logs are the raw evidence for delivery-loss patterns
  (e.g. "every subscriber received exactly one question's worth of events").
