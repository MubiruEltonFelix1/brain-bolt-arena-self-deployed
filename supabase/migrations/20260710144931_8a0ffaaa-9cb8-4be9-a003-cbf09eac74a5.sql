
ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_question_type_check;
ALTER TABLE public.questions ADD CONSTRAINT questions_question_type_check
  CHECK (question_type = ANY (ARRAY['mcq'::text, 'true_false'::text, 'image_mcq'::text, 'map_pin'::text, 'number'::text, 'type'::text, 'feedback'::text]));

CREATE OR REPLACE FUNCTION public.submit_text_answer(p_participant_id uuid, p_secret_token text, p_question_id uuid, p_text text, p_response_ms integer)
 RETURNS TABLE(accepted boolean, is_correct boolean, points integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session_id uuid; v_quiz_id uuid; v_status text; v_order jsonb;
  v_idx int; v_revealed boolean; v_expected_qid uuid;
  v_accepted text[]; v_qtype text; v_point_value int; v_time_limit_sec int; v_time_limit_ms int;
  v_double boolean; v_quiz_default int; v_resp int;
  v_norm text; v_is_correct boolean; v_base int; v_speed int;
  v_old_streak int; v_streak_mult numeric; v_total int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.participant_secrets
    WHERE participant_id = p_participant_id AND secret_token = p_secret_token) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT p.session_id, p.streak INTO v_session_id, v_old_streak
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

  SELECT q.accepted_answers, q.question_type, COALESCE(q.point_value,1000),
         COALESCE(q.time_limit_sec, v_quiz_default, 20), COALESCE(q.double_points,false)
    INTO v_accepted, v_qtype, v_point_value, v_time_limit_sec, v_double
    FROM public.questions q WHERE q.id = p_question_id AND q.quiz_id = v_quiz_id;

  IF v_qtype <> 'feedback' AND v_accepted IS NULL THEN
    RAISE EXCEPTION 'Not a text question';
  END IF;

  v_time_limit_ms := GREATEST(v_time_limit_sec,1) * 1000;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms,0), v_time_limit_ms));

  IF v_qtype = 'feedback' THEN
    INSERT INTO public.answers(session_id, participant_id, question_id, selected_index,
                               is_correct, response_ms, points, text_submission)
    VALUES (v_session_id, p_participant_id, p_question_id, -1,
            false, v_resp, 0, p_text);
    RETURN QUERY SELECT true, false, 0;
    RETURN;
  END IF;

  v_norm := public.normalize_text_answer(p_text);
  v_is_correct := EXISTS (
    SELECT 1 FROM unnest(v_accepted) a(val)
     WHERE public.normalize_text_answer(a.val) = v_norm AND v_norm <> ''
  );

  IF v_is_correct THEN
    v_base := ROUND(v_point_value * 0.5);
    v_speed := ROUND(v_point_value * 0.5 * (1.0 - v_resp::numeric / v_time_limit_ms));
    v_streak_mult := 1 + LEAST(v_old_streak, 5) * 0.1;
    v_total := ROUND((v_base + v_speed) * v_streak_mult);
    IF v_double THEN v_total := v_total * 2; END IF;
  ELSE
    v_total := 0;
  END IF;

  INSERT INTO public.answers(session_id, participant_id, question_id, selected_index,
                             is_correct, response_ms, points, text_submission)
  VALUES (v_session_id, p_participant_id, p_question_id, -1,
          v_is_correct, v_resp, v_total, p_text);

  UPDATE public.participants
     SET score = score + v_total,
         streak = CASE WHEN v_is_correct THEN streak + 1 ELSE 0 END
   WHERE id = p_participant_id;

  RETURN QUERY SELECT true, v_is_correct, v_total;
END; $function$;
