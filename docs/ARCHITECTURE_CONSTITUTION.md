# Brain Bolt — Architecture Constitution (Phase 7B lock)

Design document only. No schema, RLS, function, or gameplay change accompanies this file.
It converts the Phase 7A audit (`docs/ARCHITECTURE_CONSTITUTION_AUDIT.md`) into a locked target
and a migration blueprint.

Every statement is tagged:

- **CURRENT** — what exists in the frozen MVP today.
- **TARGET** — the locked constitutional end-state.
- **DEFERRED** — acknowledged, deliberately not scheduled.

## 1. Executive verdict

Brain Bolt is **constitutionally compatible but not constitutionally implemented**, and that is
the correct place to be at MVP freeze. Ownership is uniform (`owner_id → auth.users.id` on every
ownable table), results already converge on one permanent store, and branding is referenced rather
than copied. Nothing in the MVP forces a rewrite.

Status: **🟡 transitional — locked target, frozen implementation.**

One correctness contradiction exists (role vs. grant divergence, section 6). It fails closed —
it denies legitimate hosts, never grants unauthorized access — so it is safe to defer, and it is
the highest-leverage first migration.

## 2. Immutable conceptual model (TARGET)

```text
Identity            Principal ── User
                              └─ Organization
                    Profile   (presentation only, never authorization)

Business assets     Quiz ── Question
                    BrandingProfile
                    League
                    MarketplaceListing      (deferred)
                    Sponsorship             (deferred)

Event               Competition

Runtime             Session ── Participant ── Answer

Permanent outcome   CompetitionResult
```

CURRENT: `Principal`, `Organization`, `MarketplaceListing`, and `Sponsorship` do not exist as
tables. Everything else does. This section creates nothing; it fixes the vocabulary.

## 3. Principal decision (LOCKED)

**Principal is the universal ownership and acting identity abstraction.**

- Principal kinds: `user`, `organization`, `platform`, `partner`.
- A User is a Principal. An Organization is a Principal.
- Platform administration is represented by the `platform` Principal — never by hardcoded emails,
  never by a special ownership column.
- Partners / API clients become Principals later without a second ownership rewrite.
- **Profile stays presentation-only.** It must never become an ownership or authorization primitive.

CURRENT: ownership references `auth.users.id` directly. `profiles.id` *is* the user id, so
`competition_results.profile_id` and `host_authorizations.profile_id` hold user ids — a naming
leak, not a data problem.

✅ RESOLVED (Phase 7F, 2026-08-14): `principals` exists with user-kind seeded 1:1 (id =
user_id); `principal_type` already admits organization/platform/partner. Organization membership
remains deferred.

## 4. Ownership decision (LOCKED)

Every ownable business object eventually carries exactly one ownership column:
**`owner_principal_id`**.

Forbidden forever: `organization_id` as an alternative owner, `platform_owner`, `partner_owner`,
any second ownership column, and profile-based ownership. Ownership transfer must be a change of
Principal reference, never a structural migration.

Tables that will eventually migrate (CURRENT → TARGET):

| Table | Column today | Target | Notes |
|---|---|---|---|
| quizzes | ~~owner_id~~ **owner_principal_id** | owner_principal_id | ✅ MIGRATED (7J + 7L; legacy column retired 7L) |
| competitions | ~~owner_id~~ **owner_principal_id** | owner_principal_id | ✅ MIGRATED (7K + 7L; legacy column retired 7L) |
| leagues | ~~owner_id~~ **owner_principal_id** | owner_principal_id | ✅ MIGRATED (7I + 7L; legacy column retired 7L) |
| branding_profiles | ~~owner_id~~ **owner_principal_id** | owner_principal_id | ✅ MIGRATED (7H + 7L; legacy column retired 7L) |
| sessions | host_id | *drop* | runtime identity; derive from competition — deferred |
| host_authorizations | profile_id | grantee_principal_id | rename + retype — deferred |
| host_requests | user_id | requester_principal_id | low risk — deferred |
| user_roles | user_id | principal_id + scope_principal_id | needs role scoping first — deferred |
| competition_results | profile_id | subject_principal_id | user-kind only initially — deferred |
| participants | profile_id | subject_principal_id (nullable) | guests stay NULL — deferred |

## 5. Permission decision (LOCKED)

Four separated concepts:

| Concept | Question it answers | CURRENT carrier |
|---|---|---|
| Identity | Who is the Principal? | `auth.users` / `profiles` / `principals` |
| Ownership | What does the Principal own? | `owner_principal_id` columns (✅ migrated for quizzes, competitions, leagues, branding_profiles; legacy `owner_id` retired) |
| Role | What relationship does a Principal have to another Principal? | `user_roles` (unscoped) |
| Grant | What specific capability was granted? | `host_authorizations` |

Capability examples the model must express: host competitions, edit quiz, manage organization,
review marketplace content, access analytics, API access, quota-limited hosting.

TARGET: all authorization converges on **`can(principal, action, resource)`**. RLS policies call
that resolver; no policy calls `has_role()` directly and no policy reinvents authorization inline.

## 6. Current role system and the known mismatch

CURRENT primitives: `user_roles(user_id, role app_role[admin|host])`, `has_role()`, `is_admin()`,
`is_authorized_host()`, `has_active_host_authorization()`, and the `enforce_host_authorization()`
trigger. `host_authorizations` is already a scoped, expiring, quota-limited grant — the strongest
constitutional component in the codebase.

**Where the mismatch is, exactly.** `is_authorized_host()` resolves to *admin only* — it ignores
the `host` role. It is used as the host capability check in:

- restrictive write policies on `quizzes`, `questions`, `sessions`, `leagues`, `league_quizzes`
  (`is_authorized_host() OR has_active_host_authorization(auth.uid())`)
- `branding_profiles` INSERT (`auth.uid() = owner_id AND is_authorized_host()`) — admin-only, no
  grant fallback at all
- `competitions` admin SELECT, `host_authorizations` / `host_requests` admin management

Meanwhile `enforce_host_authorization()` accepts `admin` **or** `host` role, and
`src/components/host-shell.tsx` gates UI on `isAdmin || hasHostRole || active grant`.

**Does it affect a valid host journey?** Yes for one configuration only: a user holding the `host`
role with **no** active `host_authorizations` row. They pass the UI gate and the session-insert
trigger but fail restrictive writes on quizzes/questions/sessions/leagues, and cannot create a
branding profile. Every host provisioned through the admin flow receives a grant, so the live
journey is unaffected; the failure is denial, never escalation.

**Safe to defer?** Yes — it fails closed. Operationally, keep issuing a grant alongside the `host`
role until the resolver lands.

**Eventual unified rule (TARGET):** one resolver, `can(principal, 'host.write', resource)` =
`admin role OR host role OR active grant`, used by both the trigger and every host-gated policy.
Also fold in the audit's housekeeping: duplicate `user_roles` read policies, and the dead narrow
`leagues read public` policy shadowed by `leagues read all`.

DEFERRED: no change in this phase.

## 7. Competition decision (LOCKED)

Competition is the definitive permanent record that an event **is going to happen, is happening,
or happened**. It owns the business meaning: owner, quiz, mode, scheduling, visibility, branding
reference, league relationship, sponsorship relationship, lifecycle, result relationship.

A Quiz is reusable content. A Competition is an event using that content. One Quiz powers many
Competitions.

CURRENT: `competitions` exists with mode, status, visibility, scheduling, branding and league
references — correct. But sessions can still exist **without** a competition (ad-hoc hosted games,
Arena solo runs write results with no competition row). That is the sole reason the duplication in
section 8 exists.

## 8. Session decision (LOCKED)

Session is the runtime execution of **exactly one** Competition, holding only ephemeral state.
Session must never become a second business object.

Classification of every current `sessions` column:

| Column | Verdict |
|---|---|
| id, code, status, current_question_index, current_question_started_at, current_question_revealed, question_order, paused_at, skipped_question_ids, time_added_ms, created_at | **keep** (runtime) |
| host_id | **move to Competition** (owner) — then drop |
| quiz_id | **move to Competition** — then drop |
| league_id | **move to Competition** — then drop |
| branding_profile_id | **move to Competition** — then drop |
| team_mode | **move to Competition** (event configuration) |
| autonomous | **move to Competition** — duplicated today, trigger-synced |

Related runtime tables: `participants.score` / `streak` and `answers.*` are runtime-shaped rows
that currently outlive the match and are read by profile and league surfaces. TARGET: those
surfaces read `competition_results`; participant/answer rows become prunable runtime data
(**remove/deprecate** as a permanent source, not as runtime storage).

Also noted (DEFERRED): question content is read live from `questions`, so editing a quiz mutates
the historical record of a completed competition. Content versioning is the fix and is a
prerequisite for Marketplace, not for gameplay.

## 9. Results decision (LOCKED)

`competition_results` is the **sole** permanent outcome record. Hosted, autonomous, Arena and
guest-claim paths all converge on it. Profile statistics derive from results. League standings
derive from results. No second permanent score or history system may be created.

CURRENT: all five paths already converge (trigger `record_competition_results`, `submit_arena_run`,
`claim_result`). Two rival stores to demote: `league_standings` (a materialized aggregate written
manually while `get_league_standings` computes live) and the indefinite retention of
`participants`/`answers`. Existing guest and Arena behaviour stays intact.

## 10. Branding decision (LOCKED)

BrandingProfile is a reusable business asset owned by a Principal. Competitions reference it by id.
Branding values are never copied into Sessions. Future Marketplace listings reference
BrandingProfiles rather than duplicating them.

CURRENT: 🟢 aligned. No denormalized name/logo/colour columns exist anywhere. The only deviation is
the duplicated FK `sessions.branding_profile_id`, which disappears with the section 8 cleanup.

## 11. Competition modes (LOCKED principle)

New forms of competition are normally **modes of Competition**, not parallel competition-like
tables.

- CURRENT `competition_mode`: `hosted`, `arena`, `scheduled`. Autonomy is a boolean flag, not a mode.
- Outside the enum today: Training (pure client, no rows), Arena solo runs, League fixtures
  (an FK, not a mode).
- TARGET vocabulary, added only when a real surface needs it: `training`, `arena_public`,
  `hosted_live`, `scheduled`, `autonomous`, `league_fixture`, `championship`, `enterprise_private`.

Do not add modes speculatively. The enum is additive-extensible; no blocker exists.

## 12. Organizations (future model, DEFERRED)

Illustration only — nothing to build now:

A university becomes an Organization Principal. It owns quizzes, competitions, leagues and branding
through the same `owner_principal_id` column users use. Users become members with scoped roles and
grants. A lecturer creates a weekly competition owned by the university; students participate as
Player Principals; standings derive from `CompetitionResult`. The Organization later controls
rewards, marks, permissions and analytics.

**No second ownership system is introduced at any step.** Blocker: `user_roles` has no scope column,
so "admin of org X" is unrepresentable — role scoping must land before Organizations.

## 13. League future model (DEFERRED)

Intended progression:

```text
League → registration/roster → scheduled Competitions → CompetitionResults
      → standings → season completion → awards/rewards
```

A participant joining mid-season is the same Principal identity with fewer completed competitions —
no separate late-join concept. Guest → account claiming (`result_claims` → `claim_result`) must stay
compatible: a claimed result feeds standings exactly like a natively authenticated one.

## 14. Marketplace (future model, DEFERRED)

Marketplace sells or licenses **reusable business assets, never runtime Sessions**. Candidate assets:
Quiz, question pack, BrandingProfile, League template. `MarketplaceListing` is the commercial
wrapper referencing the asset; the underlying business object remains independently usable.

Prerequisite: content versioning/immutability. Selling a quiz the seller can still edit is unsound,
and question packs do not exist (a question belongs to exactly one `quiz_id`).

## 15. Sponsorship (future model, DEFERRED)

Sponsorship is a first-class commercial relationship owned by a sponsor Principal, attached to a
Competition, a League, or an Arena slot. It must not be implemented as a branding hack — branding is
presentation, sponsorship is a commercial agreement with its own lifecycle.

Prerequisite: Arena is a boolean flag on quizzes (`is_arena`, `featured_rank`), not a schedulable
slot object. A sponsored Arena placement needs a slot/placement object to attach to.

## 16. Analytics philosophy (LOCKED)

Business analytics derive from authoritative business records. No duplicated metrics tables for
convenience. When scale eventually demands materialized aggregates, they are documented and treated
as **derived cache**, never as a source of truth, and must be rebuildable from the authoritative
records alone.

## 17. Migration blueprint

Executed later, one at a time. Ordering deviates from the naive list: **Role/Grant consolidation
comes first** (it is cheap, fixes the only 🔴, and unblocks real users today) and **`can(...)`
lands before Principal/`owner_principal_id`**, because every ownership migration otherwise rewrites
the same ~30 policies. Doing the resolver first collapses that into one function.

| # | Migration | Objective | Affected tables | Affected RLS / functions | Risk | Rollback | Prerequisite | Downtime |
|---|---|---|---|---|---|---|---|---|
| 1 | Role/Grant consolidation | Make `host` role actually grant host writes; one definition of "may host" | none (function-only) | `is_authorized_host()`, restrictive policies on quizzes/questions/sessions/leagues/league_quizzes, `branding_profiles` insert, `enforce_host_authorization()`, duplicate `user_roles` policies, dead `leagues read public` | Low — widens a closed-fail predicate | Restore prior function body | none | No |
| 2 | Centralized `can(principal, action, resource)` | One authorization choke point | none | New resolver wrapping #1; policies migrated table-by-table | Medium — touches every gated policy | Per-table revert to prior policy | #1 | No |
| 3 | Competition/Session boundary cleanup | Every session originates from a competition (additive), then drop duplicated session columns | sessions, competitions | `tg_sync_competition_from_session`, `prepare_competition_session*`, `advance_question_internal`, session RLS | **High** — touches frozen timing + autonomous engines | Phase A additive (trivial revert); phase B needs column restore from backup | #2, full replay testing | Phase B: maintenance window |
| 4 | CompetitionResult canonicalization | Demote `league_standings` to cache; stop reading `participants`/`answers` for history | league_standings, (reads) participants, answers | `get_league_standings`, `src/lib/player-stats.ts` | Medium — historical rows may not be derivable | Snapshot `league_standings` before demotion | #3 | No |
| 5 | Principal abstraction + `owner_principal_id` | One ownership primitive, one Principal table | new `principals`; quizzes, competitions, leagues, branding_profiles, host_authorizations, host_requests, user_roles, competition_results, participants | All owner-based policies via `can()` | **High** — partial backfill orphans ownership | Transactional; keep old columns until cutover verified | #2, #4 | Short window at cutover |

✅ **EXECUTED as Phases 7F-7L (2026-08-14 → 2026-08-16).** `principals` (7F) with user-kind
seed; the four ownership-bearing tables migrated (7H-7K) and their legacy `owner_id` columns
retired (7L); `can(...)` principal-only for all ownership-sensitive capabilities (7L); all
ownership RLS principal-aware (7L). Remaining rows of this table are deferred (DEFERRED_WORK
register).
| 6 | Organizations | Second Principal kind + scoped membership | principals, user_roles (scope), membership table | `can()` scope resolution | Medium | Feature-flag org kind | #5 + role scoping | No |
| 7 | Advanced League registration/rosters | Roster, fixtures, season completion | leagues, new roster/fixture tables | league policies via `can()` | Low | Drop new tables | #6 | No |
| 8 | Marketplace | Listings over reusable assets | new listing tables, quiz versioning | `can()` marketplace actions | Medium | Drop listings; versioning stays | Content versioning, #6 | No |
| 9 | Sponsorship | Commercial relationships on competitions/leagues/arena slots | new sponsorship + arena slot tables | `can()` sponsor actions | Low | Drop new tables | Arena slot object, #6 | No |
| 10 | Public APIs / webhooks | Partner Principals with scoped grants | principals, grants | `can()` API actions | Medium | Revoke partner grants | #5, #2 | No |
| 11 | AI / Brain Bolt Labs | Generation and adaptive difficulty over versioned content | quizzes, questions | none new | Low | Feature flag | #8 versioning | No |

Nothing above is executed in this phase.

## 18. Architecture invariants

Future developers must not violate these:

1. No new ownership primitive — `owner_principal_id` is the only one.
2. No email-based authorization, ever.
3. Profile never controls permissions.
4. Session never becomes permanent business state.
5. Competition remains the primary event object.
6. `competition_results` remains the permanent outcome record.
7. Marketplace never owns or sells runtime Sessions.
8. Branding is referenced by id, never copied.
9. New competition types normally become modes, not parallel tables.
10. RLS converges on centralized capability checks — no policy reinvents authorization.
11. Do not duplicate business data for premature optimization; aggregates are cache, not truth.
12. Do not introduce Organizations with a second ownership system.
13. Do not bypass the authoritative server timing model.
14. Do not weaken guest → account continuity.
15. Do not modify the frozen MVP without a demonstrated production reason.

## 19. Known transitional MVP exceptions

Accepted deviations, intentionally left in place because the MVP is frozen:

- `is_authorized_host()` is admin-only while the trigger and UI accept the `host` role (section 6). Fails closed.
- Sessions carry business state (`host_id`, `quiz_id`, `league_id`, `branding_profile_id`, `team_mode`, `autonomous`), trigger-synced with competitions.
- Sessions may exist without a Competition (ad-hoc hosted games); Arena solo runs write results with no competition row.
- ✅ RESOLVED (7F-7L): ownership on the four business tables now flows through `principals` (`owner_principal_id`); legacy `owner_id` columns retired. Remaining `auth.users.id` references are runtime/attribution/identity, not ownership: `sessions.host_id`, `participants.profile_id`, `competition_results.profile_id`, `host_authorizations.profile_id`, `user_roles.user_id`.
- `profile_id` naming on `competition_results` and `host_authorizations` leaks Profile into ownership-adjacent positions (naming only — values are user ids).
- Blanket `true` SELECT policies on `sessions`, `participants`, `answers`, `quizzes`, `leagues`, `league_standings`, `branding_profiles` — required by anonymous live play.
- `league_standings` is a manually written aggregate rivalling live `get_league_standings`.
- Autonomy is a boolean flag rather than a Competition mode.
- Quiz edits mutate the historical content of completed competitions (no content versioning).
- Training runs entirely client-side with no Competition or result rows.

## 20. Frozen — do not touch

- Timing engine: `src/lib/question-intro-timing.ts`, `src/lib/server-clock.ts`
- Autonomous engine: `run_autonomous_tick`, `run_autonomous_scheduler`, `advance_question_internal`, `prepare_competition_session*` (ownership-resolution carve-out only: Phase 7K/7L changed the owner read from `owner_id` to `owner_principal_id` — decision-equivalent for user principals), pg_cron jobs
- Arena scoring: `submit_arena_run`, `score_arena_run`
- League standings: `get_league_standings`
- Shared question engine: `src/lib/question-registry.ts`, `src/components/question/QuestionRenderer.tsx`
- Answer submission RPCs: `submit_answer`, `submit_text_answer`, `submit_number_answer`, `submit_geo_answer`, `submit_ordering_answer`, `evaluate_question_answer`, `score_answer`
- Live realtime layer: `src/hooks/use-live-channel.ts`
- Result recording: `record_competition_results`, `claim_result`, `create_*_claim`
