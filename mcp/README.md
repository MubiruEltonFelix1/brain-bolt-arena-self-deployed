# Brain Bolt MCP Server

An [MCP](https://modelcontextprotocol.io) server that connects Brain Bolt Arena to **any LLM** (via a single OpenAI-compatible endpoint) and automatically generates quizzes in the app's native format.

- `generate_quiz` — the server calls your configured LLM to write a complete quiz on any topic.
- `validate_quiz` — checks quiz JSON against Brain Bolt's format (per-question errors + warnings).
- `to_csv` — serializes quiz JSON to the editor's CSV import template (validates first).
- `save_quiz` — writes a generated quiz straight into the app's Supabase database (opt-in).
- `get_capabilities` — returns the supported question types, limits, media URL policy, CSV template, lifecycle tools, ownership rules and idempotency requirements.
- **Lifecycle (Phase 8B)** — `list_quizzes`, `get_quiz`, `update_quiz`, `archive_quiz`, `add_questions`, `update_question`, `remove_question`, `reorder_questions`: inspect, update and safely manage existing quizzes.
- **Competitions (Phase 8C)** — `list_competitions`, `get_competition`, `create_competition`, `update_competition`, `schedule_competition`, `cancel_competition`: create, configure, schedule, inspect and cancel competitions on the existing Brain Bolt Competition engine. No competition/league orchestration yet.

It runs locally as a stdio server. **Bwat is the only client connected to it for now** — exercised through the SDK test client in this repo (`bun run smoke`).

## Quickstart

```bash
cd mcp
cp .env.example .env   # then fill in your LLM config
bun install
bun run dev
```

That starts the server on stdio (it prints a one-line banner to stderr). It will sit there until an MCP client connects.

### Provider config (pick one)

| Provider          | `LLM_BASE_URL`                   | `LLM_MODEL` example       | Key         |
| ----------------- | -------------------------------- | ------------------------- | ----------- |
| OpenAI            | `https://api.openai.com/v1`      | `gpt-4o-mini`             | required    |
| Anthropic         | `https://api.anthropic.com/v1`   | `claude-sonnet-4-5`       | required    |
| Groq              | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | required    |
| DeepSeek          | `https://api.deepseek.com/v1`    | `deepseek-chat`           | required    |
| OpenRouter        | `https://openrouter.ai/api/v1`   | `openai/gpt-4o-mini`      | required    |
| Ollama (local)    | `http://localhost:11434/v1`      | `llama3.2`                | leave blank |
| LM Studio (local) | `http://localhost:1234/v1`       | any loaded model          | leave blank |

Any OpenAI-compatible `/chat/completions` endpoint works. The server requests JSON output and falls back to plain text for endpoints that reject `response_format`.

## Connecting clients

**Bwat (current — the only client).** The server is exercised through the MCP SDK test client in this repo: `bun run smoke` from `mcp/`. It boots the server over stdio and calls every tool. No external client (Claude Desktop, Cursor, ...) is configured to launch the server.

Access control is inherent to the transport: stdio servers only accept connections from processes that launch them, so nothing needs to be locked down while this stays local. When you're ready to open it up to other clients, the standard configs apply — Claude Desktop's `claude_desktop_config.json` and Cursor's `.cursor/mcp.json` both take an `mcpServers` block pointing `command: bun, args: [run, src/index.ts]` with `cwd` set to this folder.

## Tools

### `generate_quiz`

Ask the configured LLM to write a quiz. Args: `topic` (required), `questionCount` (1-30, default 10), `questionTypes` (default: mcq, true_false, number, ordering, type, map_pin), `difficulty` (easy|medium|hard), `language`, `title`, `description`, `timeLimitSec` (quiz-level, 5-120), `pointValue`, `includeFeedback`.

Returns `{ quiz, csv, validation, attempts, requestedCount, generatedCount, exactMatch }`. The quiz is validated; on failure the LLM is re-prompted once with the specific errors. `exactMatch` is `false` (with a `questionCount` warning in `validation.warnings`) whenever the LLM returns a different number of questions than requested — the mismatch is never silent. Example prompt in any MCP client:

> "Generate a 10-question medium quiz about Ugandan geography, mix in a map_pin question."

### `validate_quiz`

Takes `quiz` JSON, returns a report of per-question errors and warnings. Errors always carry the affected `questionIndex`.

### `to_csv`

Takes `quiz` JSON, returns the CSV string for the app's quiz editor → **Import CSV**. Runs the same full semantic validation as `save_quiz` first: an invalid quiz is rejected with a structured report and no CSV is emitted — if MCP says the quiz is valid and exports it, the app's importer accepts it.

### `save_quiz`

Inserts the quiz + questions into Supabase using the **service role key**. Requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and an owner: pass `ownerId` (the uuid of a user in `auth.users`) or set `BRAINBOLT_DEFAULT_OWNER_ID` in `mcp/.env`. Returns `{ ok, action, id, quizId, questionCount, changed, warnings, errors, replayed }`; the quiz shows up in the app's `/dashboard`.

Before writing anything, `save_quiz`:

- re-runs the full semantic validation (hard errors on media questions without a real https URL, out-of-range answers, etc.) — invalid quizzes are rejected with a per-question report,
- verifies the owner has a user principal (`principals` table, created 1:1 with auth users at signup) and fails with a precise error if not,
- verifies the owner passes the app's own capability resolver `can(principal, 'quiz.create')` — the host capability (admin role, host role, or active host authorization), the same gate as the app's "quizzes host only write" RLS policy.

`save_quiz` accepts an optional `idempotencyKey`: a retried call with the same key and identical payload replays the stored result instead of creating a duplicate quiz.

> **Security note.** The service role key bypasses RLS and can write rows as any owner. Keep `mcp/.env` out of git (it is git-ignored) and only run the server on machines you trust. If you don't need DB writes, leave `SUPABASE_*` unset — everything else still works.
>
> **Trust boundary.** MCP is a trusted development/server-side integration at this stage: local stdio transport only, service-role writes, no remote authentication. Do not expose this server over a network transport without adding authentication and an owner allowlist.

### Lifecycle tools (Phase 8B)

The lifecycle tools manage existing quizzes. Every one of them:

- takes an optional `actorId` (uuid of the acting auth user; defaults to `BRAINBOLT_DEFAULT_OWNER_ID`) and **resolves the acting principal** through the `principals` table — an actor without a user principal is rejected,
- enforces capability through the app's **existing** `public.can(principal, action, resource)` resolver (service-role RPC). There is no parallel MCP permission system: reads, updates, archives and question edits all require `can(principal, 'quiz.edit', quizId)` — the principal must **own** the quiz (`owner_principal_id`, Phase 7L principal-only ownership) and hold the host capability. Admins are hosts but still must own the resource.
- returns a structured envelope: `{ ok, action, id, changed, warnings, errors }` (plus `replayed` when an idempotency key was replayed).

| Tool                 | Purpose                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list_quizzes`       | Compact metadata for the actor's own quizzes (no question payloads, no answer keys). Filters: `search` (title substring), `archived` (true/false/omitted), `difficulty`, `isArena`, `limit` (1-100). |
| `get_quiz`           | Full quiz: metadata + questions in the camelCase contract, in position order. Answer keys are returned **only to the owning principal**; `includeAnswers=false` strips them. |
| `update_quiz`        | Patch-style: only the supplied fields of `title`, `description` (null clears), `difficulty`, `timePerQuestionSec` change; everything else is preserved. |
| `archive_quiz`       | Soft-delete via `archived_at` — the **only** removal tool. There is no hard delete; "delete this quiz" should be answered with archive. Re-archiving is a no-op. |
| `add_questions`      | Appends validated questions (same zod + semantic gate as generation: media URLs, answer ranges, duplicates, semicolon-free fields). Cap: 30 per quiz. |
| `update_question`    | Patches one question; the **merged** question must pass the full validation gate. Question types are immutable (remove + re-add to change type). Fields that don't apply to the type are ignored with a warning. |
| `remove_question`    | Removes one question and renumbers positions. Refuses to remove a quiz's last question. |
| `reorder_questions`  | Rewrites 0-based positions from the full list of question ids; a partial or mismatched id set is rejected. |

Schema gaps (exposed in `get_capabilities`, not invented by MCP): `quizzes` has **no** `visibility`, `published`, `category`, `branding` or `updated_at` columns — visibility/branding live on competitions/leagues/sessions. `created_at` is the only timestamp.

#### Idempotency

All write tools (`save_quiz`, `update_quiz`, `archive_quiz`, `add_questions`, `update_question`, `remove_question`, `reorder_questions`) accept `idempotencyKey`. The key is claimed as a row in `mcp_idempotency_keys` (migration `20260817060000_...sql`); a repeated request with the same key and an **identical** payload replays the stored result instead of re-running the write — safe across server restarts, which is exactly the timeout/retry scenario this protects against. Reusing a key with a **different** payload is rejected with a precise error; failed runs free the key so a retry can succeed; keys expire after 24h.

### Competition tools (Phase 8C)

The competition tools manage the **Competition business object** on the existing engine. They never read or write sessions — the `status` column is the safe summarized state (draft/scheduled/lobby_open/running/completed/cancelled), and the existing pg_cron scheduler (not MCP) turns a scheduled competition into a session at lobby time.

Every competition tool:

- takes an optional `actorId` (defaults to `BRAINBOLT_DEFAULT_OWNER_ID`), resolves the acting principal through `principals`, and enforces the app's existing `can(...)` resolver: `competition.create` (host capability) for creation, `competition.manage` (own **and** host — no admin bypass) for everything else,
- validates that quiz, league and branding references are the actor's own (league additionally not archived),
- returns a structured envelope `{ ok, action, competitionId, status, changed, warnings, errors, replayed }` on success — and, unlike the 8B quiz tools, failures come back as **normal results** `{ ok:false, action, error:{code,message} }` with codes `unauthorized | not-found | validation | conflict | unknown` (never raw SQL/stack traces),
- never accepts an arbitrary owner: `owner_principal_id` always comes from the resolved actor.

| Tool | Purpose |
| ---- | ------- |
| `list_competitions` | Compact metadata for the actor's own competitions (no session state). Filters: `quizId`, `leagueId`, `status`, `mode`, `visibility`, `scheduledFrom`/`scheduledTo` (ISO), `limit` (1-100). |
| `get_competition` | Full business state: identity, owner, quiz, mode, visibility, scheduling, league/branding refs, lifecycle status, participant limits. No session runtime fields. |
| `create_competition` | Creates a **draft** from an owned, non-archived quiz. Requires explicit `mode` (`hosted`/`arena`/`scheduled` — the app's enum), explicit `visibility` (`private`/`unlisted`/`public`) and a future `scheduledStartAt`. Optional `leagueId`/`brandingProfileId`/`maxParticipants`/`lobbyDurationSeconds` (30-3600, default 300). |
| `update_competition` | Patch-style, **draft/scheduled only** (lobby_open has a session linked; running/completed/cancelled are protected). `null` detaches league/branding and clears description/maxParticipants. `scheduledStartAt` must stay in the future. |
| `schedule_competition` | The handoff: sets `status='scheduled'` + a future `scheduled_start_at` (argument or stored — never coerced). Only `mode='scheduled'` competitions can be scheduled (the tick opens lobbies for that mode only). The pg_cron scheduler opens the lobby at start − lobby duration; MCP never creates sessions. |
| `cancel_competition` | The app's exact cancellation (`status='cancelled'` + `cancelled_at`). Completed competitions are protected; re-cancelling is a no-op. Sessions are never touched — the autonomous tick cleans up sessions of cancelled competitions; hosted/arena sessions are left alone, like the app. |

There is **no** `delete_competition` — cancellation is the retirement path (the app's hard delete stays app-only).

#### Idempotency

`create_competition`, `update_competition`, `schedule_competition` and `cancel_competition` accept `idempotencyKey` with the exact same semantics as the quiz tools (shared `mcp_idempotency_keys` table, 24h expiry): a repeated create replays the same `competitionId` and never duplicates the row; repeated schedule/cancel never repeat side effects.

## Question types

| Type                                   | CSV name          | Answer fields                                                                                                                                                                                                                          |
| -------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcq`                                  | `multiple_choice` | `options` (2-6), `correctIndex` (0-based)                                                                                                                                                                                              |
| `true_false`                           | `true_false`      | `correct` (boolean)                                                                                                                                                                                                                    |
| `number`                               | `closest_number`  | `correctNumber`, `min`, `max`, `tolerance?`, `format?`, `unit?`                                                                                                                                                                        |
| `map_pin`                              | `map_pin`         | `lat`, `lng`, `maxDistanceKm?` (default 5000)                                                                                                                                                                                          |
| `type`                                 | `text`            | `acceptedAnswers`                                                                                                                                                                                                                      |
| `feedback`                             | `free_text`       | none (opinion, 0 points)                                                                                                                                                                                                               |
| `ordering`                             | `ordering`        | `items` (2-8, in correct order)                                                                                                                                                                                                        |
| `image_mcq` / `image_reveal` / `audio` | same              | like mcq + `imageUrl` / `audioUrl` — **media types require a real https URL**; missing, `http://`, or reserved example-domain URLs (`example.com` etc.) are hard validation errors because the LLM can't reliably invent working media |

The CSV serializer emits the editor's exact 25-column template; `option_e/option_f` columns are appended automatically for questions with more than 4 options.

## Development

```bash
bun run test    # unit tests + typecheck
bun run smoke   # end-to-end stdio smoke test (generate_quiz needs a real key or local Ollama)
```

The storage conventions and question registry are mirrored in `src/schema.ts` and `src/question-types.ts` from the app's source of truth (`src/routes/quizzes.$id.tsx` CSV importer, `src/lib/question-registry.ts`). Keep them in sync when the app's question types change.
