-- ============================================================================
-- Phase 7L-1: Principal-aware authorization completion
-- ----------------------------------------------------------------------------
-- Complements Phases 7H-7K (ownership columns + backfill + trigger + RLS
-- cutover on branding_profiles / leagues / quizzes / competitions) by making
-- owner_principal_id the AUTHORITATIVE ownership model everywhere:
--
--   1. Pre-flight integrity verification (HARD STOP on any anomaly).
--   2. Sync triggers become BIDIRECTIONAL: owner_principal_id drives the
--      legacy owner_id mirror; owner_id-only writes (transitional legacy
--      writers) still derive the principal. Safe in BOTH directions, so the
--      application can switch its writes to owner_principal_id with no
--      deployment window.
--   3. public.can(...): all four ownership-sensitive capabilities
--      (quiz.edit, quiz.delete, competition.manage, league.manage,
--      branding.manage) resolve ownership through the principal ONLY.
--      The legacy owner_id fallback branches are removed — provably dead
--      once the integrity check below passes (no NULL owner_principal_id can
--      exist, and the triggers keep it that way).
--   4. RLS completion: every remaining true ownership policy on the four
--      ownership-bearing tables (and their child tables questions,
--      league_quizzes, league_standings) becomes principal-aware, including
--      WITH CHECK clauses that previously stayed auth.uid() = owner_id.
--   5. RPC resolution migration: every remaining owner_id reference in
--      stored functions (prepare_competition_session[_internal],
--      list_due_competitions, can_view_league, get_arena_quiz_detail,
--      get_arena_quizzes) moves to owner_principal_id. All are
--      decision-equivalent: user principals are id-identical to auth users,
--      so the resolved rows/values are byte-identical.
--
-- FROZEN INVARIANTS (unchanged by this migration):
--   * gameplay, timing, realtime, Arena, autonomous competition execution,
--     League standings calculation, CompetitionResults, guest claiming,
--     question rendering, scheduler behaviour
--   * admin capability rules, host rules, create capability rules,
--     session runtime capability rules (session.manage stays host_id-based)
--   * sessions.host_id, participants.profile_id,
--     competition_results.profile_id, user_roles.user_id, attribution fields
--   * No Organizations introduced; no Principal model redesign;
--     no new ownership primitive.
--
-- The legacy owner_id columns are NOT dropped here. They remain, maintained
-- as a mirror by the bidirectional triggers, until Phase 7L-3 retires them
-- (after the application has stopped referencing them entirely).
-- ============================================================================

-- ############################################################################
-- 1. Pre-flight integrity verification — HARD STOP
-- ----------------------------------------------------------------------------
-- Fails the migration if any row on any of the four tables lacks a principal,
-- has drifted from its legacy owner, maps to a non-user principal, or maps
-- ambiguously — or if any session host has drifted from its competition's
-- owner. All columns are untouched until this passes, so a failure is fully
-- recoverable (fix the offending rows and re-run).
DO $$
DECLARE
  v_missing_b int; v_missing_l int; v_missing_q int; v_missing_c int;
  v_drift_b   int; v_drift_l   int; v_drift_q   int; v_drift_c   int;
  v_badtype   int; v_dup       int; v_host_mismatch int;
BEGIN
  SELECT count(*) INTO v_missing_b FROM public.branding_profiles WHERE owner_principal_id IS NULL;
  SELECT count(*) INTO v_missing_l FROM public.leagues          WHERE owner_principal_id IS NULL;
  SELECT count(*) INTO v_missing_q FROM public.quizzes          WHERE owner_principal_id IS NULL;
  SELECT count(*) INTO v_missing_c FROM public.competitions     WHERE owner_principal_id IS NULL;

  SELECT count(*) INTO v_drift_b FROM public.branding_profiles WHERE owner_principal_id IS DISTINCT FROM owner_id;
  SELECT count(*) INTO v_drift_l FROM public.leagues          WHERE owner_principal_id IS DISTINCT FROM owner_id;
  SELECT count(*) INTO v_drift_q FROM public.quizzes          WHERE owner_principal_id IS DISTINCT FROM owner_id;
  SELECT count(*) INTO v_drift_c FROM public.competitions     WHERE owner_principal_id IS DISTINCT FROM owner_id;

  SELECT count(*) INTO v_badtype FROM (
    SELECT p.id FROM public.principals p
    JOIN public.branding_profiles b ON b.owner_principal_id = p.id
    WHERE p.type <> 'user'
    UNION ALL
    SELECT p.id FROM public.principals p
    JOIN public.leagues l ON l.owner_principal_id = p.id
    WHERE p.type <> 'user'
    UNION ALL
    SELECT p.id FROM public.principals p
    JOIN public.quizzes q ON q.owner_principal_id = p.id
    WHERE p.type <> 'user'
    UNION ALL
    SELECT p.id FROM public.principals p
    JOIN public.competitions c ON c.owner_principal_id = p.id
    WHERE p.type <> 'user'
  ) bad;

  SELECT count(*) INTO v_dup FROM (
    SELECT owner_id FROM public.branding_profiles GROUP BY owner_id HAVING count(DISTINCT owner_principal_id) > 1
    UNION ALL
    SELECT owner_id FROM public.leagues GROUP BY owner_id HAVING count(DISTINCT owner_principal_id) > 1
    UNION ALL
    SELECT owner_id FROM public.quizzes GROUP BY owner_id HAVING count(DISTINCT owner_principal_id) > 1
    UNION ALL
    SELECT owner_id FROM public.competitions GROUP BY owner_id HAVING count(DISTINCT owner_principal_id) > 1
  ) dups;

  SELECT count(*) INTO v_host_mismatch
    FROM public.sessions s
    JOIN public.competitions c ON c.session_id = s.id
   WHERE s.host_id IS DISTINCT FROM c.owner_id;

  IF v_missing_b > 0 OR v_missing_l > 0 OR v_missing_q > 0 OR v_missing_c > 0
     OR v_drift_b > 0 OR v_drift_l > 0 OR v_drift_q > 0 OR v_drift_c > 0
     OR v_badtype > 0 OR v_dup > 0 OR v_host_mismatch > 0 THEN
    RAISE EXCEPTION
      'Phase 7L-1 integrity check FAILED: missing(b=%,l=%,q=%,c=%) drift(b=%,l=%,q=%,c=%) non_user=% duplicate=% session_host_mismatch=%',
      v_missing_b, v_missing_l, v_missing_q, v_missing_c,
      v_drift_b, v_drift_l, v_drift_q, v_drift_c,
      v_badtype, v_dup, v_host_mismatch;
  END IF;
END $$;

-- ############################################################################
-- 2. Bidirectional ownership sync triggers
-- ----------------------------------------------------------------------------
-- owner_principal_id is now authoritative. The triggers:
--   * principal present  -> mirror the legacy owner_id (NULL for
--                           organization/platform/partner principals, which
--                           the user-id column cannot represent)
--   * only owner_id set  -> transitional legacy direction: derive the
--                           principal (unchanged behaviour for pre-deploy
--                           writers such as scripts or the MCP server)
--   * neither set        -> reject
-- A missing principal id raises (matching the previous drift-protection
-- behaviour); the FK on owner_principal_id additionally rejects bogus ids.
-- Once Phase 7L-2 removes these triggers, writes set owner_principal_id
-- directly and owner_id becomes a frozen historical column.
CREATE OR REPLACE FUNCTION public.tg_branding_sync_owner_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal uuid;
  v_user      uuid;
BEGIN
  IF NEW.owner_principal_id IS NOT NULL THEN
    SELECT p.user_id INTO v_user
    FROM public.principals p
    WHERE p.id = NEW.owner_principal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No principal exists for owner_principal_id %', NEW.owner_principal_id;
    END IF;
    -- user principals mirror their (id-identical) user id; organization /
    -- platform / partner principals have user_id NULL and mirror NULL — the
    -- legacy column cannot represent them.
    NEW.owner_id := v_user;
  ELSIF NEW.owner_id IS NOT NULL THEN
    SELECT p.id INTO v_principal
    FROM public.principals p
    WHERE p.type = 'user' AND p.user_id = NEW.owner_id;
    IF v_principal IS NULL THEN
      RAISE EXCEPTION 'No user principal exists for owner_id %', NEW.owner_id;
    END IF;
    NEW.owner_principal_id := v_principal;
  ELSE
    RAISE EXCEPTION 'Ownership requires owner_principal_id or owner_id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS branding_sync_owner_principal_trg ON public.branding_profiles;
CREATE TRIGGER branding_sync_owner_principal_trg
BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id ON public.branding_profiles
FOR EACH ROW EXECUTE FUNCTION public.tg_branding_sync_owner_principal();

CREATE OR REPLACE FUNCTION public.tg_leagues_sync_owner_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal uuid;
  v_user      uuid;
BEGIN
  IF NEW.owner_principal_id IS NOT NULL THEN
    SELECT p.user_id INTO v_user
    FROM public.principals p
    WHERE p.id = NEW.owner_principal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No principal exists for owner_principal_id %', NEW.owner_principal_id;
    END IF;
    -- user principals mirror their (id-identical) user id; organization /
    -- platform / partner principals have user_id NULL and mirror NULL — the
    -- legacy column cannot represent them.
    NEW.owner_id := v_user;
  ELSIF NEW.owner_id IS NOT NULL THEN
    SELECT p.id INTO v_principal
    FROM public.principals p
    WHERE p.type = 'user' AND p.user_id = NEW.owner_id;
    IF v_principal IS NULL THEN
      RAISE EXCEPTION 'No user principal exists for owner_id %', NEW.owner_id;
    END IF;
    NEW.owner_principal_id := v_principal;
  ELSE
    RAISE EXCEPTION 'Ownership requires owner_principal_id or owner_id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leagues_sync_owner_principal_trg ON public.leagues;
CREATE TRIGGER leagues_sync_owner_principal_trg
BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id ON public.leagues
FOR EACH ROW EXECUTE FUNCTION public.tg_leagues_sync_owner_principal();

CREATE OR REPLACE FUNCTION public.tg_quizzes_sync_owner_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal uuid;
  v_user      uuid;
BEGIN
  IF NEW.owner_principal_id IS NOT NULL THEN
    SELECT p.user_id INTO v_user
    FROM public.principals p
    WHERE p.id = NEW.owner_principal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No principal exists for owner_principal_id %', NEW.owner_principal_id;
    END IF;
    -- user principals mirror their (id-identical) user id; organization /
    -- platform / partner principals have user_id NULL and mirror NULL — the
    -- legacy column cannot represent them.
    NEW.owner_id := v_user;
  ELSIF NEW.owner_id IS NOT NULL THEN
    SELECT p.id INTO v_principal
    FROM public.principals p
    WHERE p.type = 'user' AND p.user_id = NEW.owner_id;
    IF v_principal IS NULL THEN
      RAISE EXCEPTION 'No user principal exists for owner_id %', NEW.owner_id;
    END IF;
    NEW.owner_principal_id := v_principal;
  ELSE
    RAISE EXCEPTION 'Ownership requires owner_principal_id or owner_id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quizzes_sync_owner_principal_trg ON public.quizzes;
CREATE TRIGGER quizzes_sync_owner_principal_trg
BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id ON public.quizzes
FOR EACH ROW EXECUTE FUNCTION public.tg_quizzes_sync_owner_principal();

CREATE OR REPLACE FUNCTION public.tg_competitions_sync_owner_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal uuid;
  v_user      uuid;
BEGIN
  IF NEW.owner_principal_id IS NOT NULL THEN
    SELECT p.user_id INTO v_user
    FROM public.principals p
    WHERE p.id = NEW.owner_principal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No principal exists for owner_principal_id %', NEW.owner_principal_id;
    END IF;
    -- user principals mirror their (id-identical) user id; organization /
    -- platform / partner principals have user_id NULL and mirror NULL — the
    -- legacy column cannot represent them.
    NEW.owner_id := v_user;
  ELSIF NEW.owner_id IS NOT NULL THEN
    SELECT p.id INTO v_principal
    FROM public.principals p
    WHERE p.type = 'user' AND p.user_id = NEW.owner_id;
    IF v_principal IS NULL THEN
      RAISE EXCEPTION 'No user principal exists for owner_id %', NEW.owner_id;
    END IF;
    NEW.owner_principal_id := v_principal;
  ELSE
    RAISE EXCEPTION 'Ownership requires owner_principal_id or owner_id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS competitions_sync_owner_principal_trg ON public.competitions;
CREATE TRIGGER competitions_sync_owner_principal_trg
BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id ON public.competitions
FOR EACH ROW EXECUTE FUNCTION public.tg_competitions_sync_owner_principal();

-- ############################################################################
-- 3. Capability resolver: principal-only ownership resolution
-- ----------------------------------------------------------------------------
-- ONLY the four ownership branches change. Admin rules, host rules, create
-- rules, session.manage, the principal->user resolution and NULL handling
-- are byte-identical to the Phase 7K version. The legacy fallback branches
-- are removed: the integrity check above proves every existing row has a
-- non-NULL owner_principal_id, and the triggers above guarantee that for
-- every future row.
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
  ELSE
    RETURN false;
  END IF;

  RETURN v_owner AND v_host;
END;
$$;

REVOKE ALL ON FUNCTION public.can(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can(uuid, text, uuid) TO service_role;

-- ############################################################################
-- 4. RLS completion — all remaining true ownership policies become
--    principal-aware. Only ownership expressions change; admin / host /
--    public-read / restrictive policies and the owner/host/public/participant
--    distinction are untouched.
-- ############################################################################

-- 4a. quizzes: principal-only USING and WITH CHECK (was auth.uid() = owner_id)
DROP POLICY IF EXISTS "quizzes manage own" ON public.quizzes;
CREATE POLICY "quizzes manage own" ON public.quizzes
FOR ALL
USING (owner_principal_id = public.principal_for_user(auth.uid()))
WITH CHECK (owner_principal_id = public.principal_for_user(auth.uid()));

-- 4b. competitions: principal-only USING and WITH CHECK (was auth.uid() = owner_id)
DROP POLICY IF EXISTS "Owners manage their competitions" ON public.competitions;
CREATE POLICY "Owners manage their competitions"
ON public.competitions FOR ALL TO authenticated
USING (owner_principal_id = public.principal_for_user(auth.uid()))
WITH CHECK (owner_principal_id = public.principal_for_user(auth.uid()));

-- 4c. branding_profiles INSERT: principal-aware WITH CHECK (create rule kept)
DROP POLICY IF EXISTS "Owner can insert own branding" ON public.branding_profiles;
CREATE POLICY "Owner can insert own branding"
ON public.branding_profiles FOR INSERT TO authenticated
WITH CHECK (
  owner_principal_id = public.current_principal_id()
  AND public.can('branding.create')
);

-- 4d. questions inherit quiz ownership (principal-only)
DROP POLICY IF EXISTS "questions manage by owner" ON public.questions;
CREATE POLICY "questions manage by owner" ON public.questions
FOR ALL
USING (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = questions.quiz_id
    AND q.owner_principal_id = public.principal_for_user(auth.uid())
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = questions.quiz_id
    AND q.owner_principal_id = public.principal_for_user(auth.uid())
));

DROP POLICY IF EXISTS "questions owner read" ON public.questions;
CREATE POLICY "questions owner read" ON public.questions
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = questions.quiz_id
    AND q.owner_principal_id = public.principal_for_user(auth.uid())
));

-- 4e. league_quizzes inherits league ownership (was l.owner_id / q.owner_id)
DROP POLICY IF EXISTS "league_quizzes read public or owner" ON public.league_quizzes;
CREATE POLICY "league_quizzes read public or owner" ON public.league_quizzes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.leagues l
      WHERE l.id = league_id
        AND (l.visibility = 'public' OR l.owner_principal_id = public.principal_for_user(auth.uid()))
    )
  );

DROP POLICY IF EXISTS "league_quizzes owner write" ON public.league_quizzes;
CREATE POLICY "league_quizzes owner write" ON public.league_quizzes
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = league_id AND l.owner_principal_id = public.principal_for_user(auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = league_id AND l.owner_principal_id = public.principal_for_user(auth.uid()))
    AND EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = quiz_id AND q.owner_principal_id = public.principal_for_user(auth.uid()))
  );

-- 4f. league_standings inherits league ownership (was l.owner_id)
DROP POLICY IF EXISTS "standings owner insert" ON public.league_standings;
CREATE POLICY "standings owner insert"
  ON public.league_standings FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.leagues l WHERE l.id = league_id AND l.owner_principal_id = public.principal_for_user(auth.uid())
  ));

DROP POLICY IF EXISTS "standings owner update" ON public.league_standings;
CREATE POLICY "standings owner update"
  ON public.league_standings FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.leagues l WHERE l.id = league_id AND l.owner_principal_id = public.principal_for_user(auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.leagues l WHERE l.id = league_id AND l.owner_principal_id = public.principal_for_user(auth.uid())
  ));

-- ############################################################################
-- 5. RPC resolution migration — every remaining owner_id reference moves to
--    owner_principal_id. All replacements are decision-equivalent: user
--    principals are id-identical to auth users, so resolved rows and values
--    are byte-identical. Behaviour (gates, exceptions, return shapes,
--    scheduling, Arena output) is unchanged.
-- ############################################################################

-- 5a. Session preparation (7K shape, COALESCE removed: the principal is
--     guaranteed non-NULL). sessions.host_id is still derived per competition;
--     host identity, join codes, quota/authorization rules unchanged.
CREATE OR REPLACE FUNCTION public.prepare_competition_session_internal(p_competition_id uuid, p_force boolean DEFAULT false)
RETURNS TABLE(session_id uuid, code text, status public.competition_status, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c public.competitions%ROWTYPE;
  v_code text; v_order jsonb; v_session_id uuid; v_count int; v_attempt int := 0;
BEGIN
  SELECT * INTO c FROM public.competitions WHERE id = p_competition_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Competition not found'; END IF;

  IF c.session_id IS NOT NULL THEN
    RETURN QUERY SELECT s.id, s.code, c.status, false FROM public.sessions s WHERE s.id = c.session_id;
    RETURN;
  END IF;

  IF c.status IN ('cancelled', 'completed') THEN
    RAISE EXCEPTION 'Competition is % and cannot open a lobby', c.status;
  END IF;
  IF c.status = 'running' THEN
    RAISE EXCEPTION 'Competition is already running without a linked session';
  END IF;

  IF NOT p_force THEN
    IF c.scheduled_start_at IS NULL THEN RAISE EXCEPTION 'Competition has no scheduled start time'; END IF;
    IF now() < c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds) THEN
      RAISE EXCEPTION 'Lobby time has not arrived yet';
    END IF;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.questions q JOIN public.quizzes z ON z.id = q.quiz_id
   WHERE q.quiz_id = c.quiz_id AND z.archived_at IS NULL;
  IF v_count = 0 THEN RAISE EXCEPTION 'Quiz is missing, archived, or has no questions'; END IF;

  SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
    FROM public.questions q WHERE q.quiz_id = c.quiz_id;

  LOOP
    v_attempt := v_attempt + 1;
    v_code := lpad((100000 + floor(random() * 900000))::int::text, 6, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.code = v_code);
    IF v_attempt > 20 THEN RAISE EXCEPTION 'Could not allocate a join code'; END IF;
  END LOOP;

  INSERT INTO public.sessions(quiz_id, host_id, code, status, league_id, branding_profile_id, question_order, autonomous)
  VALUES (c.quiz_id, c.owner_principal_id, v_code, 'lobby', c.league_id, c.branding_profile_id, v_order,
          COALESCE(c.autonomous, true) AND c.mode = 'scheduled' AND c.scheduled_start_at IS NOT NULL)
  RETURNING id INTO v_session_id;

  UPDATE public.competitions SET session_id = v_session_id, status = 'lobby_open' WHERE id = c.id;

  RETURN QUERY SELECT v_session_id, v_code, 'lobby_open'::public.competition_status, true;
END; $function$;

REVOKE ALL ON FUNCTION public.prepare_competition_session_internal(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- Public wrapper: owner gate reads the principal (decision-equivalent).
CREATE OR REPLACE FUNCTION public.prepare_competition_session(p_competition_id uuid, p_force boolean DEFAULT false)
RETURNS TABLE(session_id uuid, code text, status public.competition_status, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_principal_id INTO v_owner FROM public.competitions WHERE id = p_competition_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Competition not found'; END IF;
  IF NOT (v_owner = auth.uid() OR public.is_admin()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT * FROM public.prepare_competition_session_internal(p_competition_id, p_force);
END; $function$;

REVOKE ALL ON FUNCTION public.prepare_competition_session(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_competition_session(uuid, boolean) TO authenticated, service_role;

-- 5b. Autonomous-scheduler feed: owner scoping via principal (frozen query
--     shape; only the ownership comparison changes).
CREATE OR REPLACE FUNCTION public.list_due_competitions()
 RETURNS TABLE(id uuid, title text, scheduled_start_at timestamp with time zone, lobby_opens_at timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT c.id, c.title, c.scheduled_start_at,
         c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds)
    FROM public.competitions c
   WHERE c.status = 'scheduled'
     AND c.session_id IS NULL
     AND c.scheduled_start_at IS NOT NULL
     AND now() >= c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds)
     AND (c.owner_principal_id = public.principal_for_user(auth.uid()) OR public.is_admin())
   ORDER BY c.scheduled_start_at;
$function$;

REVOKE ALL ON FUNCTION public.list_due_competitions() FROM public;
GRANT EXECUTE ON FUNCTION public.list_due_competitions() TO authenticated, service_role;

-- 5c. League visibility gate: principal-aware owner branch (was l.owner_id)
CREATE OR REPLACE FUNCTION public.can_view_league(p_league_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id
      AND (l.visibility = 'public' OR l.owner_principal_id = public.principal_for_user(auth.uid()) OR public.is_admin())
  );
$function$;

GRANT EXECUTE ON FUNCTION public.can_view_league(uuid) TO anon, authenticated;

-- 5d. Arena attribution (creator_name): joins through the principal. User
--     principals are id-identical to auth users, so the resolved profile —
--     and therefore the Arena output — is unchanged.
CREATE OR REPLACE FUNCTION public.get_arena_quiz_detail(p_quiz_id uuid)
RETURNS table(
  id uuid,
  title text,
  description text,
  difficulty text,
  estimated_duration_minutes integer,
  play_count integer,
  time_per_question integer,
  created_at timestamptz,
  last_updated timestamptz,
  question_count integer,
  avg_accuracy numeric,
  creator_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    q.id,
    q.title,
    q.description,
    q.difficulty,
    q.estimated_duration_minutes,
    q.play_count,
    q.time_per_question,
    q.created_at,
    greatest(q.created_at, coalesce((select max(qq.created_at) from questions qq where qq.quiz_id = q.id), q.created_at)) as last_updated,
    (select count(*)::int from questions qq where qq.quiz_id = q.id) as question_count,
    (select round(avg(cr.accuracy_percentage), 1) from competition_results cr where cr.quiz_id = q.id) as avg_accuracy,
    (select p.display_name from profiles p where p.id = q.owner_principal_id) as creator_name
  from quizzes q
  where q.id = p_quiz_id
    and q.is_arena = true
    and q.archived_at is null
$$;

GRANT EXECUTE ON FUNCTION public.get_arena_quiz_detail(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_arena_quizzes()
RETURNS TABLE(
  id uuid, title text, description text, difficulty text,
  estimated_duration_minutes integer, play_count integer, time_per_question integer,
  featured_rank integer, last_updated timestamptz, question_count integer,
  avg_accuracy numeric, creator_name text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select
    q.id, q.title, q.description, q.difficulty,
    q.estimated_duration_minutes, q.play_count, q.time_per_question,
    q.featured_rank,
    greatest(q.created_at, coalesce((select max(qq.created_at) from questions qq where qq.quiz_id = q.id), q.created_at)) as last_updated,
    (select count(*)::int from questions qq where qq.quiz_id = q.id) as question_count,
    (select round(avg(cr.accuracy_percentage), 1) from competition_results cr where cr.quiz_id = q.id) as avg_accuracy,
    (select p.display_name from profiles p where p.id = q.owner_principal_id) as creator_name
  from quizzes q
  where q.is_arena = true and q.archived_at is null
  order by q.featured_rank nulls last, q.play_count desc
$$;

GRANT EXECUTE ON FUNCTION public.get_arena_quizzes() TO anon, authenticated;

-- ############################################################################
-- 6. Post-migration verification (read-only, safe to re-run in the SQL editor)
-- All counts below must be 0.
--   Missing principal on any of the four tables
-- SELECT count(*) FROM public.branding_profiles WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.leagues          WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.quizzes          WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.competitions     WHERE owner_principal_id IS NULL;
--   Session hosts still match competition owners
-- SELECT count(*) FROM public.sessions s JOIN public.competitions c ON c.session_id = s.id WHERE s.host_id IS DISTINCT FROM c.owner_id;
--   can() principal-only resolution sanity (1 = owner can manage, 0 = non-owner)
-- SELECT count(*) FROM public.quizzes q WHERE q.owner_principal_id = public.principal_for_user(auth.uid()); -- owner's rows
-- SELECT public.can(auth.uid(), 'quiz.edit', (SELECT id FROM public.quizzes LIMIT 1)); -- 1 for the owner, 0 for others
--   Remaining owner_id references in live objects (should list only the four
--   legacy columns themselves, the sync triggers/functions in this file, and
--   the historical migrations):
-- SELECT n.nspname, p.proname, pg_get_functiondef(p.oid) LIKE '%owner_id%' AS uses_owner_id
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND pg_get_functiondef(p.oid) LIKE '%owner_id%';
-- SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public' AND (pg_get_expr(polqual, polrelid) LIKE '%owner_id%' OR pg_get_expr(polwithcheck, polrelid) LIKE '%owner_id%');
