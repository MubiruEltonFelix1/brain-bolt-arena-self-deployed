# Phase 9E — Authentication, Session Persistence & Guest-First Identity Continuity

## 1. Root causes found

The reported symptoms ("signing in from the Game PIN/join journey returns you to the
wrong page, appears to log you out, or asks you to sign in again") were **six
independent defects**, not one. Four were client-side, and the fifth was a
production database bug that had disabled the Save Result feature entirely.

| # | Defect | Evidence | Symptom |
|---|---|---|---|
| RC-1 | Return intent was one unvalidated `next` string defaulting to `/dashboard`. The homepage nav, `host-shell` and `profile` all passed none. | `index.tsx:74,80`, `host-shell.tsx:34`, `profile.tsx:84`; `auth.tsx:16` | wrong page after sign-in |
| RC-2 | `getUser()` is a **network** call, never caught. A failure resolved `user: null` + `loading: false`, and the guards immediately redirected. | `use-auth-user.ts:10-13` (no `.catch`) | "logged me out" |
| RC-3 | 11 consumers each ran their own `getUser()` **and** their own `onAuthStateChange`. `__root` and `play.$sessionId` added two more. | 11 call sites; 4+ listeners on `/play/:id` | racing clobber, "sign in again" |
| RC-4 | `signUp` navigated to the dashboard even when **no session** was returned (confirmation-required projects). | `auth.tsx:36-46` | bounce back to the sign-in form |
| RC-5 | Save Result used `window.location.href` (full reload); `FinalView` reported "Saved" from `isGuest` alone, before and regardless of the claim result. | `play.$sessionId.tsx:1464,752` | results view discarded, misleading state |
| RC-6 | `create_session_claim` / `create_arena_claim` call `gen_random_bytes(32)` while pinned to `search_path = 'public'`; pgcrypto lives in `extensions`. | live DB: `42883 function gen_random_bytes(integer) does not exist` | **Save Result never worked at all** |
| RC-7 | The landing page had **no auth awareness**. A signed-in visitor still saw "Sign in" / "Host"; clicking one sent them to `/auth`, which auto-redirects an authenticated user straight back to `next` (= `/`). Zero document requests, no visible change, same page. **This is what "sign in and host just refresh the page" actually was.** | `index.tsx` read no auth state at all | "it just refreshes" |

### RC-6 in detail

Both functions are `SECURITY DEFINER` with `SET search_path TO 'public'`.
`gen_random_bytes` ships with `pgcrypto`, which on this project is installed in
the `extensions` schema. A pinned search_path removes it from resolution, so
**every claim-minting call failed at runtime**. The guest saw a generic
"Could not prepare this result" and no ticket was ever issued.

This was invisible to the test suite because no test executed these RPCs against
the live database. `gen_random_uuid()` is unaffected — it is core in PG13+ and
resolves from `pg_catalog`, which is why `join_session` and the whole game engine
worked.

Fix: `20260927090000_phase_9e_claim_token_pgcrypto.sql` — schema-qualify the
call as `extensions.gen_random_bytes(32)`. Deliberately **not** "add `extensions`
to the search_path": widening a `SECURITY DEFINER` search_path is how
object-hijack vulnerabilities happen.

## 2. Architecture after this phase

```
src/lib/auth-state.ts     ONE store: loading | authenticated | guest | error
                          bootstraps from getSession() (storage, no network)
                          exactly ONE onAuthStateChange listener
                          guest only from SIGNED_OUT or an empty getSession()
src/hooks/use-auth-user.ts  thin read over the store (0 listeners, 0 requests)
src/hooks/use-auth-gate.ts  the one guard contract
src/lib/return-intent.ts    allowlisted, one-shot, sessionStorage return paths
src/lib/claim-handoff.ts    claim phase + outcome, scoped per result
src/lib/claim-panel.ts      pure "what may the results screen say" decision
```

Key invariants, each covered by a test:

- `guest` is reachable **only** from a `SIGNED_OUT` event or a completed
  `getSession()` with no session. A failed check becomes `error`, never `guest`.
- `isAuthResolved()` is deliberately false for `error`, so a consumer can never
  render a "signed out" surface from a dropped connection.
- A slow bootstrap can never overwrite a newer auth event (`bootstrapToken`).
- Return intents are validated against an **allowlist** of known routes, not
  `startsWith("/")` (which accepted `//evil.example.com`).
- Claim tokens never enter a URL, analytics, or logs.
- `"saved"` requires a server confirmation or a completed seat-ownership read.

## 3. Production fix applied

`20260927090000_phase_9e_claim_token_pgcrypto.sql` was applied to the live
project. Verified post-apply: both functions carry the qualified call and `anon`
retains EXECUTE.

> **Note:** two OTHER migrations report PENDING and were deliberately **not**
> applied: `20260823120000_phase_9b_arena_publication_platform.sql` and
> `20260926150000_phase_9d2_broadcast_transport.sql`. The second is superseded by
> the 9D.2b transitional fallback; running `bun scripts/migrate.mjs` would apply
> it in filename order and **re-break the read path** Phase 9D deliberately
> restored. See §7.

## 4. Verification

| Gate | Result |
|---|---|
| `bunx tsc --noEmit` | **PASS** |
| `bun test` | **612 pass / 0 fail** across 28 files (baseline 530/23) |
| `bun run build` | **PASS** (`✓ built in 11.14s`) |
| ESLint on new modules | **0 problems** |
| Browser journey (real Chromium) | **47/47 checks** |

`bun run lint` is **broken repo-wide and unrelated to this phase**: every file
trips `prettier/prettier Delete ␍` (CRLF checkout vs Prettier's LF default), and
`.vercel/output` is not in the eslint ignore list so `eslint-plugin-prettier`
reformats 61 bundles (14+ minute runtime). Use
`bunx eslint <files> --rule '{"prettier/prettier":"off"}'`.

### Browser verification — `scripts/auth-journey.mjs`

Real Chromium (Playwright build) against the production bundle, served by the
Phase 9D nitro harness. Each journey gets its own browser context so localStorage
never leaks between them.

- **A — Guest → PIN → lobby → play → finish → Save Result → Sign in → return →
  claim → saved confirmation.** Asserts server-side afterwards: exactly one
  `competition_results` row, seat linked to the signed-in profile, score on
  screen matches the claimed score, return intent consumed.
- **B — Unauthenticated → host deep-link → sign in → return to the host room.**
  Asserts it did **not** land on `/dashboard` (the headline regression).
- **C — Typed-in Game PIN survives a voluntary sign-in.**
- **D — Sign-out** ends the session, leaves no stale auth storage, keeps guest
  play working, and re-gates the dashboard.
- **E — Pixel 8 mobile** repeats journey A.
- **F — The landing page reflects a signed-in visitor.** Signs in through the
  landing nav itself, then asserts the "Sign in" control is gone, "Dashboard"
  and "Profile" replace it, the account nav survives a reload, and the Game PIN
  box is still there. Added after RC-7; the earlier guest-only probe could not
  see the bug because it never signed anyone in.

The load-bearing assertion is **A11**: a marker planted on `window` before the
handoff must survive it. The old `window.location.href` lost it (full reload);
the client-side navigation preserves it.

Verified against a throwaway user, quiz and session on the live project; all
removed afterwards (residual counts confirmed 0/0/0/0/0).

## 5. Files changed

**New:** `src/lib/auth-state.ts`, `src/lib/return-intent.ts`,
`src/lib/claim-handoff.ts`, `src/lib/claim-panel.ts`,
`src/hooks/use-auth-gate.ts`, `src/components/SaveResultPanel.tsx`,
`scripts/auth-journey.mjs`,
`supabase/migrations/20260927090000_phase_9e_claim_token_pgcrypto.sql`

**Tests (new):** `auth-state.test.ts`, `return-intent.test.ts`,
`claim-handoff.test.ts`, `claim-panel.test.ts`, `guest-flow.test.ts`

**Modified:** `use-auth-user.ts`, `use-host-status.ts`, `ClaimRedeemer.tsx`,
`host-shell.tsx`, `auth.tsx`, `__root.tsx`, `profile.tsx`,
`request-hosting.tsx`, `play.$sessionId.tsx`, `host.$sessionId.tsx`,
`index.tsx`, `arena.$quizId.index.tsx`, `arena.$quizId.play.tsx`,
`migration-markers.mjs`, `.gitignore`

## 6. Behaviour changes worth knowing

- An already-signed-in player whose seat is unlinked can now save **in place**,
  without leaving the results page.
- A pending claim auto-redeems **only on the trip the player started**. Signing
  in days later for an unrelated reason now offers a button instead of silently
  attaching a result. (Behaviour change, per the product decision taken at the
  start of this phase.)
- A host whose token expires during a live game is **not** navigated away. The
  room stays put with a banner; every control action is still rejected
  server-side by `is_session_host`. Asserted by test.
- `request-hosting` preserves its form draft across the sign-in round trip.

## 7. Known limitations

1. **`bun run lint` is broken repo-wide** (CRLF + `.vercel/output`). Pre-existing;
   not fixed in this phase because the real fix is a repo-wide decision.
2. **Two migrations report PENDING** and were left alone on purpose (§3). The
   9D.2 one is superseded; the 9B one needs a human decision.
3. **Single pending-claim slot.** `brainbolt:pending-claim` holds one ticket, the
   existing design. Saving a second result replaces the first. The panel never
   redeems a ticket belonging to a different result, so this can lose a save
   attempt but can never report a false success. Left as-is: changing it is new
   claim storage, which this phase forbids.
4. **Google OAuth is unverified.** The button is untouched; whether the provider
   is enabled in the Supabase project was not confirmed, so that flow is
   untested.
5. **Email confirmation is unverified.** Sign-up handles both cases
   correctly by construction (`data.session` null → "check your inbox"), but
   which setting the project uses was not confirmed.
6. Session storage is browser-local: no cross-device continuity, by design.

## 8. Remaining for Phase 9F

- The results/podium/share redesign itself, now that saving is honest and
  reachable.
- Consume the claim outcome into the Arena results screen (it still uses the old
  inline anchor flow; only its navigation was modernised).
- Revisit the single pending-claim slot if multiple pending results matter.
- Consider an account-independent way to render "already saved" on the Arena
  screen, which has no seat-ownership read.
