
DROP FUNCTION IF EXISTS public.submit_answer(uuid, text, uuid, integer, integer);

-- 1. Schema
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS current_question_revealed boolean NOT NULL DEFAULT false;

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS question_type text NOT NULL DEFAULT 'mcq',
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS double_points boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_question_type_check') THEN
    ALTER TABLE public.questions
      ADD CONSTRAINT questions_question_type_check
      CHECK (question_type IN ('mcq','true_false','image_mcq'));
  END IF;
END $$;

-- 2. Host helper
CREATE OR REPLACE FUNCTION public.is_session_host(p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sessions WHERE id = p_session_id AND host_id = auth.uid());
$$;

-- 3. Reveal current question
CREATE OR REPLACE FUNCTION public.reveal_current_question(p_session_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;
  UPDATE public.sessions SET current_question_revealed = true
    WHERE id = p_session_id AND status = 'active';
END; $$;

-- 4. Advance question
CREATE OR REPLACE FUNCTION public.advance_question(p_session_id uuid)
RETURNS TABLE(next_index int, ended boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order jsonb; v_quiz_id uuid; v_idx int; v_total int; v_next int;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;
  SELECT s.question_order, s.current_question_index, s.quiz_id
    INTO v_order, v_idx, v_quiz_id FROM public.sessions s WHERE s.id = p_session_id;
  IF v_order IS NULL OR jsonb_typeof(v_order) <> 'array' OR jsonb_array_length(v_order) = 0 THEN
    SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
      FROM public.questions q WHERE q.quiz_id = v_quiz_id;
    UPDATE public.sessions SET question_order = v_order WHERE id = p_session_id;
  END IF;
  v_total := jsonb_array_length(v_order);
  v_next := COALESCE(v_idx, -1) + 1;
  IF v_next >= v_total THEN
    UPDATE public.sessions SET status = 'ended', current_question_revealed = true
      WHERE id = p_session_id;
    RETURN QUERY SELECT v_next, true;
  ELSE
    UPDATE public.sessions SET current_question_index = v_next,
      current_question_started_at = now(), current_question_revealed = false, status = 'active'
      WHERE id = p_session_id;
    RETURN QUERY SELECT v_next, false;
  END IF;
END; $$;

-- 5. Round progress
CREATE OR REPLACE FUNCTION public.get_round_progress(p_session_id uuid, p_question_id uuid)
RETURNS TABLE(answered_count int, total_count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*)::int FROM public.answers a WHERE a.session_id = p_session_id AND a.question_id = p_question_id),
    (SELECT count(*)::int FROM public.participants p WHERE p.session_id = p_session_id);
$$;

-- 6. Round stats (post-reveal only)
CREATE OR REPLACE FUNCTION public.get_round_stats(p_session_id uuid, p_question_id uuid)
RETURNS TABLE(selected_index int, vote_count int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_revealed boolean; v_status text;
BEGIN
  SELECT current_question_revealed, status INTO v_revealed, v_status
    FROM public.sessions WHERE id = p_session_id;
  IF NOT (COALESCE(v_revealed,false) OR v_status = 'ended' OR public.is_session_host(p_session_id)) THEN
    RAISE EXCEPTION 'Round not revealed yet';
  END IF;
  RETURN QUERY
    SELECT a.selected_index, count(*)::int
      FROM public.answers a
     WHERE a.session_id = p_session_id AND a.question_id = p_question_id
     GROUP BY a.selected_index ORDER BY a.selected_index;
END; $$;

-- 7. Submit answer (synchronized, no correct_index leak)
CREATE FUNCTION public.submit_answer(
  p_participant_id uuid, p_secret_token text, p_question_id uuid,
  p_selected_index int, p_response_ms int
) RETURNS TABLE(accepted boolean, new_streak int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session_id uuid; v_quiz_id uuid; v_status text; v_order jsonb;
  v_idx int; v_revealed boolean; v_expected_qid uuid;
  v_correct int; v_point_value int; v_time_limit_sec int; v_time_limit_ms int;
  v_double boolean; v_quiz_default int; v_is_correct boolean; v_resp int;
  v_old_streak int; v_base int; v_speed int; v_subtotal int;
  v_streak_mult numeric; v_total int; v_new_streak int;
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

  SELECT q.correct_index, COALESCE(q.point_value,1000),
         COALESCE(q.time_limit_sec, v_quiz_default, 20), COALESCE(q.double_points,false)
    INTO v_correct, v_point_value, v_time_limit_sec, v_double
    FROM public.questions q WHERE q.id = p_question_id AND q.quiz_id = v_quiz_id;
  IF v_correct IS NULL THEN RAISE EXCEPTION 'Question not found'; END IF;

  v_time_limit_ms := GREATEST(v_time_limit_sec,1) * 1000;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms,0), v_time_limit_ms));
  v_is_correct := (p_selected_index = v_correct);

  IF v_is_correct THEN
    v_base := ROUND(v_point_value * 0.5);
    v_speed := ROUND(v_point_value * 0.5 * (1.0 - v_resp::numeric / v_time_limit_ms));
    v_subtotal := v_base + v_speed;
    v_streak_mult := 1 + LEAST(v_old_streak, 5) * 0.1;
    v_total := ROUND(v_subtotal * v_streak_mult);
    IF v_double THEN v_total := v_total * 2; END IF;
    v_new_streak := v_old_streak + 1;
  ELSE
    v_total := 0; v_new_streak := 0;
  END IF;

  INSERT INTO public.answers(session_id, participant_id, question_id, selected_index, is_correct, response_ms, points)
  VALUES (v_session_id, p_participant_id, p_question_id, p_selected_index, v_is_correct, v_resp, v_total);

  UPDATE public.participants SET score = score + v_total, streak = v_new_streak
    WHERE id = p_participant_id;

  RETURN QUERY SELECT true, v_new_streak;
END; $$;

-- 8. Per-player round result (post-reveal only)
CREATE OR REPLACE FUNCTION public.get_my_round_result(
  p_participant_id uuid, p_secret_token text, p_question_id uuid
) RETURNS TABLE(answered boolean, selected_index int, is_correct boolean, points int, correct_index int, total_score int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_session_id uuid; v_revealed boolean; v_status text; v_correct int; v_score int;
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
  SELECT q.correct_index INTO v_correct FROM public.questions q WHERE q.id = p_question_id;
  RETURN QUERY
    SELECT (a.id IS NOT NULL), a.selected_index, a.is_correct, a.points, v_correct, v_score
      FROM (SELECT 1) d
      LEFT JOIN public.answers a
        ON a.participant_id = p_participant_id AND a.question_id = p_question_id;
END; $$;

-- 9. get_session_questions: also expose new metadata
DROP FUNCTION IF EXISTS public.get_session_questions(uuid);
CREATE FUNCTION public.get_session_questions(p_session_id uuid)
RETURNS TABLE(q_id uuid, q_quiz_id uuid, q_text text, q_options jsonb, q_position int,
              q_time_limit_sec int, q_point_value int, q_question_type text, q_image_url text, q_double_points boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT q.id, q.quiz_id, q.text, q.options, q.position, q.time_limit_sec, q.point_value,
           q.question_type, q.image_url, q.double_points
      FROM public.questions q JOIN public.sessions s ON s.quiz_id = q.quiz_id
     WHERE s.id = p_session_id ORDER BY q.position;
END; $$;

-- 10. Storage policies for quiz-images
DROP POLICY IF EXISTS "quiz-images public read" ON storage.objects;
CREATE POLICY "quiz-images public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'quiz-images');
DROP POLICY IF EXISTS "quiz-images host upload" ON storage.objects;
CREATE POLICY "quiz-images host upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'quiz-images' AND owner = auth.uid());
DROP POLICY IF EXISTS "quiz-images host update" ON storage.objects;
CREATE POLICY "quiz-images host update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'quiz-images' AND owner = auth.uid());
DROP POLICY IF EXISTS "quiz-images host delete" ON storage.objects;
CREATE POLICY "quiz-images host delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'quiz-images' AND owner = auth.uid());
