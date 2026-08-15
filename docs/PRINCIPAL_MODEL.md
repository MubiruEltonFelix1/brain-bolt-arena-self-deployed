# Brain Bolt — Principal Model (Phase 7F)

Principal is the universal acting/ownership identity abstraction. This phase introduces the
foundation only: no ownership column, RLS policy, or gameplay behaviour changed.

## 1. Schema

```sql
public.principal_type = ('user','organization','platform','partner')

public.principals (
  id         uuid primary key,
  type       principal_type not null,
  user_id    uuid unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((type = 'user' and user_id is not null) or (type <> 'user' and user_id is null)),
  check (type <> 'user' or id = user_id)     -- 1:1 identity continuity
)
```

User principals carry the **same id as the auth user**. That is deliberate: a future
`owner_principal_id` backfill is a straight copy of the existing `owner_id`/`user_id`/`host_id`
value — no lookup table joins, no id remapping, no second identity system.

Only `user` principals exist in production. Organization / platform / partner rows are reserved
for later phases and cannot currently be created from the client.

## 2. Population

- Seeded once: exactly one `user` principal per row in `auth.users`.
- `public.handle_new_user()` now inserts the profile **and** the principal for every new signup
  (`ON CONFLICT DO NOTHING`, so it is idempotent).
- Deleting an auth user cascades the principal away; it can never leave an orphan or produce an
  unrelated principal.

## 3. Resolution helpers

```sql
public.principal_for_user(uuid) -> uuid     -- auth user  -> user principal
public.user_for_principal(uuid) -> uuid     -- user principal -> auth user
public.current_principal_id()   -> uuid     -- auth.uid()  -> user principal
```

All are `STABLE SECURITY DEFINER`, `search_path = public`, executable by `authenticated` and
`service_role` only.

## 4. Capability integration

```text
auth.uid() -> user principal -> role / grant / ownership -> capability
```

`public.can(p_principal, p_action, p_resource)` now resolves the acting user through
`public.principals` before evaluating roles, grants and ownership. Because user principals are
id-identical to auth users, every truth-table outcome is unchanged from Phase 7E. The resolver
accepts either a principal id or a raw auth user id during the transition, and falls back to the
raw id when no principal row exists — so no call site had to change.

Public overloads and grants are unchanged:

- `can(uuid, text, uuid)` — `service_role` only
- `can(text, uuid)` — `authenticated`, derives identity from `auth.uid()`

## 5. Security

- RLS enabled; the only policy is a self-scoped `SELECT` (`user_id = auth.uid()`).
- No `INSERT` / `UPDATE` / `DELETE` policy exists, so authenticated users cannot create a principal
  for another user, create a platform/partner principal, or delete one. Writes happen only through
  `service_role` and `SECURITY DEFINER` functions.
- `principals_immutable_trg` rejects any change to `id`, `type` or `user_id` — the user↔principal
  link is immutable, including for privileged writers, except via an explicit administrative
  migration that drops the trigger.
- CHECK constraints make an impersonating or malformed row impossible even server-side.

## 6. Principal ≠ Profile ≠ Role ≠ Grant

| Concept | Meaning | Table |
|---|---|---|
| Principal | identity / actor / owner | `principals` |
| Profile | public presentation (display name, username, avatar) | `profiles` |
| Role | durable authority (`admin`, `host`) | `user_roles` |
| Grant | scoped, expiring, quota-bearing permission | `host_authorizations` |

Presentation fields stay in `profiles`; nothing was moved.

## 7. Compatibility path (how the next migration is mechanical)

Current state:

```text
auth.users.id  ==  principals.id (type='user')
business rows still use owner_id / user_id / host_id / profile_id
```

Future ownership migration, per table:

```sql
ALTER TABLE public.<t> ADD COLUMN owner_principal_id uuid REFERENCES public.principals(id);
UPDATE public.<t> SET owner_principal_id = owner_id;   -- identity copy, no join
-- backfill trigger keeps both in sync, then policies switch, then the legacy column drops
```

Because ids are equal, both columns can coexist and be validated against each other before any
policy is rewritten.

## 8. Invariants

- one auth user → exactly one `user` principal (verified: 5 users, 5 user principals, 0 duplicates,
  0 unmapped, 0 id mismatches)
- Profile ≠ Principal, Role ≠ Principal, Grant ≠ Principal
- Principal is the future ownership/acting identity abstraction
- existing MVP ownership columns and RLS remain unchanged in this phase

## 9. Explicitly deferred

`owner_principal_id`, principal-aware resource authorization inside `can(...)`, Organization
principals, organization membership/roles, partner and platform ownership, RLS rewrites.
