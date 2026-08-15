# Brain Bolt MCP Server

An [MCP](https://modelcontextprotocol.io) server that connects Brain Bolt Arena to **any LLM** (via a single OpenAI-compatible endpoint) and automatically generates quizzes in the app's native format.

- `generate_quiz` — the server calls your configured LLM to write a complete quiz on any topic.
- `validate_quiz` — checks quiz JSON against Brain Bolt's format (per-question errors + warnings).
- `to_csv` — serializes quiz JSON to the editor's CSV import template (validates first).
- `save_quiz` — writes a generated quiz straight into the app's Supabase database (opt-in).
- `get_capabilities` — returns the supported question types, limits, media URL policy, CSV template and owner requirements.

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

Inserts the quiz + questions into Supabase using the **service role key**. Requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and an owner: pass `ownerId` (the uuid of a user in `auth.users`) or set `BRAINBOLT_DEFAULT_OWNER_ID` in `mcp/.env`. Returns `{ quizId, questionCount }`; the quiz shows up in the app's `/dashboard`.

Before writing anything, `save_quiz`:

- re-runs the full semantic validation (hard errors on media questions without a real https URL, out-of-range answers, etc.) — invalid quizzes are rejected with a per-question report,
- verifies the owner has a user principal (`principals` table, created 1:1 with auth users at signup) and fails with a precise error if not.

> **Security note.** The service role key bypasses RLS and can write rows as any owner. Keep `mcp/.env` out of git (it is git-ignored) and only run the server on machines you trust. If you don't need DB writes, leave `SUPABASE_*` unset — everything else still works.
>
> **Trust boundary.** MCP is a trusted development/server-side integration at this stage: local stdio transport only, service-role writes, no remote authentication. Do not expose this server over a network transport without adding authentication and an owner allowlist.

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
