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
  status            text not null default 'uploaded' -- uploaded|extracting|extracted|ocr|failed
    constraint prep_documents_status_check check (status in ('uploaded','extracting','extracted','ocr','failed')),
  version           integer not null default 1,       -- increments on re-upload of same logical doc
  needs_ocr         boolean not null default false,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists prep_documents_owner_idx
  on public.prep_documents (owner_principal_id, created_at desc);

alter table public.prep_documents enable row level security;

drop policy if exists prep_documents_owner_read on public.prep_documents;
create policy prep_documents_owner_read on public.prep_documents
  for select
  using (owner_principal_id = public.current_principal_id());

comment on table public.prep_documents is 'One uploaded source document (PDF/image), owner-scoped.';
comment on column public.prep_documents.object_key is 'Object key in the quiz-prep-documents private storage bucket.';
comment on column public.prep_documents.version is 'Increments when the same logical document is re-uploaded.';
comment on column public.prep_documents.needs_ocr is 'True when the document has no extractable native text and requires multimodal OCR.';

-- ############################################################################
-- 2. prep_jobs
-- ############################################################################

create table if not exists public.prep_jobs (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references public.prep_documents(id) on delete cascade,
  quiz_id            uuid references public.quizzes(id) on delete set null, -- target quiz, nullable until host adds questions
  owner_principal_id uuid not null references public.principals(id),
  status             text not null default 'pending' -- pending|running|paused|completed|failed|cancelled
    constraint prep_jobs_status_check check (status in ('pending','running','paused','completed','failed','cancelled')),
  current_stage      text, -- document_extract|document_ocr|media_interpretation|content_map|host_blueprint|question_generate|validate|quality_review|draft_assembled|complete
  progress_pct       integer not null default 0
    constraint prep_jobs_progress_pct_check check (progress_pct >= 0 and progress_pct <= 100),
  error              text,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index if not exists prep_jobs_owner_idx on public.prep_jobs (owner_principal_id, created_at desc);
create index if not exists prep_jobs_document_idx on public.prep_jobs (document_id);

alter table public.prep_jobs enable row level security;

drop policy if exists prep_jobs_owner_read on public.prep_jobs;
create policy prep_jobs_owner_read on public.prep_jobs
  for select
  using (owner_principal_id = public.current_principal_id());

comment on table public.prep_jobs is 'One resumable preparation run from a source document to a quiz draft.';
comment on column public.prep_jobs.current_stage is 'The most recent pipeline stage (extract, ocr, map, blueprint, generate, validate, quality, draft, complete).';
comment on column public.prep_jobs.progress_pct is 'Client-visible progress percentage, 0-100.';

-- ############################################################################
-- 3. prep_job_stages
-- ############################################################################

create table if not exists public.prep_job_stages (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.prep_jobs(id) on delete cascade,
  stage          text not null,
  attempt        integer not null default 1,
  status         text not null default 'pending' -- pending|running|succeeded|failed|skipped
    constraint prep_job_stages_status_check check (status in ('pending','running','succeeded','failed','skipped')),
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

drop policy if exists prep_job_stages_owner_read on public.prep_job_stages;
create policy prep_job_stages_owner_read on public.prep_job_stages
  for select
  using (exists (
    select 1 from public.prep_jobs j
    where j.id = prep_job_stages.job_id
      and j.owner_principal_id = public.current_principal_id()
  ));

comment on table public.prep_job_stages is 'One stage attempt within a preparation job.';
comment on column public.prep_job_stages.attempt is 'Incremented each time a stage is retried.';
comment on column public.prep_job_stages.output_summary is 'Stage-specific result payload (e.g. per-page text, generated question list).';

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

drop policy if exists prep_sources_owner_read on public.prep_sources;
create policy prep_sources_owner_read on public.prep_sources
  for select
  using (exists (
    select 1 from public.prep_jobs j
    where j.id = prep_sources.job_id
      and j.owner_principal_id = public.current_principal_id()
  ));

comment on table public.prep_sources is 'Provenance: page/section/excerpt anchor linking each drafted question to its source.';
comment on column public.prep_sources.confidence is 'Extraction/interpretation confidence 0..1, null when unavailable.';

-- ############################################################################
-- 5. prep_drafts
-- ############################################################################

create table if not exists public.prep_drafts (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.prep_jobs(id) on delete cascade,
  quiz_id        uuid references public.quizzes(id) on delete set null,
  title          text not null,
  questions      jsonb not null, -- canonical BrainBoltQuestion[] shape (validated)
  status         text not null default 'pending_review' -- pending_review|approved|rejected|superseded
    constraint prep_drafts_status_check check (status in ('pending_review','approved','rejected','superseded')),
  created_at     timestamptz not null default now(),
  approved_at    timestamptz
);

create index if not exists prep_drafts_job_idx on public.prep_drafts (job_id);
create index if not exists prep_drafts_quiz_idx on prep_drafts (quiz_id);

alter table public.prep_drafts enable row level security;

drop policy if exists prep_drafts_owner_read on public.prep_drafts;
create policy prep_drafts_owner_read on public.prep_drafts
  for select
  using (exists (
    select 1 from public.prep_jobs j
    where j.id = prep_drafts.job_id
      and j.owner_principal_id = public.current_principal_id()
  ));

comment on table public.prep_drafts is 'Assembled host-reviewable draft. Becomes approved when published to the questions table.';
comment on column public.prep_drafts.questions is 'Canonical BrainBoltQuestion[] JSON, validated by validateQuiz before insert.';

-- ############################################################################
-- 6. ai_usage_log: job_id / stage attribution
-- ############################################################################

alter table public.ai_usage_log add column if not exists job_id uuid;
alter table public.ai_usage_log add column if not exists stage text;
create index if not exists ai_usage_log_job_stage_idx
  on public.ai_usage_log (job_id, stage, created_at desc);

-- ############################################################################
-- 7. updated_at triggers
-- ############################################################################

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists prep_documents_set_updated_at on public.prep_documents;
create trigger prep_documents_set_updated_at
  before update on public.prep_documents
  for each row
  execute function public.set_updated_at();

drop trigger if exists prep_jobs_set_updated_at on public.prep_jobs;
create trigger prep_jobs_set_updated_at
  before update on public.prep_jobs
  for each row
  execute function public.set_updated_at();

-- ############################################################################
-- 8. public.can(...) — ai.prep.* arm
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

create or replace function public.can(p_principal uuid, p_action text, p_resource uuid default null::uuid)
returns boolean
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare
  v_user  uuid;
  v_admin boolean;
  v_host  boolean;
  v_owner boolean := false;
begin
  if p_principal is null then
    return false;
  end if;

  select p.user_id into v_user
  from public.principals p
  where p.type = 'user' and (p.id = p_principal or p.user_id = p_principal)
  limit 1;

  if v_user is null then
    v_user := p_principal;
  end if;

  v_admin := public.has_role(v_user, 'admin');

  if p_action like 'admin.%' then
    return v_admin;
  end if;

  v_host := v_admin
         or public.has_role(v_user, 'host')
         or public.has_active_host_authorization(v_user);

  if p_action in ('quiz.create','competition.create','league.create','branding.create','session.host','ai.prep_upload') then
    return v_host;
  end if;

  if p_resource is null then
    return false;
  end if;

  if p_action in ('quiz.edit','quiz.delete') then
    select exists (
      select 1 from public.quizzes q
      where q.id = p_resource
        and q.owner_principal_id = public.principal_for_user(v_user)
    ) into v_owner;
  elsif p_action = 'competition.manage' then
    select exists (
      select 1 from public.competitions c
      where c.id = p_resource
        and c.owner_principal_id = public.principal_for_user(v_user)
    ) into v_owner;
  elsif p_action = 'league.manage' then
    select exists (
      select 1 from public.leagues l
      where l.id = p_resource
        and l.owner_principal_id = public.principal_for_user(v_user)
    ) into v_owner;
  elsif p_action = 'branding.manage' then
    select exists (
      select 1 from public.branding_profiles b
      where b.id = p_resource
        and b.owner_principal_id = public.principal_for_user(v_user)
    ) into v_owner;
  elsif p_action = 'session.manage' then
    select exists (select 1 from public.sessions s where s.id = p_resource and s.host_id = v_user) into v_owner;
  elsif p_action like 'ai.%' then
    if p_action = 'ai.generate_questions' then
      select exists (
        select 1 from public.quizzes q
        where q.id = p_resource
          and q.owner_principal_id = public.principal_for_user(v_user)
      ) into v_owner;
    else
      return false;
    end if;
  elsif p_action like 'ai.prep.%' then
    -- Phase 10 AI Quiz Preparation: prep capabilities are owner-scoped.
    if p_action = 'ai.prep_document' then
      select exists (
        select 1 from public.prep_documents d
        where d.id = p_resource
          and d.owner_principal_id = public.principal_for_user(v_user)
      ) into v_owner;
    elsif p_action = 'ai.prep_job' or p_action = 'ai.prep_generate' then
      select exists (
        select 1 from public.prep_jobs j
        join public.prep_documents d on d.id = j.document_id
        where j.id = p_resource
          and d.owner_principal_id = public.principal_for_user(v_user)
      ) into v_owner;
    elsif p_action = 'ai.prep_publish' then
      select exists (
        select 1 from public.prep_drafts df
        join public.prep_jobs j on j.id = df.job_id
        join public.prep_documents d on d.id = j.document_id
        where df.id = p_resource
          and d.owner_principal_id = public.principal_for_user(v_user)
      ) into v_owner;
    else
      -- Unknown ai.prep.* action: deny. Add new actions explicitly here.
      return false;
    end if;
  else
    return false;
  end if;

  return v_owner and v_host;
end;
$$;

revoke all on function public.can(uuid, text, uuid) from PUBLIC, anon, authenticated;
grant execute on function public.can(uuid, text, uuid) to service_role;
