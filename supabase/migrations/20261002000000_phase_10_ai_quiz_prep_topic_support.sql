-- Phase 10 — AI Quiz Preparation: topic-based job support.
--
-- Companion to 20261001120000_phase_10_ai_quiz_prep.sql (the document-to-quiz
-- pipeline). This migration extends prep_jobs so a preparation run can be
-- backed by a free-text topic instead of an uploaded document, enabling one
-- unified creation workflow without creating an empty quiz first.
--
-- All changes are additive:
--   1. prep_jobs.topic — nullable text; the topic for topic-based jobs.
--   2. prep_jobs.document_id — made nullable; topic-based jobs have no document.
--   3. public.can(...) — prep.* arms now check prep_jobs.owner_principal_id
--      directly (already on the table) instead of joining through
--      prep_documents, so topic-based jobs (null document_id) resolve
--      ownership correctly.
--
-- Existing document-based jobs are unaffected: document_id stays NOT NULL
-- for them (the column becomes nullable but existing rows keep their values),
-- and topic stays NULL.

-- ############################################################################
-- 1. prep_jobs: add topic column, make document_id nullable
-- ############################################################################

alter table public.prep_jobs
  alter column document_id drop not null;

alter table public.prep_jobs
  add column if not exists topic text;

comment on column public.prep_jobs.topic is
  'Free-text topic for topic-based preparation jobs. NULL for document-backed jobs.';

-- ############################################################################
-- 2. public.can(...) — prep.* arms: check prep_jobs.owner_principal_id directly
-- ############################################################################
--
-- Re-defines public.can(...) so this migration is the canonical definition.
-- The body is byte-identical to the Phase 10 version except the
-- ai.prep_job / ai.prep_generate / ai.prep_publish arms no longer join
-- through prep_documents. This lets topic-based jobs (null document_id)
-- resolve ownership via prep_jobs.owner_principal_id, which is already
-- populated for every job.

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
    -- Ownership is resolved via prep_jobs.owner_principal_id directly so that
    -- topic-based jobs (no document) are covered.
    if p_action = 'ai.prep_document' then
      select exists (
        select 1 from public.prep_documents d
        where d.id = p_resource
          and d.owner_principal_id = public.principal_for_user(v_user)
      ) into v_owner;
    elsif p_action = 'ai.prep_job' or p_action = 'ai.prep_generate' then
      select exists (
        select 1 from public.prep_jobs j
        where j.id = p_resource
          and j.owner_principal_id = public.principal_for_user(v_user)
      ) into v_owner;
    elsif p_action = 'ai.prep_publish' then
      select exists (
        select 1 from public.prep_drafts df
        join public.prep_jobs j on j.id = df.job_id
        where df.id = p_resource
          and j.owner_principal_id = public.principal_for_user(v_user)
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
