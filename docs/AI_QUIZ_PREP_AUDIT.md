# Brain Bolt — AI Quiz Preparation: Audit & Missing Capabilities

Audit of the existing implementation that the "upload PDFs/images → source-grounded, reviewed, playable quiz" feature must build on. Reuse existing abstractions wherever appropriate; do not create a parallel AI service, duplicate question schema, or new persistence mechanism without justification.

---

## 1. Existing AI service & AWS Bedrock integration (reusable)

| Component | File | Role | Reusable for prep pipeline? |
|---|---|---|---|
| `BrainBoltAiService` | `src/lib/ai/service.server.ts` | Server-only AI service; `generateQuestions` + `regenerateQuestion`; typed `GenerationResult` envelope; never throws raw provider errors | **Yes** — the `AiProvider` abstraction, usage logging, validation gate, and error taxonomy reuse directly. New task types (document understanding, OCR, quality review) add provider methods or new provider implementations, not a parallel service. |
| `AiProvider` interface | `src/lib/ai/types.ts` | `name`, `modelId`, `pricing`, `generate(prompt)` | **Yes** — task-based routing is implemented by selecting among providers by task, not by adding services. |
| `BedrockDeepSeekProvider` | `src/lib/ai/providers/bedrock-deepseek.server.ts` | `InvokeModelCommand` vs `us.deepseek.r1-v1:0`; strips `⟪think⟫…⟪/think⟫`; translates SDK errors to `AiErrorCode` | **Partially** — good for text question generation/review. Not multimodal; cannot ingest PDF bytes or images directly. |
| `BedrockDeepSeekV3Provider` | `src/lib/ai/providers/bedrock-deepseek-v3.server.ts` | Same SDK vs `us.deepseek.v3.2:0`; cheaper/faster structured JSON | **Partially** — text-only. |
| `PROMPT_VERSIONS` | `src/lib/ai/prompts.ts` | Frozen system + user prompt pairs; `extractJsonObject`, `stripReasoning`, `emptyQuizShell` | **Yes** — prompt-version pattern reused for document-understanding and quality-review prompts. `extractJsonObject` reused for parsing model JSON. |
| `cost-table.ts` | `src/lib/ai/cost-table.ts` | `getPricingForModel`, `estimateCost`, `DEFAULT_MODEL_ID`, `PRICING_TABLE` | **Yes** — extend `PRICING_TABLE` with document/OCR/multimodal models. |
| `usage-log.server.ts` | `src/lib/ai/usage-log.server.ts` | `recordUsage` INSERT into `ai_usage_log` via `supabaseAdmin` (service_role only, RLS deny-all) | **Yes** — reused verbatim for every prep-pipeline AI call. |
| `ai.functions.ts` | `src/lib/api/ai.functions.ts` | `generateQuestions`/`regenerateQuestion` server fns; `requireSupabaseAuth` + `can('ai.generate_questions', quizId)`; `recordAuthDenied` | **Partially** — the serverFn + auth + usage-log pattern is the template for prep-pipeline server fns. New capabilities (`ai.prep_document`, `ai.prep_generate`, etc.) are added to `public.can()`. |
| `ai_usage_log` table | migration `20260822120000_phase_8e_ai_question_builder.sql` | One row per AI call; principal, capability, model, prompt_version, tokens, latency, cost, success, error_kind | **Yes** — reused for prep pipeline; add a `job_id`/`stage` column if attribution to a prep job is needed (see schema doc). |

**Gap:** No Bedrock provider handles images/PDFs natively. DeepSeek R1/V3.2 are text-only. The prep pipeline needs a **multimodal** model (image + text input) for scanned PDFs, photos, diagrams, charts, math. That is a new provider implementation against a Bedrock multimodal model (e.g. Claude 3.x Haiku/Sonnet or Amazon Titan), registered behind the same `AiProvider` interface.

**Gap:** No per-task routing. `BrainBoltAiService` picks ONE provider by env var for all work. The prep pipeline needs a configurable task → model router (document understanding vs question generation vs quality review vs simple tasks).

**Gap:** No per-task token budgets, concurrency caps, or kill switch. All controlled only by the single `maxOutputTokens` passed per call.

---

## 2. AI question & quiz generation (reusable)

| Component | File | Role |
|---|---|---|
| `generateQuestions` server fn | `src/lib/api/ai.functions.ts` | POST, auth, `can()` check, fetches existing question texts for de-dup, calls service, returns envelope |
| `regenerateQuestion` server fn | `src/lib/api/ai.functions.ts` | Same-type enforcement, single-question regeneration |
| `GenerateQuestionsRequest` type | `src/lib/ai/types.ts` | `quizId`, `topic`, `count` (1–20), `difficulty`, `types`, `instructions` (≤500), `existingQuestionTexts` |
| `SUPPORTED_AI_TYPES` | `src/lib/ai/types.ts` | mcq, true_false, number, type, ordering, feedback, map_pin (media types excluded) |
| `AiErrorCode` / `FRIENDLY_MESSAGES` | `src/lib/ai/types.ts` | Closed error taxonomy; provider names/model IDs never leak to UI |
| `AiQuestionBuilderPanel.tsx` | `src/components/quiz/AiQuestionBuilderPanel.tsx` | Client draft review: per-card edit/regenerate/remove/exclude, "Add to Quiz" inserts with `is_playable=false` |

**Reuse:** The prep pipeline's question-generation stage calls the same `generateQuestions` server fn (or a source-grounded variant of it) with source text/excerpts injected into the prompt instead of a free topic. The same validation + de-dup + same-type logic applies.

**Gap:** No source-grounded generation prompt (the current prompt takes a `topic`, not source excerpts with page citations). No batching across many pages/chunks with per-batch resumability.

---

## 3. Canonical question schema & all supported question types (reusable, do not duplicate)

| Component | File | Role |
|---|---|---|
| `questionSchema` / `quizSchema` | `src/lib/quiz/validate.ts` | Zod discriminated union on `type`: mcq, image_mcq, true_false, number, image_reveal, audio, ordering, type, feedback, map_pin. `BrainBoltQuestion` / `BrainBoltQuiz` types |
| `validateQuiz` | `src/lib/quiz/validate.ts` | Schema + semantic validation (correctIndex range, duplicate options, media URL policy, `;` in ordering/type, map_pin region, tolerance bounds, etc.). Returns `valid`/`errors`/`warnings` — **distinguishes errors from warnings** |
| `questionToDbRow` | `src/lib/quiz/validate.ts` | Maps a validated question to the exact `questions` table insert shape |
| `question-registry.ts` | `src/lib/question-registry.ts` | `QuestionTypeDef` (behaviour: accent, answerKind, scored, media), `getQuestionType`, `haversineKm`, `geoCorrectness`, `orderingRatio`, `numberRatio` |
| `question-presentation.ts` | `src/lib/question-presentation.ts` | User-facing strings per type (label, tagline, description, icon, helpText, playerHint) |
| `sync.test.ts` | `src/lib/quiz/sync.test.ts` | Drift test: `src/lib/quiz/validate.ts` vs `mcp/src/validate.ts` |

**Rule:** The prep pipeline must validate every generated question against THIS `questionSchema` / `validateQuiz`. Do NOT create a duplicate schema. The prep pipeline adds **provenance fields** (source document id, version, page/section, excerpt) as metadata attached to the draft/question — these live in prep-specific tables, not in `BrainBoltQuestion`.

**Gap:** `BrainBoltQuestion` has no provenance field. Provenance is stored separately (see schema doc) and attached to the draft before host approval.

---

## 4. Quiz editing, drafts, saving, validation, preview (reusable)

| Component | File | Role |
|---|---|---|
| Quiz editor route | `src/routes/quizzes.$id.tsx` | Loads quiz + questions; `saveQuiz`, `addQuestion`, `updateQuestion`, CSV import, image/audio upload to `quiz-images` bucket + signed URLs, orphaned-upload cleanup |
| `is_playable` flag | migration `20260821090000_question_playable_flag.sql` | AI-inserted questions default `is_playable=false`; host toggles per question |
| Drafts | `AiQuestionBuilderPanel.tsx` client state | AI drafts are **client state only** — lost on page refresh (acknowledged limitation in BRAINBOLT_AI_ARCHITECTURE.md §8) |

**Reuse:** The editor's existing question cards, save flow, CSV import, and media upload (`supabase.storage.from('quiz-images')`) are the persistence target for approved prep questions.

**Gap:** No durable draft persistence for prep jobs. A page refresh mid-pipeline must not destroy completed stages. Prep drafts need server-side persistence (prep_jobs + prep_job_stages tables) so hosts can resume/retry.

---

## 5. Existing file upload & private storage infrastructure (reusable)

| Component | File | Role |
|---|---|---|
| Image upload | `src/routes/quizzes.$id.tsx:1373` | `supabase.storage.from('quiz-images').upload(path, file, {upsert:true})` + `createSignedUrl` (10-year expiry) |
| Audio upload | `src/routes/quizzes.$id.tsx:1400` | Same `quiz-images` bucket pattern |
| Orphaned upload cleanup | `src/routes/quizzes.$id.tsx:79` | `removeOrphanedUpload` parses path from signed URL, fire-and-forget `.remove()` |
| Storage buckets | `scripts/upload-storage.mjs` | Creates private buckets `quiz-images`, `branding-logos` via service-role key |
| `supabaseAdmin` | `src/integrations/supabase/client.server.ts` | Service-role client, bypasses RLS; lazy Proxy, imported inside `.server.ts` only |

**Reuse:** The prep pipeline stores uploaded PDFs/images in a **new private bucket** (e.g. `quiz-prep-documents`) using the same service-role upload + signed-URL pattern. Owner-scoped access enforced via RLS on a `prep_documents` table (not by making the bucket public).

**Gap:** No document bucket exists. No file-type/size/page-count validation. No server-side virus/malicious-content scan hook. No document record table (`prep_documents`) tying a file to an owner principal + version.

---

## 6. Principal-based ownership & authorization (reusable)

| Component | File | Role |
|---|---|---|
| `public.can()` | migration `20260816124500_phase_7l_authorization_completion.sql` + `20260822120000_phase_8e_ai_question_builder.sql` | `can(p_principal, p_action, p_resource)`; truth table: admin / host-capable / owner-of-resource; `ai.generate_questions` branch scoped to quiz owner + host-capable |
| `requireSupabaseAuth` | `src/integrations/supabase/auth-middleware.ts` | Validates Bearer JWT, attaches `userId` + `supabase` client to context |
| `principal_for_user` / `current_principal_id` | `docs/PRINCIPAL_MODEL.md` | SQL helpers resolving auth user → user principal |
| `user_roles` / `host_authorizations` | `docs/CAPABILITY_MODEL.md` | Roles (`admin`, `host`), grants with quota/expiration |

**Reuse:** Prep-pipeline server fns use `requireSupabaseAuth` + `can('ai.prep_<action>', <document-or-quiz-id>)`. Owner-scoped document access: principal must own the document (or the quiz it's attached to). Unknown `ai.prep.*` actions denied by default (consistent with `ai.*` handling).

**Gap:** No document-ownership table or `prep_documents.owner_principal_id`. No RLS policies for documents/jobs. These must be added (see schema doc).

---

## 7. Persistent job / background-processing infrastructure

| Component | File | Role |
|---|---|---|
| `pg_cron` | migration `20260926140000_phase_9d2_scheduler.sql` | `pg_cron` extension installed; `brainbolt-autonomous-scheduler` job runs `run_autonomous_tick()` once per minute. One short transaction per minute — **not** suitable for long-running per-doc AI jobs directly, but the extension is available for maintenance/cleanup cron |
| `run_autonomous_tick` | same migration | Statement-scoped locks, stale-session cleanup |

**Assessment:** The app runs on **TanStack Start (Nitro) on Cloudflare Workers** per BWAT.md. There is **no durable queue, no background worker, no cron-triggered server function** for long-running AI jobs. `pg_cron` runs SQL only, not arbitrary TypeScript/AI logic. Long-running preparation (PDF extraction, OCR, multi-batch generation) cannot be executed inline in a server function request without risking timeout, and there is no worker to pick up a persisted job.

**Decision required:** How to execute long-running prep jobs on Cloudflare Workers. Options:
1. **Client-polling driven stages:** Each stage is a short server fn; the client polls stage status and triggers the next stage. Work is split into small server-function calls (one per page/batch) so none hits the Worker timeout. State persisted in `prep_jobs`/`prep_job_stages`.
2. **External worker:** A separate long-running process (e.g. on a VM/container) pulls due jobs from `prep_jobs` and calls Bedrock, updating stage rows. Adds operational complexity and a second deployment target.

Recommendation: **Option 1** for the minimal reliable path — no new infra, reuses server fns + pg_cron only for cleanup/retention. Revisit Option 2 if jobs routinely exceed Worker limits.

---

## 8. AI request logging, usage tracking, timeouts, retries, spending controls

| Capability | Status |
|---|---|
| Per-call usage log (`ai_usage_log`) | ✅ Exists — principal, capability, model, prompt_version, tokens, latency, cost, success, error_kind |
| Per-model pricing | ✅ `cost-table.ts` (`PRICING_TABLE`, `estimateCost`) |
| Friendly error taxonomy (no provider/model leak) | ✅ `AiErrorCode` / `FRIENDLY_MESSAGES` |
| Server-side timeout translation | ✅ Providers map SDK errors → `provider_timeout`/`provider_rate_limited`/`provider_unavailable` |
| Retry logic | ❌ None — a provider failure returns an error envelope; caller decides whether to retry |
| Per-task token budgets | ❌ Single `maxOutputTokens` per call; no per-task or per-job aggregate cap |
| Per-task concurrency limits | ❌ None |
| Spending controls / budget alerts | ❌ None (Phase 9 monetization is deferred) |
| Administrative AI kill switch | ❌ None |

---

## 9. Tests, migrations, documentation, deferred work

| Item | File | Status |
|---|---|---|
| AI service unit tests | `src/lib/ai/service.test.ts` | Stub provider, covers over-limit, validation, invalid_output, reasoning-stripping, same-type regen, pricing |
| Validation drift test | `src/lib/quiz/sync.test.ts` | `src` vs `mcp` validate.ts agreement |
| Bedrock smoke script | `scripts/bedrock-smoke.mjs` | Manual verification of chat template against configured model |
| Migration tooling | `scripts/migrate.mjs`, `check-migrations.mjs`, `migration-markers.mjs` | Applies pending migrations in filename order, one transaction each, marker-based state |
| AI architecture doc | `docs/BRAINBOLT_AI_ARCHITECTURE.md` | Phases 8E/8F — the foundation this prep feature extends |
| Roadmap | `docs/ROADMAP.md` | Phase 8 (AI/MCP) in progress; 8G (AI Assistant) planned |
| Deferred work | `docs/DEFERRED_WORK.md` | Lists "AI integration (question generation, adaptive difficulty)" as parked — now partially complete via 8E/8F; prep pipeline is new |

---

## 10. Reuse verdict

**Reuse (no duplication):** `BrainBoltAiService`, `AiProvider`, `cost-table`, `PROMPT_VERSIONS`, `validateQuiz`/`questionSchema`, `question-registry`, `questionToDbRow`, `ai.functions.ts` serverFn+auth pattern, `ai_usage_log`, `public.can()`, `requireSupabaseAuth`, `supabase.storage` private-bucket + signed-URL pattern, `supabaseAdmin`, migration tooling, existing test patterns.

**New (justified — no existing equivalent):**
- Document upload server fn + `prep_documents` table (owner-scoped, private bucket)
- PDF text extraction + page-structure preservation (no existing equivalent)
- OCR/multimodal provider + multimodal prompt (DeepSeek is text-only)
- Diagram/table/chart/math interpretation (no existing equivalent)
- Document provenance tracking (source doc version + page/section/excerpt) — new `prep_sources`/`prep_job_stages.source_refs`
- Staged job persistence (`prep_jobs`, `prep_job_stages`) — drafts are currently client-state only
- Task-based Bedrock model router (single provider env-var selection today)
- Per-task token budgets, concurrency caps, kill switch
- Prompt-injection / malicious-instruction protection for uploaded documents
- Staged host review with selective per-stage regeneration + durable draft
