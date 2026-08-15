
-- 1. Schema additions
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS accepted_answers text[];
ALTER TABLE public.answers   ADD COLUMN IF NOT EXISTS text_submission text;

-- 2. Relax the check constraint to include 'type'
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'public.questions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%question_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.questions DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.questions ADD CONSTRAINT questions_question_type_check
  CHECK (question_type IN ('mcq','true_false','image_mcq','map_pin','number','type'));

-- 3. Normalization helper: lower, trim, strip basic punctuation & collapse whitespace
CREATE OR REPLACE FUNCTION public.normalize_text_answer(s text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT regexp_replace(
           regexp_replace(
             lower(coalesce(s,'')),
             '[[:punct:]]', '', 'g'
           ),
           '\s+', ' ', 'g'
         )::text
  ;
$$;
-- Wrap in trim
CREATE OR REPLACE FUNCTION public.normalize_text_answer(s text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(s,'')), '[[:punct:]]', '', 'g'),
      '\s+', ' ', 'g'
    )
  );
$$;

-- 4. get_session_questions: include accepted_answers (safe: player still can't see, this fn returns it though)
--    We DO NOT expose accepted_answers to players. Instead give a distinct player-safe list minus that.
--    Keep signature backward-compatible by adding a new column at the end.
DROP FUNCTION IF EXISTS public.get_session_questions(uuid);
CREATE OR REPLACE FUNCTION public.get_session_questions(p_session_id uuid)
RETURNS TABLE(
  q_id uuid, q_quiz_id uuid, q_text text, q_options jsonb, q_position integer,
  q_time_limit_sec integer, q_point_value integer, q_question_type text,
  q_image_url text, q_double_points boolean,
  q_max_distance_km numeric, q_number_min numeric, q_number_max numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT q.id, q.quiz_id, q.text, q.options, q.position, q.time_limit_sec, q.point_value,
           q.question_type, q.image_url, q.double_points,
           q.max_distance_km, q.number_min, q.number_max
      FROM public.questions q JOIN public.sessions s ON s.quiz_id = q.quiz_id
     WHERE s.id = p_session_id ORDER BY q.position;
END; $$;

-- 5. Extend get_my_round_result to also return correct_text (first accepted answer) and text_submission
DROP FUNCTION IF EXISTS public.get_my_round_result(uuid, text, uuid);
CREATE OR REPLACE FUNCTION public.get_my_round_result(
  p_participant_id uuid, p_secret_token text, p_question_id uuid
)
RETURNS TABLE(
  answered boolean, selected_index integer, is_correct boolean, points integer,
  correct_index integer, total_score integer, answer_value jsonb,
  correct_lat numeric, correct_lng numeric, correct_number numeric,
  correct_text text, text_submission text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session_id uuid; v_revealed boolean; v_status text;
        v_correct int; v_score int;
        v_lat numeric; v_lng numeric; v_num numeric;
        v_accepted text[]; v_correct_text text;
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
  SELECT q.correct_index, q.correct_lat, q.correct_lng, q.correct_number, q.accepted_answers
    INTO v_correct, v_lat, v_lng, v_num, v_accepted
    FROM public.questions q WHERE q.id = p_question_id;
  v_correct_text := CASE WHEN v_accepted IS NOT NULL AND array_length(v_accepted,1) > 0
                         THEN v_accepted[1] ELSE NULL END;
  RETURN QUERY
    SELECT (a.id IS NOT NULL), a.selected_index, a.is_correct, a.points,
           v_correct, v_score, a.answer_value, v_lat, v_lng, v_num,
           v_correct_text, a.text_submission
      FROM (SELECT 1) d
      LEFT JOIN public.answers a
        ON a.participant_id = p_participant_id AND a.question_id = p_question_id;
END; $$;

-- 6. Extend answer key with correct_text
DROP FUNCTION IF EXISTS public.get_session_answer_key(uuid);
CREATE OR REPLACE FUNCTION public.get_session_answer_key(p_session_id uuid)
RETURNS TABLE(
  question_id uuid, correct_index integer,
  correct_lat numeric, correct_lng numeric, correct_number numeric,
  correct_text text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sessions WHERE id = p_session_id AND status = 'ended') THEN
    RAISE EXCEPTION 'Answer key not available until session ends';
  END IF;
  RETURN QUERY
    SELECT q.id, q.correct_index, q.correct_lat, q.correct_lng, q.correct_number,
           CASE WHEN q.accepted_answers IS NOT NULL AND array_length(q.accepted_answers,1) > 0
                THEN q.accepted_answers[1] ELSE NULL END
      FROM public.questions q
      JOIN public.sessions s ON s.quiz_id = q.quiz_id
     WHERE s.id = p_session_id;
END; $$;

-- 7. Text answer submission
CREATE OR REPLACE FUNCTION public.submit_text_answer(
  p_participant_id uuid, p_secret_token text, p_question_id uuid,
  p_text text, p_response_ms integer
)
RETURNS TABLE(accepted boolean, is_correct boolean, points integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_session_id uuid; v_quiz_id uuid; v_status text; v_order jsonb;
  v_idx int; v_revealed boolean; v_expected_qid uuid;
  v_accepted text[]; v_point_value int; v_time_limit_sec int; v_time_limit_ms int;
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

  SELECT q.accepted_answers, COALESCE(q.point_value,1000),
         COALESCE(q.time_limit_sec, v_quiz_default, 20), COALESCE(q.double_points,false)
    INTO v_accepted, v_point_value, v_time_limit_sec, v_double
    FROM public.questions q WHERE q.id = p_question_id AND q.quiz_id = v_quiz_id;
  IF v_accepted IS NULL THEN RAISE EXCEPTION 'Not a text question'; END IF;

  v_time_limit_ms := GREATEST(v_time_limit_sec,1) * 1000;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms,0), v_time_limit_ms));
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
END; $$;
