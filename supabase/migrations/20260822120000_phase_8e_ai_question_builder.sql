-- Phase 8E — AI Question Builder: ai_usage_log table + ai.* capability branch.
--
-- Companion to 20260820090000_phase_8e_geo_region_grading.sql (which adds geo_region
-- polygon grading for map_pin questions). Same 8E phase, different sub-feature.
--
-- What this migration adds:
--   1. public.ai_usage_log table — one row per generateQuestions / regenerateQuestion
--      call. Principal-aware (FK to public.principals). RLS: enabled, no policy =>
--      INSERT/UPDATE/DELETE/SELECT denied for everyone except service_role (which
--      bypasses RLS). Phase 16 Mission Control may surface aggregates later.
--   2. New ELSIF p_action LIKE 'ai.%' arm inside the existing public.can(...)
--      function (defined in 20260816124500_phase_7l_authorization_completion.sql
--      and re-defined here as CREATE OR REPLACE so this migration is the canonical
--      Phase 8E definition). Same truth table as quiz.edit (principal owner of the
--      resource + host-capable) so AI spend is gated by the same controls as
--      editing the quiz itself.

-- ############################################################################
-- 1. ai_usage_log
-- ############################################################################

create table if not exists public.ai_usage_log (
  id                  uuid primary key default gen_random_uuid(),
  principal_id        uuid not null references public.principals(id),
  capability          text not null,
  model               text not null,
  prompt_version      text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  latency_ms          integer not null default 0,
  estimated_cost_usd  numeric(10,6) not null default 0,
  success             boolean not null,
  error_kind          text,
  created_at          timestamptz not null default now(),
  -- Error kinds are a closed set; lock it down at the DB layer so a typo in
  -- the AI service can't silently write garbage.
  constraint ai_usage_log_error_kind_chk check (
    error_kind is null or error_kind in (
      'provider_unavailable',
      'provider_timeout',
      'provider_rate_limited',
      'invalid_output',
      'validation_failed',
      'over_limit',
      'not_authorized',
      'unknown'
    )
  )
);

create index if not exists ai_usage_log_principal_created_idx
  on public.ai_usage_log (principal_id, created_at desc);

create index if not exists ai_usage_log_capability_created_idx
  on public.ai_usage_log (capability, created_at desc);

alter table public.ai_usage_log enable row level security;

-- No explicit policy => INSERT/UPDATE/DELETE/SELECT denied for everyone except
-- service_role (which bypasses RLS). The createServerFn writes via supabaseAdmin.

-- ############################################################################
-- 2. public.can(...) — add ai.* branch
-- ----------------------------------------------------------------------------
-- The Phase 7L function is re-defined here so this migration is the canonical
-- Phase 8E definition (the marker probe reads this version). The body is
-- byte-identical to the Phase 7L version with one new ELSIF arm for ai.*.
--
-- The new arm follows the same shape as the existing quiz.edit arm: principal
-- owner of the resource (currently only quizzes are supported) AND host-capable
-- (v_host already computed above the IF chain from admin/host role/grant).
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
    -- Phase 7L: principal-only ownership (legacy owner_id fallback removed)
    SELECT EXISTS (
      SELECT 1 FROM public.quizzes q
      WHERE q.id = p_resource
        AND q.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'competition.manage' THEN
    -- Phase 7L: principal-only ownership (legacy owner_id fallback removed)
    SELECT EXISTS (
      SELECT 1 FROM public.competitions c
      WHERE c.id = p_resource
        AND c.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'league.manage' THEN
    -- Phase 7L: principal-only ownership (legacy owner_id fallback removed)
    SELECT EXISTS (
      SELECT 1 FROM public.leagues l
      WHERE l.id = p_resource
        AND l.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'branding.manage' THEN
    -- Phase 7L: principal-only ownership (legacy owner_id fallback removed)
    SELECT EXISTS (
      SELECT 1 FROM public.branding_profiles b
      WHERE b.id = p_resource
        AND b.owner_principal_id = public.principal_for_user(v_user)
    ) INTO v_owner;
  ELSIF p_action = 'session.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = p_resource AND s.host_id = v_user) INTO v_owner;
  ELSIF p_action LIKE 'ai.%' THEN
    -- Phase 8E AI Builder: AI capabilities are scoped to a target resource.
    -- Currently only quiz is supported. Same truth table as quiz.edit
    -- (principal owner of the resource + host-capable, where host-capable
    -- is already computed into v_host above) but tagged separately so the
    -- ai_usage_log can attribute spend.
    --
    -- The v_host check is folded into the final RETURN v_owner AND v_host
    -- below, mirroring the quiz.edit branch.
    IF p_action = 'ai.generate_questions' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.quizzes q
        WHERE q.id = p_resource
          AND q.owner_principal_id = public.principal_for_user(v_user)
      ) INTO v_owner;
    ELSE
      -- Unknown ai.* action: deny. Add new actions explicitly here as they
      -- are introduced (ai.regenerate_question, ai.analyze_quiz, etc).
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