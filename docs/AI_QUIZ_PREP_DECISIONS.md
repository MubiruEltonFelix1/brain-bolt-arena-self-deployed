# Brain Bolt — AI Quiz Preparation: Decisions Requiring Approval

These decisions must be confirmed before implementation begins. They are architectural and have cost/ops implications.

---

## D1 — Long-running job execution on Cloudflare Workers

**Question:** How do we run multi-stage PDF/AI prep jobs given TanStack Start runs on Nitro/Cloudflare Workers (no durable queue, no background worker, `pg_cron` runs SQL only)?

**Recommended (Option A):** Client-polling driven stages. Each stage is a short server fn; the client triggers stage N+1 after stage N persists. Work is split into small calls so none hits the Worker timeout. State in `prep_jobs`/`prep_job_stages`. No new infra.

**Alternative (Option B):** External long-running worker (VM/container) pulling due jobs from `prep_jobs` and calling Bedrock, updating stage rows. Adds a second deployment target and operational complexity.

**Preferred:** Option A (smallest reliable path, no new infra). Revisit Option B if jobs routinely exceed Worker limits.

**Approval needed:** Confirm Option A, or specify Option B.

---

## D2 — Multimodal model choice & provider implementations

**Question:** Which Bedrock multimodal model(s) for OCR and visual interpretation, and do we implement `BedrockClaudeHaikuProvider` + `BedrockClaudeSonnetProvider`?

**Recommended:** Claude 3.5 Haiku for OCR (fast, cheap), Claude 3.5 Sonnet for diagrams/tables/charts/math + quality review (stronger reasoning). Add both to `PRICING_TABLE`; select via env vars `PREP_MODEL_OCR` / `PREP_MODEL_VISUAL`.

**Approval needed:** Confirm model IDs; confirm we implement both providers behind the existing `AiProvider` interface (no parallel service).

---

## D3 — Default model for question generation

**Question:** Keep DeepSeek V3.2 (`us.deepseek.v3.2:0`) as the generation default, or switch to R1?

**Recommended:** V3.2 as default (cheaper ~2.2x, faster, reliable structured JSON), with R1 as the configured fallback for generation timeouts. This matches Phase 8F's existing opt-in pattern.

**Approval needed:** Confirm V3.2 default + R1 fallback.

---

## D4 — Schema additions to `ai_usage_log`

**Question:** Add `job_id` and `stage` columns to `ai_usage_log` for prep spend attribution?

**Recommended:** Yes — keeps usage tracking in the existing table (no parallel usage mechanism). Nullable, indexed.

**Approval needed:** Confirm the two column additions.

---

## D5 — `prep_drafts.questions` stores canonical JSON; no separate draft-question table

**Question:** Store assembled draft questions as `BrainBoltQuestion[]` JSON in `prep_drafts.questions`, linked to `prep_sources` for provenance — no new `draft_questions` table?

**Recommended:** Yes. Avoids duplicating the question schema; `prep_sources` carries page/section/excerpt provenance. On approval, questions flow into `questions` via the existing `questionToDbRow` insert path.

**Approval needed:** Confirm.

---

## D6 — `public.can()` `ai.prep.*` arm + truth table

**Question:** Add `ai.prep_upload`, `ai.prep_document`, `ai.prep_job`, `ai.prep_generate`, `ai.prep_publish` to `public.can()` with owner + host-capable truth table; unknown `ai.prep.*` denied?

**Recommended:** Yes, mirroring the `ai.generate_questions` arm in the Phase 8E migration.

**Approval needed:** Confirm the action set and that unknown actions deny.

---

## D7 — Kill switch form

**Question:** Env var `PREP_AI_ENABLED` only, or also a DB-administered boolean?

**Recommended:** Env var `PREP_AI_ENABLED` (simplest, serverless-friendly). A DB flag can be added later if redeploy is too slow.

**Approval needed:** Confirm env var is sufficient for now.

---

## D8 — Cost not exposed to creator in this phase

**Question:** Confirm no cost/credit display to the host in the prep UI (consistent with Phase 8F), with cost visible only to service-role readers/admins?

**Recommended:** Yes.

**Approval needed:** Confirm.

---

## D9 — Out-of-scope confirmations

Confirm these are explicitly NOT in this task:
- No public question marketplace.
- No collaborative editing.
- No document embeddings / vector search / RAG.
- No unrelated AI capabilities (player coach, lecturer assistant, etc.).
- No paid AI credits / subscription gating.
- No per-user monthly budgets.
- No virus scanning of uploads.

**Approval needed:** Confirm scope boundaries.
