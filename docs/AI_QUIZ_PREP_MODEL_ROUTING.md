# Brain Bolt — AI Quiz Preparation: Bedrock Model Routing Proposal

> Do not hardcode model IDs throughout the application. Routing is configured centrally, task by task.

Reuses the existing `AiProvider` interface (`src/lib/ai/types.ts`) and `cost-table.ts` (`PRICING_TABLE`, `estimateCost`). Adds a **task-based router** that selects the provider+model by task, plus extension of `PRICING_TABLE` with multimodal/document models.

---

## 1. Current state (single model for everything)

`BrainBoltAiService` picks ONE provider by `BRAINBOLT_AI_PROVIDER` env and ONE model by `BRAINBOLT_AI_MODEL` env. DeepSeek R1 (default) and V3.2 (alternative) are both **text-only**. That is fine for question generation/review but cannot ingest PDF bytes, images, or scanned pages.

## 2. Recommended model assignments by task

| Task | Recommended model (Bedrock) | Rationale | Deterministic-code alternative? |
|---|---|---|---|
| Document text extraction (text-based PDFs) | **None** — server-side PDF library | Cheap, exact, page anchors preserved | ✅ Yes — pdf parsing library, no LLM |
| OCR / scanned PDFs / photos of pages | **Claude 3.5 Haiku** (multimodal, Bedrock) | Multimodal image+text input; fast & cheap; strong OCR/layout | No |
| Diagram / table / chart / math interpretation | **Claude 3.5 Sonnet** (multimodal, Bedrock) | Strongest visual reasoning; math & chart interpretation | No |
| Structured content mapping (chunking, sections) | **None** — deterministic code | Rule-based on page breaks + headings | ✅ Yes |
| Source-grounded question generation | **DeepSeek V3.2** (text, Bedrock) | Cheap, fast, reliable structured JSON; good at following source-citation instructions | No |
| Question regeneration (single) | **DeepSeek V3.2** | Same-type enforcement, lower cost | No |
| Schema & answer validation | **None** — `validateQuiz` (zod) | Deterministic, exact | ✅ Yes |
| Duplicate / near-duplicate detection | **None** — deterministic text similarity | Exact/fuzzy match on question text | ✅ Yes |
| AI quality review (source support, ambiguity, quality) | **Claude 3.5 Sonnet** (multimodal-capable text) | Different model from generation → independent cross-check; strong reasoning | No (advisory only) |
| Simpler tasks (stage summaries, blueprint validation) | **DeepSeek V3.2** | Low cost, sufficient | No |

### Preferred Bedrock model IDs (configured centrally, not hardcoded per call)

| Role | Model ID | Pricing (per 1M tokens, verify vs aws.amazon.com/bedrock/pricing/) |
|---|---|---|
| Generation (default) | `us.deepseek.v3.2:0` | input 0.62 / output 1.85 |
| Generation (reasoning fallback) | `us.deepseek.r1-v1:0` | input 1.35 / output 5.40 |
| OCR / visual | `anthropic.claude-3-5-haiku-20241022-v1:0` | Bedrock on-demand pricing |
| Visual reasoning / quality review | `anthropic.claude-3-5-sonnet-20241022-v2:0` | Bedrock on-demand pricing |

> **Note:** These model IDs are configuration values. Add them to `PRICING_TABLE` in `cost-table.ts` and select via env vars, never inline in components or server fns.

## 3. Router design

Extend `BrainBoltAiService` (or a thin wrapper) with a `task` dimension:

```ts
type PrepTask =
  | 'ocr' | 'visual_interpretation' | 'question_generate'
  | 'question_regenerate' | 'quality_review' | 'simple';

interface ModelRouter {
  providerFor(task: PrepTask): AiProvider;
  modelIdFor(task: PrepTask): string;
  maxOutputTokensFor(task: PrepTask): number;
  temperatureFor(task: PrepTask): number;
  tokenBudgetFor(task: PrepTask): number;   // per-call aggregate cap
  concurrencyFor(task: PrepTask): number;    // max in-flight calls
}
```

Configuration via env vars with sensible defaults:

| Env var | Default | Effect |
|---|---|---|
| `PREP_MODEL_OCR` | `anthropic.claude-3-5-haiku-20241022-v1:0` | OCR/multimodal |
| `PREP_MODEL_VISUAL` | `anthropic.claude-3-5-sonnet-20241022-v2:0` | diagrams/tables/charts/math + quality review |
| `PREP_MODEL_GENERATE` | `us.deepseek.v3.2:0` | question generation |
| `PREP_MODEL_REGENERATE` | `us.deepseek.v3.2:0` | single-question regen |
| `PREP_MODEL_SIMPLE` | `us.deepseek.v3.2:0` | blueprint/summary tasks |
| `BRAINBOLT_AI_PROVIDER` | `bedrock-deepseek` | legacy text-generation fallback |
| `PREP_MAX_BATCH_TOKENS` | `30000` | per-batch input+output token budget |
| `PREP_MAX_CONCURRENCY` | `3` | max concurrent prep AI calls per job |
| `PREP_AI_ENABLED` | `true` | administrative kill switch (see §6) |

Implementation:
- New provider implementations `BedrockClaudeHaikuProvider` and `BedrockClaudeSonnetProvider` against Bedrock's `InvokeModel` with the Anthropic `messages` API format (image + text content blocks). Registered behind `AiProvider` — same interface, new `case`s in `BrainBoltAiService` (or a `ModelRouter` class composes providers).
- `BrainBoltAiService.generateQuestions` gains an optional `task` param; when set, it uses `router.providerFor(task)` instead of the singleton provider. The existing text-generation path keeps `task='question_generate'`.

## 4. Fallback behavior

| Failure | Fallback |
|---|---|
| Primary generation model times out / rate-limited | Retry same model once (exp backoff). Then switch to `us.deepseek.r1-v1:0` (reasoning) for that batch only. |
| Multimodal model unavailable | Fail the stage with `provider_unavailable`; surface to host ("document understanding unavailable — try again later"). Do **not** silently fall back to a text-only model for scanned content (would produce garbage). |
| All generation retries exhausted | Stage marked failed; job stays `running` with error; host can retry the stage or cancel. Completed batches preserved. |
| Provider returns non-JSON / invalid output | `invalid_output` → retry with a stricter system prompt once, then `validation_failed`. |

Never cascade failures: a failure in OCR for one page must not fail OCR for all pages; a failure in one generation batch must not fail other batches.

## 5. Model-specific limits

| Model | Limits / notes |
|---|---|
| Claude 3.5 Haiku | Image+text; input image limits per Bedrock; token budget per call; enforce `PREP_MAX_BATCH_TOKENS` |
| Claude 3.5 Sonnet | Larger context; higher cost; reserve for visual reasoning + quality review |
| DeepSeek V3.2 | Text-only; no image input; chat template (`<|User|>…<|Assistant|>`) |
| DeepSeek R1 | Reasoning; strips `⟪think⟫` blocks; slower & costlier; fallback only |

Token counting: use Bedrock-reported `input_tokens`/`output_tokens` where available; otherwise estimate. Enforce per-call `maxOutputTokens` and per-job aggregate token budget (tracked in `prep_job_stages.output_summary`).

## 6. Concurrency & token-budget controls

- **Per-job concurrency cap** (`PREP_MAX_CONCURRENCY`, default 3): in-flight AI calls for a single job. Excess calls queue; stage server fn returns `retry_after` or the client paces requests.
- **Per-call token budget** (`PREP_MAX_BATCH_TOKENS`): reject generation requests whose estimated input+output would exceed the budget, before calling Bedrock (no cost for rejected calls).
- **Per-stage retry cap**: `prep_job_stages.retry_count` ≤ 3; then fail the stage, preserve completed work, surface to host.
- **Cost tracking**: every prep AI call writes to `ai_usage_log` (with optional `job_id`/`stage`). Aggregates computable per job, per principal, per day.

## 7. Administrative AI kill switch

Env `PREP_AI_ENABLED` (`true`/`false`). Checked at the top of every prep-pipeline server fn:

- `false` ⇒ all prep AI stages return a friendly "AI preparation is temporarily unavailable" error **before** any Bedrock call; no usage-log row, no cost.
- Manual quiz creation, editing, CSV import, and hosting are **unaffected** — AI availability is not a prerequisite for non-AI features.
- A DB-level boolean flag on `prep_jobs` (or a separate admin-controlled kill-switch table) can be added if an env-var redeploy is too slow; start with env var (simplest, serverless-friendly).

## 8. What is NOT done (out of scope)

- No hardcoded model IDs in components/server fns — all via `cost-table.ts` + env-configured router.
- No parallel AI service — the router composes the existing `AiProvider`s.
- No duplicate question schema — generation output still validated by `validateQuiz`.
- No embeddings / vector search / RAG — source grounding is via excerpt citation, not semantic search.
