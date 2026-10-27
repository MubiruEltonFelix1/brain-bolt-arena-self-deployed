# Brain Bolt — AI Quiz Preparation: Staged Implementation Plan

Dependencies order: infra first (schema, storage bucket, router), then pipeline stages end-to-end, then host review UI, then security/cost hardening. Do not implement the full feature in one PR; each phase is independently verifiable.

Phase numbering continues after Phase 8 (AI/MCP). Treat this as Phase 10 (AI Quiz Preparation).

---

## Phase 10A — Infrastructure & routing (foundation, no user-facing feature)

**Dependencies:** none (builds on Phase 8E/8F AI service).

1. **Schema migration** — create `prep_documents`, `prep_jobs`, `prep_job_stages`, `prep_sources`, `prep_drafts` + RLS + owner-read policies + optional `ai_usage_log.job_id/stage` + `can()` `ai.prep.*` arm (see `AI_QUIZ_PREP_SCHEMA.md`). Add migration marker to `scripts/migration-markers.mjs`. Apply via `bun scripts/migrate.mjs`.
2. **Private storage bucket** — `quiz-prep-documents` (private), created via service-role, mirroring `scripts/upload-storage.mjs` pattern for `quiz-images`/`branding-logos`.
3. **Task-based model router** — `ModelRouter` + `BedrockClaudeHaikuProvider` + `BedrockClaudeSonnetProvider`; extend `PRICING_TABLE`; env-var configuration; `PREP_AI_ENABLED` kill-switch check (see `AI_QUIZ_PREP_MODEL_ROUTING.md`).
4. **Extend `BrainBoltAiService`** with optional `task` param so `generateQuestions`/`regenerateQuestion` route through the router; keep existing text-generation path working unchanged.

**Exit criteria:** `bun run build` green; `bun run lint` green; migration applies cleanly; router selects correct provider per task; kill switch blocks calls when `PREP_AI_ENABLED=false`.

---

## Phase 10B — Stage 1: document upload & validation (server fn)

**Dependencies:** 10A.

1. Server fn `prepUploadDocument` (POST, `requireSupabaseAuth`, `can('ai.prep_upload')`): validate mime/type/size/pages; upload to `quiz-prep-documents` under `owner_principal_id/{jobId}/`; create `prep_documents` row (status=uploaded); return signed URL (server-side only) + document_id.
2. Client upload component (file input, accept `.pdf,.png,.jpg,.jpeg,.webp`, size/page caps, progress, friendly errors).
3. Unit tests: type/size/page rejection, owner-scoped row, unsigned access denied.

**Exit criteria:** a host can upload a PDF/image and get back a persisted `prep_documents` row; invalid files are rejected before storage; cross-user document access denied.

---

## Phase 10C — Stage 2: PDF text extraction & page structure

**Dependencies:** 10A, 10B.

1. Server fn `prepExtractDocument` (POST, `can('ai.prep_document', documentId)`): server-side PDF text extraction per page + page count + reading order; store per-page text; `prep_documents.status=extracted`; `prep_job_stages` row `document_extract`; flag `needs_ocr` when no extractable text.
2. Client: poll stage status; show extracted text preview per page; OCR-needed indicator.

**Exit criteria:** text-based PDF yields per-page text with page anchors; scanned PDF correctly sets `needs_ocr` and does not crash.

---

## Phase 10D — Stage 3: OCR / multimodal for scanned PDFs & images

**Dependencies:** 10A, 10C.

1. `BedrockClaudeHaikuProvider` wired to router task `ocr`.
2. Server fn `prepOcrDocument`: multimodal calls per page/image; OCR text + per-page confidence; `prep_job_stages` row `document_ocr`; low-confidence pages flagged.
3. Client: show OCR results, confidence flags.

**Exit criteria:** scanned PDF and photo-of-page produce readable text with confidence; failed pages are isolated (don't fail the whole document).

---

## Phase 10E — Stage 4: diagrams/tables/charts/math interpretation

**Dependencies:** 10A, 10D.

1. `BedrockClaudeSonnetProvider` wired to router task `visual_interpretation`.
2. Server fn `prepInterpretMedia`: for pages/blocks flagged as non-text, produce text descriptions (alt-text, table structure, LaTeX-ish math); `prep_job_stages` row `media_interpretation`.
3. Client: show interpretations, uncertainty flags.

**Exit criteria:** a document with a chart/table/math yields text descriptions anchored to page/section.

---

## Phase 10F — Stage 5: structured content mapping with provenance

**Dependencies:** 10A, 10E.

1. Deterministic chunking (server-side code, no LLM): split into sections by page breaks/headings; create `prep_sources` rows (`document_id`, `version`, `page`, `section`, `excerpt`); `prep_job_stages` row `content_map`.
2. Client: review/edit the content map (sections, which pages to include).

**Exit criteria:** every section has a page/section/excerpt anchor; re-mapping is idempotent.

---

## Phase 10G — Stage 6: host configuration & blueprint

**Dependencies:** 10F.

1. Server fn `prepSetBlueprint`: host selects sections/pages, question types, count, difficulty; validate against available `prep_sources`; store `prep_job_stages` row `host_blueprint`; job waits for host confirmation.
2. Client: blueprint form (types, count, difficulty, include/exclude pages).

**Exit criteria:** host can configure and confirm a blueprint; empty selection rejected.

---

## Phase 10H — Stage 7: source-grounded batch generation

**Dependencies:** 10A (router), 10G.

1. Source-grounded variant of `generateQuestions` prompt: system prompt instructs the model to ground each question in a cited excerpt and emit `page`/`section` per question; input includes source excerpts.
2. Server fn `prepGenerateBatch`: per-batch generation with token budget, per-batch retry, count-mismatch warning; stage rows `question_generate` per batch; partial success preserved.
3. Client: batch progress, per-batch status, retry failed batch.

**Exit criteria:** a batch of source-grounded questions is produced, each linked to `prep_sources`; failed batch retried in isolation; completed batches survive refresh.

---

## Phase 10I — Stage 8: deterministic schema & answer validation

**Dependencies:** 10H.

1. Run `validateQuiz` on each generated question; deterministic checks (answer key, distractors, type-specific config).
2. Store `prep_job_stages` row `validate`; route failures to stage 10 (selective regen).

**Exit criteria:** every generated question passes `validateQuiz` before reaching host review; errors vs warnings distinguished.

---

## Phase 10J — Stage 9: AI quality checks (source support, ambiguity, duplicates, quality)

**Dependencies:** 10A (router task `quality_review`), 10I.

1. `BedrockClaudeSonnetProvider` (different model from generation) checks each question: source support vs cited excerpt, ambiguity, near-duplicate vs other questions & existing quiz questions, quality score.
2. Output flags as warnings (advisory), not errors; `prep_job_stages` row `quality_review`; mark `review_required` when model unavailable.

**Exit criteria:** each question has advisory flags; two-model agreement is not treated as proof; host sees flags in review UI.

---

## Phase 10K — Stage 10: persistent draft assembly

**Dependencies:** 10I.

1. Assemble `prep_drafts` row (questions in canonical `BrainBoltQuestion[]` JSON + `prep_sources` links); status `pending_review`.
2. Server fn `prepAssembleDraft`; client can view draft any time (survives refresh).

**Exit criteria:** draft is server-persisted; page refresh does not lose it.

---

## Phase 10L — Stage 11: host review, edit, selective regen, preview, publish

**Dependencies:** 10K.

1. Host review UI: per-question card showing question + source excerpt + page citation; controls: edit text, regenerate one question (same type, re-grounded), exclude, reorder, preview (read-only).
2. "Add to Quiz" → insert via existing `supabase.from('questions').insert(...)` with `is_playable=false`, using `questionToDbRow`; `prep_drafts.status=approved`.
3. Host toggles `is_playable=true` per question via existing editor to publish.

**Exit criteria:** host-approved questions reach the `questions` table; AI never auto-publishes; draft resumable until approved.

---

## Phase 10M — Security, cost & failure hardening (throughout, completed by 10L)

- Owner-scoped RLS + `can()` on all prep server fns (10A).
- Per-task token budgets, concurrency caps, retry caps (10A router).
- `PREP_AI_ENABLED` kill switch (10A).
- Usage attribution to `job_id`/`stage` in `ai_usage_log` (schema).
- Prompt-injection protection: system boundary delimits user document text from instructions; document content never treated as executable instruction (see `AI_QUIZ_PREP_SECURITY_COST.md`).
- Unit + integration tests per stage (see `AI_QUIZ_PREP_TESTS.md`).

---

## Dependency summary

```
10A (infra+router) → 10B (upload) → 10C (extract) → 10D (OCR) → 10E (media) → 10F (content map) → 10G (blueprint) → 10H (generate) → 10I (validate) → 10J (quality) → 10K (draft) → 10L (review/publish)
10M runs across all phases.
```

Each phase's exit criteria are independently verifiable (build/lint + targeted tests), so work can pause after any phase.
