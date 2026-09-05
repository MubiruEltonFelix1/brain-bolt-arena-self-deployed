-- Phase 21: Multiplayer Question Timeout Reliability
--
-- A production incident at ~50 concurrent players showed that the visible
-- question timer reached 0 but the question did NOT automatically transition.
-- The host had to press End Question Early multiple times to recover.
--
-- Root cause: the autonomous tick (`run_autonomous_tick`) only processes
-- sessions with `s.autonomous = true` (the competition-backed, scheduled
-- path). For manually-hosted sessions — the university session in question
-- had `sessions.autonomous = false` — natural expiration depended entirely
-- on the host browser firing `reveal_current_question`. Under 50-player
-- load the host's JS event loop saturated with realtime events, the
-- `setTimeout(..., 250)` queued behind it, and the host UI appeared frozen
-- on the old question until manual intervention.
--
-- This phase makes natural expiration server-authoritative for ALL active
-- sessions (autonomous AND hosted), adds stale-state protection to the
-- host RPCs, and (by way of Decision 2 in the Phase 21 plan) fixes the
-- "session not in admin analytics" symptom that stems from the same
-- `controlBusy` wedge blocking the final `advance_question`.
--
-- Design notes:
--   - One migration, three sections, no new tables, no new cron job.
--   - The existing `run_autonomous_tick` is REPLACED (not duplicated). Its
--     progression block's WHERE clause is widened to also match hosted
--     sessions with a non-null `host_id`. The competition-backed sub-filter
--     is preserved for autonomous sessions; hosted sessions take a parallel
--     path that does not require a competitions row.
--   - The deadline formula (`current_question_started_at + INTRO + time_limit_ms
--     + time_added_ms`) is reused verbatim. It already mirrors the
--     client-side `getQuestionIntroTiming` calculation.
--   - The reveal branch (`UPDATE … WHERE current_question_revealed = false`)
--     is already idempotent and serialized via `SKIP LOCKED`; no change
--     needed.
--   - `reveal_current_question` and `end_question_early` gain an optional
--     `p_expected_started_at` parameter. When supplied, the UPDATE WHERE
--     clause matches only if the row's `current_question_started_at`
--     equals it. This prevents a reconnecting client with a stale view
--     from flipping `current_question_revealed = true` on the WRONG
--     question (a real latent risk that pre-Phase-21 callers could not
--     detect).
--   - The two RPCs intentionally differ on stale behavior:
--       * `reveal_current_question` RAISES `phase21.stale_started_at` —
--         client catches it via the error-capture taxonomy and calls
--         `load()` to resync silently. Expected behavior after a
--         fast-forward.
--       * `end_question_early` silently no-ops — End-Early is the host's
--         recovery hammer; a stale tab hammering End-Early must NOT be
--         blocked with an error. The realtime UPDATE will reconcile.
--   - Scoring, timing semantics, Arena, autonomous competition lifecycle,
--     guest claiming, league standings, competition result recording,
--     question rendering, shared question registry, AI, MCP, and principal
--     architecture are all UNCHANGED.

-- ============================================================================
-- Section 1: Broaden `run_autonomous_tick` to cover hosted active sessions.
--
-- The previous definition restricted the progression block to competition-
-- backed autonomous sessions via an INNER JOIN on `public.competitions`.
-- Hosted sessions (which may have no competition row at all) were excluded.
--
-- We replace the function with a version whose progression block uses a
-- LEFT JOIN and a broader WHERE. Autonomous sessions keep their existing
-- behaviour verbatim (still gated by `c.mode = 'scheduled'` and the
-- competition status filter). Hosted sessions take a parallel path that
-- only requires the session row itself.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.run_autonomous_tick()
RETURNS TABLE(session_id uuid, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intro_ms constant int := 5000;   -- client-side question intro window
  v_hold_ms  constant int := 8000;   -- results/reveal hold before advancing
  r record;                           -- FOR-loop row variable (cancelled, lobby_opened, started, revealed, advanced)
  v_new_session uuid;
  v_qid uuid;
  v_limit_ms int;
  v_deadline timestamptz;
  v_ended boolean;
BEGIN
  -- (a0) Cancelled competitions must not leave a live session behind.
  -- PRESERVED FROM PRIOR DEFINITION (20260805055746 L17-31). Dropping this
  -- block would let orphaned sessions from cancelled competitions linger
  -- in 'lobby'/'active' state.
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

  -- (c) Progression: widened to BOTH autonomous and hosted active sessions.
  --
  -- A session is in scope when:
  --   * `status = 'active'` AND `paused_at IS NULL` (not paused)
  --   * AND one of:
  --       (i)  autonomous AND competition-backed AND the competition
  --            allows the scheduler to drive it, OR
  --       (ii) hosted (autonomous = false) AND has a host_id
  --
  -- The LEFT JOIN on competitions preserves the autonomous-session path
  -- (cases where a competition row exists) while allowing hosted sessions
  -- (which may or may not have a competition row, depending on whether the
  -- host opened the session directly from the dashboard vs. as a scheduled
  -- competition) to match without one.
  --
  -- A single SELECT row is processed per iteration. `SKIP LOCKED` ensures
  -- concurrent ticks and any in-flight host RPCs (`pause_session`,
  -- `resume_session`, `add_question_time`) cannot deadlock. The reveal
  -- branch's UPDATE is itself idempotent (matches 0 rows when already
  -- revealed), so multiple ticks firing in the same second are safe.
  FOR r IN
    SELECT s.id, s.quiz_id, s.question_order, s.current_question_index,
           s.current_question_revealed, s.current_question_started_at, s.time_added_ms,
           z.time_per_question
      FROM public.sessions s
      JOIN public.quizzes z ON z.id = s.quiz_id
      LEFT JOIN public.competitions c ON c.session_id = s.id
     WHERE s.status = 'active' AND s.paused_at IS NULL
       AND (
         -- (i) autonomous, competition-backed, scheduler-driven
         (s.autonomous
          AND c.id IS NOT NULL
          AND c.mode = 'scheduled'
          AND COALESCE(c.autonomous, false)
          AND c.status IN ('lobby_open', 'running'))
         OR
         -- (ii) hosted (manually driven from the host UI); server is the
         -- safety net for natural expiration. The session keeps progressing
         -- even if the host closes their tab mid-quiz — matches the existing
         -- behaviour for autonomous sessions.
         (NOT s.autonomous AND s.host_id IS NOT NULL)
       )
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
GRANT EXECUTE ON FUNCTION public.run_autonomous_tick() TO service_role;

-- ============================================================================
-- Section 2: Stale-state protection on `reveal_current_question`.
--
-- Adds an OPTIONAL `p_expected_started_at` parameter. When supplied, the
-- UPDATE WHERE clause matches only when the row's `current_question_started_at`
-- equals it. On mismatch, RAISE a typed exception with ERRCODE P0001 so the
-- error-capture layer can route it through the Phase 10A taxonomy.
--
-- When the parameter is NULL, the function behaves exactly as before
-- (backward compatible with any callers we may have missed).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reveal_current_question(
  p_session_id uuid,
  p_expected_started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actual_started_at timestamptz;
  v_rows int;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;

  IF p_expected_started_at IS NOT NULL THEN
    SELECT current_question_started_at INTO v_actual_started_at
      FROM public.sessions WHERE id = p_session_id;
    IF v_actual_started_at IS DISTINCT FROM p_expected_started_at THEN
      RAISE EXCEPTION 'phase21.stale_started_at:session=% expected=% actual=%',
        p_session_id, p_expected_started_at, v_actual_started_at
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Backward-compatible path: when `p_expected_started_at` is NULL we mirror
  -- the pre-Phase-21 definition exactly (no `current_question_revealed = false`
  -- short-circuit). This keeps the contract for any caller that hasn't been
  -- updated to pass the new parameter. When the parameter IS supplied, we
  -- gate the UPDATE on both revealed=false AND started_at matching, so the
  -- stale check above is double-guarded and a non-stale call is still a
  -- no-op when the question is already revealed (preserves idempotency).
  IF p_expected_started_at IS NULL THEN
    UPDATE public.sessions
      SET current_question_revealed = true
      WHERE id = p_session_id AND status = 'active';
  ELSE
    UPDATE public.sessions
      SET current_question_revealed = true
      WHERE id = p_session_id
        AND status = 'active'
        AND current_question_revealed = false
        AND current_question_started_at = p_expected_started_at;
  END IF;
END; $$;

-- ============================================================================
-- Section 3: Stale-state protection on `end_question_early`.
--
-- Same `p_expected_started_at` parameter, but stale behaviour is SILENT
-- no-op (UPDATE matches 0 rows, no error). End-Early is the host's recovery
-- hammer; a stale tab hammering End-Early must NOT be blocked with an
-- error. The realtime UPDATE will reconcile the host's view within a few
-- hundred milliseconds.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.end_question_early(
  p_session_id uuid,
  p_expected_started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN RAISE EXCEPTION 'Not the host'; END IF;

  -- Clear pause so downstream logic runs cleanly. Update is idempotent.
  UPDATE public.sessions
    SET current_question_revealed = true,
        paused_at = NULL
    WHERE id = p_session_id
      AND status = 'active'
      AND (
        p_expected_started_at IS NULL
        OR current_question_started_at = p_expected_started_at
      );
END; $$;

-- ============================================================================
-- Section 4: GRANTs (unchanged from prior definitions).
-- ============================================================================

REVOKE ALL ON FUNCTION public.reveal_current_question(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reveal_current_question(uuid, timestamptz) TO authenticated;

REVOKE ALL ON FUNCTION public.end_question_early(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.end_question_early(uuid, timestamptz) TO authenticated;

-- ============================================================================
-- Section 5: Post-migration sanity queries (read-only — for the operator).
--
-- Confirm the broadened tick is seeing hosted sessions:
--   SELECT s.id, s.autonomous, c.id IS NOT NULL AS has_competition
--     FROM public.sessions s
--     LEFT JOIN public.competitions c ON c.session_id = s.id
--    WHERE s.status = 'active';
--
-- Confirm the existing pg_cron schedule is still in place (it should be):
--   SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'brainbolt-autonomous-scheduler';
-- ============================================================================