-- 1) Data fix: only competition-backed scheduled sessions may be autonomous
UPDATE public.sessions s
   SET autonomous = false
 WHERE s.autonomous
   AND NOT EXISTS (
     SELECT 1 FROM public.competitions c
      WHERE c.session_id = s.id
        AND c.mode = 'scheduled'
        AND COALESCE(c.autonomous, false)
   );

-- 2) Tick: scope progression to competition-backed autonomous sessions and
--    start the intro early so question 1 opens at scheduled_start_at.
CREATE OR REPLACE FUNCTION public.run_autonomous_tick()
 RETURNS TABLE(session_id uuid, action text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intro_ms constant int := 5000;   -- client-side question intro window
  v_hold_ms  constant int := 8000;   -- results/reveal hold before advancing
  r record;
  v_qid uuid;
  v_limit_ms int;
  v_deadline timestamptz;
  v_ended boolean;
BEGIN
  -- (a) Automatic start: begin the intro `intro` before the scheduled time so
  --     the first question actually opens at scheduled_start_at.
  FOR r IN
    SELECT s.id
      FROM public.sessions s
      JOIN public.competitions c ON c.session_id = s.id
     WHERE s.autonomous
       AND s.status = 'lobby'
       AND c.status = 'lobby_open'
       AND c.mode = 'scheduled'
       AND COALESCE(c.autonomous, false)
       AND c.scheduled_start_at IS NOT NULL
       AND now() >= c.scheduled_start_at - make_interval(secs => v_intro_ms / 1000.0)
     FOR UPDATE OF s SKIP LOCKED
  LOOP
    SELECT a.ended INTO v_ended FROM public.advance_question_internal(r.id) a;
    session_id := r.id; action := 'started'; RETURN NEXT;
  END LOOP;

  -- (b) Progression for running autonomous sessions (competition-backed only)
  FOR r IN
    SELECT s.id, s.quiz_id, s.question_order, s.current_question_index,
           s.current_question_revealed, s.current_question_started_at, s.time_added_ms,
           z.time_per_question
      FROM public.sessions s
      JOIN public.quizzes z ON z.id = s.quiz_id
      JOIN public.competitions c ON c.session_id = s.id
     WHERE s.autonomous
       AND s.status = 'active'
       AND s.paused_at IS NULL
       AND c.mode = 'scheduled'
       AND COALESCE(c.autonomous, false)
       AND c.status IN ('lobby_open', 'running')
     FOR UPDATE OF s SKIP LOCKED
  LOOP
    IF r.question_order IS NULL
       OR r.current_question_index IS NULL
       OR r.current_question_index < 0
       OR r.current_question_index >= jsonb_array_length(r.question_order) THEN
      SELECT a.ended INTO v_ended FROM public.advance_question_internal(r.id) a;
      session_id := r.id; action := 'advanced'; RETURN NEXT;
      CONTINUE;
    END IF;

    v_qid := (r.question_order ->> r.current_question_index)::uuid;

    SELECT COALESCE(q.time_limit_sec, r.time_per_question, 20) * 1000
      INTO v_limit_ms
      FROM public.questions q WHERE q.id = v_qid;
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

-- 3) Tighter scheduler resolution: check every second, cover the whole minute
SELECT cron.alter_job(1, command => 'SELECT public.run_autonomous_scheduler(58, 1);');
