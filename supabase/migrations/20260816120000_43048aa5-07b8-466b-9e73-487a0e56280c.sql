-- Phase 7K: competitions ownership migration (owner_id → owner_principal_id)
-- Pattern: identical to Phase 7H (branding_profiles), 7I (leagues), 7J (quizzes).
-- Competitions is intentionally the LAST ownership-bearing table: it is coupled to
-- session preparation, the autonomous scheduler and live host authorization.
--
-- Frozen invariants of this migration:
--   * competitions.owner_id is retained, untouched and authoritative (legacy fallback).
--   * sessions.host_id is NOT migrated; it remains the runtime/acting identity.
--   * No scheduler, gameplay, scoring, timing, realtime, results or Arena changes.
--   * No Organizations introduced.

-- 1. New ownership column
ALTER TABLE public.competitions
  ADD COLUMN IF NOT EXISTS owner_principal_id uuid REFERENCES public.principals(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS competitions_owner_principal_id_idx
  ON public.competitions (owner_principal_id);

-- 2. Backfill (identity copy: user principals share the auth user id)
UPDATE public.competitions c
SET owner_principal_id = p.id
FROM public.principals p
WHERE p.type = 'user'
  AND p.user_id = c.owner_id
  AND c.owner_principal_id IS DISTINCT FROM p.id;

-- 3. Integrity verification — HARD STOP before any authorization change.
-- Fails the migration if any competition lacks a principal mapping, has a
-- mismatched/duplicate/non-user mapping, or has a broken quiz/session reference.
-- owner_id is untouched, so a failure here is fully recoverable by
-- DROP COLUMN owner_principal_id (or by fixing the offending row and re-running).
DO $$
DECLARE
  v_missing   int;
  v_mismatch  int;
  v_badtype   int;
  v_dup       int;
  v_orphan_q  int;
  v_orphan_s  int;
BEGIN
  SELECT count(*) INTO v_missing  FROM public.competitions WHERE owner_principal_id IS NULL;
  SELECT count(*) INTO v_mismatch FROM public.competitions WHERE owner_principal_id IS DISTINCT FROM owner_id;
  SELECT count(*) INTO v_badtype  FROM public.competitions c
    JOIN public.principals p ON p.id = c.owner_principal_id WHERE p.type <> 'user';
  SELECT count(*) INTO v_dup FROM (
    SELECT owner_id FROM public.competitions
    GROUP BY owner_id HAVING count(DISTINCT owner_principal_id) > 1
  ) d;
  SELECT count(*) INTO v_orphan_q FROM public.competitions c
    LEFT JOIN public.quizzes z ON z.id = c.quiz_id WHERE z.id IS NULL;
  SELECT count(*) INTO v_orphan_s FROM public.competitions c
    LEFT JOIN public.sessions s ON s.id = c.session_id
   WHERE c.session_id IS NOT NULL AND s.id IS NULL;

  IF v_missing > 0 OR v_mismatch > 0 OR v_badtype > 0 OR v_dup > 0
     OR v_orphan_q > 0 OR v_orphan_s > 0 THEN
    RAISE EXCEPTION
      'Phase 7K integrity check FAILED: missing=%, mismatch=%, non_user_type=%, duplicate=%, orphan_quiz=%, orphan_session=%',
      v_missing, v_mismatch, v_badtype, v_dup, v_orphan_q, v_orphan_s;
  END IF;
END $$;

-- 4. Drift protection: always derive owner_principal_id from owner_id.
-- Clients cannot set the principal independently; no principal → reject.
CREATE OR REPLACE FUNCTION public.tg_competitions_sync_owner_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal uuid;
BEGIN
  SELECT p.id INTO v_principal
  FROM public.principals p
  WHERE p.type = 'user' AND p.user_id = NEW.owner_id;

  IF v_principal IS NULL THEN
    RAISE EXCEPTION 'No user principal exists for owner_id %', NEW.owner_id;
  END IF;

  NEW.owner_principal_id := v_principal;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS competitions_sync_owner_principal_trg ON public.competitions;
CREATE TRIGGER competitions_sync_owner_principal_trg
BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id ON public.competitions
FOR EACH ROW EXECUTE FUNCTION public.tg_competitions_sync_owner_principal();

-- 5. Capability resolver: competition ownership via principal (legacy fallback retained).
-- ONLY the 'competition.manage' branch changes. quiz/league/branding/session/admin
-- branches, create-actions, role/host resolution and NULL handling are byte-identical
-- to the Phase 7J version. Decision-equivalence: user principals are id-identical to
-- auth users, so owner_principal_id = principal_for_user(v_user) resolves to the same
-- rows as the previous owner_id = v_user check.
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
    -- Phase 7J: principal-aware, with legacy owner_id fallback during transition
    SELECT EXISTS (
      SELECT 1 FROM public.quizzes q
      WHERE q.id = p_resource
        AND (
          q.owner_principal_id = public.principal_for_user(v_user)
          OR (q.owner_principal_id IS NULL AND q.owner_id = v_user)
        )
    ) INTO v_owner;
  ELSIF p_action = 'competition.manage' THEN
    -- Phase 7K: principal-aware, with legacy owner_id fallback during transition
    SELECT EXISTS (
      SELECT 1 FROM public.competitions c
      WHERE c.id = p_resource
        AND (
          c.owner_principal_id = public.principal_for_user(v_user)
          OR (c.owner_principal_id IS NULL AND c.owner_id = v_user)
        )
    ) INTO v_owner;
  ELSIF p_action = 'league.manage' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.leagues l
      WHERE l.id = p_resource
        AND (
          l.owner_principal_id = public.principal_for_user(v_user)
          OR (l.owner_principal_id IS NULL AND l.owner_id = v_user)
        )
    ) INTO v_owner;
  ELSIF p_action = 'branding.manage' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.branding_profiles b
      WHERE b.id = p_resource
        AND (
          b.owner_principal_id = public.principal_for_user(v_user)
          OR (b.owner_principal_id IS NULL AND b.owner_id = v_user)
        )
    ) INTO v_owner;
  ELSIF p_action = 'session.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = p_resource AND s.host_id = v_user) INTO v_owner;
  ELSE
    RETURN false;
  END IF;

  RETURN v_owner AND v_host;
END;
$$;

-- 6. Session preparation — the single owner-propagation point, made principal-aware.
-- prepare_competition_session_internal reads the competition's principal owner and
-- writes it to sessions.host_id. Because user principals are id-identical to auth
-- users, the resulting host_id is byte-identical to the pre-migration value:
-- session host identity, join codes, quota/authorization rules and the
-- enforce_host_authorization trigger behave exactly as before. sessions.host_id
-- itself is NOT migrated.
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
  VALUES (c.quiz_id, COALESCE(c.owner_principal_id, c.owner_id), v_code, 'lobby', c.league_id, c.branding_profile_id, v_order,
          COALESCE(c.autonomous, true) AND c.mode = 'scheduled' AND c.scheduled_start_at IS NOT NULL)
  RETURNING id INTO v_session_id;

  UPDATE public.competitions SET session_id = v_session_id, status = 'lobby_open' WHERE id = c.id;

  RETURN QUERY SELECT v_session_id, v_code, 'lobby_open'::public.competition_status, true;
END; $function$;

REVOKE ALL ON FUNCTION public.prepare_competition_session_internal(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- Public wrapper: the owner read in its authorization gate becomes principal-aware.
-- Decision-equivalent (ids identical); admin gate, 'Competition not found' and
-- delegation are unchanged.
CREATE OR REPLACE FUNCTION public.prepare_competition_session(p_competition_id uuid, p_force boolean DEFAULT false)
RETURNS TABLE(session_id uuid, code text, status public.competition_status, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_owner uuid;
BEGIN
  SELECT COALESCE(owner_principal_id, owner_id) INTO v_owner FROM public.competitions WHERE id = p_competition_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Competition not found'; END IF;
  IF NOT (v_owner = auth.uid() OR public.is_admin()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT * FROM public.prepare_competition_session_internal(p_competition_id, p_force);
END; $function$;

-- 7. RLS cutover — ownership policy only.
--   * "Owners manage their competitions": principal-first with legacy fallback
--     (Phase 7J shape). WITH CHECK stays auth.uid() = owner_id: the legacy column
--     remains authoritative on write and the drift trigger derives the principal.
--   * "Admin can view all competitions" (is_admin()): UNCHANGED — administrative access.
--   * "Public competitions are viewable" (visibility/status): UNCHANGED — public surface.
--   * sessions/participants runtime policies: UNCHANGED — host identity is untouched.
DROP POLICY IF EXISTS "Owners manage their competitions" ON public.competitions;
CREATE POLICY "Owners manage their competitions"
ON public.competitions FOR ALL TO authenticated
USING (
  owner_principal_id = public.principal_for_user(auth.uid())
  OR (owner_principal_id IS NULL AND auth.uid() = owner_id)
)
WITH CHECK (auth.uid() = owner_id);

-- 8. Post-migration verification (read-only, safe to re-run in the SQL editor).
-- All counts below must be 0 except the two totals.
--   Total competitions / mapped principals
-- SELECT count(*) AS total_competitions FROM public.competitions;
-- SELECT count(owner_principal_id) AS mapped FROM public.competitions;
--   Missing / mismatched / non-user / duplicate / drift
-- SELECT count(*) AS missing_principal   FROM public.competitions WHERE owner_principal_id IS NULL;
-- SELECT count(*) AS mismatched          FROM public.competitions WHERE owner_principal_id IS DISTINCT FROM owner_id;
-- SELECT count(*) AS non_user_principal  FROM public.competitions c JOIN public.principals p ON p.id = c.owner_principal_id WHERE p.type <> 'user';
-- SELECT count(*) AS duplicate_principal FROM (SELECT owner_id FROM public.competitions GROUP BY owner_id HAVING count(DISTINCT owner_principal_id) > 1) d;
-- SELECT count(*) AS drift              FROM public.competitions WHERE owner_principal_id IS DISTINCT FROM owner_id;
--   Sessions still reference the same competition + host
-- SELECT count(*) AS session_host_mismatch FROM public.sessions s JOIN public.competitions c ON c.session_id = s.id WHERE s.host_id IS DISTINCT FROM c.owner_id;
--   Quiz / league / branding references remain intact
-- SELECT count(*) AS orphan_quiz     FROM public.competitions c LEFT JOIN public.quizzes z ON z.id = c.quiz_id WHERE z.id IS NULL;
-- SELECT count(*) AS orphan_league   FROM public.competitions c LEFT JOIN public.leagues l ON l.id = c.league_id WHERE c.league_id IS NOT NULL AND l.id IS NULL;
-- SELECT count(*) AS orphan_branding FROM public.competitions c LEFT JOIN public.branding_profiles b ON b.id = c.branding_profile_id WHERE c.branding_profile_id IS NOT NULL AND b.id IS NULL;
