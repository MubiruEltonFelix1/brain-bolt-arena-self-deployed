-- Question playable flag ("exclude from play")
--
-- Adds questions.is_playable (boolean, NOT NULL, DEFAULT TRUE) and teaches
-- every server-side question-selection surface to skip excluded questions:
--   - get_arena_questions / get_arena_quiz_detail / get_arena_quizzes
--   - prepare_competition_session_internal (competition -> session snapshot)
--   - advance_question_internal's lazy question_order backfill
-- Client-side creation points (dashboard startSession, host startGame fallback)
-- are filtered in app code; the Quiz editor manages the flag directly.
--
-- Session-freeze semantics are preserved: sessions.question_order is written
-- ONCE at session creation from the then-playable set. Later availability
-- changes never mutate an existing session, its live order, or recorded
-- results. get_session_questions intentionally stays UNFILTERED so a frozen
-- order created before an exclusion still resolves every id it references.
--
-- Backward compatibility: DEFAULT TRUE means every existing question stays in
-- play and existing quizzes behave exactly as before.

ALTER TABLE public.questions ADD COLUMN is_playable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.questions.is_playable IS
  'FALSE = stored but excluded from gameplay (Arena, competitions, new sessions). Reversible; never affects already-created sessions or historical results.';

-- ---------------------------------------------------------------------------
-- Arena solo play: serve only playable questions.
-- (Redefinition of the Phase 8E version with `and qq.is_playable` added.)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_arena_questions(uuid);
CREATE OR REPLACE FUNCTION public.get_arena_questions(p_quiz_id uuid)
returns table(
  q_id uuid,
  q_position integer,
  q_text text,
  q_options jsonb,
  q_correct_index integer,
  q_time_limit_sec integer,
  q_point_value integer,
  q_question_type text,
  q_image_url text,
  q_audio_url text,
  q_double_points boolean,
  q_reveal_stages integer,
  q_correct_lat numeric,
  q_correct_lng numeric,
  q_max_distance_km numeric,
  q_correct_number numeric,
  q_number_min numeric,
  q_number_max numeric,
  q_number_tolerance numeric,
  q_accepted_answers text[],
  q_geo_region jsonb,
  q_geo_region_label text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    qq.id, qq.position, qq.text, qq.options, qq.correct_index, qq.time_limit_sec,
    qq.point_value, qq.question_type, qq.image_url, qq.audio_url, qq.double_points,
    qq.reveal_stages, qq.correct_lat, qq.correct_lng, qq.max_distance_km,
    qq.correct_number, qq.number_min, qq.number_max, qq.number_tolerance, qq.accepted_answers,
    qq.geo_region, qq.geo_region_label
  from questions qq
  join quizzes q on q.id = qq.quiz_id
  where qq.quiz_id = p_quiz_id
    and q.is_arena = true
    and q.archived_at is null
    and qq.is_playable
    and qq.question_type <> 'feedback'
  order by qq.position asc
$$;

grant execute on function public.get_arena_questions(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Arena listing + detail metadata: question_count reports PLAYABLE questions
-- so cards, detail pages and duration estimates agree with what a run serves.
-- (Redefinitions of the Phase 7L versions; only the count subselect changes.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_arena_quiz_detail(p_quiz_id uuid)
RETURNS table(
  id uuid,
  title text,
  description text,
  difficulty text,
  estimated_duration_minutes integer,
  play_count integer,
  time_per_question integer,
  created_at timestamptz,
  last_updated timestamptz,
  question_count integer,
  avg_accuracy numeric,
  creator_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    q.id,
    q.title,
    q.description,
    q.difficulty,
    q.estimated_duration_minutes,
    q.play_count,
    q.time_per_question,
    q.created_at,
    greatest(q.created_at, coalesce((select max(qq.created_at) from questions qq where qq.quiz_id = q.id), q.created_at)) as last_updated,
    (select count(*)::int from questions qq where qq.quiz_id = q.id and qq.is_playable) as question_count,
    (select round(avg(cr.accuracy_percentage), 1) from competition_results cr where cr.quiz_id = q.id) as avg_accuracy,
    (select p.display_name from profiles p where p.id = q.owner_principal_id) as creator_name
  from quizzes q
  where q.id = p_quiz_id
    and q.is_arena = true
    and q.archived_at is null
$$;

GRANT EXECUTE ON FUNCTION public.get_arena_quiz_detail(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_arena_quizzes()
RETURNS TABLE(
  id uuid, title text, description text, difficulty text,
  estimated_duration_minutes integer, play_count integer, time_per_question integer,
  featured_rank integer, last_updated timestamptz, question_count integer,
  avg_accuracy numeric, creator_name text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select
    q.id, q.title, q.description, q.difficulty,
    q.estimated_duration_minutes, q.play_count, q.time_per_question,
    q.featured_rank,
    greatest(q.created_at, coalesce((select max(qq.created_at) from questions qq where qq.quiz_id = q.id), q.created_at)) as last_updated,
    (select count(*)::int from questions qq where qq.quiz_id = q.id and qq.is_playable) as question_count,
    (select round(avg(cr.accuracy_percentage), 1) from competition_results cr where cr.quiz_id = q.id) as avg_accuracy,
    (select p.display_name from profiles p where p.id = q.owner_principal_id) as creator_name
  from quizzes q
  where q.is_arena = true and q.archived_at is null
  order by q.featured_rank nulls last, q.play_count desc
$$;

GRANT EXECUTE ON FUNCTION public.get_arena_quizzes() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Competition -> session engine: the lobby/scheduler snapshot now freezes ONLY
-- playable questions into sessions.question_order, and refuses to open a
-- lobby for a quiz with zero playable questions. Already-linked sessions are
-- untouched (the function returns early when c.session_id IS NOT NULL).
-- (Redefinition of the Phase 7L version; count + v_order queries change.)
-- ---------------------------------------------------------------------------
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
   WHERE q.quiz_id = c.quiz_id AND z.archived_at IS NULL AND q.is_playable;
  IF v_count = 0 THEN RAISE EXCEPTION 'Quiz is missing, archived, or has no playable questions'; END IF;

  SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
    FROM public.questions q WHERE q.quiz_id = c.quiz_id AND q.is_playable;

  LOOP
    v_attempt := v_attempt + 1;
    v_code := lpad((100000 + floor(random() * 900000))::int::text, 6, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.code = v_code);
    IF v_attempt > 20 THEN RAISE EXCEPTION 'Could not allocate a join code'; END IF;
  END LOOP;

  INSERT INTO public.sessions(quiz_id, host_id, code, status, league_id, branding_profile_id, question_order, autonomous)
  VALUES (c.quiz_id, c.owner_principal_id, v_code, 'lobby', c.league_id, c.branding_profile_id, v_order,
          COALESCE(c.autonomous, true) AND c.mode = 'scheduled' AND c.scheduled_start_at IS NOT NULL)
  RETURNING id INTO v_session_id;

  UPDATE public.competitions SET session_id = v_session_id, status = 'lobby_open' WHERE id = c.id;

  RETURN QUERY SELECT v_session_id, v_code, 'lobby_open'::public.competition_status, true;
END; $function$;

REVOKE ALL ON FUNCTION public.prepare_competition_session_internal(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Live-session engine: only the lazy backfill path changes (it runs solely for
-- legacy/missing question_order rows, i.e. effectively at first start).
-- Sessions that already carry an order keep it byte-for-byte. A backfill that
-- finds zero playable questions leaves v_order NULL -> session ends gracefully
-- (pre-existing branch below).
-- (Redefinition of the 20260804061631 version; backfill query adds the filter.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_question_internal(p_session_id uuid)
RETURNS TABLE(next_index integer, ended boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_order jsonb; v_quiz_id uuid; v_idx int; v_total int; v_next int;
BEGIN
  SELECT s.question_order, s.current_question_index, s.quiz_id
    INTO v_order, v_idx, v_quiz_id FROM public.sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  IF v_order IS NULL OR jsonb_typeof(v_order) <> 'array' OR jsonb_array_length(v_order) = 0 THEN
    SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
      FROM public.questions q WHERE q.quiz_id = v_quiz_id AND q.is_playable;
    UPDATE public.sessions SET question_order = v_order WHERE id = p_session_id;
  END IF;
  IF v_order IS NULL THEN
    UPDATE public.sessions SET status = 'ended', current_question_revealed = true,
      paused_at = NULL, time_added_ms = 0
      WHERE id = p_session_id AND status <> 'ended';
    RETURN QUERY SELECT 0, true;
    RETURN;
  END IF;
  v_total := jsonb_array_length(v_order);
  v_next := COALESCE(v_idx, -1) + 1;
  IF v_next >= v_total THEN
    UPDATE public.sessions SET status = 'ended', current_question_revealed = true,
      paused_at = NULL, time_added_ms = 0
      WHERE id = p_session_id AND status <> 'ended';
    RETURN QUERY SELECT v_next, true;
  ELSE
    UPDATE public.sessions SET current_question_index = v_next,
      current_question_started_at = now(), current_question_revealed = false, status = 'active',
      paused_at = NULL, time_added_ms = 0
      WHERE id = p_session_id;
    RETURN QUERY SELECT v_next, false;
  END IF;
END; $function$;

REVOKE ALL ON FUNCTION public.advance_question_internal(uuid) FROM PUBLIC, anon, authenticated;

-- Post-migration sanity (read-only):
--   SELECT count(*) FROM public.questions WHERE is_playable IS NULL;              -- 0 (NOT NULL column)
--   SELECT count(*) FROM public.questions WHERE is_playable = false;              -- 0 right after migration
--   Existing session orders still reference real questions even after exclusions:
--   SELECT s.id FROM public.sessions s,
--          jsonb_array_elements_text(s.question_order) AS qid
--     WHERE s.question_order IS NOT NULL
--       AND NOT EXISTS (SELECT 1 FROM public.questions q WHERE q.id::text = qid); -- 0
