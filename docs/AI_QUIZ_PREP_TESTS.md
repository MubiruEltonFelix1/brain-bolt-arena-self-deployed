# Brain Bolt — AI Quiz Preparation: Test & Evaluation Plans

Reuses existing test patterns: `bun:test`, static-analysis style with stub providers (see `src/lib/ai/service.test.ts`), no network, no jsdom. Migration tests via `scripts/migrate.mjs` / `check-migrations.mjs`.

---

## 1. Automated tests (unit / integration)

### AI service & router
- Router selects the correct provider+model per task (`ocr`, `visual_interpretation`, `question_generate`, `question_regenerate`, `quality_review`, `simple`).
- Unknown task falls back to default text-generation provider.
- Kill switch (`PREP_AI_ENABLED=false`) blocks all prep calls before Bedrock; no usage-log row; non-AI server fns unaffected.
- Per-call token budget rejects oversized requests before any provider call (no cost).
- Provider error translation: timeout → `provider_timeout`, rate limit → `provider_rate_limited`, unavailable → `provider_unavailable`.
- Retry logic: transient failure retried up to cap; exhausted → stage failed, prior stages preserved.
- Pricing table lookups for new models (Claude Haiku/Sonnet); `estimateCost` correct.

### Document upload & storage
- Accepted: pdf, png, jpg, jpeg, webp within size/page caps → `prep_documents` row + object.
- Rejected: unsupported mime, over size, over page count → `validation_failed`/`over_limit`, no object stored, no AI cost.
- Owner-scoped: user A cannot read/delete user B's document (RLS + `can()` deny).
- Signed URLs are short-lived and server-side only.

### PDF extraction & OCR (stubbed provider)
- Text-based PDF → per-page text with page anchors; `needs_ocr=false`.
- Scanned PDF → `needs_ocr=true`, no crash.
- OCR failure on one page → isolated; other pages complete; low-confidence flagged.
- Re-extraction is idempotent (overwrites, no duplicates).

### Content mapping & provenance
- Chunking by page breaks/headings yields `prep_sources` rows with `document_id`, `version`, `page`, `section`, `excerpt`.
- Re-mapping same document is idempotent.
- Empty document → validation error.

### Question generation (stubbed provider)
- Source-grounded generation returns questions each linked to a `prep_sources` page/section/excerpt.
- Count mismatch → warning, not error (per brief §4).
- Invalid output → `invalid_output`; retry then fail.
- Unscoped question type (e.g. `image_mcq` requested when not supported) → `validation_failed` before AI call.
- Existing-question-texts de-dup context is sent and respected.

### Validation & quality
- Every generated question passes `validateQuiz` (canonical schema + semantic rules) before host review.
- Errors vs warnings distinguished: schema violations block; ambiguity/duplicate/low-source-support are warnings.
- Answer keys, distractors, type-specific config (map_pin lat/lng, number range, ordering uniqueness, type acceptedAnswers) checked.
- Quality-check model is different from generation model; its output is advisory only (never treated as proof).

### Draft persistence & recovery
- `prep_drafts` row survives a simulated page refresh (new request, same job_id returns the draft).
- Failed batch: retry that batch only; completed batches intact.
- Job cancellation: `cancelled` status; resumable; prior stages preserved.
- Duplicate `Generate` clicks guarded (ref pattern, like `AiQuestionBuilderPanel`).

### Authorization & cross-user protection
- `can('ai.prep_upload')`, `can('ai.prep_document', docId)`, `can('ai.prep_job', jobId)`, `can('ai.prep_generate', jobId)`, `can('ai.prep_publish', draftId)` all require ownership + host capability.
- Unknown `ai.prep.*` action denied.
- Non-owner cannot read another user's job/draft/sources.
- `supabaseAdmin` writes only after `can()`; no client-side bypass.

### Existing-feature regression
- `generateQuestions`/`regenerateQuestion` (Phase 8F) unchanged: same provider selection, same envelope, same `ai_usage_log` rows.
- `validateQuiz`/`questionSchema` unchanged; drift test (`sync.test.ts`) still passes.
- Quiz editor save flow, CSV import, media upload unaffected.

---

## 2. Evaluation corpus (representative documents)

Each document is processed end-to-end; results scored against the metrics in §3.

| Corpus item | Content type | What it validates |
|---|---|---|
| C1 | Text-based PDF, 5–10 pages, clear headings | Stage 2 extraction + page anchors |
| C2 | Scanned PDF (image-only pages) | Stage 3 OCR + `needs_ocr` flag |
| C3 | Photograph of a printed page (photo, angle/lighting variance) | Stage 3 multimodal OCR robustness |
| C4 | Document with tables | Stage 4 table interpretation + structure |
| C5 | Document with diagrams/charts | Stage 4 visual reasoning + alt-text |
| C6 | Document with mathematical notation | Stage 4 math → LaTeX-ish text |
| C7 | Long document (>100 pages, chunking) | Stage 5 sectioning + pagination + batching |
| C8 | Malformed/unsupported file (corrupt PDF, .exe, .zip) | Stage 1 rejection, no cost |
| C9 | Duplicate/ambiguous source material (repeated paragraphs, contradictory statements) | Stage 9 duplicate + ambiguity flags |
| C10 | Model timeout / rate-limit injection (stub) | Retry + fallback + partial preservation |
| C11 | Invalid generated schema (stub emits bad JSON / out-of-schema) | `validateQuiz` blocks; warning vs error |
| C12 | Draft recovery (refresh mid-pipeline, repeat request) | `prep_drafts` persistence, idempotency |
| C13 | Cross-user access attempt (user B hits user A's job) | Authorization deny |

---

## 3. Measurable quality & cost metrics

Computed from `ai_usage_log`, `prep_jobs`, `prep_job_stages`, `prep_sources`, `prep_drafts`.

| Metric | Definition | Target (indicative) |
|---|---|---|
| Source support | % of host-approved questions whose cited excerpt page/section matches the actual source | ≥ 90% |
| Topic coverage | % of blueprint sections that have ≥1 approved question | ≥ 80% |
| Duplicate rate | % of approved questions near-duplicate of another question in the quiz or existing quiz questions | ≤ 5% |
| Accepted playable questions per minute of host effort | approved questions with `is_playable=true` ÷ host minutes in review UI | track baseline |
| Cost per accepted question | `ai_usage_log.estimated_cost_usd` sum for the job ÷ approved questions | track vs $0.01–$0.05 baseline |
| Time to host-approved quiz | upload → `prep_drafts.status=approved` wall-clock | track baseline |
| Stage failure rate | % of stages that fail after retries | ≤ 5% |
| Per-batch retry rate | % of generation batches needing ≥1 retry | track |

Host effort and time-to-approved are measured via client telemetry (stage start/end timestamps) — not required for the first implementation, but the schema supports it (`prep_job_stages.started_at/finished_at`).
