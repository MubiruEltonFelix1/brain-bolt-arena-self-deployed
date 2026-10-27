# Brain Bolt — AI Quiz Preparation: Minimal Schema & Migration Plan

Only where required. Reuses the existing `questions`, `quizzes`, `principals`, and `ai_usage_log` tables. Adds four new tables for document ownership, job persistence, provenance, and drafts.

All new tables: RLS enabled, no explicit policy ⇒ deny-all except `service_role` (which bypasses RLS). Writes go through `supabaseAdmin` inside server fns after a `can()` check. Reads use the normal authenticated `supabase` client with RLS policies scoped to `owner_principal_id`.

## 1. New tables

```sql
-- 2026XXXXXXXXXXXX_phase_10_ai_quiz_prep_documents.sql
-- One uploaded source document, owner-scoped.
create table if not exists public.prep_documents (
  id              uuid primary key default gen_random_uuid(),
  owner_principal_id uuid not null references public.principals(id),
  bucket          text not null default 'quiz-prep-documents',
  object_key      text not null,
  mime_type       text not null,
  size_bytes      bigint not null,
  page_count      integer,
  status          text not null default 'uploaded', -- uploaded|extracting|extracted|ocr|failed
  version         integer not null default 1,       -- increments on re-upload of same logical doc
  needs_ocr       boolean not null default false,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists prep_documents_owner_idx on public.prep_documents (owner_principal_id, created_at desc);
alter table public.prep_documents enable row level security;

create table if not exists public.prep_jobs (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.prep_documents(id) on delete cascade,
  quiz_id         uuid references public.quizzes(id) on delete set null, -- target quiz, nullable until host adds questions
  owner_principal_id uuid not null references public.principals(id),
  status          text not null default 'pending', -- pending|running|paused|completed|failed|cancelled
  current_stage   text,                            -- document_extract|document_ocr|media_interpretation|content_map|host_blueprint|question_generate|validate|quality_review|draft_assembled|complete
  progress_pct    integer not null default 0,
  error           text,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index if not exists prep_jobs_owner_idx on public.prep_jobs (owner_principal_id, created_at desc);
create index if not exists prep_jobs_document_idx on public.prep_jobs (document_id);
alter table public.prep_jobs enable row level security;

create table if not exists public.prep_job_stages (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.prep_jobs(id) on delete cascade,
  stage           text not null,
  attempt         integer not null default 1,
  status          text not null default 'pending', -- pending|running|succeeded|failed|skipped
  retry_count     integer not null default 0,
  input_summary   jsonb,
  output_summary  jsonb,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists prep_job_stages_job_idx on public.prep_job_stages (job_id, created_at);
alter table public.prep_job_stages enable row level security;

create table if not exists public.prep_sources (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.prep_jobs(id) on delete cascade,
  question_index  integer not null,               -- index within the assembled draft
  document_id     uuid not null references public.prep_documents(id),
  version         integer not null,               -- doc version the question was grounded in
  page            integer not null,
  section         text,
  excerpt         text not null,                  -- supporting excerpt (host-visible citation)
  confidence      numeric(3,2),                   -- extraction/interpretation confidence 0..1
  created_at      timestamptz not null default now()
);
create index if not exists prep_sources_job_idx on public.prep_sources (job_id, question_index);
alter table public.prep_sources enable row level security;

create table if not exists public.prep_drafts (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.prep_jobs(id) on delete cascade,
  quiz_id         uuid references public.quizzes(id) on delete set null,
  title           text not null,
  questions       jsonb not null,                 -- canonical BrainBoltQuestion[] shape (validated)
  status          text not null default 'pending_review', -- pending_review|approved|rejected|superseded
  created_at      timestamptz not null default now(),
  approved_at     timestamptz
);
create index if not exists prep_drafts_job_idx on public.prep_drafts (job_id);
create index if not exists prep_drafts_quiz_idx on prep_drafts (quiz_id);
alter table public.prep_drafts enable row level security;
```

RLS policies (owner-scoped, `service_role` bypasses):

```sql
-- prep_documents: owner can read; service_role writes via server fn after can()
create policy prep_documents_owner_read on public.prep_documents
  for select using (owner_principal_id = public.current_principal_id());

-- prep_jobs / prep_job_stages / prep_sources / prep_drafts: owner can read own;
-- service_role writes after can() check inside server functions.
create policy prep_jobs_owner_read on public.prep_jobs
  for select using (owner_principal_id = public.current_principal_id());
create policy prep_job_stages_owner_read on public.prep_job_stages
  for select using (exists (select 1 from public.prep_jobs j where j.id = prep_job_stages.job_id and j.owner_principal_id = public.current_principal_id()));
create policy prep_sources_owner_read on public.prep_sources
  for select using (exists (select 1 from public.prep_jobs j where j.id = prep_sources.job_id and j.owner_principal_id = public.current_principal_id()));
create policy prep_drafts_owner_read on public.prep_drafts
  for select using (exists (select 1 from public.prep_jobs j where j.id = prep_drafts.job_id and j.owner_principal_id = public.current_principal_id()));
```

No `INSERT/UPDATE/DELETE` policy for authenticated roles on these tables — only `service_role` via `supabaseAdmin`, matching the `ai_usage_log` convention.

## 2. Column additions to existing tables

None strictly required. The `ai_usage_log` table can optionally gain `job_id` and `stage` columns to attribute prep spend to a job/stage:

```sql
alter table public.ai_usage_log add column if not exists job_id uuid;
alter table public.ai_usage_log add column if not exists stage text;
create index if not exists ai_usage_log_job_stage_idx on public.ai_usage_log (job_id, stage, created_at desc);
```

This keeps usage tracking in the existing table (no parallel usage mechanism).

## 3. `public.can()` additions

Add a `p_action LIKE 'ai.prep.%'` arm to `public.can()` (in the Phase 8E migration pattern), following the same truth table as `ai.generate_questions`:

| Action | Resource | Rule |
|---|---|---|
| `ai.prep_upload` | null | host capability (create) |
| `ai.prep_document` | prep_documents.id | owner of document AND host-capable |
| `ai.prep_job` | prep_jobs.id | owner of job AND host-capable |
| `ai.prep_generate` | prep_jobs.id | owner of job AND host-capable |
| `ai.prep_publish` | prep_drafts.id | owner of draft's job AND host-capable |
| unknown `ai.prep.*` | — | deny |

Resource resolution: `prep_jobs` → `prep_documents.owner_principal_id`; `prep_drafts` → `prep_jobs.owner_principal_id`.

## 4. Migration plan

File: `supabase/migrations/2026XXXXXXXXXXXX_phase_10_ai_quiz_prep.sql` (single migration, per the repo's one-file-per-change convention; add a marker entry to `scripts/migration-markers.mjs`).

**Apply order:** filename-ordered; each in its own transaction; stops on first failure (existing `bun scripts/migrate.mjs` behavior).

1. Create the five new tables + indexes + RLS + owner-read policies.
2. Optional: add `job_id`/`stage` to `ai_usage_log`.
3. `CREATE OR REPLACE public.can(...)` adding the `ai.prep.*` arm (canonical definition, re-defining the function as Phase 8E did).
4. Revoke/execute grants mirroring `ai_usage_log`: `REVOKE ALL ON FUNCTION public.can(...) FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;` (unchanged for `can` since it's already service_role-only).

**Rollback:** drop the five tables and the `ai_usage_log` columns; `can()` reverts to its prior definition (re-deploy the Phase 8E `can()` body). No existing table data depends on the new tables.

## 5. Why new persistence is justified

- Existing AI drafts are **client state only** and lost on refresh (acknowledged in BRAINBOLT_AI_ARCHITECTURE.md §8). That is unacceptable for a multi-stage PDF prep job that can span minutes and multiple page refreshes.
- No existing table tracks document ownership, per-stage status, or page/section provenance.
- `questions`/`quizzes` are the final persistence target (approved questions only); prep drafts live in `prep_drafts` until host approval, then flow into `questions` via the existing insert path. No duplication of the question schema — `prep_drafts.questions` holds canonical `BrainBoltQuestion[]` JSON.
