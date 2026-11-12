-- =============================================================================
-- Phase 12 — Quiz Sections: competition RPC session snapshots
-- -----------------------------------------------------------------------------
-- Updates `public.prepare_competition_session_internal` so competition-created
-- sessions carry the same immutable section snapshot as dashboard-created
-- sessions.
--
-- Changes:
--   * Reads `quizzes.question_flow` for the linked quiz.
--   * For `categorized` quizzes:
--       - Validates that no playable scored question lacks a section (raises
--         an exception, aborting session creation, mirroring the dashboard
--         pre-start gate).
--       - Builds `question_order` in canonical section order (sections by
--         position/created_at/id, questions within a section by position/id,
--         ungrouped feedback appended at the end).
--       - Builds the immutable `section_snapshot` JSONB capturing section ids,
--         titles, positions, and question ids.
--       - Inserts with `presentation_mode = 'categorized'` and the snapshot.
--   * For `flat` quizzes: behaviour is byte-identical to before
--     (`jsonb_agg(q.id ORDER BY q.position)`, presentation_mode defaults to
--     'flat', section_snapshot NULL).
--
-- Existing columns, policies, permissions, participant handling, and session
-- creation semantics are preserved. No new tables or columns are added here
-- (those were added by the previous migration).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prepare_competition_session_internal(p_competition_id uuid, p_force boolean DEFAULT false)
RETURNS TABLE(session_id uuid, code text, status public.competition_status, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c public.competitions%ROWTYPE;
  v_code text; v_order jsonb; v_session_id uuid; v_count int; v_attempt int := 0;
  v_flow text; v_snapshot jsonb;
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
   WHERE q.quiz_id = c.quiz_id AND z.archived_at IS NULL AND q.is_playable;
  IF v_count = 0 THEN RAISE EXCEPTION 'Quiz is missing, archived, or has no playable questions'; END IF;

  -- Read the quiz's authoring layout (defaults to flat when the column is
  -- absent, e.g. on a database that predates the Phase 12 migration).
  SELECT z.question_flow INTO v_flow FROM public.quizzes z WHERE z.id = c.quiz_id;

  IF v_flow = 'categorized' THEN
    -- Reject playable scored questions without a section, mirroring the
    -- dashboard pre-start gate. Feedback may be ungrouped (plays last).
    SELECT count(*) INTO v_count
      FROM public.questions q
     WHERE q.quiz_id = c.quiz_id AND q.is_playable
       AND q.question_type <> 'feedback' AND q.section_id IS NULL;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Categorized quiz has playable questions not assigned to any section';
    END IF;

    -- Immutable snapshot: section ids, titles, positions, and question ids.
    SELECT jsonb_build_object(
      'presentation_mode', 'categorized',
      'sections', coalesce((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'title', s.title,
            'position', s.position,
            'question_ids', coalesce(sq.q_ids, '[]'::jsonb)
          )
          ORDER BY s.position, s.created_at, s.id
        )
        FROM public.quiz_sections s
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(q.id ORDER BY q.position, q.id) AS q_ids
          FROM public.questions q
          WHERE q.section_id = s.id AND q.is_playable
        ) sq ON true
        WHERE s.quiz_id = c.quiz_id
      ), '[]'::jsonb)
    ) INTO v_snapshot;

    -- Flat question order in canonical section presentation order. Ungrouped
    -- questions (no section) sort after all sections.
    SELECT jsonb_agg(q.id ORDER BY
      COALESCE(s.position, 999999), s.created_at, s.id, q.position, q.id
    ) INTO v_order
    FROM public.questions q
    LEFT JOIN public.quiz_sections s ON q.section_id = s.id
    WHERE q.quiz_id = c.quiz_id AND q.is_playable;
  ELSE
    -- Flat quiz: existing behaviour, question order by position only.
    SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
      FROM public.questions q WHERE q.quiz_id = c.quiz_id AND q.is_playable;
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    v_code := lpad((100000 + floor(random() * 900000))::int::text, 6, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.code = v_code);
    IF v_attempt > 20 THEN RAISE EXCEPTION 'Could not allocate a join code'; END IF;
  END LOOP;

  INSERT INTO public.sessions(quiz_id, host_id, code, status, league_id, branding_profile_id, question_order, presentation_mode, section_snapshot, autonomous)
  VALUES (c.quiz_id, c.owner_principal_id, v_code, 'lobby', c.league_id, c.branding_profile_id, v_order,
          COALESCE(v_flow, 'flat'), v_snapshot,
          COALESCE(c.autonomous, true) AND c.mode = 'scheduled' AND c.scheduled_start_at IS NOT NULL)
  RETURNING id INTO v_session_id;

  UPDATE public.competitions SET session_id = v_session_id, status = 'lobby_open' WHERE id = c.id;

  RETURN QUERY SELECT v_session_id, v_code, 'lobby_open'::public.competition_status, true;
END; $function$;

REVOKE ALL ON FUNCTION public.prepare_competition_session_internal(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_competition_session_internal(uuid, boolean) TO authenticated, service_role;

-- Post-application verification (read-only, safe to re-run):
--   The function now accepts and sets presentation_mode / section_snapshot:
--     SELECT pg_get_functiondef('public.prepare_competition_session_internal(uuid,boolean)'::regprocedure)
--           LIKE '%section_snapshot%';                                          -- true
--   Flat sessions still get presentation_mode = 'flat':
--     (inspect a session created by a competition on a flat quiz)
