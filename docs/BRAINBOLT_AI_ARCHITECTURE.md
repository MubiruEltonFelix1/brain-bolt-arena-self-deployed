# Brain Bolt — AI Architecture (Phase 8E + 8F)

> The first user-facing Brain Bolt AI capability: **AI Question & Quiz Builder**.
> Server-side AI service + inline panel in the Quiz Editor.

This document describes the architecture shipped in Phase 8E (AI service foundation) and Phase 8F (the AI Question Builder). It is the entry point for anyone touching AI in Brain Bolt — read this before changing the AI service or the prompt registry.

## Table of contents

1. What it is
2. Trust boundary
3. Provider model
4. End-to-end flow (UI → DB)
5. Request structure
6. Generation flow
7. Validation pipeline
8. Draft model
9. Human review
10. Saving
11. Authorization
12. Usage logging & cost
13. Error handling
14. Limitations
15. What is out of scope
16. Related docs

---

<a id="what-it-is"></a>
## 1. What it is

A creator opens a normal Brain Bolt Quiz, describes the questions they want, and receives a validated AI-generated **draft**. The draft is reviewed and edited in the existing editor; accepted questions are inserted into the same `questions` table as human-written ones, with `is_playable=false` by default.

The AI is an **assistant**, not the authority — every saved question passes through the human review surface and is never silently published.

This is the **first user-facing AI capability** in Brain Bolt. Future capabilities (player coach, lecturer assistant, competition analytics) will share the same `BrainBoltAiService` and `ai_usage_log` infrastructure.

---

<a id="trust-boundary"></a>
## 2. Trust boundary

```text
Browser
   │ (Authorization: Bearer <jwt>)
   ↓
TanStack Start server function
   ↓
requireSupabaseAuth middleware (validates JWT, attaches userId)
   ↓
supabase.rpc("can", { p_action: "ai.generate_questions", p_resource: <quizId> })
   ↓
BrainBoltAiService.generateQuestions()
   ↓
PROMPT_VERSIONS.generate_questions_v1 (server-side only)
   ↓
AiProvider.generate()  ── BedrockDeepSeekProvider ──→ AWS Bedrock (us.deepseek.r1-v1:0)
   ↓
extractJsonObject + validateQuiz
   ↓
recordUsage() INSERT into ai_usage_log (service_role only)
   ↓
Typed envelope → browser
```

Provider names, model IDs, AWS keys, and AWS regions are **never** exposed to the browser. The browser only sees the friendly-message mapping from `AiError.code`.

---

<a id="provider-model"></a>
## 3. Provider model

The `AiProvider` interface (in `src/lib/ai/types.ts`) abstracts the model gateway. Today exactly one provider ships:

- **` BedrockDeepSeekProvider`** — uses `@aws-sdk/client-bedrock` `InvokeModelCommand` against `us.deepseek.r1-v1:0` (DeepSeek R1 via the cross-region inference profile). Reasoning tokens (`<think>...</think>`) are stripped from the output before JSON parsing. Pricing: $1.35 input / $5.40 output per 1M tokens (verified against `aws.amazon.com/bedrock/pricing/` DeepSeek-R1 example).

Future providers (OpenAI, Anthropic direct, self-hosted) drop in as new implementations of `AiProvider`. Selection is server-side via `BRAINBOLT_AI_PROVIDER` and `BRAINBOLT_AI_MODEL` env vars.

The `AiProvider` interface deliberately hides provider names from the caller — the service sees only `modelId`, `pricing`, and `generate(prompt)`.

---

<a id="end-to-end-flow"></a>
## 4. End-to-end flow (UI → DB)

```text
Creator
   ↓ opens /quizzes/$id
Editor (src/routes/quizzes.$id.tsx)
   ↓ clicks "AI Generate Questions"
AiQuestionBuilderPanel (src/components/quiz/AiQuestionBuilderPanel.tsx)
   ↓ submits structured + optional natural-language request
generateQuestions serverFn (src/lib/api/ai.functions.ts)
   ↓
requireSupabaseAuth → can('ai.generate_questions', quizId)
   ↓
BrainBoltAiService.generateQuestions()
   ↓
Bedrock DeepSeek R1 → response
   ↓
extractJsonObject (strips reasoning tokens)
   ↓
validateQuiz (shared with mcp/src/validate.ts)
   ↓
recordUsage → ai_usage_log row
   ↓
Typed envelope → panel
   ↓ renders editable draft cards
Creator edits, regenerates individual questions, excludes
   ↓ clicks "Add N to Quiz"
supabase.from("questions").insert(rows with is_playable=false)
   ↓
RLS-protected INSERT → questions table
   ↓
Existing editor per-question cards render the new rows
Creator toggles is_playable=true on questions they want live
   ↓
Existing Quiz save flow persists as normal
```

---

<a id="request-structure"></a>
## 5. Request structure

`generateQuestions` input (zod-validated server-side):

```ts
{
  quizId: string;        // uuid
  topic: string;         // 1..200 chars, trimmed
  count: number;         // 1..20 (MAX_GENERATION_COUNT)
  difficulty: "easy" | "medium" | "hard";
  types: SupportedAiType[];  // 1..7 of: mcq, true_false, number, type, ordering, feedback, map_pin
  instructions?: string; // 1..500 chars, optional natural-language note
  excludeExistingTopicDuplication?: boolean;
}
```

Server enforces:

- `count <= 20` (returns `over_limit` before any AI call)
- `types` only contains members of `SUPPORTED_AI_TYPES`
- `instructions` ≤ 500 chars
- `quizId` is a UUID
- Authorization via `can('ai.generate_questions', quizId)` (see §11)

---

<a id="generation-flow"></a>
## 6. Generation flow

1. Server composes `system` + `user` prompt from `PROMPT_VERSIONS.generate_questions_v1`. The system prompt explicitly forbids chain-of-thought, markdown fences, and preamble — the model is told to output JSON only.
2. Server renders the prompt into the DeepSeek-R1 chat template: `<system>\n\nHuman: <user>\n\nAssistant:`.
3. Provider calls `InvokeModelCommand` with `temperature: 0.4`, `top_p: 0.9`, `max_tokens: 8000`.
4. Server strips any `<think>...</think>` block from the response (defensive — R1 occasionally emits one despite instructions).
5. Server extracts the JSON object from the (possibly prose-surrounded) response.
6. Server runs `validateQuiz` on the result. If validation fails, returns `validation_failed`.
7. Server checks `count` matches and surfaces a `count_mismatch` warning if not.
8. Server records a row in `ai_usage_log` with the outcome.

For **regenerate** (one question), the same flow applies with `regenerate_question_v1` and a `max_tokens: 2000` budget. Same-type enforcement is the additional gate.

---

<a id="validation-pipeline"></a>
## 7. Validation pipeline

AI output goes through three validation gates:

1. **Provider-specific parse** (`PROMPT_VERSIONS.generate_questions_v1.parse`) — shape check: did the model emit `{ questions: [...] }`?
2. **Shared `validateQuiz`** (`src/lib/quiz/validate.ts`) — same zod schema + semantic rules as `mcp/src/validate.ts`. Includes media-URL policy (https only, no `example.*` placeholders, missing-URL is an error), ordering uniqueness, `acceptedAnswers` no `;`, etc.
3. **Same-type check** (regenerate only) — the new question must be the same `type` as the original it replaces.

AI output is **never** written to the production `questions` table without passing all three gates.

The `src/lib/quiz/validate.ts` and `mcp/src/validate.ts` files are intentionally duplicated (per Phase 8F D3 decision). A drift test (`src/lib/quiz/sync.test.ts`) loads both and asserts they agree on representative inputs. Future Phase 17 / 8G work may promote them to a shared workspace package.

---

<a id="draft-model"></a>
## 8. Draft model

Drafts are **client state** — no separate draft table, no persistence beyond the panel's local React state.

When the creator clicks **Add N to Quiz**, the panel:

1. Collects the kept (non-removed, non-excluded) questions.
2. Runs `validateQuiz` once more on the client (defense in depth).
3. Maps each question to its DB row via `questionToDbRow(q, position)`.
4. Inserts via the existing `supabase.from("questions").insert(...)` path with `is_playable=false`.
5. Appends the inserted rows to the editor's local state so they render in the existing per-question cards.
6. Shows a toast: `N AI-generated questions added (excluded from play until you enable them).`
7. Resets the panel state and collapses the panel.

The creator then toggles `is_playable=true` per question via the existing editor toggle. Saving the quiz persists everything normally.

**Trade-off acknowledged**: drafts are lost on page refresh. This is acceptable for the first AI feature and aligns with the editor's "no draft state" convention. Phase 11 (UX Constitution) may revisit if persistence becomes a real complaint.

---

<a id="human-review"></a>
## 9. Human review

The AI is an assistant, not the authority. Every generated question must pass through the human-review surface before it can be played:

- The editor renders the **AI-generated draft — review before publishing** badge in volt green at the top of the panel.
- Per-question cards show the question type icon + accent color (consistent with the existing per-question editor).
- Each card has explicit `Regenerate`, `Remove`, and `Exclude from play` controls.
- **Add to Quiz** is the only way to persist draft questions — clicking it requires the creator to commit to the draft.
- Inserted rows have `is_playable=false` and are excluded from any live session that the creator starts before enabling them.

No mechanism exists for AI content to bypass this path. The provider cannot write to the database directly (the `BrainBoltAiService` does not take a database client in its public surface).

---

<a id="saving"></a>
## 10. Saving

AI-generated questions persist through the **existing** quiz/question write path. The AI panel uses the same `supabase.from("questions").insert(...)` pattern the editor already uses for manual additions. RLS, ownership, and the Principal-aware `can(...)` resolver apply unchanged.

The AI service does **not** write to the database itself. The chain is:

```text
AI draft (client state)
  ↓
Human review
  ↓
Existing supabase INSERT (RLS + ownership)
  ↓
Existing editor save flow
  ↓
Database (questions table)
```

This preserves all existing ownership, RLS, Principal and capability rules. There is no AI-specific write path.

---

<a id="authorization"></a>
## 11. Authorization

The `ai.generate_questions` capability is added to `public.can(...)` in `supabase/migrations/20260822120000_phase_8e_ai_question_builder.sql`. It sits as a new `ELSIF p_action LIKE 'ai.%' THEN` arm inside the existing IF chain in `20260816124500_phase_7l_authorization_completion.sql`.

The branch follows the same truth table as `quiz.edit`:

```text
principal is NULL              -> deny
action LIKE 'admin.%'          -> admin only (not reached for ai.*)
create/host actions            -> admin OR host OR active grant
ai.generate_questions | quizId -> (quiz.owner_principal_id = principal) AND host-capable
otherwise                      -> deny
```

The server function calls `supabase.rpc("can", { p_action: "ai.generate_questions", p_resource: quizId })` and short-circuits with `not_authorized` if the RPC returns false. No `canUseAI()` function exists. No AI-specific ownership logic. Reuses `principal_for_user` and the existing `quiz.owner_principal_id` column.

Unknown `ai.*` actions are explicitly denied (a future `ai.analyze_quiz` action, for example, would have to be added to the resolver arm).

---

<a id="usage-logging-cost"></a>
## 12. Usage logging & cost

Every `generateQuestions` and `regenerateQuestion` call writes exactly one row to `ai_usage_log`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `principal_id` | `uuid` | references `principals.id` |
| `capability` | `text` | `ai.generate_questions` or `ai.regenerate_question` |
| `model` | `text` | e.g. `us.deepseek.r1-v1:0` |
| `prompt_version` | `text` | e.g. `generate_questions_v1` |
| `input_tokens` | `int` | from Bedrock response |
| `output_tokens` | `int` | from Bedrock response |
| `latency_ms` | `int` | wall-clock from server side |
| `estimated_cost_usd` | `numeric(10,6)` | computed from `cost-table.ts` |
| `success` | `boolean` | false if provider/validation failed |
| `error_kind` | `text` | null on success; one of the AiErrorCode set (closed via CHECK constraint) |
| `created_at` | `timestamptz` | default `now()` |

RLS is enabled with no explicit policy — `INSERT/UPDATE/DELETE/SELECT` denied for everyone except service_role (which bypasses RLS). The server function uses `supabaseAdmin`.

The `cost-table.ts` is the single source of truth for per-model pricing. Verify against `aws.amazon.com/bedrock/pricing/` when adding a new model.

**No paid AI credits in this phase.** No subscription gating. The user's existing AWS account covers the spend. **Cost is never exposed to the creator** — not in the panel, not in toasts, not in the questions table. It is only visible to service-role readers (Phase 16 Mission Control may surface aggregates later).

**Cost estimates** (DeepSeek R1, $1.35/$5.40 per 1M tokens):

- 5-question generation (~2k input + 1k output) ≈ $0.008
- 20-question generation (~4k input + 3k output) ≈ $0.022

The user's stated $100 AWS credit covers ~4,500–6,500 generations.

---

<a id="error-handling"></a>
## 13. Error handling

`AiErrorCode` is the closed set of error kinds:

```text
not_authorized
over_limit
provider_unavailable
provider_timeout
provider_rate_limited
invalid_output
validation_failed
unknown
```

Every code has a corresponding friendly message in `FRIENDLY_MESSAGES`. Messages deliberately:

- Do **not** mention provider names (Bedrock, OpenAI, DeepSeek, Claude, etc.)
- Do **not** mention model IDs (`us.deepseek.r1-v1:0`)
- Do **not** include stack traces or HTTP status codes
- Speak in user language ("Brain Bolt AI couldn't create the questions right now.")

The `service.test.ts` test `friendly messages don't leak provider info` enforces this property.

Provider errors are translated to the AiErrorCode taxonomy inside the provider. The service never propagates a raw `BedrockError` to the caller — only the code.

---

<a id="limitations"></a>
## 14. Limitations

- **Media**: the AI does not generate image or audio URLs. `image_mcq`, `image_reveal`, and `audio` are excluded from `SUPPORTED_AI_TYPES`. The prompt explicitly forbids inventing media URLs. Creators upload media through the existing editor storage path.
- **`geo_region` polygons**: AI-generated `map_pin` questions are **lat/lng only** with `maxDistance_km` default 5000. GeoJSON region polygons are out of scope for this phase.
- **Drafts lost on refresh**: drafts are client state; reload = lost.
- **No paid AI credits / subscription gating**: Phase 9.
- **No autonomous publishing**: AI never writes to the database without human review.
- **No chat / player coach / lecturer assistant**: Phase 8G.
- **English-first prompts**: the system prompt is English. Non-English topics work (the model is multilingual), but the prompt scaffolding is not localized.
- **Provider**: only Bedrock + DeepSeek R1 ships today. Adding others is a new `AiProvider` implementation.
- **Validation duplication**: `src/lib/quiz/validate.ts` and `mcp/src/validate.ts` are duplicated. Drift caught by `sync.test.ts`. Phase 17 / 8G may unify.

---

<a id="out-of-scope"></a>
## 15. What is out of scope

Explicitly not part of Phase 8E / 8F (later phases per `docs/ROADMAP.md`):

- AI chat / player coach / lecturer assistant (Phase 8G)
- Question improvement / difficulty balancing / weakness detection (Phase 8G)
- Plans, entitlements, `ai.monthly_credits` (Phase 9)
- Paid AI credits / subscription gating (Phase 9)
- Autonomous background agents (no phase assigned)
- AI marketplace (Phase 14)
- MCP ↔ native AI unification (Phase 17)

---

<a id="related-docs"></a>
## 16. Related docs

- [ARCHITECTURE_CONSTITUTION.md](ARCHITECTURE_CONSTITUTION.md) — overall principles
- [CAPABILITY_MODEL.md](CAPABILITY_MODEL.md) — `public.can(...)` resolver + capability vocabulary
- [PRINCIPAL_MODEL.md](PRINCIPAL_MODEL.md) — `principals` identity table
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) — the MCP package; today its `mcp/src/validate.ts` is mirrored by `src/lib/quiz/validate.ts`
- [ROADMAP.md](ROADMAP.md) — Phase 8E / 8F / 8G context and next steps