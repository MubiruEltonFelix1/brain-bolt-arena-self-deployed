# Brain Bolt — AI Quiz Preparation: Security, Cost & Failure-Handling Requirements

---

## 1. Private source storage & owner-scoped access

- Uploaded PDFs/images live in a **new private bucket** `quiz-prep-documents` (not public), created via service-role like `quiz-images`/`branding-logos`.
- Object path prefixed with `owner_principal_id/{jobId}/` so a user cannot guess another user's object key.
- A `prep_documents` row ties the object to `owner_principal_id`. RLS owner-read policy: `owner_principal_id = current_principal_id()`. No authenticated `INSERT/UPDATE/DELETE` policy — writes only via `supabaseAdmin` inside server fns after `can()`.
- Signed URLs are short-lived and server-side only; the browser never gets a direct object URL it can share.
- Cross-user access: `can('ai.prep_document', documentId)` requires ownership of the document + host capability. Deny by default.

## 2. File type, size, page-count, content limits

Enforced server-side **before** storage or AI processing:

| Limit | Default | Enforcement |
|---|---|---|
| Mime type | `application/pdf`, `image/png`, `image/jpeg`, `image/webp` | reject before storage |
| File size | 25 MB | reject before storage |
| PDF page count | 200 | reject before storage |
| Image dimensions | no upscale beyond reasonable cap | reject before storage |
| Pages sent to OCR per job | 200 | capped; host must select subset for large docs |
| Generation batch size | 20 questions (mirrors `MAX_GENERATION_COUNT`) | server-enforced |
| Per-job token budget | configurable (`PREP_MAX_BATCH_TOKENS`) | reject before Bedrock call |

Oversized/over-limit inputs return `over_limit`/`validation_failed` friendly messages; no AI cost is incurred for rejected inputs.

## 3. Server-side Bedrock access & authorization

- All Bedrock calls are server-side (`.server.ts` / server fns). AWS credentials (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) read inside provider methods, never at module scope, never shipped to the client.
- The browser never sees provider names, model IDs, AWS keys, regions, status codes, or stack traces — only `FRIENDLY_MESSAGES[error.code]`.
- Every prep server fn: `requireSupabaseAuth` → `can('ai.prep_<action>', <resource>)` → `supabaseAdmin` for writes.
- `ai.prep.*` actions added to `public.can()` with owner + host-capable truth table; unknown `ai.prep.*` denied.

## 4. Protection against malicious instructions inside uploaded documents

Uploaded documents may contain text that attempts to override the system prompt (prompt injection / "ignore previous instructions"). Defenses:

- **System/message boundary:** document text is always passed as user content, never concatenated into the system prompt. The system prompt is fixed and authoritative.
- **Delimiter escaping:** document excerpts are wrapped in a fixed, escaped delimiter; any delimiter-like sequences inside the document are escaped so the document cannot terminate the instruction block.
- **Instruction hierarchy:** the generation system prompt explicitly states that content between delimiters is source material to answer questions about, not instructions to follow.
- **Output validation:** every model output passes `validateQuiz` (canonical schema). Even an injected instruction cannot produce an out-of-schema question.
- **No code execution from document text:** document text is never eval'd, never rendered unsanitized into a prompt that the model treats as commands.
- **Advisory review:** stage 9 flags source-support and ambiguity; a document that tricks the model still produces questions the host must review and approve before publishing.

## 5. Per-task model & token limits

- Task-based router (see `AI_QUIZ_PREP_MODEL_ROUTING.md`): each task maps to a provider+model with its own `maxOutputTokens`, temperature, and token budget.
- Per-call budget enforced before the Bedrock call (rejected calls cost nothing).
- Per-job aggregate token tracking in `prep_job_stages.output_summary`.
- Per-job concurrency cap (`PREP_MAX_CONCURRENCY`, default 3).
- Per-stage retry cap (≤ 3) with exponential backoff.

## 6. Usage & cost tracking

- Every prep AI call writes to `ai_usage_log` (existing table), optionally with `job_id` and `stage` columns. Fields: principal, capability, model, prompt_version, input/output tokens, latency, estimated cost, success, error_kind.
- Cost computed from `cost-table.ts` (`estimateCost`) at record time — single source of truth, verified against AWS Bedrock pricing.
- Aggregates computable per principal, per job, per stage, per day (for future Mission Control / Phase 16 surfacing).
- **No cost is exposed to the creator** in this phase (consistent with Phase 8F: cost is not shown in the panel). Cost is visible only to service-role readers/admins.

## 7. Retry & concurrency limits

- Per-stage retry cap ≤ 3, exponential backoff, jitter.
- Per-batch isolation: a failed generation batch is retried independently; completed batches are preserved.
- Per-job concurrency cap; excess calls queue or return `retry_after`.
- Idempotent stages: re-running a stage overwrites its output, never duplicates.

## 8. Administrative AI kill switch

- Env `PREP_AI_ENABLED` (`true`/`false`). Checked at the top of every prep-pipeline server fn before any Bedrock call.
- `false` ⇒ all prep AI stages return a friendly "AI preparation is temporarily unavailable" error; no usage-log row, no cost.
- Manual quiz creation, editing, CSV import, image/audio upload, and hosting are **completely unaffected** — AI availability is never a prerequisite for non-AI features.
- (Optional future) a DB-administered boolean kill switch if env-var redeploy is too slow; start with env var.

## 9. Failure handling principles (summary)

| Situation | Behavior |
|---|---|
| Page refresh mid-pipeline | Resume from `prep_jobs.current_stage`; completed stages intact |
| Model timeout / rate limit | Retry same model (exp backoff) → fallback model → fail stage, preserve work |
| Invalid model output | Retry with stricter prompt → `validation_failed` |
| Scanned/unreadable page | Flag `needs_ocr` / low-confidence; warn host, don't fail whole doc |
| Schema/answer violation | Error — blocks that question; host must fix/regenerate |
| Ambiguity / duplicate / low source support | Warning — advisory, host decides |
| Host cancels | Job `cancelled`; completed work preserved, resumable |
| Kill switch on | All prep AI blocked; non-AI features unaffected |

## 10. Non-goals for security/cost in this phase

- No paid AI credits / subscription gating (Phase 9).
- No creator-visible cost (consistent with Phase 8F).
- No per-user monthly budgets (Phase 9/16).
- No virus scanning of uploads (can be added later; storage is private + server-side only).
