# Brain Bolt — Architecture Constitution Audit (Phase 7A)

Read-only audit. No schema, RLS, gameplay, or UI changes were made.

## 1. Executive verdict

The frozen MVP is **constitutionally compatible but not constitutionally implemented**. There are no architectural violations that would force a rewrite. Ownership is uniform enough (`owner_id → auth.users.id` on every ownable table) that a Principal abstraction can be introduced later as an additive migration rather than a redesign.

Two real gaps deserve attention before platform work begins:

1. **Roles vs. grants are conflated.** `is_authorized_host()` currently resolves to *admin only* — it ignores the `host` role entirely. That is the known MVP mismatch, and it is now located precisely (section 5).
2. **Session still carries business state** (ownership via `host_id`, quiz reference, branding, league, lifecycle). Competition duplicates all of it. The duplication is synced by trigger, so it is transitional, not broken.

Verdict: **🟡 transitional — safe to evolve. Keep the core frozen.**

## 2. Principal assessment

Current ownership primitives found:

- `auth.users.id` referenced directly as owner on: `quizzes.owner_id`, `competitions.owner_id`, `leagues.owner_id`, `branding_profiles.owner_id`, `sessions.host_id`, `host_requests.user_id`, `host_authorizations.profile_id` (misnamed — it is a user id, not a profile row), `user_roles.user_id`, `result_claims.claimed_by`.
- `profile_id` used as an *identity* link, not ownership: `participants.profile_id`, `competition_results.profile_id`.
- Nothing is abstracted yet; there is no indirection table.

Important correctness note: `competition_results.profile_id` and `host_authorizations.profile_id` both hold `auth.users.id` values (profiles.id is itself the user id), so "profile as ownership primitive" is a naming problem, not a data problem. Renaming later is mechanical.

**Would introducing Principal now be safe?** Yes, technically — a `principals` table with `id`, `kind (user|organization|platform|partner)`, and a unique `user_id` backfill row per auth user, plus nullable `owner_principal_id` columns added additively. But it is **not yet valuable**: no second Principal kind exists. Recommendation: defer until Organizations are actually scheduled, then do it in one pass.

### Migration map (Principal)

| Table | Column today | Principal target | Notes |
|---|---|---|---|
| quizzes | owner_id | owner_principal_id | Straight backfill |
| competitions | owner_id | owner_principal_id | Straight backfill |
| leagues | owner_id | owner_principal_id | Straight backfill |
| branding_profiles | owner_id | owner_principal_id | Straight backfill |
| sessions | host_id | *drop* — derive from competition | Runtime; should not own |
| host_authorizations | profile_id | grantee_principal_id | Rename + retype |
| host_requests | user_id | requester_principal_id | Low risk |
| user_roles | user_id | (principal_id, scope_principal_id) | Needs role-scope redesign |
| competition_results | profile_id | subject_principal_id | Keep user-kind only initially |
| participants | profile_id | subject_principal_id (nullable) | Guests stay NULL |

## 3. Competition / Session assessment

Target: Competition = permanent business event; Session = ephemeral execution.

Observed duplication between `competitions` and `sessions`:

| Concern | On competitions | On sessions | Verdict |
|---|---|---|---|
| Ownership | `owner_id` | `host_id` | Duplicated |
| Quiz | `quiz_id` | `quiz_id` | Duplicated |
| Branding | `branding_profile_id` | `branding_profile_id` | Duplicated |
| League | `league_id` | `league_id` | Duplicated |
| Scheduling | `scheduled_start_at`, `lobby_duration_seconds` | none | Correctly placed |
| Visibility | `visibility` | none | Correctly placed |
| Lifecycle | `status` (6 states) | `status` (runtime states) | Overlapping, trigger-synced |
| Autonomy | `autonomous` | `autonomous` | Duplicated |

`tg_sync_competition_from_session` keeps the two in step, and `competitions.session_id` is the link. Sessions can also exist **without** a competition (ad-hoc hosted games) — that is the main reason the duplication exists and the main obstacle to making Competition mandatory.

Assessment: **sufficiently close to target; requires consolidation, not restructuring.** The safe future move is to make every session originate from a competition row (including ad-hoc "instant" competitions), then delete the duplicated columns from sessions.

## 4. Session runtime boundary classification

**Runtime (keep on sessions):** `id`, `code`, `status`, `current_question_index`, `current_question_started_at`, `current_question_revealed`, `question_order`, `paused_at`, `skipped_question_ids`, `time_added_ms`, `created_at`.

**Business (belongs on Competition):** `host_id`, `quiz_id`, `league_id`, `branding_profile_id`, `team_mode`, `autonomous`.

**Historical/result (belongs to a permanent object):** none stored directly on sessions — good. But `participants.score/streak` and `answers.*` are runtime-shaped rows that outlive the match and are read by profile/league surfaces; they are effectively an implicit permanent store (see section 9).

Question content is correctly *not* copied into sessions (`get_session_questions` reads `questions`). One consequence: editing a quiz mid-life mutates the historical record of a completed competition. That is a real integrity gap, deferred.

## 5. Roles & grants assessment

Concepts present:

- **Identity:** `auth.users`, `profiles` (presentational only — correct).
- **Role:** `user_roles(user_id, role app_role[admin|host])`, `has_role()`.
- **Capability shortcut:** `is_admin()` = `has_role(uid,'admin')`; `is_authorized_host()` = **also** `has_role(uid,'admin')`.
- **Grant:** `host_authorizations` — typed `single | bundle | time`, with `remaining_sessions` (quota), `expires_at` (expiry), `status`. This is genuinely the strongest constitutional component in the codebase: it is already a scoped, expiring, quota-limited grant.
- **Enforcement:** `enforce_host_authorization()` trigger on session insert — accepts `admin` **or** `host` role, otherwise consumes a grant.

### The mismatch, located exactly

`is_authorized_host()` returns admin-only, yet it is used as the *host* capability check in:

- restrictive write policies on `quizzes`, `questions`, `sessions`, `leagues`, `league_quizzes`: `is_authorized_host() OR has_active_host_authorization(auth.uid())`
- `branding_profiles` INSERT check: `auth.uid() = owner_id AND is_authorized_host()` — admin-only, no grant fallback at all
- `competitions` SELECT "Admin can view all competitions"
- `host_authorizations` and `host_requests` admin management policies

Consequence: a user with the `host` **role** but no active `host_authorizations` row passes the session-insert trigger and passes the client gate in `src/components/host-shell.tsx`, but **fails the restrictive RLS write policies** on quizzes/questions/sessions/leagues. Branding creation is stricter still — grants do not satisfy it. Two divergent definitions of "may host" exist: the trigger's (role OR grant) and RLS's (admin OR grant).

Also noted: duplicate identical policies on `user_roles` ("Users can read own roles" and "Users can read their own roles"), and both `leagues read all` (true) and `leagues read public` — the permissive OR makes the narrower one dead.

**Constitutional end-state:** one capability resolver, e.g. `can(auth.uid(),'host.write', resource)`, computed as `admin role OR host role OR active grant`, called by every host-gated policy and by the trigger. Roles and grants both feed the resolver; no policy calls `has_role` directly.

## 6. RLS / capability classification

| Class | Policies |
|---|---|
| A — capability-oriented | `quizzes/questions/sessions/leagues/league_quizzes host only write` (restrictive), `branding_profiles` insert — all call helper functions, but the helpers are miswired |
| B — role-based | `user_roles` admin manage, `host_authorizations` admin manage, `host_requests` admin update, `competitions` admin view |
| C — owner-based | `quizzes manage own`, `leagues manage own`, `competitions owners manage`, `branding` owner CRUD, `sessions host manage`, `teams`/`participants` host-update via session subquery, `questions manage by owner`, `league_standings owner insert/update`, `profiles` own CRUD, `competition_results` own select |
| D — hardcoded identity | none remaining (email checks were removed in 6A) ✅ |
| E — other/custom | Public reads: `sessions read all` (true), `participants public read` (true), `answers public read` (true), `quizzes read all` (true), `leagues read all` (true), `league_standings public read` (true), `branding publicly readable` (true) |

**Highest risk:** the class-E blanket `true` SELECTs on `answers`, `participants`, and `sessions`. They are required by the live game (anon players read live state) but expose historical answers and nicknames platform-wide. Migrating these to `can(...)`-scoped reads is the single highest-leverage future change — and the most dangerous to gameplay, so it must be done behind the frozen engine, not inside it.

**Highest leverage:** fixing `is_authorized_host()` — one function, unblocks the host role across five tables.

## 7. Competition modes

- Enum `competition_mode` exists with values `hosted | arena | scheduled`.
- Enum `competition_status`: `draft | scheduled | lobby_open | running | completed | cancelled`.
- Autonomy is a **boolean flag**, not a mode — so `autonomous` and `league_fixture` are not representable as modes today.
- Surfaces **not** represented as modes: Training (pure client, `src/lib/demo-questions.ts`, no rows), Arena solo runs (`submit_arena_run` writes `competition_results` with no competition row), League fixtures (`league_id` FK, not a mode).
- Duplication of Competition functionality: **`sessions` duplicates it** (section 3). Arena additionally duplicates the "competition happened" concept by writing results without a competition.

The enum is extensible; no blocker. Adding `training`, `arena_public`, `autonomous`, `league_fixture` later is additive.

## 8. Branding assessment

- `branding_profiles` is a proper reusable asset (owner_id, name, logo_url, colors).
- Referenced by FK from **both** `competitions.branding_profile_id` and `sessions.branding_profile_id` — a duplicated reference, but **no branding values are copied** anywhere. No denormalized name/logo/color columns exist on competitions, sessions, or quizzes.
- Arena and host surfaces read through `src/lib/branding.ts` by id.

Verdict: 🟢 aligned apart from the duplicated FK, which disappears with the session-boundary cleanup. Sponsorship can later attach as its own table referencing competitions/leagues plus a branding profile, without touching branding's shape.

## 9. Results assessment

Paths audited:

| Path | Writes to competition_results | Mechanism |
|---|---|---|
| Hosted competition | ✅ | `record_competition_results()` trigger on session → `ended` |
| Autonomous competition | ✅ | same trigger (autonomous tick sets `ended`) |
| Arena solo | ✅ | `submit_arena_run` (server re-grades) |
| Guest claim | ✅ | `claim_result` links `result_claims` → results |
| Leagues | reads only | `get_league_standings` derives from results |
| Profiles | reads only | `src/lib/player-stats.ts` |

Convergence confirmed. Two secondary stores that could drift into being sources of truth:

- **`league_standings`** — a materialized aggregate table with its own owner-write policies, while `get_league_standings` computes standings live. Two answers to the same question; the table should eventually be a cache with no manual writes, or be dropped.
- **`participants.score` / `answers`** — retained indefinitely after the match; profile and accuracy surfaces can read them directly instead of results. Should be treated as runtime and eventually pruned.

Also note the trigger skips guests (`profile_id IS NOT NULL`), which is correct — guests convert through `result_claims`.

## 10. Future-platform readiness

**Organizations** — Can own quizzes, competitions, leagues, branding *without redesigning each table*, because all four use a single uniform `owner_id uuid` referencing a single identity table. Swapping the FK target to `principals` is one migration per table with identical shape. **Blocker:** `user_roles` has no scope column, so "admin of org X" is unrepresentable; roles must gain a scope before Organizations.

**Marketplace** — Can reference quizzes, question packs (would be new), branding profiles, and league templates without coupling to Sessions, because none of those objects reference sessions. **Blocker:** `questions` belongs to exactly one `quiz_id` with no pack concept, and quizzes have no version/immutability — selling a quiz that the seller can later edit is unsound. Content versioning is the real prerequisite, not marketplace plumbing.

**Sponsorship** — Can attach to competitions and leagues cleanly (both have stable permanent ids). Arena slots are the weak point: Arena is a boolean flag on quizzes (`is_arena`, `featured_rank`), not a schedulable slot object, so a sponsored Arena placement has nothing to attach to. **Blocker:** Arena needs a slot/placement object before it can be sponsored without ad-hoc fields.

## 11. Constitutional scorecard

| Principle | Current state | Gap | Severity | Recommended migration |
|---|---|---|---|---|
| Principal as ownership primitive | Uniform `owner_id → auth.users.id` | No indirection layer | 🟡 | Additive `principals` table + backfill, when Orgs are scheduled |
| Profile is presentational only | True in practice; `profile_id` naming leaks into results/authorizations | Naming only | 🟡 | Rename to `*_principal_id` during Principal migration |
| Competition = permanent business object | Exists, owns scheduling/visibility/mode | Sessions can exist without one | 🟡 | Require a competition per session |
| Session = ephemeral runtime | Carries ownership, quiz, branding, league, autonomy | Duplicated business state | 🟡 | Drop duplicated columns after the above |
| owner_principal_id everywhere | 5 different ownership column names | Naming divergence | 🟡 | Consolidate during Principal migration |
| Identity / Ownership / Role / Grant separated | Grants are excellent; roles are flat and unscoped | `is_authorized_host()` ≠ host role | 🔴 | Fix the resolver; add role scope |
| can(principal, action, resource) | Helper functions exist but are ad-hoc | No unified resolver; blanket `true` reads | 🟡 | Introduce `can()` behind existing helpers |
| Competition modes | Enum with 3 of 8 values | Autonomy is a boolean; Training/Arena/League outside the enum | 🟡 | Extend enum additively |
| Branding as reusable asset | Referenced by id, never copied | Duplicated FK on sessions | 🟢 | Falls out of session cleanup |
| competition_results canonical | All five paths converge | `league_standings` is a rival aggregate | 🟡 | Demote standings to pure cache |
| No hardcoded identity in RLS | Removed in Phase 6A | None | 🟢 | — |

One 🔴: the role/grant authorization mismatch. It is a *correctness* violation of the constitution's Role/Grant separation, not a security hole — it fails closed (denies legitimate hosts), never open.

## 12. Migration risks

- **Session column removal** touches the frozen timing and autonomous engines. Highest blast radius; must be last among the boundary changes and gated behind full replay testing.
- **Changing blanket `true` SELECT policies** on `sessions`/`participants`/`answers` will break anonymous players instantly if scoped wrong. Never ship this without a live game rehearsal.
- **Principal backfill** must be transactional with FK re-pointing; a partial backfill orphans ownership and locks users out of their own quizzes.
- **`user_roles` scoping** changes a table that `has_role()` — and therefore nearly every restrictive policy — depends on. Do it before Organizations, never during.
- **`league_standings` demotion** risks losing historically written rows that were never derivable; snapshot before dropping.

## 13. Recommended implementation order

1. **Roles & grants consolidation** (fix `is_authorized_host()`, unify trigger and RLS definitions, dedupe policies). Smallest, highest leverage, fixes the only 🔴, touches no gameplay.
2. **`can(principal, action, resource)`** introduced as a thin wrapper *over* the fixed resolver, with policies migrated one table at a time. Must come before ownership changes so ownership migrations have a single choke point to update.
3. **Competition/Session boundary cleanup** — require a competition per session first (additive), then remove duplicated session columns.
4. **competition_results canonicalization** — demote `league_standings`, stop reading `participants`/`answers` for historical stats.
5. **Principal abstraction** + **owner_principal_id** as one combined migration.
6. **Organizations** (requires 1, 2, 5).
7. **Advanced Leagues**, then **Marketplace** (requires content versioning), **Sponsorships** (requires an Arena slot object), **APIs**, **AI / Brain Bolt Labs**.

Reordering rationale vs. the expected list: `can(...)` is moved *ahead of* Principal and `owner_principal_id`. The expected order puts it after, but every ownership migration rewrites the same policies — doing `can()` first means ownership changes touch one function instead of ~30 policies. Roles-first is likewise cheap and unblocks real users today.

## 14. Explicitly frozen — do not touch

- Timing engine: `src/lib/question-intro-timing.ts`, `src/lib/server-clock.ts`
- Autonomous engine: `run_autonomous_tick`, `run_autonomous_scheduler`, `advance_question_internal`, `prepare_competition_session*`, pg_cron jobs
- Arena scoring: `submit_arena_run`, `score_arena_run`
- League standings: `get_league_standings`
- Shared question engine: `src/lib/question-registry.ts`, `src/components/question/QuestionRenderer.tsx`
- Answer submission RPCs: `submit_answer`, `submit_text_answer`, `submit_number_answer`, `submit_geo_answer`, `submit_ordering_answer`, `evaluate_question_answer`, `score_answer`
- Live realtime layer: `src/hooks/use-live-channel.ts`
- Result recording: `record_competition_results`, `claim_result`, `create_*_claim`
