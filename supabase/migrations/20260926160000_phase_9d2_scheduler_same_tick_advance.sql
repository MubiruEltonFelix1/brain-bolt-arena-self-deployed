-- Phase 9D.2 P0-B follow-up: a LATE tick may reveal AND advance in one
-- invocation.
--
-- Measured by scripts/scale-audit/tick-expiry-test.mjs (50 players, no host
-- action): with the one-tick-per-minute cadence, a question whose reveal was
-- finalized late (tick landed 33 s after the deadline, i.e. the 8 s reveal hold
-- was already over) still had to wait for the NEXT tick to advance — 84 s from
-- the advance threshold, ~2 full cadences of dead air for a dead host.
--
-- Fix: when the reveal branch fires and `now()` is already past
-- deadline + hold, the SAME tick immediately runs the guarded advance
-- (`advance_question_if_unadvanced`, mode 'expired'). Behaviour when a host is
-- present is unchanged (the host reveals at the deadline; the tick sees
-- `revealed = true` and takes the existing advance branch). Worst case for a
-- dead host drops from two cadences to one.
--
-- No new tables; the guarded helper and all safety checks are reused verbatim.
-- Rollback: re-apply the previous `run_autonomous_tick` definition from
-- 20260926140000_phase_9d2_scheduler.sql.

CREATE OR REPLACE FUNCTION public.run_autonomous_tick()
RETURNS TABLE(session_id uuid, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intro_ms constant int := 5000;
  v_hold_ms  constant int := 8000;
  r record;
  v_new_session uuid;
  v_qid uuid;
  v_limit_ms int;
  v_deadline timestamptz;
  v_ended boolean;
  v_did boolean;
  v_next int;
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

  -- (a) Lobby opening (autonomous competitions only — unchanged).
  FOR r IN
    SELECT c.id
      FROM public.competitions c
     WHERE c.mode = 'scheduled' AND COALESCE(c.autonomous, false)
       AND c.status = 'scheduled' AND c.session_id IS NULL
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

  -- (b) Automatic start (autonomous competitions only — unchanged).
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

  -- (c) Progression: BOTH autonomous and hosted active sessions.
  --     Lock-light scan; every action re-checks its preconditions under a
  --     statement-scoped lock (see advance_question_if_unadvanced).
  FOR r IN
    SELECT s.id, s.quiz_id, s.question_order, s.current_question_index,
           s.current_question_revealed, s.current_question_started_at, s.time_added_ms,
           z.time_per_question
      FROM public.sessions s
      JOIN public.quizzes z ON z.id = s.quiz_id
      LEFT JOIN public.competitions c ON c.session_id = s.id
     WHERE s.status = 'active' AND s.paused_at IS NULL
       AND (
         (s.autonomous
          AND c.id IS NOT NULL
          AND c.mode = 'scheduled'
          AND COALESCE(c.autonomous, false)
          AND c.status IN ('lobby_open', 'running'))
         OR
         (NOT s.autonomous AND s.host_id IS NOT NULL)
       )
  LOOP
    -- Repair path: broken/absent order or index out of range.
    IF r.question_order IS NULL OR r.current_question_index IS NULL
       OR r.current_question_index < 0
       OR r.current_question_index >= jsonb_array_length(r.question_order) THEN
      SELECT a.next_index, a.ended, a.advanced INTO v_next, v_ended, v_did
        FROM public.advance_question_if_unadvanced(r.id, r.current_question_started_at, 'repair') a;
      IF v_did THEN
        session_id := r.id; action := CASE WHEN v_ended THEN 'completed' ELSE 'repaired' END; RETURN NEXT;
      END IF;
      CONTINUE;
    END IF;

    v_qid := (r.question_order ->> r.current_question_index)::uuid;

    SELECT COALESCE(q.time_limit_sec, r.time_per_question, 20) * 1000
      INTO v_limit_ms
      FROM public.questions q WHERE q.id = v_qid;

    IF r.current_question_started_at IS NULL THEN
      UPDATE public.sessions
         SET current_question_started_at = now()
       WHERE id = r.id AND status = 'active' AND paused_at IS NULL
         AND current_question_started_at IS NULL;
      CONTINUE;
    END IF;

    v_limit_ms := COALESCE(v_limit_ms, COALESCE(r.time_per_question, 20) * 1000)
                  + GREATEST(0, COALESCE(r.time_added_ms, 0));
    v_deadline := r.current_question_started_at
                  + make_interval(secs => (v_intro_ms + v_limit_ms) / 1000.0);

    IF NOT r.current_question_revealed THEN
      -- Idempotent, guarded reveal.
      UPDATE public.sessions
         SET current_question_revealed = true
       WHERE id = r.id
         AND status = 'active'
         AND paused_at IS NULL
         AND current_question_revealed = false
         AND current_question_started_at = r.current_question_started_at
         AND now() >= v_deadline;
      IF FOUND THEN
        -- A late tick may arrive after the hold window is already over; in that
        -- case advance in the SAME invocation instead of burning another minute.
        IF now() >= v_deadline + make_interval(secs => v_hold_ms / 1000.0) THEN
          SELECT a.next_index, a.ended, a.advanced INTO v_next, v_ended, v_did
            FROM public.advance_question_if_unadvanced(r.id, r.current_question_started_at, 'expired') a;
          IF v_did THEN
            session_id := r.id;
            action := CASE WHEN v_ended THEN 'completed' ELSE 'revealed_advanced' END;
            RETURN NEXT;
            CONTINUE;
          END IF;
        END IF;
        session_id := r.id; action := 'revealed'; RETURN NEXT;
      END IF;
    ELSE
      SELECT a.next_index, a.ended, a.advanced INTO v_next, v_ended, v_did
        FROM public.advance_question_if_unadvanced(r.id, r.current_question_started_at, 'expired') a;
      IF v_did THEN
        session_id := r.id;
        action := CASE WHEN v_ended THEN 'completed' ELSE 'advanced' END;
        RETURN NEXT;
      END IF;
    END IF;
  END LOOP;

  RETURN;
END; $function$;

REVOKE ALL ON FUNCTION public.run_autonomous_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_autonomous_tick() TO service_role;

-- Post-migration verification (read-only, manual):
--   SELECT prosrc LIKE '%revealed_advanced%' AS same_tick_advance
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'run_autonomous_tick';
