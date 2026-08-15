-- ============ 1. CENTRALIZED ROLE SYSTEM ============
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'host');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  granted_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(auth.uid(), 'admin');
$$;

DROP POLICY IF EXISTS "Users can read their own roles" ON public.user_roles;
CREATE POLICY "Users can read their own roles" ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "Admins manage roles" ON public.user_roles;
CREATE POLICY "Admins manage roles" ON public.user_roles
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Seed the current administrator (previously a hardcoded email check).
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'admin' FROM auth.users u
 WHERE lower(u.email) = 'mubirueltonfelix@gmail.com'
ON CONFLICT (user_id, role) DO NOTHING;

-- Single source of truth: every existing policy/function keeps calling
-- is_authorized_host(), which now resolves through the role table.
CREATE OR REPLACE FUNCTION public.is_authorized_host()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(auth.uid(), 'admin');
$$;

-- Session-creation gate: role table instead of the hardcoded email.
CREATE OR REPLACE FUNCTION public.enforce_host_authorization()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.host_authorizations%ROWTYPE;
BEGIN
  IF public.has_role(NEW.host_id, 'admin') OR public.has_role(NEW.host_id, 'host') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_row FROM public.host_authorizations
   WHERE profile_id = NEW.host_id
     AND status = 'active'
     AND (starts_at IS NULL OR starts_at <= now())
     AND (
       (authorization_type = 'time' AND (expires_at IS NULL OR expires_at > now()))
       OR (authorization_type IN ('single','bundle') AND COALESCE(remaining_sessions,0) > 0)
     )
   ORDER BY CASE WHEN authorization_type = 'time' THEN 0 ELSE 1 END,
            COALESCE(remaining_sessions, 999999) ASC, created_at ASC
   LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hosting not authorized. Contact the administrator.' USING ERRCODE = '42501';
  END IF;

  IF v_row.authorization_type IN ('single','bundle') THEN
    UPDATE public.host_authorizations
       SET remaining_sessions = GREATEST(COALESCE(remaining_sessions,0) - 1, 0),
           status = CASE WHEN COALESCE(remaining_sessions,0) - 1 <= 0
                         THEN 'consumed'::public.host_auth_status ELSE status END
     WHERE id = v_row.id;
  END IF;
  RETURN NEW;
END; $$;

-- ============ 2. SHARED SERVER-SIDE SCORING ============
-- One canonical implementation of the two existing scoring shapes.
CREATE OR REPLACE FUNCTION public.score_answer(
  p_point_value int, p_response_ms int, p_time_limit_ms int,
  p_streak int, p_correctness numeric, p_double boolean, p_graded boolean)
RETURNS int LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v_resp int; v_speed numeric; v_total int;
BEGIN
  IF COALESCE(p_correctness,0) <= 0 THEN RETURN 0; END IF;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms,0), GREATEST(p_time_limit_ms,1)));
  v_speed := 1.0 - v_resp::numeric / GREATEST(p_time_limit_ms,1);
  IF p_graded THEN
    v_total := ROUND(p_point_value * p_correctness * (0.5 + 0.5 * v_speed));
  ELSE
    v_total := ROUND((ROUND(p_point_value * 0.5) + ROUND(p_point_value * 0.5 * v_speed))
                     * (1 + LEAST(GREATEST(COALESCE(p_streak,0),0), 5) * 0.1));
  END IF;
  IF p_double THEN v_total := v_total * 2; END IF;
  RETURN GREATEST(v_total, 0);
END; $$;

-- Evaluates one submitted answer against the stored question. Never trusts
-- any client-supplied correctness or score.
CREATE OR REPLACE FUNCTION public.evaluate_question_answer(
  p_question_id uuid, p_answer jsonb, p_response_ms int, p_streak int)
RETURNS TABLE(is_correct boolean, correctness numeric, points int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q public.questions%ROWTYPE; v_limit_ms int; v_default int;
  v_c numeric := 0; v_ok boolean := false; v_graded boolean := false;
  v_tol numeric; v_norm text; v_arr jsonb; v_n int; v_hit int := 0; i int;
BEGIN
  SELECT * INTO q FROM public.questions WHERE id = p_question_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT time_per_question INTO v_default FROM public.quizzes WHERE id = q.quiz_id;
  v_limit_ms := GREATEST(COALESCE(q.time_limit_sec, v_default, 20), 1) * 1000;

  IF q.question_type = 'feedback' THEN
    RETURN QUERY SELECT false, 0::numeric, 0; RETURN;
  ELSIF q.question_type = 'ordering' THEN
    v_graded := true;
    v_arr := COALESCE(p_answer -> 'order', '[]'::jsonb);
    v_n := jsonb_array_length(COALESCE(q.options, '[]'::jsonb));
    IF v_n > 0 AND jsonb_array_length(v_arr) = v_n THEN
      FOR i IN 0..v_n-1 LOOP
        IF (v_arr ->> i)::int = i THEN v_hit := v_hit + 1; END IF;
      END LOOP;
      v_c := v_hit::numeric / v_n;
    END IF;
    v_ok := v_c >= 1;
  ELSIF q.correct_lat IS NOT NULL AND q.correct_lng IS NOT NULL
        AND p_answer ? 'lat' AND p_answer ? 'lng' THEN
    v_graded := true;
    v_c := GREATEST(0, 1 - public.haversine_km(
             q.correct_lat, q.correct_lng,
             (p_answer ->> 'lat')::numeric, (p_answer ->> 'lng')::numeric)
           / GREATEST(COALESCE(q.max_distance_km, 5000), 1));
    v_ok := v_c >= 0.9;
  ELSIF q.correct_number IS NOT NULL AND p_answer ? 'value' THEN
    v_graded := true;
    v_tol := q.number_tolerance;
    IF v_tol IS NULL OR v_tol <= 0 THEN
      v_tol := GREATEST(ABS(COALESCE(q.number_max, q.correct_number)
                          - COALESCE(q.number_min, q.correct_number)) * 0.25, 1);
    END IF;
    v_c := GREATEST(0, 1 - ABS((p_answer ->> 'value')::numeric - q.correct_number) / v_tol);
    v_ok := v_c >= 0.9;
  ELSIF q.accepted_answers IS NOT NULL AND array_length(q.accepted_answers, 1) > 0 THEN
    v_norm := public.normalize_text_answer(p_answer ->> 'text');
    v_ok := v_norm <> '' AND EXISTS (
      SELECT 1 FROM unnest(q.accepted_answers) a(val)
       WHERE public.normalize_text_answer(a.val) = v_norm);
    v_c := CASE WHEN v_ok THEN 1 ELSE 0 END;
  ELSE
    v_ok := (p_answer ->> 'selected_index') IS NOT NULL
            AND (p_answer ->> 'selected_index')::int = q.correct_index;
    v_c := CASE WHEN v_ok THEN 1 ELSE 0 END;
  END IF;

  RETURN QUERY SELECT v_ok, v_c,
    public.score_answer(COALESCE(q.point_value, 1000), p_response_ms, v_limit_ms,
                        p_streak, v_c, COALESCE(q.double_points, false), v_graded);
END; $$;

-- Scores a full Arena run from raw answers. Returns the authoritative totals.
CREATE OR REPLACE FUNCTION public.score_arena_run(p_quiz_id uuid, p_answers jsonb)
RETURNS TABLE(score int, accuracy numeric, correct_count int, graded_count int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_score int := 0; v_streak int := 0; v_correct int := 0; v_graded int := 0;
  v_seen uuid[] := '{}'; a jsonb; r record; v_qid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.quizzes q
                  WHERE q.id = p_quiz_id AND q.is_arena = true AND q.archived_at IS NULL) THEN
    RAISE EXCEPTION 'not an arena quiz';
  END IF;

  SELECT count(*)::int INTO v_graded FROM public.questions
   WHERE quiz_id = p_quiz_id AND question_type <> 'feedback';

  FOR a IN SELECT value FROM jsonb_array_elements(COALESCE(p_answers, '[]'::jsonb)) LOOP
    v_qid := (a ->> 'question_id')::uuid;
    CONTINUE WHEN v_qid IS NULL OR v_qid = ANY(v_seen);
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.questions q
                               WHERE q.id = v_qid AND q.quiz_id = p_quiz_id
                                 AND q.question_type <> 'feedback');
    v_seen := v_seen || v_qid;
    SELECT * INTO r FROM public.evaluate_question_answer(
      v_qid, a, COALESCE((a ->> 'response_ms')::int, 0), v_streak);
    v_score := v_score + COALESCE(r.points, 0);
    IF COALESCE(r.is_correct, false) THEN
      v_correct := v_correct + 1; v_streak := v_streak + 1;
    ELSE
      v_streak := 0;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_score,
    CASE WHEN v_graded > 0 THEN ROUND(v_correct::numeric / v_graded * 100, 2) ELSE 0 END,
    v_correct, v_graded;
END; $$;

-- Signed-in Arena completion: server computes the score, client cannot.
CREATE OR REPLACE FUNCTION public.submit_arena_run(p_run_id uuid, p_quiz_id uuid, p_answers jsonb)
RETURNS TABLE(score int, accuracy numeric, correct_count int, graded_count int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO r FROM public.score_arena_run(p_quiz_id, p_answers);
  INSERT INTO public.competition_results(
    id, profile_id, session_id, quiz_id, final_score, final_rank,
    total_participants, accuracy_percentage, completed_at)
  VALUES (p_run_id, auth.uid(), NULL, p_quiz_id, r.score, 0, 0, r.accuracy, now())
  ON CONFLICT (id) DO NOTHING;
  RETURN QUERY SELECT r.score, r.accuracy, r.correct_count, r.graded_count;
END; $$;

-- Guest Arena claim ticket now also carries a server-computed score.
DROP FUNCTION IF EXISTS public.create_arena_claim(uuid, integer, numeric);
CREATE OR REPLACE FUNCTION public.create_arena_claim(p_quiz_id uuid, p_answers jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token text; r record;
BEGIN
  SELECT * INTO r FROM public.score_arena_run(p_quiz_id, p_answers);
  v_token := encode(gen_random_bytes(32), 'hex');
  INSERT INTO public.result_claims(token, kind, quiz_id, score, accuracy)
    VALUES (v_token, 'arena', p_quiz_id, r.score, r.accuracy);
  RETURN v_token;
END; $$;

-- Client-reported Arena scoring is gone.
DROP FUNCTION IF EXISTS public.record_arena_result(uuid, uuid, integer, numeric);

-- ============ 3. FUNCTION PERMISSIONS ============
REVOKE ALL ON FUNCTION public.score_answer(int,int,int,int,numeric,boolean,boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.evaluate_question_answer(uuid,jsonb,int,int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.score_arena_run(uuid,jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
REVOKE ALL ON FUNCTION public.is_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_arena_run(uuid,uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_arena_claim(uuid,jsonb) TO anon, authenticated;

-- Admin-only surface: never reachable anonymously.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'admin\_%'
            OR p.proname IN ('run_autonomous_tick','run_autonomous_scheduler',
                             'advance_question_internal','prepare_competition_session_internal',
                             'enforce_host_authorization','record_competition_results',
                             'handle_new_user','increment_quiz_play_count'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
  -- Admin console RPCs are authorization-checked inside and needed by signed-in admins.
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'admin\_%'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
  END LOOP;
END $$;

-- Session control RPCs require an authenticated host; drop anonymous access.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('advance_question','reveal_current_question','end_question_early',
                         'pause_session','resume_session','add_question_time',
                         'skip_current_question','prepare_competition_session',
                         'list_due_competitions','get_my_leagues','claim_result',
                         'record_competition_results')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
  END LOOP;
END $$;