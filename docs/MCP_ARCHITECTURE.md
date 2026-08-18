# Brain Bolt MCP Architecture

**Phase 8B — MCP Quiz Lifecycle & Idempotency. Phase 8C — MCP Competition Lifecycle & Scheduling.**

This document describes the MCP server (`mcp/`) as of Phase 8C: its trust
boundary, how it acts as an authorized Brain Bolt principal, the quiz and
competition lifecycle toolset, the idempotency model, the safe error contract,
the ownership model, the Competition/Session boundary, current limitations, and
the roadmap toward League/Results orchestration.

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
| **MCP Tool** | A local stdio server that lets an LLM/agent call **Brain Bolt operations** through a small, validated tool surface (`generate_quiz`, `save_quiz`, the Phase 8B lifecycle tools). It is a *client of Brain Bolt*, acting as an authorized principal. | `mcp/` |
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

The Phase 7L `can()` rules apply verbatim:

- Admin implies host, but **ownership is explicit and separate from role**: an
  admin who does not own a quiz cannot edit it, and an admin who does not own a
  competition cannot manage it.
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
generic denial that leaks which quizzes exist.

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
frozen engine takes over: `list_due_competitions()` feeds the pg_cron tick,
which opens the lobby at `scheduled_start_at − lobby_duration_seconds` via
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
`competition_results`/standings machinery unchanged.

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
Section 9.

## 7. Idempotency model

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
`remove_question`, `reorder_questions`.

## 8. Ownership model

- **Principal owns Quiz.** `quizzes.owner_principal_id` is authoritative
  (Phase 7L). The legacy `owner_id` mirror is maintained by bidirectional DB
  triggers and is not the authorization primitive.
- **Principal owns Competition.** `competitions.owner_principal_id` is
  authoritative the same way; `create_competition` always derives the owner
  from the resolved actor.
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

## 9. Safe error contract

Every operation returns a **structured envelope**:

```jsonc
// success
{ "ok": true, "action": "update_quiz", "id": "...", "changed": { "title": true }, "warnings": [], "errors": [], "replayed": false }
// failure (thrown; surfaced by the MCP transport as an error result — 8B quiz tools)
{ "ok": false, "action": "update_quiz", "error": { "code": "unauthorized", "message": "...", "field": null } }
// failure (returned as a NORMAL result — 8C competition tools)
{ "ok": false, "action": "schedule_competition", "error": { "code": "validation", "message": "..." } }
```

The 8C competition tools return failures as normal structured results with
codes `unauthorized | not-found | validation | conflict | unknown`; the 8B
quiz tools keep their throw behavior. Both never leak internals.

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
(e.g. `add_questions` validates the whole batch before inserting).

## 10. Current limitations

- **MCP can now manage the Quiz and Competition business lifecycles, but it
  does not yet orchestrate Leagues, Results/Analytics, or complete multi-step
  Brain Bolt workflows.**
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
- No competition delete, no standings/roster/points writes, no league
  orchestration.
- Schema gaps, surfaced in `get_capabilities` rather than invented by MCP:
  `quizzes` has no `visibility`, `published`, `category`, `branding` or
  `updated_at` columns — those concepts live on competitions/leagues/sessions.
- `update_quiz` supports the fields the app represents at quiz level: title,
  description, difficulty, timePerQuestionSec. Reveal/feedback configuration
  is per-question (`reveal_stages`, `point_value`, `double_points`,
  `time_limit_sec`) and editable through `update_question`.
- Single default owner (`BRAINBOLT_DEFAULT_OWNER_ID`) for non-actor calls; no
  remote transport, no per-client auth (local stdio is the trust boundary).

## 11. Roadmap

- **8C — MCP Competition Lifecycle ✅ COMPLETE**: create (draft) → configure →
  schedule (handoff to the existing pg_cron scheduler) → inspect → cancel,
  gated through `competition.create` / `competition.manage`, idempotent via
  the shared key table, session boundary enforced.
- **8D — MCP League & Results Orchestration** (NEXT): connect Quiz →
  Competition → League → Results → Standings.
- **8E+ — Brain Bolt AI foundation**: the native service layer (model gateway,
  prompts, usage, credits), then the assistant surfaces.

The lifecycle tools deliberately reuse the Phase 8B patterns — principal
resolution, `can()` enforcement, structured envelopes, idempotency keys — so
later phases extend the toolset without inventing parallel machinery.
