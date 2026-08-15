CREATE INDEX IF NOT EXISTS sessions_autonomous_live_idx
  ON public.sessions (status)
  WHERE autonomous AND status IN ('lobby','active');

CREATE OR REPLACE FUNCTION public.run_autonomous_tick()
 RETURNS TABLE(session_id uuid, action text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intro_ms constant int := 5000;
  v_hold_ms  constant int := 8000;
  r record; v_qid uuid; v_limit_ms int; v_deadline timestamptz; v_ended boolean;
  v_new_session uuid;
BEGIN
  -- (a0) Cancelled competitions must not leave a live session behind.
  FOR r IN
    SELECT s.id
      FROM public.sessions s
      JOIN public.competitions c ON c.session_id = s.id
     WHERE s.autonomous AND s.status IN ('lobby','active')
       AND c.status = 'cancelled'
     FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.sessions
       SET status = 'ended', current_question_revealed = true,
           paused_at = NULL, time_added_ms = 0
     WHERE id = r.id AND status <> 'ended';
    session_id := r.id; action := 'cancelled'; RETURN NEXT;
  END LOOP;

  -- (a) Open lobbies automatically when the lobby window arrives.
  FOR r IN
    SELECT c.id
      FROM public.competitions c
     WHERE c.status = 'scheduled'
       AND c.mode = 'scheduled'
       AND COALESCE(c.autonomous, false)
       AND c.session_id IS NULL
       AND c.scheduled_start_at IS NOT NULL
       AND now() >= c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds)
     FOR UPDATE OF c SKIP LOCKED
  LOOP
    BEGIN
      SELECT p.session_id INTO v_new_session
        FROM public.prepare_competition_session_internal(r.id, false) p;
      session_id := v_new_session; action := 'lobby_opened'; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
  END LOOP;

  -- (b) Automatic start: begin the intro so question 1 opens at scheduled_start_at.
  FOR r IN
    SELECT s.id
      FROM public.sessions s
      JOIN public.competitions c ON c.session_id = s.id
     WHERE s.autonomous AND s.status = 'lobby'
       AND c.status = 'lobby_open' AND c.mode = 'scheduled'
       AND COALESCE(c.autonomous, false)
       AND c.scheduled_start_at IS NOT NULL
       AND now() >= c.scheduled_start_at - make_interval(secs => v_intro_ms / 1000.0)
     FOR UPDATE OF s SKIP LOCKED
  LOOP
    SELECT a.ended INTO v_ended FROM public.advance_question_internal(r.id) a;
    session_id := r.id; action := 'started'; RETURN NEXT;
  END LOOP;

  -- (c) Progression for running autonomous sessions (competition-backed only)
  FOR r IN
    SELECT s.id, s.quiz_id, s.question_order, s.current_question_index,
           s.current_question_revealed, s.current_question_started_at, s.time_added_ms,
           z.time_per_question
      FROM public.sessions s
      JOIN public.quizzes z ON z.id = s.quiz_id
      JOIN public.competitions c ON c.session_id = s.id
     WHERE s.autonomous AND s.status = 'active' AND s.paused_at IS NULL
       AND c.mode = 'scheduled' AND COALESCE(c.autonomous, false)
       AND c.status IN ('lobby_open', 'running')
     FOR UPDATE OF s SKIP LOCKED
  LOOP
    IF r.question_order IS NULL OR r.current_question_index IS NULL
       OR r.current_question_index < 0
       OR r.current_question_index >= jsonb_array_length(r.question_order) THEN
      SELECT a.ended INTO v_ended FROM public.advance_question_internal(r.id) a;
      session_id := r.id; action := 'advanced'; RETURN NEXT;
      CONTINUE;
    END IF;

    v_qid := (r.question_order ->> r.current_question_index)::uuid;

    SELECT COALESCE(q.time_limit_sec, r.time_per_question, 20) * 1000
      INTO v_limit_ms FROM public.questions q WHERE q.id = v_qid;
    v_limit_ms := COALESCE(v_limit_ms, COALESCE(r.time_per_question, 20) * 1000)
                  + GREATEST(0, COALESCE(r.time_added_ms, 0));

    IF r.current_question_started_at IS NULL THEN
      UPDATE public.sessions SET current_question_started_at = now() WHERE id = r.id;
      CONTINUE;
    END IF;

    v_deadline := r.current_question_started_at
                  + make_interval(secs => (v_intro_ms + v_limit_ms) / 1000.0);

    IF NOT r.current_question_revealed THEN
      IF now() >= v_deadline THEN
        UPDATE public.sessions SET current_question_revealed = true
          WHERE id = r.id AND status = 'active' AND current_question_revealed = false;
        session_id := r.id; action := 'revealed'; RETURN NEXT;
      END IF;
    ELSE
      IF now() >= v_deadline + make_interval(secs => v_hold_ms / 1000.0) THEN
        SELECT a.ended INTO v_ended FROM public.advance_question_internal(r.id) a;
        session_id := r.id;
        action := CASE WHEN v_ended THEN 'completed' ELSE 'advanced' END;
        RETURN NEXT;
      END IF;
    END IF;
  END LOOP;

  RETURN;
END; $function$;