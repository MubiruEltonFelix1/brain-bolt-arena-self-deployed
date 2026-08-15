# Brain Bolt — Ownership Migration Plan (Phase 7G)

Audit and planning only. **No ownership column, RLS policy, function, or gameplay behaviour was
changed in this phase.** `owner_principal_id` does not exist and was not created.

Prerequisites in place: Phase 7C (role/grant consolidation), 7D (`can(...)`), 7E (stabilization),
7F (`public.principals`, user principals id-identical to `auth.users.id`).

## 1. Executive summary

The migration replaces every ad-hoc ownership reference (`owner_id`, `host_id`, `profile_id`,
`user_id`) on business objects with a single uniform column, `owner_principal_id`, referencing
`public.principals`. Because user principals were seeded with **the same id** as the auth user,
every backfill is an identity copy (`SET owner_principal_id = owner_id`) with zero joins, zero
remapping and zero ambiguity. Validation is a trivial equality check, and rollback at every stage
is "drop the new column" until the policy cutover step.

The purpose is not cosmetic: it is to make Organization / Platform / Partner ownership possible
without a second ownership primitive (`organization_id`), and to let `can(...)` resolve resource
authorization against principals rather than raw auth users.

**Verdict: 🟢 GREEN — ready for ownership migration.** Safest first migration:
**`branding_profiles`** (section 8, step 1).

## 2. Ownership inventory (live schema)

Every column in `public` named like an ownership/identity reference, as found in the live database:

| Table | Column | FK target |
|---|---|---|
| quizzes | owner_id | auth.users.id |
| competitions | owner_id | auth.users.id |
| leagues | owner_id | auth.users.id |
| branding_profiles | owner_id | auth.users.id |
| sessions | host_id | auth.users.id |
| host_requests | user_id, reviewed_by | auth.users.id |
| host_authorizations | profile_id, granted_by | auth.users.id |
| user_roles | user_id, granted_by | auth.users.id |
| competition_results | profile_id | profiles.id |
| participants | profile_id | profiles.id |
| result_claims | claimed_by | auth.users.id |
| principals | user_id | auth.users.id |

Not present anywhere in the live schema: `created_by`, `author_id`, `creator_id`,
`organization_id`, marketplace tables, sponsorship tables. `questions` has **no** owner column — it
inherits ownership from `quizzes.quiz_id` and is not independently owned.

Frontend touchpoints (all read/filter only, no ownership logic of their own): `dashboard.tsx`,
`leagues.$id.tsx`, `leagues.index.tsx`, `competitions.tsx`, `branding.tsx`, `quizzes.$id.tsx`,
`host.$sessionId.tsx`, `profile.tsx`, `admin.tsx`, `join.$code.tsx`, `play.$sessionId.tsx`,
`request-hosting.tsx`, `src/lib/arena.ts`, `src/lib/branding.ts`, `src/hooks/use-host-status.ts`.

## 3. Ownership classification

| Occurrence | Classification | Migrate to owner_principal_id? |
|---|---|---|
| quizzes.owner_id | **true ownership** (reusable business asset) | Yes |
| competitions.owner_id | **true ownership** (permanent business event) | Yes |
| leagues.owner_id | **true ownership** | Yes |
| branding_profiles.owner_id | **true ownership** | Yes |
| sessions.host_id | **acting identity** on ephemeral runtime | No — derive from competition; drop later |
| questions (via quiz) | inherited ownership | No column; follows quizzes |
| league_quizzes, league_standings, teams | inherited via parent | No column; follows parent |
| participants.profile_id | **participant identity / presence** | No (future `subject_principal_id`, out of scope) |
| competition_results.profile_id | **subject identity** of a permanent outcome | No (future `subject_principal_id`) |
| host_authorizations.profile_id | **grantee identity** (holds a user id despite the name) | Later: `grantee_principal_id` |
| host_authorizations.granted_by / user_roles.granted_by | **attribution** (who issued it) | Attribution only; principal-ize last |
| host_requests.user_id / reviewed_by | requester identity / attribution | Low priority |
| user_roles.user_id | **role subject**, needs scoping redesign first | Not in this migration |
| result_claims.claimed_by | claim attribution | No |
| principals.user_id | identity bridge | N/A |

**Ambiguous cases, documented rather than guessed:**

1. **League continuing owner.** `leagues.owner_id` is set at creation and never transferred. Once
   Organizations exist, a league created by a lecturer likely belongs to the university, not the
   lecturer. The column is genuine ownership today, but expect an ownership *transfer* operation
   (a principal reference change, never a structural migration) rather than a re-model.
2. **Session host.** `sessions.host_id` is used by RLS as both "who may control this session" and
   implicitly "who owns it". The Constitution says runtime must not own. Until every session
   originates from a competition (ad-hoc hosted games and Arena runs do not today), `host_id`
   cannot be dropped. Treat it as acting identity and leave it alone during the ownership phase.
3. **Question authorship.** No author column exists. If per-question attribution is ever needed it
   must be a new `author_principal_id`, explicitly *not* ownership.

## 4. Principal mapping validation (live counts, read-only)

Principals: **5** (all `type='user'`, 1:1 with auth users).

| Table | Rows | Valid principal for owner | Missing principal | Ambiguous | Manual review |
|---|---|---|---|---|---|
| quizzes (owner_id) | 17 | 17 | 0 | 0 | 0 |
| competitions (owner_id) | 3 | 3 | 0 | 0 | 0 |
| leagues (owner_id) | 2 | 2 | 0 | 0 | 0 |
| branding_profiles (owner_id) | 3 | 3 | 0 | 0 | 0 |
| sessions (host_id) | 94 | 94 | 0 | 0 | 0 |
| host_authorizations | 5 | n/a (deferred) | 0 | 0 | 0 |
| host_requests | 2 | n/a (deferred) | 0 | 0 | 0 |
| competition_results | 1 | n/a (subject, deferred) | 0 | 0 | 0 |
| participants with profile_id | 0 | n/a | 0 | 0 | 0 |

Every ownership row maps deterministically. No orphans, no NULL owners, no anomalies. No data was
modified.

## 5. RLS dependency map

| Table | Policy | Current shape | Target | Risk |
|---|---|---|---|---|
| branding_profiles | Owner can insert own branding | `auth.uid() = owner_id AND can('branding.create')` | `owner_principal_id = current_principal_id() AND can('branding.create')` | mechanical |
| branding_profiles | Owner can update / delete own branding | `auth.uid() = owner_id` | `can('branding.manage', id)` | mechanical |
| quizzes | quizzes manage own | `auth.uid() = owner_id` | `can('quiz.edit', id)` / principal compare | mechanical |
| quizzes | quizzes host only write (RESTRICTIVE) | `is_authorized_host() OR has_active_host_authorization(auth.uid())` | `can('quiz.create')` | mechanical, no owner reference |
| questions | questions manage by owner / owner read | EXISTS on `quizzes.owner_id = auth.uid()` | EXISTS on `quizzes.owner_principal_id = current_principal_id()` | mechanical (follows quizzes) |
| competitions | Owners manage their competitions | `auth.uid() = owner_id` | `can('competition.manage', id)` | mechanical |
| leagues | leagues manage own | `auth.uid() = owner_id` | `can('league.manage', id)` | mechanical |
| leagues | leagues read public | `visibility='public' OR owner_id = auth.uid()` | principal compare | moderate (public read path — must not regress) |
| league_quizzes | owner write / read public or owner | EXISTS on `leagues.owner_id` **and** `quizzes.owner_id` | EXISTS on both `owner_principal_id`s | moderate (two-parent join) |
| league_standings | standings owner insert / update | EXISTS on `leagues.owner_id` | EXISTS on `leagues.owner_principal_id` | mechanical |
| sessions | sessions host manage | `auth.uid() = host_id` | unchanged this migration | high risk if touched — **do not touch** |
| participants / teams | host update / manage via `sessions.host_id` | EXISTS on sessions | unchanged | high risk — **do not touch** |
| competition_results | view own | `auth.uid() = profile_id` | subject-principal phase | deferred |
| host_authorizations / host_requests / user_roles / principals / profiles | self or admin | `x = auth.uid() OR is_admin()` | unchanged | not ownership |

Summary: 11 mechanical, 3 moderate, 0 high-risk **within scope**. Everything high-risk is
session/runtime and is explicitly excluded.

## 6. RPC / trigger dependency map

Functions that read or write an ownership field (from `pg_proc`):

| Function | Ownership dependency | Migration action |
|---|---|---|
| `can(uuid,text,uuid)` | reads `quizzes/competitions/leagues/branding_profiles.owner_id` and `sessions.host_id` | dual-read during transition, then switch to `owner_principal_id` — **last** ownership step |
| `can_view_league` | `leagues.owner_id` | switch with leagues |
| `get_arena_quizzes`, `get_arena_quiz_detail` | select by `quizzes.owner_id` | read-only; switch with quizzes |
| `list_due_competitions` | `competitions.owner_id` | switch with competitions |
| `prepare_competition_session` / `_internal` | reads `competitions.owner_id`, **writes** `sessions.host_id` | writes owner into a child — must dual-write during transition |
| `is_session_host`, `enforce_host_authorization` | `sessions.host_id` | unchanged (runtime) |
| `record_competition_results`, `claim_result`, `create_session_claim`, `submit_arena_run`, `join_session`, `get_league_*`, `get_my_leagues` | `profiles`/`participants.profile_id` | subject identity — **not part of this migration** |
| `admin_*` (11 functions) | `host_authorizations.profile_id`, `profiles` | grantee-principal phase, after ownership |
| all `submit_*`, `advance_*`, `score_*`, autonomous tick | no ownership reference | untouched |

The only function that **creates a child object from parent ownership** is
`prepare_competition_session_internal` (competition → session). It is the single dual-write point.

## 7. `can(...)` migration strategy

Current (verified from live source):

```text
auth.uid() → principals lookup → v_user (auth user id) → owner_id comparison
```

The resolver already resolves a principal, but then compares using the *auth user id* because the
tables only have `owner_id`. Target:

```text
auth.uid() → current_principal_id() → owner_principal_id comparison
```

- **Unchanged:** the whole role/grant half (`has_role`, `has_active_host_authorization`), the
  `admin.*` short-circuit, the action vocabulary, both overloads and their grants
  (`can(text,uuid)` → authenticated, `can(uuid,text,uuid)` → service_role only), NULL handling.
- **Changes:** only the five `EXISTS` branches, each swapping `owner_id = v_user` for
  `owner_principal_id = v_principal`. During transition each branch becomes
  `(owner_principal_id = v_principal OR owner_id = v_user)` so it is correct whether or not that
  table has been migrated yet.
- `session.manage` keeps using `sessions.host_id` throughout.

`can(...)` is migrated **after** all four owning tables carry a validated `owner_principal_id`.

## 8. Ordered migration sequence

Order is driven by the live dependency graph (fewest dependents first, resolver last), not table
creation order.

| # | Entity | Current field | New field | Backfill | RLS | RPC | Validation | Rollback | Old col kept? | Downtime |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | branding_profiles | owner_id | owner_principal_id | `SET = owner_id` (3 rows) | 3 policies | none | count mismatch = 0 | drop column | yes | no |
| 2 | quizzes | owner_id | owner_principal_id | `SET = owner_id` (17 rows) | 2 + questions' 2 | arena readers | mismatch = 0 | drop column | yes | no |
| 3 | leagues | owner_id | owner_principal_id | `SET = owner_id` (2 rows) | 3 + league_quizzes 2 + standings 2 | `can_view_league` | mismatch = 0 | drop column | yes | no |
| 4 | competitions | owner_id | owner_principal_id | `SET = owner_id` (3 rows) | 1 | `list_due_competitions`, `prepare_competition_session*` (dual-write) | mismatch = 0 | drop column | yes | no |
| 5 | `can(...)` resource branches | owner_id compare | owner_principal_id compare (OR fallback) | n/a | none | resolver only | re-run 7E truth matrix | `CREATE OR REPLACE` previous body | n/a | no |
| 6 | Legacy column retirement | owner_id | — | n/a | already switched | already switched | 30 days of zero drift | restore from `owner_principal_id` | no | no |

Each step is a separate migration with this fixed shape:

```sql
ALTER TABLE public.<t> ADD COLUMN owner_principal_id uuid REFERENCES public.principals(id);
UPDATE public.<t> SET owner_principal_id = owner_id WHERE owner_principal_id IS NULL;
-- trigger: keep both columns in sync on INSERT/UPDATE
-- (policies switch only after validation returns 0 mismatches)
```

Deferred beyond this plan, in this order: `host_authorizations.grantee_principal_id`,
`host_requests.requester_principal_id`, `competition_results`/`participants`
`subject_principal_id`, `sessions.host_id` removal (blocked on every session having a
competition), `user_roles` scoping.

## 9. Transitional compatibility strategy

Both columns coexist for the whole migration. A `BEFORE INSERT OR UPDATE` trigger per table fills
whichever side the writer omitted, so unmigrated frontend queries and RPCs that still write
`owner_id` stay correct, and new writers that set only `owner_principal_id` stay correct too.

Continuous invariant, run per table before any policy switch:

```sql
SELECT count(*) FROM public.<t>
WHERE owner_principal_id IS DISTINCT FROM owner_id;   -- must be 0 (ids are identical)
```

`owner_id` may be retired only when: the invariant has held at 0 for a sustained observation
window, no RLS policy or function references `owner_id`, no frontend file references it
(`rg owner_id src`), and non-user principals are still absent or explicitly handled. Nothing is
retired now.

## 10. Rollback strategy

| Failure | Recovery |
|---|---|
| Backfill fails / partial | `owner_id` is untouched and authoritative; `DROP COLUMN owner_principal_id` restores the exact prior state |
| RLS policy breaks | Policies switch in a separate migration from the column add; re-apply the previous policy definition (kept verbatim in the migration body) |
| Function rejects valid owners | `CREATE OR REPLACE FUNCTION` with the prior source; `can(...)` transitional branches keep the `OR owner_id = v_user` fallback so the old path still passes |
| Frontend still expects owner_id | Column is still present and sync-triggered; no frontend change is required until retirement |
| Ownership mismatch discovered | Invariant query identifies exact rows; `UPDATE ... SET owner_principal_id = owner_id` re-syncs, since `owner_id` remains the source of truth until step 6 |

Every stage before step 6 is fully reversible with a single statement, and no stage requires
downtime or a data backfill that cannot be recomputed.

## 11. Organization readiness

The end model needs no second ownership primitive:

```text
University Organization Principal
        ↓ owner_principal_id
   Competition → League → CompetitionResult

Lecturer User Principal
        ↓ organization membership
      Role / Grant
        ↓
      can(principal, action, resource)
```

- `owner_principal_id` references `principals(id)`, which already admits `organization`,
  `platform` and `partner` types — an org-owned quiz needs no schema change.
- Ownership transfer becomes an `UPDATE ... SET owner_principal_id = <org principal>` — a
  reference change, never a structural migration.
- `organization_id` as an ownership column is forbidden by the Constitution and is unnecessary:
  membership (user principal → organization principal) is a *separate* relation feeding the
  capability resolver, not an ownership column.
- Because user principals are id-identical to auth users, the transitional
  `OR owner_id = v_user` fallback stays valid until organization ownership actually appears, at
  which point it is removed with `owner_id`.

## 12. Frozen-MVP confirmation

This phase changed no gameplay, UI, scoring, timing, realtime, Arena behaviour, autonomous
execution, League standings, guest claiming, or result recording. No schema object, policy,
function or trigger was created, altered or dropped. The only artefact is this document.

## 13. Risks

- **Highest risk is scope creep into `sessions`.** `sessions.host_id` participates in RLS for
  `participants`, `teams`, the host-authorization trigger and the autonomous engine. Migrating it
  during the ownership phase risks the frozen core. It is out of scope and stays that way until
  every session originates from a competition.
- **`prepare_competition_session_internal`** is the only owner-propagating writer; missing the
  dual-write there would leave new sessions inconsistent. It is the one function requiring care.
- **Public league read path** (`leagues read public`) is the only ownership policy reachable by
  unauthenticated users; a mistake there is a visibility regression, not just a denial.
- Restrictive host-write policies do not reference ownership at all, so they cannot regress from
  this migration.
- Data-loss risk is effectively nil: every backfill is an identity copy and the source column is
  retained through step 5.

## 14. Verdict

**🟢 GREEN — ready for ownership migration.**

Single safest first migration: **`branding_profiles.owner_id → owner_principal_id`** — 3 rows, no
child tables, no RPC dependency, only three policies, already the proof-of-concept table for
`can(...)`, and entirely outside the gameplay engine. Not executed in this phase.

---

## Phase 7H — branding_profiles ownership migration (EXECUTED 2026-08-15)

**Status: branding_profiles = Principal-aware. All other ownership-bearing tables remain on the
legacy model (`quizzes`, `leagues`, `competitions` untouched).**

### Migration
- Added `branding_profiles.owner_principal_id uuid REFERENCES public.principals(id) ON DELETE RESTRICT`
  (nullable, indexed via `branding_profiles_owner_principal_id_idx`). `RESTRICT` guarantees branding
  can never be deleted as a side effect of principal removal.
- Backfill: identity copy from `owner_id` through `principals(type='user')`. No new principals, no
  profile-based inference.
- Legacy `owner_id` retained, unchanged, still written by the client.

### Validation (post-migration, live)
| check | expected | actual |
|---|---|---|
| total branding rows | 3 | 3 |
| rows with owner_principal_id | 3 | 3 |
| missing principal | 0 | 0 |
| mismatched principal (`owner_principal_id <> owner_id`) | 0 | 0 |
| principal type <> 'user' | 0 | 0 |
| duplicate ownership mappings | 0 | 0 |

### Drift protection
`public.tg_branding_sync_owner_principal()` + `branding_sync_owner_principal_trg`
(BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id). It always derives
`owner_principal_id` from `owner_id` and raises if no user principal exists, so a client cannot set
the principal independently and the two columns cannot diverge.

### RLS changed (branding_profiles only)
| policy | before | after | why |
|---|---|---|---|
| Branding profiles are publicly readable (SELECT) | `true` | unchanged | public-read preserved exactly |
| Owner can insert own branding | `auth.uid() = owner_id AND can('branding.create')` | same, principal filled by trigger | insert still keyed on the legacy column the client writes; capability check unchanged |
| Owner can update own branding | `auth.uid() = owner_id` | `owner_principal_id = current_principal_id()` | principal-based ownership |
| Owner can delete own branding | `auth.uid() = owner_id` | `owner_principal_id = current_principal_id()` | principal-based ownership |

`can('branding.manage', id)` was intentionally **not** used for update/delete: it additionally
requires host authority, which would have narrowed today's owner-only behaviour.

### can(...) change
Only the `branding.manage` branch: ownership now resolves via `owner_principal_id =
principal_for_user(user)`, with a legacy `owner_id` fallback when the principal column is NULL. All
other branches and every truth-table outcome are unchanged.

### Frontend
No files changed. `src/routes/branding.tsx`, `dashboard.tsx`, `host.$sessionId.tsx`,
`play.$sessionId.tsx`, `join.$code.tsx` continue to read/write `owner_id`; the trigger maintains the
principal column.

### Rollback procedure
1. `DROP POLICY` the three mutation policies and recreate them with `auth.uid() = owner_id`
   (insert policy also `AND can('branding.create')`).
2. Restore the previous `can(uuid,text,uuid)` body (`branding.manage` → `b.owner_id = v_user`).
3. `DROP TRIGGER branding_sync_owner_principal_trg ON public.branding_profiles;`
   `DROP FUNCTION public.tg_branding_sync_owner_principal();`
4. Optionally `ALTER TABLE public.branding_profiles DROP COLUMN owner_principal_id;`
   `owner_id` was never modified, so steps 1–3 alone fully restore Phase 7G behaviour.

### Transitional state / not done
`owner_id` is not dropped, not renamed, and not optional. The sync trigger stays. No Organizations.

### Next recommended migration
`leagues` — 2 rows, single owner column, no cross-table ownership joins other than
`league_quizzes`/`league_standings` (which read the parent), and no runtime/autonomous coupling.
`quizzes` should follow (questions + league_quizzes join on it), and `competitions` last because of
`prepare_competition_session_internal` dual-write.

---

## Phase 7I — leagues ownership migration (EXECUTED 2026-08-15)

**Status: `branding_profiles` = Principal-aware, `leagues` = Principal-aware.
`quizzes` = legacy ownership, `competitions` = legacy ownership.**

### Migration
- Added `leagues.owner_principal_id uuid REFERENCES public.principals(id) ON DELETE RESTRICT`
  (nullable, indexed via `leagues_owner_principal_id_idx`). `leagues.owner_id` retained untouched.
- Backfill: identity copy from `owner_id` through `principals(type='user')`. No principals created,
  no owner changed, no profile-based inference.

### Validation (post-migration, live)
| check | expected | actual |
|---|---|---|
| total leagues | 2 | 2 |
| populated principal | 2 | 2 |
| missing principal | 0 | 0 |
| mismatches (`owner_principal_id <> owner_id`) | 0 | 0 |
| non-user principal type | 0 | 0 |
| duplicate ownership mappings | 0 | 0 |

### Drift protection
`public.tg_leagues_sync_owner_principal()` + `leagues_sync_owner_principal_trg`
(BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id): always derives the principal from
`owner_id`, raises when no user principal exists. Clients cannot assign a principal independently.

### RLS changed (leagues only)
| policy | before | after | why |
|---|---|---|---|
| leagues manage own (ALL, permissive) | `auth.uid() = owner_id` | `owner_principal_id = current_principal_id()` | ownership cutover |
| leagues read public (SELECT) | `visibility='public' OR owner_id = auth.uid()` | `visibility='public' OR owner_principal_id = current_principal_id()` | owner-visibility half is ownership; public half byte-identical |
| leagues read all (SELECT `true`) | unchanged | unchanged | public read preserved |
| leagues host only write (RESTRICTIVE) | unchanged | unchanged | host authority, not ownership |
| league_quizzes / league_standings policies | unchanged | unchanged | inherit through `leagues.owner_id`, which is still present and trigger-synced |

Owner / admin / host / public-reader / non-owner distinctions are preserved exactly; league
ownership was **not** collapsed into "host".

### can(...) change
Only the `league.manage` branch: ownership resolves via `owner_principal_id =
principal_for_user(user)` with a legacy `owner_id` fallback when NULL. `quiz.*`, `competition.manage`,
`session.manage` and all create-actions untouched.

### Dependent objects
`league_quizzes`, `league_standings`, `teams` received no ownership column. Their policies still
join `leagues.owner_id` (and `quizzes.owner_id`), which remains authoritative and in sync — verified
unchanged. League functions (`get_league_standings`, `get_league_overview`, `get_my_leagues`,
`can_view_league`) still read `owner_id` and were not modified.

### Frontend
No client changes required; the app writes `owner_id` and the trigger derives the principal.

### Rollback (lossless)
1. Recreate `leagues manage own` with `auth.uid() = owner_id` (USING + WITH CHECK) and
   `leagues read public` with `visibility='public' OR owner_id = auth.uid()`.
2. Restore the `league.manage` branch of `can(uuid,text,uuid)` to `l.owner_id = v_user`.
3. `DROP TRIGGER leagues_sync_owner_principal_trg ON public.leagues;`
   `DROP FUNCTION public.tg_leagues_sync_owner_principal();`
4. Optionally `ALTER TABLE public.leagues DROP COLUMN owner_principal_id;`

### Anomalies
None.

### Next recommended migration
`quizzes` (17 rows) — it is the parent of `questions` and one side of the `league_quizzes` join, so
migrating it unlocks the remaining inherited policies. `competitions` last, because
`prepare_competition_session_internal` writes competition/session rows during live execution.

## Phase 7J — quizzes ownership migration (EXECUTED 2026-08-15)

**Status: `branding_profiles` = Principal-aware, `leagues` = Principal-aware, `quizzes` =
Principal-aware. `competitions` and `sessions` remain on legacy ownership.**

### Migration
`quizzes.owner_id` retained and authoritative. Added
`quizzes.owner_principal_id uuid REFERENCES public.principals(id) ON DELETE RESTRICT`, nullable,
indexed (`idx_quizzes_owner_principal_id`).

### Rows / integrity
17 quizzes, 17 mapped, 0 missing principals, 0 mismatches, 0 duplicate user principals,
0 non-user principals. Dependency integrity re-verified: 0 orphan questions, 0 orphan
`league_quizzes` rows, 0 orphan competition quiz references.

### Drift protection
`quizzes_sync_owner_principal_trg` (BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id)
calls `tg_quizzes_sync_owner_principal()`, which always derives the principal from `owner_id` and
raises when no user principal exists. Clients cannot set `owner_principal_id` independently.

### RLS changed
- `quizzes manage own` — USING is now `owner_principal_id = principal_for_user(auth.uid())` OR the
  legacy fallback when NULL; WITH CHECK stays `auth.uid() = owner_id` (legacy stays authoritative on
  write, trigger derives the principal).
- `questions manage by owner` and `questions owner read` — the parent-quiz EXISTS predicate now
  recognises the principal owner with a legacy fallback. No `questions.owner_principal_id`.

**Unchanged:** `quizzes read all` (public), `Arena quizzes are publicly readable`, the RESTRICTIVE
`quizzes host only write` / `questions host only write` policies, and all `league_quizzes` policies
(they still join `quizzes.owner_id` / `leagues.owner_id`, which stay in sync).

### can(...) change
Only the `quiz.edit` / `quiz.delete` branch: principal-first with legacy `owner_id` fallback.
`quiz.create`, competition, session, league, branding and admin branches untouched.

### Frontend
No client changes required. The app writes/filters `owner_id`; the trigger derives the principal.

### Rollback (lossless)
1. Recreate `quizzes manage own` with `auth.uid() = owner_id` (USING + WITH CHECK).
2. Restore `questions manage by owner` / `questions owner read` to `q.owner_id = auth.uid()`.
3. Restore the `quiz.edit`/`quiz.delete` branch of `can(uuid,text,uuid)` to `q.owner_id = v_user`.
4. `DROP TRIGGER quizzes_sync_owner_principal_trg ON public.quizzes;`
   `DROP FUNCTION public.tg_quizzes_sync_owner_principal();`
5. Optionally `ALTER TABLE public.quizzes DROP COLUMN owner_principal_id;`

### Anomalies
None.

### Next recommended migration
`competitions` — intentionally last, because it is coupled to the live and autonomous runtime
(`prepare_competition_session_internal`, `tg_sync_competition_from_session`, the scheduler tick).

---

## Phase 7K — competitions ownership migration (EXECUTED 2026-08-16)

**Status: `branding_profiles` = Principal-aware, `leagues` = Principal-aware, `quizzes` =
Principal-aware, `competitions` = Principal-aware. All four true ownership-bearing business tables
are migrated. `sessions.host_id` remains legacy runtime identity (never part of this phase).**

Migration file: `supabase/migrations/20260816120000_43048aa5-07b8-466b-9e73-487a0e56280c.sql`

### Migration
- Added `competitions.owner_principal_id uuid REFERENCES public.principals(id) ON DELETE RESTRICT`
  (nullable, indexed via `competitions_owner_principal_id_idx`). `competitions.owner_id` retained
  untouched, still authoritative and still written by the client.
- Backfill: identity copy from `owner_id` through `principals(type='user')` (`p.user_id =
  owner_id`). No new principals, no profile/participant/creator/session inference, no owner
  changes.
- Row count: 3 at the Phase 7G audit (2026-08-15). This migration is the first in the series to
  carry a built-in integrity gate: a `DO` block immediately after backfill hard-fails the
  migration on any missing/mismatched/non-user/duplicate mapping or orphan quiz/session reference,
  so an inconsistent live row count stops the phase before any authorization change (per the 7K
  mandate, the live count is asserted by the migration itself).

### Validation (post-migration, live)
Run the read-only queries in migration section 8. Expected:
| check | expected | actual |
|---|---|---|
| total competitions | live count | asserted by integrity gate |
| rows with owner_principal_id | = total | asserted by integrity gate |
| missing principal | 0 | asserted by integrity gate |
| mismatched principal (`owner_principal_id <> owner_id`) | 0 | asserted by integrity gate |
| principal type <> 'user' | 0 | asserted by integrity gate |
| duplicate ownership mappings | 0 | asserted by integrity gate |
| orphan quiz / session references | 0 | asserted by integrity gate |
| session host vs competition owner mismatch | 0 | post-migration SELECT |
| orphan league / branding references | 0 | post-migration SELECT |

### Drift protection
`public.tg_competitions_sync_owner_principal()` + `competitions_sync_owner_principal_trg`
(BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id): always derives `owner_principal_id`
from `owner_id`, raises when no user principal exists. Clients cannot assign the principal
independently; the two columns cannot diverge.

### RLS changed (competitions only)
| policy | before | after | why |
|---|---|---|---|
| Owners manage their competitions (ALL, authenticated) | `auth.uid() = owner_id` (USING + WITH CHECK) | USING = `owner_principal_id = principal_for_user(auth.uid()) OR (owner_principal_id IS NULL AND auth.uid() = owner_id)`; WITH CHECK unchanged `auth.uid() = owner_id` | ownership cutover; legacy stays authoritative on write, trigger derives the principal (Phase 7J shape) |
| Admin can view all competitions (SELECT) | `public.is_admin()` | unchanged | administrative access, not ownership |
| Public competitions are viewable (SELECT, anon+authenticated) | `visibility = 'public' AND status IN (...)` | unchanged | public surface preserved exactly |
| sessions / participants / teams runtime policies | — | unchanged | host identity untouched, out of scope |

### can(...) change
Only the `competition.manage` branch: ownership now resolves via `owner_principal_id =
principal_for_user(v_user)`, with a legacy `owner_id` fallback when the principal column is NULL.
`competition.create`, `quiz.*`, `league.manage`, `branding.manage`, `session.manage`, admin and
host-role resolution are byte-identical to the Phase 7J body. Decision-equivalence: user
principals are id-identical to auth users, so the new branch matches the same rows as the
previous `c.owner_id = v_user` check.

### Session preparation (the single owner-propagation point)
- `prepare_competition_session_internal`: `sessions.host_id` is now derived from
  `COALESCE(c.owner_principal_id, c.owner_id)` instead of `c.owner_id`. Because user principal
  ids equal auth user ids, the written host value is byte-identical. Join codes, lobby window,
  quiz/archived-quiz checks, autonomous flag, competition link and status transition are
  unchanged. `sessions.host_id` itself is NOT migrated.
- `prepare_competition_session` (public wrapper): the authorization gate reads
  `COALESCE(owner_principal_id, owner_id)` — same decision as before (owner OR `is_admin()`),
  identical for every row.
- `list_due_competitions` is unchanged: it filters on `owner_id`, which remains present,
  authoritative and trigger-synced.

### Autonomous scheduler
Verified browser-free operation: `run_autonomous_tick` / `run_autonomous_scheduler` reference
**no** ownership column — they select by `status`, `mode`, `autonomous`, `session_id`,
`scheduled_start_at` and delegate lobby opening to `prepare_competition_session_internal`. The
lobby-open → single-session → auto-start → progression → completion → results chain is untouched
by the migration. `tg_sync_competition_from_session` (sessions status → competition status) and
`sync_competition_from_session` have no owner reference.

### Host authorization
Owner vs host distinction preserved exactly:
- Competition **owner** governs competition rows (principal RLS) and may prepare a session
  (wrapper gate: owner OR admin).
- **Host** is the session runtime identity (`sessions.host_id`, unchanged); session control RPCs,
  `enforce_host_authorization` (grant consumption on session insert), participants/teams policies
  and `session.manage` in `can(...)` all still key on `host_id`.
- `can('competition.manage')` still requires `v_owner AND v_host` — a competition owner without
  host authority is not granted manage by the capability layer, exactly as before.

### League compatibility
Competitions linked to leagues are unaffected: `league_id` is not touched, `get_league_standings` /
`get_league_overview` / `get_my_leagues` join `competitions` by `session_id`/`league_id`/`status`
with no ownership read, and league ownership (Phase 7I) is not re-migrated.

### Branding compatibility
`branding_profile_id` is not touched; branded competitions render through the existing branding
join and Phase 7H ownership. No changes.

### Results
`competition_results` is unchanged: `record_competition_results` reads only
sessions/participants/answers; no ownership reference. Ranking, score, accuracy, profile history
and Arena results are untouched.

### Frontend
Zero files changed. `routes/competitions.tsx` still filters `.eq("owner_id", user.id)`, inserts
`owner_id` (trigger derives the principal) and calls `prepare_competition_session` with the same
arguments. `src/integrations/supabase/types.ts` is auto-generated and was not hand-edited; the app
never selects or writes `owner_principal_id`, so stale types are harmless until the next Lovable
type generation.

### Rollback (lossless)
1. Recreate `Owners manage their competitions` with `USING (auth.uid() = owner_id)` and
   `WITH CHECK (auth.uid() = owner_id)`.
2. Restore the `competition.manage` branch of `can(uuid,text,uuid)` to `c.owner_id = v_user`
   (full body from the Phase 7J migration).
3. Restore `prepare_competition_session_internal` (`c.owner_id` in the sessions INSERT) and
   `prepare_competition_session` (`SELECT owner_id INTO v_owner`) from the pre-7K bodies.
4. `DROP TRIGGER competitions_sync_owner_principal_trg ON public.competitions;`
   `DROP FUNCTION public.tg_competitions_sync_owner_principal();`
5. Optionally `ALTER TABLE public.competitions DROP COLUMN owner_principal_id;`
   `owner_id` was never modified, so steps 1–4 alone fully restore Phase 7J behaviour.

### Transitional state / not done
`owner_id` is not dropped, not renamed, not optional. The sync trigger stays. `sessions.host_id`
is not migrated. No Organizations. Legacy retirement (step 6 of the 7G sequence) is deferred to
the next phase: it requires all four ownership tables migrated (now true), capability resolution
fully principal-aware, all RLS migrated, zero application `owner_id` reads, a sustained zero-drift
window and no rollback requirement.

### Anomalies
None.

## Phase 7L — Principal-aware authorization completion & legacy retirement (EXECUTED 2026-08-16)

**Status: `can(...)` = principal-only for all ownership-sensitive capabilities; all ownership RLS
on the four tables + child tables (questions, league_quizzes, league_standings) = principal-aware;
sync triggers = retired; legacy `owner_id` columns = retired. `sessions.host_id` remains legacy
runtime identity (never part of this phase).**

Migration files (apply in order, see gates below):
1. `supabase/migrations/20260816124500_phase_7l_authorization_completion.sql` — **apply first**,
   safe at any time.
2. `supabase/migrations/20260816130000_phase_7l_retire_sync_triggers.sql` — **apply only AFTER
   the application deploy** that switched writes to `owner_principal_id`.
3. `supabase/migrations/20260816131500_phase_7l_retire_owner_id_columns.sql` — **apply only
   AFTER (2)**; each DROP is individually reversible.

### 7L.1 Full legacy ownership dependency audit (classification)

Every live `owner_id` reference at the start of 7L, classified:

| Reference | Location | Classification | Disposition |
|---|---|---|---|
| `can(...)` ownership branches ×4 (quiz.edit/delete, competition.manage, league.manage, branding.manage) — `owner_principal_id` first, `owner_id` fallback when NULL | 20260816120000:141-178 | transitional compatibility | fallback removed (M1 §3); principal-only |
| Sync triggers ×4 (`tg_*_sync_owner_principal`) | 7H/7I/7J/7K | transitional compatibility (dual-write) | made bidirectional in M1 §2 (principal-authoritative, legacy mirror), then retired (M2) |
| RLS WITH CHECK `auth.uid() = owner_id` — quizzes "quizzes manage own", competitions "Owners manage their competitions" | 7J:49, 7K:282 | transitional compatibility | principal-aware WITH CHECK (M1 §4) |
| RLS USING legacy fallback `OR (owner_principal_id IS NULL AND auth.uid() = owner_id)` — quizzes, competitions, questions ×2 | 7J:47, 7K:280, 7J:58-76 | transitional compatibility | fallback removed (M1 §4) |
| branding INSERT policy `auth.uid() = owner_id AND can('branding.create')` | 7H:121-124 | transitional compatibility | principal-aware WITH CHECK, create rule kept (M1 §4) |
| league_quizzes policies — `l.owner_id` / `q.owner_id` | 20260719074454:36-62 | genuine ownership dependency (inherited league/quiz ownership) | principal-aware (M1 §4) |
| league_standings policies — `l.owner_id` | 20260618084857:43-50 | genuine ownership dependency (inherited league ownership) | principal-aware (M1 §4) |
| `prepare_competition_session_internal` — `COALESCE(owner_principal_id, owner_id)` host derivation | 7K:242 | genuine ownership dependency (owner-propagation point) | `owner_principal_id` only (M1 §5a) |
| `prepare_competition_session` — `COALESCE(...)` gate read | 7K:262 | genuine ownership dependency | `owner_principal_id` only (M1 §5a) |
| `list_due_competitions` — `c.owner_id = auth.uid()` | 20260812153755:147 | genuine ownership dependency (owner-scoped due list; autonomous scheduler itself has **no** owner reference) | principal-aware, decision-equivalent (M1 §5b) |
| `can_view_league` — `l.owner_id = auth.uid()` | 20260812153755:132 | genuine ownership dependency | principal-aware, decision-equivalent (M1 §5c) |
| `get_arena_quiz_detail` / `get_arena_quizzes` — creator_name via `q.owner_id` | 20260731050859:34, 20260801001013:62 | attribution (display only) | joins via `owner_principal_id`, output identical (M1 §5d) |
| Client queries `.eq("owner_id", user.id)` ×9, insert payloads ×4, ownership guards ×2, dead SELECT columns ×3, local types ×3 | src/routes/*, src/lib/branding.ts | application dependency | migrated to `owner_principal_id` (7L §5 below) |
| MCP server: `quizToDbRow` (save_quiz), `listQuizzes` fallback filter, select columns | mcp/src/schema.ts, mcp/src/supabase.ts, mcp/src/lifecycle.ts | server utility | migrated to `owner_principal_id` (principal-only) |
| `scripts/verify-live.mjs` drift/dup checks vs owner_id | scripts/ | audit tooling | principal-only invariants (missing/non-user/dup structurally impossible via FK) |
| `scripts/remap-ownership.mjs`, `scripts/remap.sql`, `migration-data/extract.json` | scripts/, migration-data/ | one-time historical migration artifacts | retained as history; not runtime dependencies |
| Historical policy/function versions in older migrations | 20260616133205, 20260618084857, 20260717231622, 20260719074454, 20260724054750, 20260803053004, 20260804061631, 20260805054014, 20260806054006, 20260812153755, 20260812154432 | obsolete (superseded by later CREATE OR REPLACE / DROP POLICY) | none — historical record only |

No views reference `owner_id`. No frozen-system code (gameplay, timing, realtime, Arena,
autonomous execution, standings calculation, results, guest claiming, question rendering,
scheduler) references `owner_id`.

### 7L.2 Principal-aware `can(...)` completion

All four ownership-sensitive capabilities resolve through the principal only:
`quiz.edit`, `quiz.delete`, `competition.manage`, `league.manage`, `branding.manage` all evaluate
`owner_principal_id = principal_for_user(v_user)` with no legacy fallback. Safety: the M1
integrity gate proves zero NULL/mismatched/non-user/duplicate principal mappings, and the
bidirectional triggers keep `owner_principal_id` non-NULL for every future row. Admin rules,
host rules, create rules, `session.manage` (still host_id-based) and NULL handling are unchanged.
The `can(text, uuid)` caller-identity overload (RLS-only, passes `auth.uid()` which `can()` still
resolves) is unchanged and cannot be spoofed: it never accepts a client-supplied principal.

### 7L.3 RLS completion

Every remaining true ownership policy is principal-aware: quizzes and competitions (USING +
WITH CHECK), branding INSERT, questions ×2, league_quizzes ×2, league_standings ×2. Leagues were
already principal-aware (7I). The owner/admin/host/public-reader/participant/anonymous
distinction is preserved: admin policies (`is_admin()`), restrictive host-write policies, and
public-read policies are untouched. The legacy fallbacks were provably dead (NULL principal
impossible) and were removed rather than kept.

### 7L.4/5 Application migration

All four ownership-bearing business-object writes, reads, guards and types now use
`owner_principal_id` (user principals are id-identical to auth users, so values are unchanged):
`routes/dashboard.tsx`, `routes/leagues.index.tsx`, `routes/leagues.$id.tsx`,
`routes/branding.tsx`, `routes/competitions.tsx`, `routes/quizzes.$id.tsx` (writes ×4, filters ×9,
guards ×2), the branding selects in `routes/host.$sessionId.tsx` / `join.$code.tsx` /
`play.$sessionId.tsx`, `src/lib/branding.ts`, and the MCP server (`schema.ts`, `supabase.ts`,
`lifecycle.ts`). Not altered: `sessions.host_id`, `participants.profile_id`,
`competition_results.profile_id`, `user_roles.user_id`, attribution fields. The M1 bidirectional
triggers make the write switch safe in a single deploy window: pre-deploy legacy writers
(`owner_id`-only) still derive the principal; post-deploy principal writers get the legacy mirror.

### 7L.6/7 Dual-write and legacy column retirement

M2 drops the four sync triggers (gated on the app deploy — after it, no code path writes
`owner_id`). M3 drops the four legacy columns (`branding_profiles`, `leagues`, `quizzes`,
`competitions`) as individually reversible statements; PostgreSQL refuses the DROP if any policy
or SQL-language function still references the column (safety net), and M1 removed every
PL/pgSQL reference. Rollback SQL for each column is inlined in M3. `sessions.host_id` is NOT a
legacy ownership column: it remains the runtime host identity and is untouched.

### 7L.8 Final ownership integrity audit

For every one of the four tables: exactly one principal owner per row (FK `owner_principal_id →
principals.id`, `ON DELETE RESTRICT`), zero NULL principals, zero non-user principals (asserted
by M1's integrity gate), zero duplicate mappings (structurally impossible: principals.id is a
primary key), zero drift (both directions of the trigger write the same value; retired after the
gate proved consistency), zero orphaned child relationships (questions/league_quizzes/
league_standings inherit ownership via their parent's principal). `scripts/verify-live.mjs`
section B now asserts these principal-only invariants.

### 7L.9 Organization readiness

The model now supports `User | Organization | Platform | Partner` principals (enum from 7F) with
no schema change: a business object's owner is a `principals` reference, so reassigning ownership
from User Principal A to Organization Principal B is a single-column UPDATE (the M1 triggers
mirror `owner_id := NULL` for non-user principals, which the legacy column cannot represent).
Ownership no longer assumes `owner = auth user`. Organizations themselves remain explicitly out
of scope (Constitution §4 forbids a second ownership column; the 7G plan defers org membership).

### 7L.10 Security verification

Owner can still manage owned resources (principal RLS + `can()`); non-owner cannot (RLS + guards);
admin retains administrative access (`is_admin()` untouched); host remains host, not owner
(`sessions.host_id` and `session.manage` untouched; `can()` still requires `v_owner AND v_host`);
anonymous access unchanged (public-read policies untouched); principals cannot be reassigned
through client calls (`principals` is read-only to clients — no INSERT/UPDATE/DELETE policies,
immutability trigger, and RLS on the four tables only matches `current_principal_id()`); `can()`
cannot be spoofed (service_role-only grant; the RLS `can(text, uuid)` overload passes
`auth.uid()`, never a client-controlled value). No privilege escalation: every change is
decision-equivalent for user principals or removes a fallback that was provably dead.

### 7L.11 Regression

Zero behavioural change was introduced: every RLS/RPC/trigger change is decision-equivalent
(user principals are id-identical to auth users) or removes provably dead fallbacks. The frozen
surfaces — gameplay, timing, realtime, Arena, autonomous competition execution (`run_autonomous_*`
have no ownership reference), League standings calculation, CompetitionResults, guest claiming,
question rendering, scheduler behaviour — are untouched.

### Remaining transitional exceptions (documented, not retired)

- `sessions.host_id` — runtime host identity, deliberately not migrated (Constitution §4 row 5,
  deferred).
- `host_authorizations.profile_id`, `host_requests.user_id`, `user_roles.user_id`,
  `competition_results.profile_id`, `participants.profile_id` — identity/attribution columns,
  not ownership; deferred subject/grantee principal renames (DEFERRED_WORK register).
- `can(text, uuid)` RLS caller wrapper — remains, resolves through `can()`.
- One-time migration artifacts (`scripts/remap-*.mjs`, `migration-data/`) — historical only.

### Anomalies
None. `src/integrations/supabase/types.ts` was hand-synced for `competitions.owner_principal_id`
(the generated file predated the 7K column); regenerate on the next Lovable type generation.
