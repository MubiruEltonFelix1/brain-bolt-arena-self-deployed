
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS correct_lat numeric,
  ADD COLUMN IF NOT EXISTS correct_lng numeric,
  ADD COLUMN IF NOT EXISTS max_distance_km numeric DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS correct_number numeric,
  ADD COLUMN IF NOT EXISTS number_min numeric,
  ADD COLUMN IF NOT EXISTS number_max numeric,
  ADD COLUMN IF NOT EXISTS number_tolerance numeric;

ALTER TABLE public.answers
  ADD COLUMN IF NOT EXISTS answer_value jsonb;

DROP FUNCTION IF EXISTS public.get_session_questions(uuid);
DROP FUNCTION IF EXISTS public.get_session_answer_key(uuid);
DROP FUNCTION IF EXISTS public.get_my_round_result(uuid, text, uuid);

CREATE FUNCTION public.get_session_questions(p_session_id uuid)
 RETURNS TABLE(
   q_id uuid, q_quiz_id uuid, q_text text, q_options jsonb, q_position integer,
   q_time_limit_sec integer, q_point_value integer, q_question_type text,
   q_image_url text, q_double_points boolean,
   q_max_distance_km numeric, q_number_min numeric, q_number_max numeric
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
    SELECT q.id, q.quiz_id, q.text, q.options, q.position, q.time_limit_sec, q.point_value,
           q.question_type, q.image_url, q.double_points,
           q.max_distance_km, q.number_min, q.number_max
      FROM public.questions q JOIN public.sessions s ON s.quiz_id = q.quiz_id
     WHERE s.id = p_session_id ORDER BY q.position;
END; $function$;

CREATE FUNCTION public.get_session_answer_key(p_session_id uuid)
 RETURNS TABLE(
   question_id uuid, correct_index integer,
   correct_lat numeric, correct_lng numeric, correct_number numeric
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from public.sessions where id = p_session_id and status = 'ended') then
    raise exception 'Answer key not available until session ends';
  end if;
  return query
    select q.id, q.correct_index, q.correct_lat, q.correct_lng, q.correct_number
    from public.questions q
    join public.sessions s on s.quiz_id = q.quiz_id
    where s.id = p_session_id;
end; $function$;

CREATE FUNCTION public.get_my_round_result(
  p_participant_id uuid, p_secret_token text, p_question_id uuid
)
 RETURNS TABLE(
   answered boolean, selected_index integer, is_correct boolean, points integer,
   correct_index integer, total_score integer,
   answer_value jsonb, correct_lat numeric, correct_lng numeric, correct_number numeric
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_session_id uuid; v_revealed boolean; v_status text;
        v_correct int; v_score int;
        v_lat numeric; v_lng numeric; v_num numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.participant_secrets
    WHERE participant_id = p_participant_id AND secret_token = p_secret_token) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  SELECT p.session_id, p.score INTO v_session_id, v_score
    FROM public.participants p WHERE p.id = p_participant_id;
  SELECT s.current_question_revealed, s.status INTO v_revealed, v_status
    FROM public.sessions s WHERE s.id = v_session_id;
  IF NOT (COALESCE(v_revealed,false) OR v_status = 'ended') THEN
    RAISE EXCEPTION 'Round not revealed yet';
  END IF;
  SELECT q.correct_index, q.correct_lat, q.correct_lng, q.correct_number
    INTO v_correct, v_lat, v_lng, v_num
    FROM public.questions q WHERE q.id = p_question_id;
  RETURN QUERY
    SELECT (a.id IS NOT NULL), a.selected_index, a.is_correct, a.points,
           v_correct, v_score, a.answer_value, v_lat, v_lng, v_num
      FROM (SELECT 1) d
      LEFT JOIN public.answers a
        ON a.participant_id = p_participant_id AND a.question_id = p_question_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.haversine_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
 RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $function$
DECLARE r numeric := 6371.0; dlat numeric; dlng numeric; a numeric;
BEGIN
  dlat := radians(lat2 - lat1);
  dlng := radians(lng2 - lng1);
  a := sin(dlat/2)^2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng/2)^2;
  RETURN r * 2 * atan2(sqrt(a), sqrt(1-a));
END; $function$;

CREATE OR REPLACE FUNCTION public.submit_geo_answer(
  p_participant_id uuid, p_secret_token text, p_question_id uuid,
  p_lat numeric, p_lng numeric, p_response_ms integer
)
 RETURNS TABLE(accepted boolean, distance_km numeric, points integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session_id uuid; v_quiz_id uuid; v_status text; v_order jsonb;
  v_idx int; v_revealed boolean; v_expected_qid uuid;
  v_lat numeric; v_lng numeric; v_max_km numeric;
  v_point_value int; v_time_limit_sec int; v_time_limit_ms int;
  v_double boolean; v_quiz_default int; v_resp int;
  v_dist numeric; v_correctness numeric; v_speed_ratio numeric;
  v_total int; v_is_correct boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.participant_secrets
    WHERE participant_id = p_participant_id AND secret_token = p_secret_token) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT p.session_id INTO v_session_id
    FROM public.participants p WHERE p.id = p_participant_id FOR UPDATE;
  IF v_session_id IS NULL THEN RAISE EXCEPTION 'Participant not found'; END IF;

  SELECT s.status, s.question_order, s.current_question_index, s.current_question_revealed, s.quiz_id, q.time_per_question
    INTO v_status, v_order, v_idx, v_revealed, v_quiz_id, v_quiz_default
  FROM public.sessions s JOIN public.quizzes q ON q.id = s.quiz_id
  WHERE s.id = v_session_id;

  IF v_status <> 'active' THEN RAISE EXCEPTION 'Session not active'; END IF;
  IF v_revealed THEN RAISE EXCEPTION 'Round already closed'; END IF;

  IF v_order IS NULL OR jsonb_typeof(v_order) <> 'array' OR jsonb_array_length(v_order) = 0 THEN
    SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
      FROM public.questions q WHERE q.quiz_id = v_quiz_id;
    UPDATE public.sessions SET question_order = v_order WHERE id = v_session_id;
  END IF;

  IF v_idx < 0 OR v_idx >= jsonb_array_length(v_order) THEN RAISE EXCEPTION 'No active question'; END IF;
  v_expected_qid := (v_order ->> v_idx)::uuid;
  IF v_expected_qid <> p_question_id THEN RAISE EXCEPTION 'Not the current question'; END IF;

  IF EXISTS (SELECT 1 FROM public.answers a
    WHERE a.participant_id = p_participant_id AND a.question_id = p_question_id) THEN
    RAISE EXCEPTION 'Already answered';
  END IF;

  SELECT q.correct_lat, q.correct_lng, COALESCE(q.max_distance_km, 5000),
         COALESCE(q.point_value, 1000),
         COALESCE(q.time_limit_sec, v_quiz_default, 30),
         COALESCE(q.double_points, false)
    INTO v_lat, v_lng, v_max_km, v_point_value, v_time_limit_sec, v_double
    FROM public.questions q WHERE q.id = p_question_id AND q.quiz_id = v_quiz_id;
  IF v_lat IS NULL OR v_lng IS NULL THEN RAISE EXCEPTION 'Not a map question'; END IF;

  v_time_limit_ms := GREATEST(v_time_limit_sec, 1) * 1000;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms, 0), v_time_limit_ms));
  v_dist := public.haversine_km(v_lat, v_lng, p_lat, p_lng);
  v_correctness := GREATEST(0, 1 - v_dist / GREATEST(v_max_km, 1));
  v_speed_ratio := 1.0 - v_resp::numeric / v_time_limit_ms;
  v_total := ROUND(v_point_value * v_correctness * (0.5 + 0.5 * v_speed_ratio));
  IF v_double THEN v_total := v_total * 2; END IF;
  v_is_correct := v_correctness >= 0.9;

  INSERT INTO public.answers(session_id, participant_id, question_id, selected_index, is_correct, response_ms, points, answer_value)
  VALUES (v_session_id, p_participant_id, p_question_id, -1, v_is_correct, v_resp, v_total,
          jsonb_build_object('lat', p_lat, 'lng', p_lng, 'distance_km', v_dist));

  UPDATE public.participants SET score = score + v_total,
    streak = CASE WHEN v_is_correct THEN streak + 1 ELSE 0 END
    WHERE id = p_participant_id;

  RETURN QUERY SELECT true, v_dist, v_total;
END; $function$;

CREATE OR REPLACE FUNCTION public.submit_number_answer(
  p_participant_id uuid, p_secret_token text, p_question_id uuid,
  p_value numeric, p_response_ms integer
)
 RETURNS TABLE(accepted boolean, diff numeric, points integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session_id uuid; v_quiz_id uuid; v_status text; v_order jsonb;
  v_idx int; v_revealed boolean; v_expected_qid uuid;
  v_correct numeric; v_min numeric; v_max numeric; v_tol numeric;
  v_point_value int; v_time_limit_sec int; v_time_limit_ms int;
  v_double boolean; v_quiz_default int; v_resp int;
  v_diff numeric; v_correctness numeric; v_speed_ratio numeric;
  v_total int; v_is_correct boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.participant_secrets
    WHERE participant_id = p_participant_id AND secret_token = p_secret_token) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT p.session_id INTO v_session_id
    FROM public.participants p WHERE p.id = p_participant_id FOR UPDATE;
  IF v_session_id IS NULL THEN RAISE EXCEPTION 'Participant not found'; END IF;

  SELECT s.status, s.question_order, s.current_question_index, s.current_question_revealed, s.quiz_id, q.time_per_question
    INTO v_status, v_order, v_idx, v_revealed, v_quiz_id, v_quiz_default
  FROM public.sessions s JOIN public.quizzes q ON q.id = s.quiz_id
  WHERE s.id = v_session_id;

  IF v_status <> 'active' THEN RAISE EXCEPTION 'Session not active'; END IF;
  IF v_revealed THEN RAISE EXCEPTION 'Round already closed'; END IF;

  IF v_order IS NULL OR jsonb_typeof(v_order) <> 'array' OR jsonb_array_length(v_order) = 0 THEN
    SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
      FROM public.questions q WHERE q.quiz_id = v_quiz_id;
    UPDATE public.sessions SET question_order = v_order WHERE id = v_session_id;
  END IF;

  IF v_idx < 0 OR v_idx >= jsonb_array_length(v_order) THEN RAISE EXCEPTION 'No active question'; END IF;
  v_expected_qid := (v_order ->> v_idx)::uuid;
  IF v_expected_qid <> p_question_id THEN RAISE EXCEPTION 'Not the current question'; END IF;

  IF EXISTS (SELECT 1 FROM public.answers a
    WHERE a.participant_id = p_participant_id AND a.question_id = p_question_id) THEN
    RAISE EXCEPTION 'Already answered';
  END IF;

  SELECT q.correct_number, q.number_min, q.number_max, q.number_tolerance,
         COALESCE(q.point_value, 1000),
         COALESCE(q.time_limit_sec, v_quiz_default, 30),
         COALESCE(q.double_points, false)
    INTO v_correct, v_min, v_max, v_tol, v_point_value, v_time_limit_sec, v_double
    FROM public.questions q WHERE q.id = p_question_id AND q.quiz_id = v_quiz_id;
  IF v_correct IS NULL THEN RAISE EXCEPTION 'Not a numeric question'; END IF;

  IF v_tol IS NULL OR v_tol <= 0 THEN
    v_tol := GREATEST(ABS(COALESCE(v_max, v_correct) - COALESCE(v_min, v_correct)) * 0.25, 1);
  END IF;

  v_time_limit_ms := GREATEST(v_time_limit_sec, 1) * 1000;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms, 0), v_time_limit_ms));
  v_diff := ABS(p_value - v_correct);
  v_correctness := GREATEST(0, 1 - v_diff / v_tol);
  v_speed_ratio := 1.0 - v_resp::numeric / v_time_limit_ms;
  v_total := ROUND(v_point_value * v_correctness * (0.5 + 0.5 * v_speed_ratio));
  IF v_double THEN v_total := v_total * 2; END IF;
  v_is_correct := v_correctness >= 0.9;

  INSERT INTO public.answers(session_id, participant_id, question_id, selected_index, is_correct, response_ms, points, answer_value)
  VALUES (v_session_id, p_participant_id, p_question_id, -1, v_is_correct, v_resp, v_total,
          jsonb_build_object('value', p_value, 'diff', v_diff));

  UPDATE public.participants SET score = score + v_total,
    streak = CASE WHEN v_is_correct THEN streak + 1 ELSE 0 END
    WHERE id = p_participant_id;

  RETURN QUERY SELECT true, v_diff, v_total;
END; $function$;
