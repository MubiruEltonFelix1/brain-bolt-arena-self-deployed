
ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_question_type_check;
ALTER TABLE public.questions ADD CONSTRAINT questions_question_type_check
  CHECK (question_type IN ('mcq','true_false','image_mcq','map_pin','number','type','feedback','image_reveal','audio','ordering'));

CREATE OR REPLACE FUNCTION public.submit_ordering_answer(
  p_participant_id uuid, p_secret_token text, p_question_id uuid,
  p_order integer[], p_response_ms integer
)
RETURNS TABLE(accepted boolean, correct_positions integer, points integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_session_id uuid; v_quiz_id uuid; v_status text; v_order jsonb;
  v_idx int; v_revealed boolean; v_expected_qid uuid;
  v_qtype text; v_options jsonb; v_total int; v_correct int := 0;
  v_point_value int; v_time_limit_sec int; v_time_limit_ms int;
  v_double boolean; v_quiz_default int; v_resp int;
  v_correctness numeric; v_speed_ratio numeric;
  v_points int; v_is_correct boolean; i int;
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

  SELECT q.question_type, q.options, COALESCE(q.point_value, 1000),
         COALESCE(q.time_limit_sec, v_quiz_default, 30),
         COALESCE(q.double_points, false)
    INTO v_qtype, v_options, v_point_value, v_time_limit_sec, v_double
    FROM public.questions q WHERE q.id = p_question_id AND q.quiz_id = v_quiz_id;

  IF v_qtype <> 'ordering' THEN RAISE EXCEPTION 'Not an ordering question'; END IF;

  v_total := jsonb_array_length(v_options);
  IF v_total < 2 THEN RAISE EXCEPTION 'Ordering needs at least 2 items'; END IF;
  IF array_length(p_order, 1) IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'Order length mismatch';
  END IF;

  FOR i IN 1..v_total LOOP
    IF p_order[i] = i - 1 THEN v_correct := v_correct + 1; END IF;
  END LOOP;

  v_time_limit_ms := GREATEST(v_time_limit_sec, 1) * 1000;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms, 0), v_time_limit_ms));
  v_correctness := v_correct::numeric / v_total;
  v_speed_ratio := 1.0 - v_resp::numeric / v_time_limit_ms;
  v_points := ROUND(v_point_value * v_correctness * (0.5 + 0.5 * v_speed_ratio));
  IF v_double THEN v_points := v_points * 2; END IF;
  v_is_correct := v_correct = v_total;

  INSERT INTO public.answers(session_id, participant_id, question_id, selected_index, is_correct, response_ms, points, answer_value)
  VALUES (v_session_id, p_participant_id, p_question_id, -1, v_is_correct, v_resp, v_points,
          jsonb_build_object('order', to_jsonb(p_order), 'correct_positions', v_correct, 'total', v_total));

  UPDATE public.participants
     SET score = score + v_points,
         streak = CASE WHEN v_is_correct THEN streak + 1 ELSE 0 END
   WHERE id = p_participant_id;

  RETURN QUERY SELECT true, v_correct, v_points;
END; $$;
