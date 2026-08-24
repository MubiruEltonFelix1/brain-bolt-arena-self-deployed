# Brain Bolt MCP Architecture

**Phase 8B — MCP Quiz Lifecycle & Idempotency. Phase 8C — MCP Competition Lifecycle & Scheduling. Phase 8D — MCP League, Results & Multi-Step Orchestration.**

This document describes the MCP server (`mcp/`) as of Phase 8D: its trust
boundary, how it acts as an authorized Brain Bolt principal, the quiz,
competition and league/result toolset, the idempotency model, the bounded
orchestration model, the safe error contract, the ownership model, the
Competition/Session boundary, current limitations, and the roadmap.

Companion documents: [ARCHITECTURE_CONSTITUTION.md](ARCHITECTURE_CONSTITUTION.md),
[PRINCIPAL_MODEL.md](PRINCIPAL_MODEL.md), [CAPABILITY_MODEL.md](CAPABILITY_MODEL.md),
[ROADMAP.md](ROADMAP.md). Operational details (env vars, provider config, tool
arguments) live in [mcp/README.md](../mcp/README.md).

---

## 1. What MCP is — and is not

Three product surfaces share capability infrastructure but are not the same
thing:

| Surface | What it is | Where it lives |
| ------- | ---------- | -------------- |
| **MCP Tool** | A local stdio server that lets an LLM/agent call **Brain Bolt operations** through a small, validated tool surface (`generate_quiz`, `save_quiz`, the Phase 8B lifecycle tools, the Phase 8C competition tools, the Phase 8D league/result/orchestration tools). It is a *client of Brain Bolt*, acting as an authorized principal. | `mcp/` |
| **Brain Bolt AI** | The future native AI service layer: model gateway, prompt management, usage tracking, AI credits, cost controls, assistants. It does not exist yet (Phase 8E, PLANNED). | — |
| **Brain Bolt API** | The application's server surface (TanStack Start server functions, Supabase RLS + SECURITY DEFINER RPCs) that the web app, the MCP server, and eventually Brain Bolt AI all go through. Authorization is Postgres-side (`public.can(...)`, RLS). | `src/`, `supabase/migrations/` |

MCP does **not** bypass the API's authorization. It uses the same
`can(principal, action, resource)` resolver and the same data model. Service-role
database access is a *transport* privilege for the MCP server, not a grant of
authority for the agent behind it.

## 2. Trust boundary

- Transport is **local stdio only**. The server accepts connections exclusively
  from processes that launch it. There is no network listener, no remote MCP
  authentication, no public exposure.
- The server connects to Supabase with the **service role key** (`SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` in `mcp/.env`) so it can resolve principals and
  enforce capability server-side, exactly like a SECURITY DEFINER context.
- **There is no general-purpose database tool, no arbitrary SQL, and no raw
  table access exposed to the agent.** Every tool is a fixed, validated
  operation with its own capability gate.
- The service role key must never be exposed to arbitrary clients. `mcp/.env`
  is git-ignored; the server only runs on machines you trust.

Consequence of the boundary: *service-role access does not automatically mean
the agent is authorized to perform every Brain Bolt action.* Each protected
operation explicitly establishes its acting principal and evaluates the
relevant capability (Section 4).

## 3. Acting Principal

Every lifecycle tool takes an optional `actorId` — the uuid of an **auth user**
who is acting. When omitted, it falls back to `BRAINBOLT_DEFAULT_OWNER_ID` from
`mcp/.env`.

Resolution (`resolveActor` in `mcp/src/lifecycle.ts`):

1. `actorId` must be a well-formed uuid; a non-uuid or empty value is rejected.
2. The server looks up the actor's **user principal** in the `principals` table
   (`type = 'user'`, `user_id = actorId`). User principals are **id-identical**
   to auth users (Phase 7), so `principalId === actorId` for user actors, but
   the lookup still proves the actor exists.
3. An actor without a user principal is rejected with a precise error — the
   server never invents a principal.

**Impersonation is not possible through the tool surface**: an MCP caller
cannot submit an arbitrary principal id and act as someone else. The `actorId`
must be a real auth user's uuid with a real principal row, and every operation
is then gated through `can(principalId, ...)` — the same resolver the web app
uses. Passing someone else's uuid does not grant their authority; it is
rejected by the capability check unless that user actually owns the resource.

## 4. Capability enforcement

MCP has **no permission model of its own**. Before each protected operation it
calls the app's existing resolver:

```sql
SELECT public.can(p_principal, p_action, p_resource)
```

| Tool(s) | Capability |
| ------- | ---------- |
| `save_quiz` | `can(principal, 'quiz.create')` — the host capability (admin role, host role, or active host authorization) |
| `list_quizzes`, `get_quiz`, `update_quiz`, `archive_quiz`, `add_questions`, `update_question`, `remove_question`, `reorder_questions` | `can(principal, 'quiz.edit', quizId)` — the principal must **own** the quiz (`owner_principal_id`) **and** hold the host capability |
| `create_competition` | `can(principal, 'competition.create')` — the host capability |
| `list_competitions`, `get_competition`, `update_competition`, `schedule_competition`, `cancel_competition` | `can(principal, 'competition.manage', competitionId)` — the principal must **own** the competition (`owner_principal_id`) **and** hold the host capability |
| `list_leagues`, `get_league`, `get_league_standings`, `list_league_competitions`, `get_player_league_history` (non-self) | `can(principal, 'league.manage', leagueId)` **or** `league.visibility = 'public'` — the app's `can_view_league` rule (see Section 7) |
| `attach_competition_to_league`, `detach_competition_from_league` | `can(principal, 'competition.manage', competitionId)` **and** `can(principal, 'league.manage', leagueId)` — ownership of both resources, plus host capability |
| `get_competition_results` | `can(principal, 'competition.manage', competitionId)` — the owner+host of the completed competition |
| `orchestrate_competition_workflow` | `can(principal, 'competition.create')` for the plan, plus the per-step gates of the underlying tools (each step re-validates ownership of its resources) |

The Phase 7L `can()` rules apply verbatim:

- Admin implies host, but **ownership is explicit and separate from role**: an
  admin who does not own a quiz cannot edit it, and an admin who does not own a
  competition cannot manage it. The same applies to leagues: **an admin who
  owns nothing cannot read a private league through MCP** — the app's
  `can_view_league` has an `is_admin()` view-all branch, which the MCP surface
  deliberately omits (read-safety tightening: the agent never sees more than
  the acting principal).
- `quiz.delete` exists in the resolver but **no MCP tool uses it** — archiving
  is the only quiz removal path, and `cancel_competition` the only competition
  retirement path (Sections 5 and 6).
- Reads (`get_quiz`, `list_quizzes`, `get_competition`, `list_competitions`)
  require the same ownership gate, so the agent never sees private quizzes or
  competitions it is not permitted to manage, even though the service-role
  client could technically read them.

The failure mode is intentional: `assertCan` fetches the quiz first, so an
unauthorized or non-existent resource reports "quiz does not exist" only when it
truly does not exist, and a precise authorization error otherwise — never a
generic denial that leaks which quizzes exist. The league tools follow the same
pattern (`assertLeagueVisible` fetches the league first, so the failure mode is
"league does not exist" rather than a generic denial).

## 5. Quiz lifecycle tools

Lifecycle = **create → list → get → update → question management → archive**.

| Tool | Behavior |
| ---- | -------- |
| `save_quiz` (create) | Validated full quiz insert (zod + the same semantic gate as the editor/CSV import: media URLs, answer ranges, duplicate options, semicolon-free fields). Requires `quiz.create`. |
| `list_quizzes` | Compact metadata for the actor's own quizzes: id, title, description, owner, archived state, `isArena`, difficulty, question count, `created_at` (no `updated_at` column exists). Filters: `search` (title substring), `archived` (true/false/omitted), `difficulty`, `isArena`, `limit` (1–100). Never returns question payloads or answer keys. |
| `get_quiz` | Metadata + configuration + questions in position order (camelCase contract, all 10 question types round-tripped). Answer keys (`correctIndex`, `correct`, `correctNumber`, `acceptedAnswers`, map lat/lng, ordering items) are returned **only to the owning principal**; `includeAnswers=false` returns a redacted view. |
| `update_quiz` | **Patch-style**: only the supplied fields of `title`, `description` (null clears), `difficulty`, `timePerQuestionSec` change; everything else is preserved. No ownership fields are writable. |
| `archive_quiz` | Sets `archived_at` — soft delete, the **only** removal tool. No hard delete is exposed. Re-archiving is a no-op. |
| `add_questions` | Appends validated questions (same zod + semantic gate as generation). Cap: 30 per quiz. |
| `update_question` | Patches one question; the **merged** question must pass the full validation gate. Question types are immutable (remove + re-add to change type). Fields that do not apply to the type are ignored with a warning. A question belonging to a different quiz is refused. |
| `remove_question` | Removes one question and renumbers positions contiguously (like the app editor). Refuses to remove a quiz's last question. |
| `reorder_questions` | Rewrites 0-based positions from the **full** list of question ids; a partial, duplicate or mismatched set is rejected. |

**One question schema, one validation gate.** `add_questions` /
`update_question` reuse the exact model of the quiz editor, CSV import,
`generate_quiz` and `save_quiz` (`mcp/src/schema.ts` zod schema +
`mcp/src/validate.ts` semantic gate). There is no second question schema and no
way to write a question that the app's own validation would reject.

### Archived-quiz behaviour

- `list_quizzes` identifies archive state (`archived`, `archivedAt`) and can
  filter on it.
- `get_quiz` still works for the authorized owner (archived quizzes remain
  readable by their owner; admins need ownership like everyone else).
- `update_quiz` still applies patch edits for the owner (the app itself has no
  separate edit restriction on archived quizzes).
- `archive_quiz` is idempotent: archiving an already-archived quiz is a no-op
  with a warning.
- **No unarchive tool exists in the MCP toolset** — an archived quiz can only
  be brought back through the web app's own edit surface, never through MCP.

## 6. Competition lifecycle (Phase 8C)

The competition tools manage the **Competition business object** through the
existing Brain Bolt Competition engine. They never touch Sessions.

Lifecycle = **create (draft) → configure → schedule → inspect → cancel**.
`create_competition` produces `status='draft'` with the scheduling config
stored; `schedule_competition` validates a future start and flips
`draft|scheduled → scheduled` — the exact state the existing scheduler
consumes. The app's one-step "Schedule" form is the same end state as
create + schedule in MCP terms.

| Tool | Behavior |
| ---- | -------- |
| `list_competitions` | Compact metadata for the actor's own competitions: id, title, quiz (id + title), owner, mode, status, visibility, scheduled start, lobby duration, league/branding references, participant limit, session link, timestamps. Filters: `quizId`, `leagueId`, `status`, `mode`, `visibility`, `scheduledFrom`/`scheduledTo`, `limit` (1–100). No session runtime state. |
| `get_competition` | The full business state — identity, owner principal, quiz, mode, visibility, scheduling, league/branding references, lifecycle status, participant limits, metadata. The `status` column IS the safe summarized state (draft/scheduled/lobby_open/running/completed/cancelled), maintained by the existing engine — no session reads, no runtime control fields, no answer keys. |
| `create_competition` | Creates a **draft** from a quiz the actor owns (exists, owned, not archived). Explicit `mode` (hosted/arena/scheduled — the app's enum), explicit `visibility` (private/unlisted/public), future `scheduledStartAt`, `lobbyDurationSeconds` (30–3600, default 300). Optional league/branding references must belong to the actor. Owner is always the resolved actor — no arbitrary owner assignment. Requires `competition.create`. |
| `update_competition` | Patch-style, **draft/scheduled only** — lobby_open/running/completed/cancelled are protected (a lobby_open competition has a session linked; mutating quiz/league/branding/start would desync it). Mutable: title, description (null clears), visibility (explicit), scheduledStartAt (must stay future), lobbyDurationSeconds, leagueId (null detaches), brandingProfileId (null detaches), maxParticipants (null clears). |
| `schedule_competition` | The **scheduling handoff**: validates the mode is `scheduled` (the tick opens lobbies for mode 'scheduled' only), the status is draft/scheduled, the quiz is still usable, and the time is a future ISO timestamp (from the argument or the stored start — never coerced), then sets `status='scheduled' + scheduled_start_at`. The existing pg_cron scheduler picks it up. |
| `cancel_competition` | The app's exact cancellation: `status='cancelled' + cancelled_at`. Rejects completed competitions; cancelling an already-cancelled competition is a no-op. Sessions are never touched — the existing autonomous tick ends sessions of cancelled competitions; hosted/arena sessions are left alone, exactly like the app. |

### Competition/Session boundary

MCP may create and manage the Competition business object, nothing more. It
never reads or writes `sessions` — no `current_question_started_at`,
`current_question_revealed`, `paused_at`, question progression, reveal timing,
participant answers, runtime scoring, or autonomous-tick internals. The chain
is authoritative and never bypassed:

```text
MCP
  ↓
Competition
  ↓
existing scheduler (pg_cron → run_autonomous_scheduler → run_autonomous_tick)
  ↓
Session
  ↓
existing autonomous engine
```

### Scheduling handoff

`schedule_competition` only configures the competition row
(`status='scheduled'`, `scheduled_start_at`). From there the existing,
frozen engine takes over: the pg_cron job
(`run_autonomous_scheduler` → `run_autonomous_tick`, whose due-competition
predicate — `status='scheduled'`, no linked session, lobby window reached —
is the same one `list_due_competitions()` exposes) opens the lobby at
`scheduled_start_at − lobby_duration_seconds` via
`prepare_competition_session_internal` (creating the session with a join
code), and the sessions-side sync trigger moves the competition to
`running`/`completed` as the session advances. MCP does not create sessions
and does not run a second scheduler.

### League & branding compatibility

A competition may reference an existing `league_id` / `branding_profile_id`.
Both must belong to the acting principal (leagues additionally must not be
archived) — the same rule the app's form applies. MCP copies no branding
data, uploads no assets, changes no ownership, and computes no standings or
points. Competition completion flows into the existing
`competition_results`/standings machinery unchanged. Since Phase 8D the
league link is also managed by the dedicated `attach_competition_to_league`
and `detach_competition_from_league` tools (Section 7) instead of only the
`update_competition` patch field.

### Public vs private visibility

`visibility` is always explicit: `create_competition` requires it and
`update_competition` patches it — nothing ever flips visibility implicitly,
so an agent cannot accidentally make a private competition public.
`list_competitions`/`get_competition` are owner-scoped: public competitions
owned by other principals are not surfaced through MCP (the app's public
surfaces remain the discovery path for players).

### Competition idempotency and errors

The four write tools (`create_competition`, `update_competition`,
`schedule_competition`, `cancel_competition`) use the same
`mcp_idempotency_keys` mechanism as the quiz tools; a repeated request with
the same key and identical payload replays the stored envelope — no duplicate
competitions, no repeated side effects. Competition failures return
`{ ok:false, action, error:{code,message} }` as **normal results** (unlike
the 8B quiz tools, which throw) with codes
`unauthorized | not-found | validation | conflict | unknown` — see
Section 11.

## 7. League & results tools (Phase 8D)

The league tools read the **League business object** and its permanent
results, and mutate only the competition↔league link. The Session boundary
from Section 6 applies unchanged: `session_id` appears in projections only as
a value on the competition/result rows the app already exposes — the
`sessions` table itself is never queried, and no session runtime internals are
ever read.

### League-read authorization

Every league read applies the app's own `can_view_league` rule:

```text
can(principal, 'league.manage', leagueId)  OR  league.visibility = 'public'
```

- The acting principal must **own** the league (and hold the host capability
  — admins do not bypass ownership) OR the league must be public.
- **The app's `is_admin()` view-all branch is deliberately excluded.** An
  admin who owns nothing cannot read a private league through MCP — the agent
  must never see more than the corresponding Brain Bolt principal.
- `list_leagues` returns owned **plus** public leagues by default; the
  `ownerOnly` filter restricts it to owned leagues.

| Tool | Behavior |
| ---- | -------- |
| `list_leagues` | Compact metadata for leagues the actor can legitimately inspect: id, name, description, season, status, visibility, owner principal, archived state, competition count, timestamps. Filters: `search` (name substring), `archived` (true/false/omitted), `visibility`, `status`, `ownerOnly`, `limit` (1–100). No standings. |
| `get_league` | Full league metadata + owner principal + visibility + archived state + **scoring configuration** (`pointsFirst/Second/Third/Participation`) + season state (status) + compact overview: participant count, total/completed/upcoming competition counts (via the existing `get_league_overview` computation) + the upcoming competitions themselves (`{id,title,status,scheduledStartAt}` — never session ids). No standings — call `get_league_standings`. |
| `get_league_standings` | The **authoritative standings**: the app's existing `get_league_standings(league_id)` database function is the only computation — no points logic is recreated in TypeScript, no standings table is created or written. Returns rank, profile, display name, avatar, league points, competitions played, wins, podiums, cumulative score, average accuracy, in the app's exact tie-break order (points → wins → podiums → total score → average accuracy → display name). |
| `list_league_competitions` | The competitions attached to a league: id, title, status, mode, scheduled/completed times, visibility, and whether permanent results exist (`hasResults`). League owners see every attached competition; a non-owner of a public league sees only public competitions in the app-visible statuses (scheduled/lobby_open/running/completed). |
| `get_competition_results` | Permanent results of a **completed** competition, in final-rank order, from the app's `competition_results` store (written by the existing engine at competition end): player, rank, score, total participants, accuracy, completion time. Gated on `can(principal,'competition.manage',competition)` — only the owner+host. **Never answer data** — result rows carry no per-question information. Non-completed competitions have no results (`conflict`). |
| `get_player_league_history` | "How has this player performed in this league?" — per-competition entries from permanent results (competition, completion time, rank, score, accuracy) plus cumulative `leaguePoints`/`overallRank` read from the authoritative standings computation (never recomputed). Access: the league owner, a reader of a public league, or the player themselves (own results only — cumulative aggregates are omitted for private leagues the player does not own). |
| `attach_competition_to_league` | Attaches a **draft/scheduled** competition owned by the actor to a league owned by the actor (league must not be archived). Idempotent: attaching to the same league again is a no-op with a warning. Completed/lobby_open/running competitions are protected — attaching a completed competition would retroactively inject its results into the league's standings. |
| `detach_competition_from_league` | Removes a draft/scheduled competition from its league. Idempotent: detaching an unattached competition is a no-op with a warning. Completed competitions are protected — detaching one would retroactively remove its results from the standings. |

### Standings delegation — the service-role wrappers

The app's `get_league_standings` / `get_league_overview` are gated by
`can_view_league`, which reads `auth.uid()` / `is_admin()` from the request
JWT. The MCP server connects with the service role, which carries no JWT
principal, so the originals only pass for public leagues. Phase 8D adds two
service-role-only wrapper functions (`mcp_league_standings`,
`mcp_league_overview` in `supabase/migrations/20260818090000_...sql`) that:

1. take an **explicit principal** and enforce the same owner-or-public rule
   above (via `can(principal, 'league.manage', league)` or the visibility
   flag — checked **before** anything else);
2. impersonate that principal for the duration of the call with
   transaction-scoped `set_config('request.jwt.claims', ...)` /
   `set_config('request.jwt.claim.sub', ...)` so the originals' JWT-based
   gate passes for private leagues the principal owns (PostgREST runs each
   RPC in its own transaction, so the claim never leaks to other calls);
3. delegate to the existing functions — **no standings/points logic is
   duplicated anywhere**.

Security is preserved: the wrappers are `SECURITY DEFINER` with
`EXECUTE` granted to `service_role` only, and the authorization gate runs
before any impersonation, so a rejected caller never reaches it and an admin
without ownership still cannot read a private league (the impersonated role
is `authenticated`, so `is_admin()` resolves from the user's real roles —
the app's exact semantics).

### League mutation scope

MCP mutates leagues **only** through competition attachment. There is no
`create_league`, no roster management, no registration, no payouts, no best-N
scoring, no playoffs, no season-advance tool — those remain app-side / future
League work. Both mutation tools accept `idempotencyKey` (same
`mcp_idempotency_keys` mechanism, 24h TTL).

## 8. Orchestration (Phase 8D)

`orchestrate_competition_workflow` is the first controlled multi-step Brain
Bolt workflow. It executes **one bounded, explicit, declarative plan** —
never an instruction stream, never a loop, never a self-modifying plan,
never a background agent, never Session control.

### Workflow contract

| Workflow | Step sequence |
| -------- | ------------- |
| `create_attach_schedule` | `create_competition` → `attach_competition_to_league` → `schedule_competition` |
| `create_schedule` | `create_competition` → `schedule_competition` |

The plan is a flat object (quiz, title, mode `scheduled`, explicit
visibility, future `scheduledStartAt`, optional lobby/branding/participant
fields, `leagueId` when the workflow includes the attach step). The
competition is always created **without** a league; the attach step owns the
league link, so every step is independently retryable.

### Preflight vs execution vs partial completion

- **Preflight** validates the complete plan *before anything is mutated*:
  workflow shape, required fields per workflow, a non-empty `idempotencyKey`
  (required — the workflow must be retry-safe), the acting principal, the
  `competition.create` capability, quiz existence/ownership, league
  existence/ownership (attach workflows), a future start and `mode =
  'scheduled'`. Preflight failures return
  `{ ok:false, phase:"preflight", error:{code,message} }` with **nothing
  written**.
- **Execution** runs the steps in deterministic order, calling the existing
  operation functions internally. Live-state gates (archived flags, statuses)
  are deliberately NOT preflighted — each step re-checks them, because they
  can change between preflight and execution. A step failure stops the
  workflow immediately.
- **Partial completion** is reported explicitly — never hidden, never
  auto-compensated:

```jsonc
{
  "ok": true,
  "action": "orchestrate_competition_workflow",
  "status": "partial",
  "steps": [
    { "step": 1, "tool": "create_competition", "status": "success", "result": { "competitionId": "...", "status": "draft", "warnings": [] } },
    { "step": 2, "tool": "attach_competition_to_league", "status": "failed", "error": { "code": "validation", "message": "..." } }
  ],
  "competitionId": "...",
  "failedStep": { "step": 2, "tool": "attach_competition_to_league", "error": { "code": "validation", "message": "..." } }
}
```

No business objects are deleted to hide a partial failure. A step failing
with `not-found` on a resource created by an earlier step of the **same run**
is reported as `dependency-failed`. All steps succeeded →
`{ "ok": true, "status": "completed", ... }`.

### Orchestration idempotency

`idempotencyKey` is **required**. Each step claims a **derived** key
(`<workflowKey>#<n>:<tool>`) through the same `mcp_idempotency_keys`
mechanism as every other write tool:

- A retry with the same key + identical payload **replays the completed
  steps** (step 1 replays the same competitionId, so step 2's payload —
  derived from step 1's output — hashes identically) and **re-executes only
  the failed step**. No duplicate competitions, no duplicate attachments, no
  duplicate schedules.
- Reusing a key with a **different payload** is rejected with `conflict`.
- The orchestration entry point itself is not wrapped — only steps carry
  keys, which is what makes resume-after-partial-failure possible.

### Session boundary

The schedule step only configures the competition business object
(`status='scheduled'` + future start). The existing autonomous scheduler
opens the lobby and creates the session — MCP never does.

## 9. Idempotency model

**Mechanism.** A unique claim row in `mcp_idempotency_keys` (migration
`20260817060000_3f7c9d21-...sql`), claimed with a single INSERT. The claim lives
in Postgres, so it survives MCP server restarts — the exact timeout/retry
scenario it protects against. No distributed job system: one unique insert, one
UPDATE on success, one DELETE on failure.

**Key format and scope.** `idempotencyKey` is any stable string (1–200 chars)
chosen by the client for one logical request. The scope is the full request:
operation + payload hash (including the actor), so the same key can never
replay one actor's result to another.

**Behaviour of a repeated request** (same key + identical payload):

- The stored response is **replayed** (`replayed: true` in the envelope) and
  the write is **not** re-run — no duplicate quiz, no repeated update, no
  double insert.

**Behaviour of key misuse:**

- Same key + **different payload** → rejected with a precise error; the
  original result is untouched.
- Same key already **pending** (a concurrent request in flight) → the caller is
  told to retry shortly; the in-flight request wins the claim.
- A failed run **frees the key** so a retry can succeed.

**Expiry/retention.** Keys older than 24h are stale: a stale `completed` row is
re-claimed and executed fresh; a stale `pending` row (a server that died between
claim and completion — the exact crash scenario) is reclaimed rather than
wedged forever. Table access is service-role only (no RLS policies; the table is
unreachable by `anon`/`authenticated`).

**Coverage.** All write tools accept `idempotencyKey`: `save_quiz`,
`update_quiz`, `archive_quiz`, `add_questions`, `update_question`,
`remove_question`, `reorder_questions`, `create_competition`,
`update_competition`, `schedule_competition`, `cancel_competition`,
`attach_competition_to_league`, `detach_competition_from_league`, and
`orchestrate_competition_workflow` (where it is **required**, with derived
per-step keys — Section 8).

## 10. Ownership model

- **Principal owns Quiz.** `quizzes.owner_principal_id` is authoritative
  (Phase 7L). The legacy `owner_id` mirror is maintained by bidirectional DB
  triggers and is not the authorization primitive.
- **Principal owns Competition.** `competitions.owner_principal_id` is
  authoritative the same way; `create_competition` always derives the owner
  from the resolved actor.
- **Principal owns League.** `leagues.owner_principal_id` is authoritative the
  same way; league reads gate on it via `can(principal,'league.manage',id)`,
  and attach/detach require the actor to own **both** the competition and the
  league.
- **Profile is not ownership.** Ownership lives on `principals`, not profiles.
- **Question inherits ownership from Quiz.** Questions carry `quiz_id`; every
  question operation first verifies the question belongs to the supplied quiz
  and is gated by `can(principal, 'quiz.edit', quizId)` — question operations
  cannot escape quiz ownership. **Competition inherits from Quiz** the same
  way at creation: only the quiz's owner can build a competition from it.
- **Ownership cannot be changed through ordinary lifecycle operations.**
  `owner_principal_id`/`owner_id` are never writable through MCP tools. There
  is no transfer tool and no ownership change field on `update_quiz` or
  `update_competition`.
- **Organizations can eventually own a Quiz or Competition** without changing
  the MCP tool model: the resolver and `assertCan` operate on principals
  generically, so an organization principal would flow through the same
  `can()` gate.

## 11. Safe error contract

Every operation returns a **structured envelope**:

```jsonc
// success
{ "ok": true, "action": "update_quiz", "id": "...", "changed": { "title": true }, "warnings": [], "errors": [], "replayed": false }
// failure (thrown; surfaced by the MCP transport as an error result — 8B quiz tools)
{ "ok": false, "action": "update_quiz", "error": { "code": "unauthorized", "message": "...", "field": null } }
// failure (returned as a NORMAL result — 8C/8D tools)
{ "ok": false, "action": "schedule_competition", "error": { "code": "validation", "message": "..." } }
// preflight failure (returned as a NORMAL result — Phase 8D orchestration)
{ "ok": false, "action": "orchestrate_competition_workflow", "phase": "preflight", "error": { "code": "validation", "message": "..." } }
```

The 8C competition tools and all Phase 8D league/result/orchestration tools
return failures as normal structured results; the 8B quiz tools keep their
throw behavior. Both never leak internals.

Error vocabulary (Phase 8D):

- `unauthorized` — the acting principal failed a `can()` gate or ownership
  check.
- `not-found` — the resource does not exist (fetched first, so this is never
  a disguised denial).
- `validation` — a malformed argument, a past start time, an archived
  resource, an illegal status transition.
- `conflict` — the resource is in a state that forbids the operation
  (e.g. completed competition), or an idempotency key is reused with a
  different payload / is still pending.
- `dependency-failed` — an orchestration step failed with not-found on a
  resource created by an earlier step of the same run.
- `partial-failure` — the workflow status of a run whose later step failed
  after earlier steps succeeded (`status:"partial"`, per-step outcomes in
  `steps[]`).
- `unknown` — sanitized generic failure.

Error messages are written by the tool layer, never passed through from the
database: **no SQL errors, stack traces, service-role details, secrets, RPC
names, or internal table structure** reach the agent. This follows the same
safe-presentation principles as Phase 10A (`src/lib/errors.ts` classification:
unauthorized / auth-required / host-access / not-found / validation /
temporary / unknown), applied to the MCP surface. The raw database error is
discarded at the tool layer — this server does not persist technical error
details — so the agent only ever sees the safe message, and any diagnosis of a
failed call happens through the MCP client's own error output.

Validation failures state exactly what was wrong and that **nothing was
written** — a failed operation never leaves a partial write behind
(e.g. `add_questions` validates the whole batch before inserting). Orchestration
distinguishes three failure classes explicitly: **preflight failure**
(`phase:"preflight"`, nothing mutated), **execution failure** (a step failed;
reported per-step with `status:"partial"`), and **partial completion** (the
same structured partial result — the workflow never pretends to be atomic when
it is not).

## 12. Current limitations

- **MCP can now inspect and safely orchestrate Quiz → Competition → League
  workflows, but it is not yet a general autonomous Brain Bolt agent.** Every
  operation is a fixed, validated tool call; the orchestration tool executes
  one bounded, explicit workflow supplied by the caller — no "keep trying
  until successful", no loops, no self-modifying plans, no scheduled or
  background agents, no autonomous competition management.
- No hard delete — archiving is the only quiz removal path and
  `cancel_competition` the only competition retirement path (by design; the
  app's own delete stays app-only).
- No unarchive tool in the MCP surface — archived quizzes can only be brought
  back through the web app, never through MCP (by design).
- No ownership transfer (by design: ownership stays in the Principal system).
- `schedule_competition` is restricted to `mode='scheduled'` competitions —
  the autonomous tick opens lobbies for that mode only (the engine's rule,
  enforced at the tool boundary rather than silently stuck).
- No session controls of any kind: MCP cannot open a lobby early, advance
  questions, pause/resume, or manage participants — those stay in the app
  (`prepare_competition_session` RPC and the host screens).
- No competition delete; no standings/roster/points writes; no league
  *creation* (a league must exist in the app first); no roster management,
  registration, payouts, best-N scoring, playoffs or advanced seasons —
  those remain future League work.
- Schema gaps, surfaced in `get_capabilities` rather than invented by MCP:
  `quizzes` has no `visibility`, `published`, `category`, `branding` or
  `updated_at` columns — those concepts live on competitions/leagues/sessions.
- `update_quiz` supports the fields the app represents at quiz level: title,
  description, difficulty, timePerQuestionSec. Reveal/feedback configuration
  is per-question (`reveal_stages`, `point_value`, `double_points`,
  `time_limit_sec`) and editable through `update_question`.
- Single default owner (`BRAINBOLT_DEFAULT_OWNER_ID`) for non-actor calls; no
  remote transport, no per-client auth (local stdio is the trust boundary).
- The service-role wrappers (`mcp_league_standings`, `mcp_league_overview`)
  depend on the Phase 8D migration being applied — `bun scripts/migrate.mjs`
  reports them as applied markers.

## 13. Roadmap

- **8C — MCP Competition Lifecycle ✅ COMPLETE**: create (draft) → configure →
  schedule (handoff to the existing pg_cron scheduler) → inspect → cancel,
  gated through `competition.create` / `competition.manage`, idempotent via
  the shared key table, session boundary enforced.
- **8D — MCP League, Results & Multi-Step Orchestration ✅ COMPLETE**: league
  discovery/inspection (`list_leagues`, `get_league`), authoritative standings
  via the existing database computation, permanent-result inspection
  (`get_competition_results`, `get_player_league_history`), safe league
  mutations (`attach_competition_to_league`, `detach_competition_from_league`)
  and the first bounded workflow (`orchestrate_competition_workflow`:
  create → attach → schedule / create → schedule) with per-step derived
  idempotency keys and explicit partial-failure reporting.
- **8E — Brain Bolt AI foundation (NEXT)**: the native in-app AI service
  layer — model gateway, prompt management, usage tracking, AI credits, cost
  controls — then richer agent planning on top of the bounded workflow
  contract.
- **8F+ — AI Question & Quiz Builder / AI Assistant**: the product surfaces
  built on 8E.

The lifecycle tools deliberately reuse the Phase 8B patterns — principal
resolution, `can()` enforcement, structured envelopes, idempotency keys — so
later phases extend the toolset without inventing parallel machinery.
