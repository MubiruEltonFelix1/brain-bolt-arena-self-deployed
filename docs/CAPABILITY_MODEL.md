# Brain Bolt — Capability Layer (Phase 7D)

Transitional capability resolver. MVP gameplay remains frozen; no user-facing permission changed.

## 1. Capability vocabulary

Derived from actions the app actually performs today. No speculative capabilities.

| Capability | Resolves via |
|---|---|
| `quiz.create` | host capability |
| `quiz.edit` / `quiz.delete` | ownership of quiz AND host capability |
| `competition.create` | host capability |
| `competition.manage` | ownership of competition AND host capability |
| `session.host` | host capability |
| `session.manage` | `sessions.host_id` match AND host capability |
| `league.create` | host capability |
| `league.manage` | ownership of league AND host capability |
| `branding.create` | host capability |
| `branding.manage` | ownership of branding profile AND host capability |
| `admin.users.manage` | admin role only |
| `admin.host_authorizations.manage` | admin role only |
| `admin.access` | admin role only |

Any `admin.*` action requires administrative authority. Any unknown action denies.

## 2. Signature

```sql
public.can(p_principal uuid, p_action text, p_resource uuid DEFAULT NULL) -> boolean   -- service_role only
public.can(p_action text, p_resource uuid DEFAULT NULL) -> boolean                     -- authenticated; uses auth.uid()
```

Both are `STABLE SECURITY DEFINER` with `search_path = public`. The caller-facing overload never accepts
a supplied identity; it derives the principal from `auth.uid()`.

## 3. Decision table

```text
principal is NULL              -> deny
action LIKE 'admin.%'          -> admin role only
create/host actions            -> admin role OR host role OR active host grant
resource actions               -> (owner of resource) AND host capability
unknown action                 -> deny
```

Ownership and role stay separate: owning a quiz never grants admin, and holding the host role never
grants ownership of someone else's resource.

## 4. Grants and quotas

`can(...)` consumes the existing `host_authorizations` table through
`has_active_host_authorization()`. No duplicate grant storage was created. Expired, revoked and
consumed grants deny exactly as before, and the host-role quota bypass is unchanged (a `host` role
still satisfies host capability without a grant row).

The grant table already expresses capability scope (`authorization_type`), expiration (`expires_at`),
quota (`remaining_sessions`) and status — the future generalized grant model extends it rather than
replacing it.

## 5. Verification matrix (executed against live data)

| Principal | Capability | Expected | Observed |
|---|---|---|---|
| admin | `admin.users.manage` | allow | allow |
| admin | `session.host` | allow | allow |
| admin | own quiz `quiz.edit` | allow | allow |
| admin | other's quiz `quiz.edit` | deny | deny |
| active grant holder | `session.host` | allow | allow |
| active grant holder | `admin.users.manage` | deny | deny |
| active grant holder | own quiz `quiz.edit` | allow | allow |
| no role, no grant | `session.host` / `branding.create` | deny | deny |
| no role, no grant | own-resource action | deny (matches restrictive RLS) | deny |
| anonymous (NULL principal) | any protected action | deny | deny |
| any | unknown action | deny | deny |

Anonymous gameplay paths are untouched — they never routed through host/admin helpers.

## 6. RLS proof

Representative migration only:

- `branding_profiles` INSERT: `auth.uid() = owner_id AND public.can('branding.create')`
  (previously `auth.uid() = owner_id AND is_authorized_host()` — identical truth table).

All other policies remain on the legacy helpers. Eventual migration order:
`branding_profiles` UPDATE/DELETE → `competitions` → `leagues` / `league_quizzes` →
`quizzes` / `questions` restrictive host-write policies → `sessions` → admin-gated tables.

## 7. Client

No client authorization rewrite. `src/hooks/use-host-status.ts` and `src/components/host-shell.tsx`
still reconstruct role/grant state for UI affordances only; the database remains authoritative.
Migration path: expose a single read-only capability RPC returning the caller's capability set and
have the client consume that instead of reading `user_roles` / `host_authorizations` directly.

## 8. Principal readiness

```text
CURRENT: auth.uid()  -> can(principal uuid, action, resource)
TARGET:  principal_id -> can(principal uuid, action, resource)
```

The three-argument signature is already principal-shaped. When Principal lands, only the resolution
of the principal id changes (and ownership comparisons move to `owner_principal_id`); call sites and
policy expressions using `can('x.y', id)` do not change again.
