
-- 1. Internal (no-auth) session preparation, reused by the public RPC and the scheduler.
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
  VALUES (c.quiz_id, c.owner_id, v_code, 'lobby', c.league_id, c.branding_profile_id, v_order,
          COALESCE(c.autonomous, true) AND c.mode = 'scheduled' AND c.scheduled_start_at IS NOT NULL)
  RETURNING id INTO v_session_id;

  UPDATE public.competitions SET session_id = v_session_id, status = 'lobby_open' WHERE id = c.id;

  RETURN QUERY SELECT v_session_id, v_code, 'lobby_open'::public.competition_status, true;
END; $function$;

REVOKE ALL ON FUNCTION public.prepare_competition_session_internal(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- 2. Public RPC keeps its auth gate and delegates.
CREATE OR REPLACE FUNCTION public.prepare_competition_session(p_competition_id uuid, p_force boolean DEFAULT false)
RETURNS TABLE(session_id uuid, code text, status public.competition_status, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.competitions WHERE id = p_competition_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Competition not found'; END IF;
  IF NOT (v_owner = auth.uid() OR public.is_authorized_host()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT * FROM public.prepare_competition_session_internal(p_competition_id, p_force);
END; $function$;

-- 3. Scheduler tick: add autonomous lobby opening as step (a).
CREATE OR REPLACE FUNCTION public.run_autonomous_tick()
RETURNS TABLE(session_id uuid, action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_intro_ms constant int := 5000;
  v_hold_ms  constant int := 8000;
  r record; v_qid uuid; v_limit_ms int; v_deadline timestamptz; v_ended boolean;
  v_new_session uuid;
BEGIN
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
      -- A broken competition (archived quiz, no questions) must not stall the loop.
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

REVOKE ALL ON FUNCTION public.run_autonomous_tick() FROM PUBLIC, anon, authenticated;
