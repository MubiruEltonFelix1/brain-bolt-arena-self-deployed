-- Phase 9D.2 — P0-B: restore genuine server-side transition authority.
--
-- Audit finding (Phase 9D.1): `pg_cron` was never installed on the project, so
-- `run_autonomous_scheduler` never ran and the Phase-21 "server-authoritative
-- natural expiration for ALL sessions" safety net was inert. 30 stale `active`
-- sessions proved it. A saturated host browser could therefore stall any game.
--
-- Three changes, one migration:
--
-- 1. ONE TICK PER MINUTE, NOT A 58-SECOND TRANSACTION.
--    The original scheduler (`run_autonomous_scheduler(58, 1)`) looped ticks
--    inside a SINGLE transaction that sleeps ~58 s. Every row lock taken in that
--    transaction — including the old tick's `FOR UPDATE OF s SKIP LOCKED` scan —
--    is held until it commits. Enabling it as-is would have blocked host
--    controls (`reveal_current_question`, `advance_question`, `pause_session`,
--    `add_question_time` are plain UPDATEs and would WAIT on those locks) for up
--    to ~58 s of every minute, in every hosted game. pg_cron's granularity is
--    one minute, and Postgres has no autonomous transactions, so a sub-minute
--    cadence inside one job is not safely possible. The cron job therefore runs
--    `run_autonomous_tick()` DIRECTLY (`* * * * *`): one short transaction per
--    minute, locks held for milliseconds. Trade-off, stated honestly: when the
--    host browser is dead, question expiry is finalized within ≤60 s instead of
--    within ~1 s. In a healthy game the host still drives transitions at the
--    deadline; the tick is the safety net, not the primary path.
--    `run_autonomous_scheduler()` stays in the database (untouched) for
--    rollback/manual use, but is NOT scheduled.
--
-- 2. LOCK-LIGHT, DOUBLE-ADVANCE-PROOF PROGRESSION.
--    The progression block no longer scans candidates with `FOR UPDATE` (which
--    locked every active session row for the transaction). Each action is now a
--    single guarded statement:
--      * reveal  — conditional UPDATE re-checked against the same
--        `current_question_started_at`, idempotent (`revealed = false` gate);
--      * advance — `advance_question_if_unadvanced(session, expected_started_at,
--        mode)`: takes its own statement-scoped row lock, verifies the question
--        is still the expected one, still active, still revealed, and past its
--        deadline, and only then calls the existing `advance_question_internal`.
--        A concurrent host action that moved the question on makes this a no-op,
--        so the tick can never produce the "Q4 → 5 → immediately 6" double
--        advance (brief §16).
--    The lobby-open / auto-start / cancelled blocks keep their existing
--    `FOR UPDATE … SKIP LOCKED` shape (autonomous competitions only, rare), which
--    is now safe because the transaction lives for milliseconds.
--
-- 3. STALE-SESSION RECOVERY.
--    Sessions abandoned for more than 24 h are ended once, up front, so the
--    new tick does not churn through months of dead games. Sessions live games
--    could plausibly still use (anything younger) are left for the tick, which
--    advances/pauses/ends them through the same authoritative path as always.
--
-- Observability (brief §34): pg_cron records every run in `cron.job_run_details`
-- (status, start_time, end_time, return_message). Query:
--   SELECT status, start_time, end_time, return_message
--     FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
--    WHERE j.jobname = 'brainbolt-autonomous-scheduler'
--    ORDER BY start_time DESC LIMIT 5;
--
-- Rollback (§35): `SELECT cron.unschedule('brainbolt-autonomous-scheduler');`
-- restores the pre-9D.2 state exactly (no scheduler running, host-only
-- authority). The tick/helper may be reverted with their prior definitions from
-- 20260823090000 and 20260804061631; no table data depends on this migration.

-- ---------------------------------------------------------------------------
-- 0. pg_cron (available on this project: pg_available_extensions 1.6.4)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- 1. Stale-session cleanup (once): end anything abandoned beyond 24 h.
--    Anything younger is handled by the tick through the normal path.
-- ---------------------------------------------------------------------------
UPDATE public.sessions
   SET status = 'ended',
       current_question_revealed = true,
       paused_at = NULL,
       time_added_ms = 0
 WHERE status IN ('lobby', 'active')
   AND created_at < now() - interval '24 hours';

-- ---------------------------------------------------------------------------
-- 2. Guarded advance helper — the single entry point for scheduler-driven
--    advancement. Statement-scoped lock only; verifies "still the same
--    question, still active, still revealed, past the deadline" under that lock.
--    p_mode: 'expired' (normal path) | 'repair' (broken/absent question order)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_question_if_unadvanced(
  p_session_id uuid,
  p_expected_started_at timestamptz,
  p_mode text DEFAULT 'expired'
)
RETURNS TABLE(next_index integer, ended boolean, advanced boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intro_ms constant int := 5000;   -- matches client intro window / original tick
  v_hold_ms  constant int := 8000;   -- reveal hold before advancing
  v_s public.sessions%ROWTYPE;
  v_limit_ms int;
  v_deadline timestamptz;
BEGIN
  -- Statement-scoped row lock: held for this function call only (the cron job
  -- is one short transaction per minute — see the migration header).
  SELECT * INTO v_s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::int, NULL::boolean, false;
    RETURN;
  END IF;

  IF v_s.status <> 'active' OR v_s.paused_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::int, NULL::boolean, false;
    RETURN;
  END IF;

  -- Another actor (host RPC, a previous tick, manual repair) already moved this
  -- question on. Not an error — converge by doing nothing.
  IF v_s.current_question_started_at IS DISTINCT FROM p_expected_started_at THEN
    RETURN QUERY SELECT NULL::int, NULL::boolean, false;
    RETURN;
  END IF;

  IF p_mode <> 'repair' THEN
    IF NOT v_s.current_question_revealed THEN
      RETURN QUERY SELECT NULL::int, NULL::boolean, false;
      RETURN;
    END IF;
    IF v_s.question_order IS NULL OR v_s.current_question_index IS NULL
       OR v_s.current_question_index < 0
       OR v_s.current_question_index >= jsonb_array_length(v_s.question_order) THEN
      RETURN QUERY SELECT NULL::int, NULL::boolean, false;
      RETURN;
    END IF;

    SELECT COALESCE(q.time_limit_sec, z.time_per_question, 20) * 1000
      INTO v_limit_ms
      FROM public.questions q
      JOIN public.quizzes z ON z.id = q.quiz_id
     WHERE q.id = (v_s.question_order ->> v_s.current_question_index)::uuid;

    v_limit_ms := COALESCE(v_limit_ms,
                           COALESCE((SELECT z.time_per_question FROM public.quizzes z WHERE z.id = v_s.quiz_id), 20) * 1000)
                  + GREATEST(0, COALESCE(v_s.time_added_ms, 0));

    v_deadline := v_s.current_question_started_at
                  + make_interval(secs => (v_intro_ms + v_limit_ms + v_hold_ms) / 1000.0);
    IF now() < v_deadline THEN
      RETURN QUERY SELECT NULL::int, NULL::boolean, false;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT a.next_index, a.ended, true
    FROM public.advance_question_internal(p_session_id) a;
END;
$function$;

REVOKE ALL ON FUNCTION public.advance_question_if_unadvanced(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_question_if_unadvanced(uuid, timestamptz, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. run_autonomous_tick — same responsibilities, lock-light progression.
--    Blocks a0/a/b are preserved verbatim from 20260823090000; block c is the
--    guarded rewrite described above.
-- ---------------------------------------------------------------------------
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
  --     NO row locks on the candidate scan; every action re-checks its own
  --     preconditions under a statement-scoped lock (see helper above).
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
    -- Repair path: broken/absent order or index out of range → let the
    -- authoritative internal advance end or repair the session.
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
      -- Idempotent, guarded reveal: only when it is still the same question,
      -- still un-revealed, and the deadline has passed.
      UPDATE public.sessions
         SET current_question_revealed = true
       WHERE id = r.id
         AND status = 'active'
         AND paused_at IS NULL
         AND current_question_revealed = false
         AND current_question_started_at = r.current_question_started_at
         AND now() >= v_deadline;
      IF FOUND THEN
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

-- ---------------------------------------------------------------------------
-- 4. The cron job: ONE tick per minute (never the 58 s in-transaction loop).
--    Rescheduled idempotently under the same job name so no competing
--    scheduler can exist.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('brainbolt-autonomous-scheduler');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'brainbolt-autonomous-scheduler',
  '* * * * *',
  $$SELECT public.run_autonomous_tick();$$
);

-- ---------------------------------------------------------------------------
-- Post-migration verification (read-only, manual):
--   SELECT jobname, schedule, command FROM cron.job;
--   --   brainbolt-autonomous-scheduler | * * * * * | SELECT public.run_autonomous_tick();
--   -- after ~1 minute:
--   SELECT status, start_time, end_time FROM cron.job_run_details d
--     JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'brainbolt-autonomous-scheduler'
--    ORDER BY start_time DESC LIMIT 3;
--   -- and no long-held row locks while a game is active:
--   SELECT count(*) FROM pg_locks WHERE locktype = 'tuple' AND relation = 'public.sessions'::regclass;
-- ---------------------------------------------------------------------------
