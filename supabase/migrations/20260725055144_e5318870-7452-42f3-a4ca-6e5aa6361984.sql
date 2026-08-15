
-- 1. Schema additions
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS skipped_question_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS time_added_ms integer NOT NULL DEFAULT 0;

-- 2. Pause session
CREATE OR REPLACE FUNCTION public.pause_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;
  UPDATE public.sessions
    SET paused_at = COALESCE(paused_at, now())
    WHERE id = p_session_id AND status = 'active';
END; $$;

-- 3. Resume session (shifts current_question_started_at forward by pause duration)
CREATE OR REPLACE FUNCTION public.resume_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_paused_at timestamptz; v_started_at timestamptz; v_delta interval;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;
  SELECT paused_at, current_question_started_at INTO v_paused_at, v_started_at
    FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF v_paused_at IS NULL THEN RETURN; END IF;
  v_delta := now() - v_paused_at;
  UPDATE public.sessions
    SET paused_at = NULL,
        current_question_started_at = CASE
          WHEN v_started_at IS NULL THEN v_started_at
          ELSE v_started_at + v_delta
        END
    WHERE id = p_session_id;
END; $$;

-- 4. Add time to current question (bumps time_added_ms)
CREATE OR REPLACE FUNCTION public.add_question_time(p_session_id uuid, p_seconds integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;
  IF p_seconds IS NULL OR p_seconds <= 0 OR p_seconds > 300 THEN
    RAISE EXCEPTION 'Invalid seconds';
  END IF;
  UPDATE public.sessions
    SET time_added_ms = GREATEST(0, time_added_ms) + (p_seconds * 1000)
    WHERE id = p_session_id
      AND status = 'active'
      AND current_question_revealed = false;
END; $$;

-- 5. End current question early (thin alias, retained for future audit hooks)
CREATE OR REPLACE FUNCTION public.end_question_early(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;
  -- Clear pause so downstream logic runs cleanly
  UPDATE public.sessions
    SET current_question_revealed = true,
        paused_at = NULL
    WHERE id = p_session_id AND status = 'active';
END; $$;

-- 6. Skip current question: void answers, refund score, mark skipped, advance
CREATE OR REPLACE FUNCTION public.skip_current_question(p_session_id uuid)
RETURNS TABLE(next_index integer, ended boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_order jsonb; v_idx int; v_revealed boolean; v_qid uuid;
        v_status text; v_quiz_id uuid; v_total int; v_next int;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;
  SELECT question_order, current_question_index, current_question_revealed, status, quiz_id
    INTO v_order, v_idx, v_revealed, v_status, v_quiz_id
    FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'Session not active'; END IF;
  IF v_revealed THEN RAISE EXCEPTION 'Round already revealed — cannot skip'; END IF;
  IF v_order IS NULL OR v_idx IS NULL OR v_idx < 0 OR v_idx >= jsonb_array_length(v_order) THEN
    RAISE EXCEPTION 'No active question';
  END IF;
  v_qid := (v_order ->> v_idx)::uuid;

  -- Refund any points already awarded for this question
  UPDATE public.participants p
    SET score = GREATEST(0, p.score - COALESCE(sub.awarded, 0)),
        streak = 0
    FROM (
      SELECT participant_id, SUM(COALESCE(points,0))::int AS awarded
      FROM public.answers
      WHERE session_id = p_session_id AND question_id = v_qid
      GROUP BY participant_id
    ) sub
    WHERE p.id = sub.participant_id;

  -- Void submitted answers for this question
  DELETE FROM public.answers
    WHERE session_id = p_session_id AND question_id = v_qid;

  -- Mark question as skipped (append if not already present)
  UPDATE public.sessions
    SET skipped_question_ids = CASE
          WHEN v_qid = ANY(skipped_question_ids) THEN skipped_question_ids
          ELSE array_append(skipped_question_ids, v_qid)
        END,
        paused_at = NULL,
        time_added_ms = 0
    WHERE id = p_session_id;

  -- Advance to next (mirrors advance_question)
  v_total := jsonb_array_length(v_order);
  v_next := v_idx + 1;
  IF v_next >= v_total THEN
    UPDATE public.sessions
      SET status = 'ended', current_question_revealed = true
      WHERE id = p_session_id;
    RETURN QUERY SELECT v_next, true;
  ELSE
    UPDATE public.sessions
      SET current_question_index = v_next,
          current_question_started_at = now(),
          current_question_revealed = false,
          time_added_ms = 0
      WHERE id = p_session_id;
    RETURN QUERY SELECT v_next, false;
  END IF;
END; $$;

-- 7. Reset per-question ephemeral fields when advancing normally
CREATE OR REPLACE FUNCTION public.advance_question(p_session_id uuid)
RETURNS TABLE(next_index integer, ended boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    UPDATE public.sessions SET status = 'ended', current_question_revealed = true,
      paused_at = NULL, time_added_ms = 0
      WHERE id = p_session_id;
    RETURN QUERY SELECT v_next, true;
  ELSE
    UPDATE public.sessions SET current_question_index = v_next,
      current_question_started_at = now(), current_question_revealed = false, status = 'active',
      paused_at = NULL, time_added_ms = 0
      WHERE id = p_session_id;
    RETURN QUERY SELECT v_next, false;
  END IF;
END; $$;
