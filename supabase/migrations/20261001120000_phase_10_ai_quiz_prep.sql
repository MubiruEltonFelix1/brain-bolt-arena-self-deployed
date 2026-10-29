-- Phase 10 — AI Quiz Preparation (document-to-quiz pipeline).
--
-- Companion to the Phase 8E AI Question Builder (20260822120000_phase_8e_ai_question_builder.sql).
--
-- What this migration adds:
--   1. public.prep_documents — one uploaded source document (PDF/image), owner-scoped.
--   2. public.prep_jobs — one resumable preparation run (document -> quiz draft).
--   3. public.prep_job_stages — one stage attempt within a job (extract/ocr/interpret/map/blueprint/generate/validate/quality/draft).
--   4. public.prep_sources — provenance: page/section/excerpt anchor for each drafted question.
--   5. public.prep_drafts — assembled host-reviewable draft (canonical BrainBoltQuestion[] JSON).
--   6. public.ai_usage_log.job_id / .stage columns (prep spend attribution; nullable, indexed).
--   7. public.can(...) — ai.prep.* arm mirroring the ai.generate_questions arm (owner + host-capable).
--
-- All new tables: RLS enabled, owner-read policies only. No authenticated INSERT/UPDATE/DELETE
-- policy — writes go through supabaseAdmin inside server fns after a can() check, matching the
-- ai_usage_log convention. Unknown ai.prep.* actions are denied by default.

-- ############################################################################
-- 1. prep_documents
-- ############################################################################

create table if not exists public.prep_documents (
  id                uuid primary key default gen_random_uuid(),
  owner_principal_id uuid not null references public.principals(id),
  bucket            text not null default 'quiz-prep-documents',
  object_key        text not null,
  mime_type         text not null,
  size_bytes        bigint not null,
  page_count        integer,
  status            text not null default 'uploaded', -- uploaded|extracting|extracted|ocr|failed
  version           integer not null default 1,       -- increments on re-upload of same logical doc
  needs_ocr         boolean not null default false,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists prep_documents_owner_idx
  on public.prep_documents (owner_principal_id, created_at desc);

alter table public.prep_documents enable row level security;

create policy prep_documents_owner_read on public.prep_documents
  for select
  using (owner_principal_id = public.current_principal_id());

-- ############################################################################
-- 2. prep_jobs
-- ############################################################################

create table if not exists public.prep_jobs (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references public.prep_documents(id) on delete cascade,
  quiz_id            uuid references public.quizzes(id) on delete set null, -- target quiz, nullable until host adds questions
  owner_principal_id uuid not null references public.principals(id),
  status             text not null default 'pending', -- pending|running|paused|completed|failed|cancelled
  current_stage      text, -- document_extract|document_ocr|media_interpretation|content_map|host_blueprint|question_generate|validate|quality_review|draft_assembled|complete
  progress_pct       integer not null default 0,
  error              text,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index if not exists prep_jobs_owner_idx on public.prep_jobs (owner_principal_id, created_at desc);
create index if not exists prep_jobs_document_idx on public.prep_jobs (document_id);

alter table public.prep_jobs enable row level security;

create policy prep_jobs_owner_read on public.prep_jobs
  for select
  using (owner_principal_id = public.current_principal_id());

-- ############################################################################
-- 3. prep_job_stages
-- ############################################################################

create table if not exists public.prep_job_stages (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.prep_jobs(id) on delete cascade,
  stage          text not null,
  attempt        integer not null default 1,
  status         text not null default 'pending', -- pending|running|succeeded|failed|skipped
  retry_count    integer not null default 0,
  input_summary  jsonb,
  output_summary jsonb,
  error          text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists prep_job_stages_job_idx on public.prep_job_stages (job_id, created_at);

alter table public.prep_job_stages enable row level security;

create policy prep_job_stages_owner_read on public.prep_job_stages
  for select
  using (exists (
    select 1 from public.prep_jobs j
    where j.id = prep_job_stages.job_id
      and j.owner_principal_id = public.current_principal_id()
  ));

-- ############################################################################
-- 4. prep_sources
-- ############################################################################

create table if not exists public.prep_sources (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.prep_jobs(id) on delete cascade,
  question_index integer not null, -- index within the assembled draft
  document_id    uuid not null references public.prep_documents(id),
  version        integer not null, -- doc version the question was grounded in
  page           integer not null,
  section        text,
  excerpt        text not null, -- supporting excerpt (host-visible citation)
  confidence     numeric(3,2), -- extraction/interpretation confidence 0..1
  created_at     timestamptz not null default now()
);

create index if not exists prep_sources_job_idx on public.prep_sources (job_id, question_index);

alter table public.prep_sources enable row level security;

create policy prep_sources_owner_read on public.prep_sources
  for select
  using (exists (
    select 1 from public.prep_jobs j
    where j.id = prep_sources.job_id
      and j.owner_principal_id = public.current_principal_id()
  ));

-- ############################################################################
-- 5. prep_drafts
-- ############################################################################

create table if not exists public.prep_drafts (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.prep_jobs(id) on delete cascade,
  quiz_id        uuid references public.quizzes(id) on delete set null,
  title          text not null,
  questions      jsonb not null, -- canonical BrainBoltQuestion[] shape (validated)
  status         text not null default 'pending_review', -- pending_review|approved|rejected|superseded
  created_at     timestamptz not null default now(),
  approved_at    timestamptz
);

create index if not exists prep_drafts_job_idx on public.prep_drafts (job_id);
create index if not exists prep_drafts_quiz_idx on prep_drafts (quiz_id);

alter table public.prep_drafts enable row level security;

create policy prep_drafts_owner_read on public.prep_drafts
  for select
  using (exists (
    select 1 from public.prep_jobs j
    where j.id = prep_drafts.job_id
      and j.owner_principal_id = public.current_principal_id()
  ));

-- ############################################################################
-- 6. ai_usage_log: job_id / stage attribution
-- ############################################################################

alter table public.ai_usage_log add column if not exists job_id uuid;
alter table public.ai_usage_log add column if not exists stage text;
create index if not exists ai_usage_log_job_stage_idx
  on public.ai_usage_log (job_id, stage, created_at desc);

-- ############################################################################
-- 7. public.can(...) — ai.prep.* arm
-- ############################################################################
-- Re-defines public.can(...) so this migration is the canonical Phase 10
-- definition (mirrors the Phase 8E pattern). Byte-identical to the Phase 8E
-- version with one new ELSIF arm for ai.prep.*.
--
-- Truth table:
--   ai.prep_upload     : resource null  -> host capability (create)
--   ai.prep_document   : prep_documents.id -> owner of document + host-capable
--   ai.prep_job        : prep_jobs.id    -> owner of job + host-capable
--   ai.prep_generate   : prep_jobs.id    -> owner of job + host-capable
--   ai.prep_publish    : prep_drafts.id  -> owner of draft's job + host-capable
--   unknown ai.prep.*  :                 -> deny
--
-- Resource resolution: prep_jobs -> prep_documents.owner_principal_id;
-- prep_drafts -> prep_jobs.owner_principal_id.

CREATE OR REPLACE FUNCTION public.can(p_principal uuid, p_action text, p_resource uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user  uuid;
  v_admin boolean;
  v_host  boolean;
  v_owner boolean := false;
BEGIN
  IF p_principal IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.user_id INTO v_user
  FROM public.principals p
  WHERE p.type = 'user' AND (p.id = p_principal OR p.user_id = p_principal)
  LIMIT 1;

  IF v_user IS NULL THEN
    v_user := p_principal;
  END IF;

  v_admin := public.has_role(v_user, 'admin');

  IF p_action LIKE 'admin.%' THEN
    RETURN v_admin;
  END IF;

  v_host := v_admin
         OR public.has_role(v_user, 'host')
         OR public.has_active_host_authorization(v_user);

  IF p_action IN ('quiz.create','competition.create','league.create','branding.create','session.host') THEN
    RETURN v_host;
  END IF;

  IF p_resource IS NULL THEN
    RETURN false;
  END IF;

  IF p_action IN ('quiz.edit','quiz.delete') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.quizzes q
      WHERE q.id = p_resource
        AND q.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'competition.manage' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.competitions c
      WHERE c.id = p_resource
        AND c.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'league.manage' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.leagues l
      WHERE l.id = p_resource
        AND l.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'branding.manage' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.branding_profiles b
      WHERE b.id = p_resource
        AND b.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'session.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = p_resource AND s.host_id = v_user) INTO v_owner;
  ELSIF p_action LIKE 'ai.%' THEN
    IF p_action = 'ai.generate_questions' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.quizzes q
        WHERE q.id = p_resource
          AND q.owner_principal_id = public.principal_for_user(v_user)
      ) INTO v_owner;
    ELSE
      RETURN false;
    END IF;
  ELSIF p_action LIKE 'ai.prep.%' THEN
    -- Phase 10 AI Quiz Preparation: prep capabilities are owner-scoped.
    IF p_action = 'ai.prep_upload' THEN
      -- Upload is a create action: resource is null, gated on host capability.
      RETURN v_host;
    ELSIF p_action = 'ai.prep_document' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.prep_documents d
        WHERE d.id = p_resource
          AND d.owner_principal_id = public.principal_for_user(v_user)
      ) INTO v_owner;
    ELSIF p_action = 'ai.prep_job' OR p_action = 'ai.prep_generate' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.prep_jobs j
        JOIN public.prep_documents d ON d.id = j.document_id
        WHERE j.id = p_resource
          AND d.owner_principal_id = public.principal_for_user(v_user)
      ) INTO v_owner;
    ELSIF p_action = 'ai.prep_publish' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.prep_drafts df
        JOIN public.prep_jobs j ON j.id = df.job_id
        JOIN public.prep_documents d ON d.id = j.document_id
        WHERE df.id = p_resource
          AND d.owner_principal_id = public.principal_for_user(v_user)
      ) INTO v_owner;
    ELSE
      -- Unknown ai.prep.* action: deny. Add new actions explicitly here.
      RETURN false;
    END IF;
  ELSE
    RETURN false;
  END IF;

  RETURN v_owner AND v_host;
END;
$$;

REVOKE ALL ON FUNCTION public.can(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can(uuid, text, uuid) TO service_role;
