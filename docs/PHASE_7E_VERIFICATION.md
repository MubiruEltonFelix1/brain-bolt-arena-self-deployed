# Brain Bolt — Phase 7E: Capability Stabilization & Production Verification

Read-only verification phase. No schema, gameplay, timing, realtime, Arena, autonomous,
league or result-recording code was changed.

## 1. Execution surface (verified live)

| Function | Security | search_path | anon | authenticated | service_role |
|---|---|---|---|---|---|
| `can(p_action, p_resource)` | DEFINER, STABLE | `public` | ✗ | ✓ | ✓ |
| `can(p_principal, p_action, p_resource)` | DEFINER, STABLE | `public` | ✗ | ✗ | ✓ |
| `is_admin()` | DEFINER, STABLE | `public` | ✗ | ✓ | ✓ |
| `has_role(uuid, app_role)` | DEFINER, STABLE | `public` | ✗ | ✓ | ✓ |
| `is_authorized_host()` | DEFINER, STABLE | `public` | ✓ (legacy) | ✓ | ✓ |
| `has_active_host_authorization(uuid)` | DEFINER, STABLE | `public` | ✓ (legacy) | ✓ | ✓ |

- Identity cannot be spoofed: the caller-facing overload takes no principal and resolves `auth.uid()`.
- The principal-taking overload is **not** executable by `authenticated` or `anon` (confirmed by
  `has_function_privilege` and by live anonymous REST calls returning `42501`).
- Anonymous REST calls to both overloads are denied (`permission denied for function can`).
- `NULL` principal → deny; unknown action → deny; resource action with `NULL` resource → deny
  (verified in the function body, which returns `false` on each path before any table read).
- `can()` returns only a boolean; no row data is exposed.

## 2. Decision-model verification (live data)

Resolver logic reduces to `admin role` / `admin OR host role OR active grant` / `owner AND host`.
Evaluating the same predicates directly against `user_roles` and
`has_active_host_authorization()` for every real account reproduces the documented matrix:

| Account class | admin caps | host caps | resource caps |
|---|---|---|---|
| admin (1 account) | allow | allow | own resources only |
| active grant holders (2 accounts) | deny | allow | own resources only |
| no role / no grant (2 accounts) | deny | deny | deny |
| anonymous | deny | deny | deny |

Host authorization never implies ownership (ownership is an explicit `owner_id`/`host_id` match),
and ownership never implies admin (`admin.%` short-circuits on role only).

## 3. Quotas — unchanged

`enforce_host_authorization_trg` on `sessions` is enabled and unchanged:
admin/host role bypass quota; grant-based hosts consume `remaining_sessions` and flip to
`consumed` at zero; `time` grants expire on `expires_at`; revoked/expired/consumed grants fail
session creation with `42501`. `can()` reads the same grant state and never mutates it.

## 4. Migrated RLS policy — correct

`branding_profiles` INSERT: `WITH CHECK (auth.uid() = owner_id AND can('branding.create'))`.
Truth table identical to the previous `auth.uid() = owner_id AND is_authorized_host()`:
owner+host allow, owner without host deny, admin (as owner) allow, non-owner deny, anonymous deny
(the policy is scoped to `authenticated` and `can` is not executable by `anon`), unknown capability
irrelevant (literal action string). No other policy was migrated.

Pre-existing (not introduced by 7C/7D): branding UPDATE/DELETE are owner-only with no host
predicate, because `branding_profiles` has no RESTRICTIVE host-write policy. Not an escalation —
scope is the caller's own row.

## 5. Client / database agreement

`use-host-status.ts` computes `canHost = admin role OR host role OR active grant`, matching
`is_authorized_host()` and the host branch of `can()`. Two theoretical divergences exist and are
currently unreachable, so they were deliberately not "fixed":

- the client ignores `starts_at`; `admin_grant_host_authorization` always inserts `starts_at = now()`.
- the client inspects only the newest active grant; the same RPC revokes prior active grants, so at
  most one active grant exists per user.

If future-dated or multiple concurrent grants ever become possible, the client hook must be updated
in the same change.

## 6. Observability

Postgres error logs for the audit window contained only the deliberate `permission denied for
function can` entries produced by this audit's anonymous probes. No RLS violations, no SECURITY
DEFINER errors, no host-authorization failures, no unexpected denials. Application-level
authorization telemetry does not exist; recorded as future work (not built in this phase).

## 7. Regression pass

Smoke pass over `/`, `/arena`, `/training`, `/auth`, `/dashboard`, `/competitions`, `/leagues`,
`/branding`, `/admin`, `/profile`: all render, protected routes redirect to `/auth` as designed,
anonymous game-code lookup and Arena reads succeed, zero console errors. No MVP journey regressed.

## 8. Principal migration readiness — dependency map

- **A. Acting identity today:** `auth.uid()` (Supabase auth user id) everywhere; `profiles.id` is
  the same uuid.
- **B. `profile_id`:** `participants`, `competition_results`, `host_authorizations`.
- **C. `auth.uid()` directly (RLS / functions):** `quizzes`, `questions`, `sessions`, `leagues`,
  `league_quizzes`, `competitions`, `branding_profiles`, `user_roles`, `host_authorizations`,
  `host_requests`, `profiles`, plus `is_admin()`, `is_authorized_host()`, `can(action, resource)`.
- **D. `owner_id`:** `quizzes`, `competitions`, `leagues`, `branding_profiles`.
- **E. Other ownership columns:** `sessions.host_id`, `user_roles.user_id`,
  `host_requests.user_id`, `result_claims.claimed_by`, `host_authorizations.granted_by`,
  `user_roles.granted_by`, `host_requests.reviewed_by`; `answers`/`participant_secrets`/`teams`
  are owned transitively through `participants`/`sessions`.
- **F. Policies depending on those identities:** all RESTRICTIVE host-write policies
  (`quizzes`, `sessions`, `leagues`), owner policies on `quizzes`/`leagues`/`competitions`/
  `branding_profiles`/`sessions`, and admin policies on `user_roles`/`host_authorizations`/
  `competitions`.
- **G. Safest first Principal migration:** introduce `principals` with a 1:1 user-principal row
  seeded from `auth.users.id` **using the same uuid**, and resolve the principal inside
  `can(...)` only. No table gains `owner_principal_id` in that step, no policy changes, no data
  duplication — ownership comparisons keep working because principal id equals user id.

## 9. Migration safety invariants (confirmed reachable)

Preserving user ids as principal ids means existing profiles, ownership, results, leagues,
competitions, quizzes, branding, guest claims, Arena history, host authorizations and RLS
semantics all survive untouched. No row needs duplication to introduce Principal.

## 10. Verdict

Capability layer: 🟢 stable. No privilege escalation. No quota change. No regression.
Ready for Phase 7F — Principal / Ownership Abstraction.
