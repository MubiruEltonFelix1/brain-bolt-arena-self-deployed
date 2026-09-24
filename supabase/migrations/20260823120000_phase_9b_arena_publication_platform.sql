-- =============================================================================
-- Phase 9B — Arena Product, Governance & UI/UX Redesign
-- =============================================================================
-- Adds a deliberate Arena publication model to the existing `quizzes` table,
-- a platform on/off switch, a moderation log, per-run per-question answer rows,
-- and the entire server-side surface (public + creator + admin) for the new
-- Arena product. Hosted competition, league, training, and the question
-- engine are NOT modified.
--
-- Conceptual model:
--   Quiz ─→ Arena publication state (creator axis)
--        ─→ Arena admin state      (platform-admin axis)
--        ─→ Arena discovery & run
--
-- Effective Arena visibility (the single WHERE used by every public RPC and
-- the RLS policy):
--   arena_publication_status = 'published'
--   AND arena_admin_status   = 'visible'
--   AND archived_at IS NULL
--
-- Notes:
--   * The boolean `is_arena` and `featured_rank` columns are dropped; the
--     new columns are the single source of truth. The RLS policy that used
--     `is_arena` is redefined to read the new effective formula.
--   * `archived` is a value on `arena_publication_status`; it is distinct
--     from the existing `archived_at` (which is the quiz-level soft-archive
--     and continues to mean "the quiz is gone entirely").
--   * `arena_run_answers` stores per-question data for every Arena run so
--     the completion screen can show deterministic insights and the admin
--     "Hardest question" view can be computed authoritatively.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. New columns on `quizzes`
-- ---------------------------------------------------------------------------
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS arena_publication_status text NOT NULL DEFAULT 'draft'
    CHECK (arena_publication_status IN ('draft','published','hidden','archived')),
  ADD COLUMN IF NOT EXISTS arena_admin_status text NOT NULL DEFAULT 'visible'
    CHECK (arena_admin_status IN ('visible','hidden')),
  ADD COLUMN IF NOT EXISTS arena_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS arena_featured_rank integer,
  ADD COLUMN IF NOT EXISTS arena_category text,
  ADD COLUMN IF NOT EXISTS tags text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags_tsv tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(arena_category, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(tags, '')), 'D')
    ) STORED;

COMMENT ON COLUMN public.quizzes.arena_publication_status IS
  'Creator-controlled Arena visibility: draft | published | hidden | archived.';
COMMENT ON COLUMN public.quizzes.arena_admin_status IS
  'Admin-controlled Arena visibility: visible | hidden.';
COMMENT ON COLUMN public.quizzes.arena_published_at IS
  'Stamped on every transition into arena_publication_status=published; powers the New section.';
COMMENT ON COLUMN public.quizzes.arena_featured_rank IS
  'When non-null, the quiz is featured in the Arena home (lower rank = earlier).';
COMMENT ON COLUMN public.quizzes.arena_category IS
  'Single free-text category bucket (e.g. "History", "Geography"). No taxonomy this phase.';
COMMENT ON COLUMN public.quizzes.tags IS
  'Semicolon-separated tags (CSV importer style). Used by search alongside title/description/category.';
COMMENT ON COLUMN public.quizzes.tags_tsv IS
  'Generated tsvector over title/description/arena_category/tags. Search index.';

-- ---------------------------------------------------------------------------
-- 2. Indexes (the old partial index is dropped first)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.quizzes_is_arena_idx;

CREATE INDEX IF NOT EXISTS quizzes_arena_listing_idx
  ON public.quizzes (arena_featured_rank NULLS LAST, play_count DESC)
  WHERE arena_publication_status = 'published'
    AND arena_admin_status       = 'visible'
    AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS quizzes_arena_published_at_idx
  ON public.quizzes (arena_published_at DESC)
  WHERE arena_publication_status = 'published'
    AND arena_admin_status       = 'visible';

CREATE INDEX IF NOT EXISTS quizzes_arena_category_idx
  ON public.quizzes (arena_category)
  WHERE arena_category IS NOT NULL;

CREATE INDEX IF NOT EXISTS quizzes_arena_tags_tsv_idx
  ON public.quizzes USING GIN (tags_tsv);

-- ---------------------------------------------------------------------------
-- 3. RLS policy redefinition (the public Arena read path)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Arena quizzes are publicly readable" ON public.quizzes;
CREATE POLICY "Arena quizzes are publicly readable"
  ON public.quizzes FOR SELECT
  TO anon, authenticated
  USING (
    arena_publication_status = 'published'
    AND arena_admin_status   = 'visible'
    AND archived_at IS NULL
  );

-- ---------------------------------------------------------------------------
-- 4. Drop the legacy boolean (single source of truth — no trigger mirror)
-- ---------------------------------------------------------------------------
ALTER TABLE public.quizzes DROP COLUMN IF EXISTS is_arena;
ALTER TABLE public.quizzes DROP COLUMN IF EXISTS featured_rank;

-- ---------------------------------------------------------------------------
-- 5. Platform settings (single row, id=1) — Arena open/closed switch
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  arena_open boolean NOT NULL DEFAULT true,
  arena_closed_message text NOT NULL DEFAULT
    'The Arena is temporarily closed. Please check back soon.',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
INSERT INTO public.platform_settings (id, arena_open)
  VALUES (1, true)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_settings public read" ON public.platform_settings
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "platform_settings admin write" ON public.platform_settings
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------------
-- 6. Arena moderation log (admin-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_moderation_log (
  id bigserial PRIMARY KEY,
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arena_moderation_log_quiz_idx
  ON public.arena_moderation_log (quiz_id, created_at DESC);
CREATE INDEX IF NOT EXISTS arena_moderation_log_actor_idx
  ON public.arena_moderation_log (actor_id, created_at DESC);

ALTER TABLE public.arena_moderation_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "arena_moderation_log admin only" ON public.arena_moderation_log
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------------
-- 7. Arena run answers — per-question data for every Arena run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_run_answers (
  run_id uuid NOT NULL REFERENCES public.competition_results(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  selected_index integer,
  answer_text text,
  answer_value numeric,
  answer_lat numeric,
  answer_lng numeric,
  answer_order integer[],
  response_ms integer NOT NULL,
  is_correct boolean NOT NULL,
  points integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, question_id)
);
CREATE INDEX IF NOT EXISTS arena_run_answers_profile_quiz_idx
  ON public.arena_run_answers (profile_id, quiz_id, created_at DESC);
CREATE INDEX IF NOT EXISTS arena_run_answers_quiz_question_idx
  ON public.arena_run_answers (quiz_id, question_id);

ALTER TABLE public.arena_run_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "arena_run_answers owner read" ON public.arena_run_answers
  FOR SELECT TO authenticated
  USING (auth.uid() = profile_id);
CREATE POLICY "arena_run_answers admin read" ON public.arena_run_answers
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ---------------------------------------------------------------------------
-- 8. Public RPCs (redefined to use the new effective formula)
-- ---------------------------------------------------------------------------

-- 8a. get_arena_quizzes — listing with new metadata columns
CREATE OR REPLACE FUNCTION public.get_arena_quizzes()
RETURNS TABLE(
  id uuid, title text, description text, difficulty text,
  estimated_duration_minutes integer, play_count integer, time_per_question integer,
  arena_featured_rank integer, last_updated timestamptz, question_count integer,
  avg_accuracy numeric, creator_name text,
  arena_category text, tags text, trend_score integer, is_featured boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    q.id, q.title, q.description, q.difficulty,
    q.estimated_duration_minutes, q.play_count, q.time_per_question,
    q.arena_featured_rank,
    GREATEST(q.created_at, COALESCE((SELECT MAX(qq.created_at) FROM public.questions qq WHERE qq.quiz_id = q.id), q.created_at)) AS last_updated,
    (SELECT count(*)::int FROM public.questions qq WHERE qq.quiz_id = q.id AND qq.is_playable) AS question_count,
    (SELECT ROUND(AVG(cr.accuracy_percentage), 1) FROM public.competition_results cr WHERE cr.quiz_id = q.id) AS avg_accuracy,
    (SELECT p.display_name FROM public.profiles p WHERE p.id = q.owner_principal_id) AS creator_name,
    q.arena_category, q.tags,
    (SELECT count(*)::int FROM public.arena_run_answers ara
       WHERE ara.quiz_id = q.id
         AND ara.created_at > now() - interval '14 days') AS trend_score,
    (q.arena_featured_rank IS NOT NULL) AS is_featured
  FROM public.quizzes q
  WHERE q.arena_publication_status = 'published'
    AND q.arena_admin_status       = 'visible'
    AND q.archived_at IS NULL
  ORDER BY
    (q.arena_featured_rank IS NULL),           -- featured first
    q.arena_featured_rank ASC NULLS LAST,
    q.play_count DESC;
$$;
GRANT EXECUTE ON FUNCTION public.get_arena_quizzes() TO anon, authenticated;

-- 8b. get_arena_quiz_detail — single-quiz fetch with the same filter
CREATE OR REPLACE FUNCTION public.get_arena_quiz_detail(p_quiz_id uuid)
RETURNS TABLE(
  id uuid, title text, description text, difficulty text,
  estimated_duration_minutes integer, play_count integer, time_per_question integer,
  created_at timestamptz, last_updated timestamptz, question_count integer,
  avg_accuracy numeric, creator_name text,
  arena_category text, tags text, plays_30d integer, last_played_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    q.id, q.title, q.description, q.difficulty,
    q.estimated_duration_minutes, q.play_count, q.time_per_question,
    q.created_at,
    GREATEST(q.created_at, COALESCE((SELECT MAX(qq.created_at) FROM public.questions qq WHERE qq.quiz_id = q.id), q.created_at)) AS last_updated,
    (SELECT count(*)::int FROM public.questions qq WHERE qq.quiz_id = q.id AND qq.is_playable) AS question_count,
    (SELECT ROUND(AVG(cr.accuracy_percentage), 1) FROM public.competition_results cr WHERE cr.quiz_id = q.id) AS avg_accuracy,
    (SELECT p.display_name FROM public.profiles p WHERE p.id = q.owner_principal_id) AS creator_name,
    q.arena_category, q.tags,
    (SELECT count(*)::int FROM public.arena_run_answers ara
       WHERE ara.quiz_id = q.id
         AND ara.created_at > now() - interval '30 days') AS plays_30d,
    (SELECT MAX(ara.created_at) FROM public.arena_run_answers ara WHERE ara.quiz_id = q.id) AS last_played_at
  FROM public.quizzes q
  WHERE q.id = p_quiz_id
    AND q.arena_publication_status = 'published'
    AND q.arena_admin_status       = 'visible'
    AND q.archived_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION public.get_arena_quiz_detail(uuid) TO anon, authenticated;

-- 8c. get_arena_questions — playable questions, same gate
CREATE OR REPLACE FUNCTION public.get_arena_questions(p_quiz_id uuid)
RETURNS TABLE(
  q_id uuid, q_position integer, q_text text, q_options jsonb,
  q_correct_index integer, q_time_limit_sec integer, q_point_value integer,
  q_question_type text, q_image_url text, q_audio_url text,
  q_double_points boolean, q_reveal_stages integer,
  q_correct_lat numeric, q_correct_lng numeric, q_max_distance_km numeric,
  q_correct_number numeric, q_number_min numeric, q_number_max numeric,
  q_number_tolerance numeric, q_accepted_answers text[],
  q_geo_region jsonb, q_geo_region_label text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    qq.id, qq.position, qq.text, qq.options, qq.correct_index, qq.time_limit_sec,
    qq.point_value, qq.question_type, qq.image_url, qq.audio_url, qq.double_points,
    qq.reveal_stages, qq.correct_lat, qq.correct_lng, qq.max_distance_km,
    qq.correct_number, qq.number_min, qq.number_max, qq.number_tolerance,
    qq.accepted_answers, qq.geo_region, qq.geo_region_label
  FROM public.questions qq
  JOIN public.quizzes q ON q.id = qq.quiz_id
  WHERE qq.quiz_id = p_quiz_id
    AND q.arena_publication_status = 'published'
    AND q.arena_admin_status       = 'visible'
    AND q.archived_at IS NULL
    AND qq.is_playable
    AND qq.question_type <> 'feedback'
  ORDER BY qq.position ASC;
$$;
GRANT EXECUTE ON FUNCTION public.get_arena_questions(uuid) TO anon, authenticated;

-- 8d. get_arena_platform_state — Arena on/off for the public surface
CREATE OR REPLACE FUNCTION public.get_arena_platform_state()
RETURNS TABLE(arena_open boolean, arena_closed_message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT arena_open, arena_closed_message
  FROM public.platform_settings
  WHERE id = 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_arena_platform_state() TO anon, authenticated;

-- 8e. submit_arena_run — gates on arena_open, persists per-question rows.
-- Backward compatible with existing callers (same signature, same return
-- shape). The new INSERT into arena_run_answers is idempotent on
-- (run_id, question_id) and runs in the same transaction.
CREATE OR REPLACE FUNCTION public.submit_arena_run(p_run_id uuid, p_quiz_id uuid, p_answers jsonb)
RETURNS TABLE(score int, accuracy numeric, correct_count int, graded_count int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_arena_open boolean;
  v_quiz record;
  a jsonb; v_qid uuid; v_seen uuid[] := '{}';
  v_resp_ms int; v_is_correct boolean; v_points int;
  v_correctness numeric;
  v_text text; v_value numeric; v_lat numeric; v_lng numeric; v_order jsonb;
  v_selected int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  -- Platform gate: Arena must be open.
  SELECT arena_open INTO v_arena_open FROM public.platform_settings WHERE id = 1;
  IF v_arena_open IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'arena_closed';
  END IF;

  -- Visibility gate (replaces the old is_arena check).
  SELECT q.id, q.owner_principal_id INTO v_quiz
    FROM public.quizzes q
   WHERE q.id = p_quiz_id
     AND q.arena_publication_status = 'published'
     AND q.arena_admin_status       = 'visible'
     AND q.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an arena quiz';
  END IF;

  -- Score the run using the existing authoritative helper.
  SELECT * INTO r FROM public.score_arena_run(p_quiz_id, p_answers);

  -- Persist the competition_results row (idempotent on id).
  INSERT INTO public.competition_results(
    id, profile_id, session_id, quiz_id, final_score, final_rank,
    total_participants, accuracy_percentage, completed_at)
  VALUES (p_run_id, auth.uid(), NULL, p_quiz_id, r.score, 0, 0, r.accuracy, now())
  ON CONFLICT (id) DO NOTHING;

  -- Persist per-question rows for completion-screen insights.
  -- Idempotent via ON CONFLICT (run_id, question_id) DO NOTHING.
  FOR a IN SELECT value FROM jsonb_array_elements(COALESCE(p_answers, '[]'::jsonb)) LOOP
    v_qid := (a ->> 'question_id')::uuid;
    CONTINUE WHEN v_qid IS NULL OR v_qid = ANY(v_seen);
    v_seen := v_seen || v_qid;
    SELECT * INTO r
      FROM public.evaluate_question_answer(
        v_qid, a,
        COALESCE((a ->> 'response_ms')::int, 0),
        0
      );
    v_is_correct := COALESCE(r.is_correct, false);
    v_points     := COALESCE(r.points, 0);
    v_resp_ms    := COALESCE((a ->> 'response_ms')::int, 0);
    v_selected   := NULLIF(a ->> 'selected_index', '')::int;
    v_text       := NULLIF(a ->> 'text', '');
    v_value      := NULLIF(a ->> 'value', '')::numeric;
    v_lat        := NULLIF(a ->> 'lat', '')::numeric;
    v_lng        := NULLIF(a ->> 'lng', '')::numeric;
    v_order      := a -> 'order';
    INSERT INTO public.arena_run_answers(
      run_id, question_id, profile_id, quiz_id,
      selected_index, answer_text, answer_value, answer_lat, answer_lng, answer_order,
      response_ms, is_correct, points)
    VALUES (p_run_id, v_qid, auth.uid(), p_quiz_id,
            v_selected, v_text, v_value, v_lat, v_lng,
            CASE WHEN v_order IS NULL THEN NULL ELSE ARRAY(SELECT (x)::int FROM jsonb_array_elements_text(v_order) x) END,
            v_resp_ms, v_is_correct, v_points)
    ON CONFLICT (run_id, question_id) DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT r.score, r.accuracy, r.correct_count, r.graded_count;
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_arena_run(uuid,uuid,jsonb) TO authenticated;

-- 8f. score_arena_run — update the gate from is_arena to the new columns
-- (everything else stays the same; the function is STABLE, not volatile,
-- so the gate change is enough to align with the new world).
CREATE OR REPLACE FUNCTION public.score_arena_run(p_quiz_id uuid, p_answers jsonb)
RETURNS TABLE(score int, accuracy numeric, correct_count int, graded_count int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_score int := 0; v_streak int := 0; v_correct int := 0; v_graded int := 0;
  v_seen uuid[] := '{}'; a jsonb; r record; v_qid uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.quizzes q
    WHERE q.id = p_quiz_id
      AND q.arena_publication_status = 'published'
      AND q.arena_admin_status       = 'visible'
      AND q.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not an arena quiz';
  END IF;

  SELECT count(*)::int INTO v_graded FROM public.questions
   WHERE quiz_id = p_quiz_id AND question_type <> 'feedback' AND is_playable;

  FOR a IN SELECT value FROM jsonb_array_elements(COALESCE(p_answers, '[]'::jsonb)) LOOP
    v_qid := (a ->> 'question_id')::uuid;
    CONTINUE WHEN v_qid IS NULL OR v_qid = ANY(v_seen);
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.questions q
                               WHERE q.id = v_qid AND q.quiz_id = p_quiz_id
                                 AND q.question_type <> 'feedback' AND q.is_playable);
    v_seen := v_seen || v_qid;
    SELECT * INTO r FROM public.evaluate_question_answer(
      v_qid, a, COALESCE((a ->> 'response_ms')::int, 0), v_streak);
    v_score := v_score + COALESCE(r.points, 0);
    IF COALESCE(r.is_correct, false) THEN
      v_correct := v_correct + 1; v_streak := v_streak + 1;
    ELSE
      v_streak := 0;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_score,
    CASE WHEN v_graded > 0 THEN ROUND(v_correct::numeric / v_graded * 100, 2) ELSE 0 END,
    v_correct, v_graded;
END; $$;

-- ---------------------------------------------------------------------------
-- 9. Public surface — search / sections / publication state / insights
-- ---------------------------------------------------------------------------

-- 9a. search_arena_quizzes — bounded server-side search with filters.
-- p_query: text (may be empty)
-- p_filters: jsonb with optional keys
--     difficulty      text  ('easy'|'medium'|'hard')
--     duration_max    int   (minutes)
--     category        text  (exact match on arena_category)
--     sort            text  ('newest'|'most_played'|'trending'|'featured')
-- p_limit / p_offset: int (limit is clamped server-side to max 60)
CREATE OR REPLACE FUNCTION public.search_arena_quizzes(
  p_query text,
  p_filters jsonb,
  p_limit int,
  p_offset int
)
RETURNS TABLE(
  id uuid, title text, description text, difficulty text,
  estimated_duration_minutes integer, play_count integer, time_per_question integer,
  arena_featured_rank integer, last_updated timestamptz, question_count integer,
  avg_accuracy numeric, creator_name text,
  arena_category text, tags text, trend_score integer, is_featured boolean,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 24), 1), 60);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_difficulty text := NULLIF(p_filters ->> 'difficulty', '');
  v_duration_max int := NULLIF(p_filters ->> 'duration_max', '')::int;
  v_category text := NULLIF(p_filters ->> 'category', '');
  v_sort text := COALESCE(NULLIF(p_filters ->> 'sort', ''), 'featured');
  v_query text := trim(coalesce(p_query, ''));
  v_use_ilike boolean := (length(v_query) < 3);
  v_total bigint;
BEGIN
  -- 1. Build the base set with the effective Arena visibility gate.
  WITH base AS (
    SELECT q.*,
           (SELECT count(*)::int FROM public.questions qq
              WHERE qq.quiz_id = q.id AND qq.is_playable) AS qc,
           (SELECT ROUND(AVG(cr.accuracy_percentage), 1) FROM public.competition_results cr
              WHERE cr.quiz_id = q.id) AS avg_acc,
           (SELECT p.display_name FROM public.profiles p WHERE p.id = q.owner_principal_id) AS creator
    FROM public.quizzes q
    WHERE q.arena_publication_status = 'published'
      AND q.arena_admin_status       = 'visible'
      AND q.archived_at IS NULL
      AND (v_difficulty IS NULL OR q.difficulty = v_difficulty)
      AND (v_category   IS NULL OR q.arena_category = v_category)
      AND (v_duration_max IS NULL
           OR COALESCE(q.estimated_duration_minutes,
                       GREATEST(1, ROUND((qc * q.time_per_question) / 60.0))) <= v_duration_max)
      AND (
        v_query = ''
        OR (v_use_ilike AND (q.title ILIKE '%' || v_query || '%'
                            OR q.description ILIKE '%' || v_query || '%'
                            OR q.arena_category ILIKE '%' || v_query || '%'
                            OR q.tags ILIKE '%' || v_query || '%'))
        OR (NOT v_use_ilike AND q.tags_tsv @@ plainto_tsquery('simple', v_query))
      )
  ), counted AS (
    SELECT count(*)::bigint AS cnt FROM base
  )
  SELECT cnt INTO v_total FROM counted;

  RETURN QUERY
  SELECT
    b.id, b.title, b.description, b.difficulty,
    b.estimated_duration_minutes, b.play_count, b.time_per_question,
    b.arena_featured_rank,
    GREATEST(b.created_at, COALESCE((SELECT MAX(qq.created_at) FROM public.questions qq
                                       WHERE qq.quiz_id = b.id), b.created_at)) AS last_updated,
    b.qc AS question_count,
    b.avg_acc AS avg_accuracy,
    b.creator AS creator_name,
    b.arena_category, b.tags,
    (SELECT count(*)::int FROM public.arena_run_answers ara
       WHERE ara.quiz_id = b.id
         AND ara.created_at > now() - interval '14 days') AS trend_score,
    (b.arena_featured_rank IS NOT NULL) AS is_featured,
    v_total AS total_count
  FROM base b
  ORDER BY
    CASE WHEN v_sort = 'newest'     THEN b.arena_published_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'most_played' THEN b.play_count END DESC NULLS LAST,
    CASE WHEN v_sort = 'trending'    THEN (SELECT count(*) FROM public.arena_run_answers ara
                                            WHERE ara.quiz_id = b.id
                                              AND ara.created_at > now() - interval '14 days') END DESC NULLS LAST,
    CASE WHEN v_sort = 'featured'    THEN b.arena_featured_rank END ASC NULLS LAST,
    b.play_count DESC
  LIMIT v_limit OFFSET v_offset;
END; $$;
GRANT EXECUTE ON FUNCTION public.search_arena_quizzes(text, jsonb, int, int) TO anon, authenticated;

-- 9b. get_arena_quizzes_by_section — single-section fetch (home page uses 1 RPC per section in parallel)
-- p_section: 'featured' | 'trending' | 'new' | 'quick_bolts' | 'hard_mode' | 'continue_exploring' | 'your_best'
-- p_profile_id: required for continue_exploring/your_best; ignored for others
CREATE OR REPLACE FUNCTION public.get_arena_quizzes_by_section(
  p_section text,
  p_profile_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid, title text, description text, difficulty text,
  estimated_duration_minutes integer, play_count integer, time_per_question integer,
  arena_featured_rank integer, last_updated timestamptz, question_count integer,
  avg_accuracy numeric, creator_name text,
  arena_category text, tags text, trend_score integer, is_featured boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF p_section = 'featured' THEN
    RETURN QUERY
      SELECT * FROM public.get_arena_quizzes() WHERE is_featured = true
      ORDER BY arena_featured_rank ASC NULLS LAST
      LIMIT 12;
  ELSIF p_section = 'trending' THEN
    RETURN QUERY
      SELECT * FROM public.get_arena_quizzes()
      ORDER BY trend_score DESC NULLS LAST, play_count DESC
      LIMIT 12;
  ELSIF p_section = 'new' THEN
    RETURN QUERY
      SELECT * FROM public.get_arena_quizzes()
      ORDER BY (SELECT arena_published_at FROM public.quizzes q WHERE q.id = id) DESC NULLS LAST
      LIMIT 12;
  ELSIF p_section = 'quick_bolts' THEN
    RETURN QUERY
      SELECT g.* FROM public.get_arena_quizzes() g
      WHERE COALESCE(g.estimated_duration_minutes,
                     GREATEST(1, ROUND((g.question_count * g.time_per_question) / 60.0))) <= 8
      ORDER BY COALESCE(g.estimated_duration_minutes,
                        GREATEST(1, ROUND((g.question_count * g.time_per_question) / 60.0))) ASC
      LIMIT 12;
  ELSIF p_section = 'hard_mode' THEN
    RETURN QUERY
      SELECT * FROM public.get_arena_quizzes() WHERE difficulty = 'hard'
      ORDER BY play_count DESC
      LIMIT 12;
  ELSIF p_section = 'continue_exploring' THEN
    IF p_profile_id IS NULL THEN RETURN; END IF;
    RETURN QUERY
      SELECT g.* FROM public.get_arena_quizzes() g
      WHERE NOT EXISTS (
        SELECT 1 FROM public.competition_results cr
        WHERE cr.profile_id = p_profile_id AND cr.quiz_id = g.id
      )
      ORDER BY g.play_count DESC
      LIMIT 6;
  ELSIF p_section = 'your_best' THEN
    IF p_profile_id IS NULL THEN RETURN; END IF;
    RETURN QUERY
      SELECT g.*
        FROM (SELECT quiz_id, MAX(final_score) AS best
                FROM public.competition_results
               WHERE profile_id = p_profile_id AND session_id IS NULL
               GROUP BY quiz_id) bests
        JOIN public.get_arena_quizzes() g ON g.id = bests.quiz_id
       ORDER BY bests.best DESC
       LIMIT 6;
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION public.get_arena_quizzes_by_section(text, uuid) TO anon, authenticated;

-- 9c. get_arena_run_insights — deterministic completion-screen insights
CREATE OR REPLACE FUNCTION public.get_arena_run_insights(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_run public.competition_results%ROWTYPE;
  v_quiz_id uuid;
  v_total int; v_correct int; v_first int; v_mid int; v_last int;
  v_first_correct int; v_mid_correct int; v_last_correct int;
  v_min_ms int; v_min_qid uuid;
  v_hardest_qid uuid; v_hardest_acc numeric := 1.0; v_hardest_n int;
  v_comeback boolean := false;
  v_response_avg numeric;
BEGIN
  SELECT * INTO v_run FROM public.competition_results WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'run_not_found'); END IF;
  v_quiz_id := v_run.quiz_id;

  -- Per-run aggregates from arena_run_answers
  SELECT count(*)::int,
         count(*) FILTER (WHERE is_correct)::int
    INTO v_total, v_correct
    FROM public.arena_run_answers WHERE run_id = p_run_id;

  -- Fastest answer (only correct rows)
  SELECT response_ms, question_id INTO v_min_ms, v_min_qid
    FROM public.arena_run_answers
   WHERE run_id = p_run_id AND is_correct
   ORDER BY response_ms ASC
   LIMIT 1;

  -- Open/Middle/Sprint thirds
  WITH ordered AS (
    SELECT question_id, is_correct, row_number() OVER (ORDER BY question_id) AS rn,
           count(*) OVER () AS total
    FROM (SELECT DISTINCT question_id, is_correct
            FROM public.arena_run_answers WHERE run_id = p_run_id) u
  )
  SELECT
    sum(CASE WHEN rn <= total/3 THEN 1 ELSE 0 END),
    sum(CASE WHEN rn <= total/3 AND is_correct THEN 1 ELSE 0 END),
    sum(CASE WHEN rn > total/3 AND rn <= 2*total/3 THEN 1 ELSE 0 END),
    sum(CASE WHEN rn > total/3 AND rn <= 2*total/3 AND is_correct THEN 1 ELSE 0 END),
    sum(CASE WHEN rn > 2*total/3 THEN 1 ELSE 0 END),
    sum(CASE WHEN rn > 2*total/3 AND is_correct THEN 1 ELSE 0 END)
    INTO v_first, v_first_correct, v_mid, v_mid_correct, v_last, v_last_correct
    FROM ordered;

  -- Comeback: last third ≥ 75% and first third < 50%
  IF v_last > 0 AND v_first > 0 THEN
    v_comeback := ((v_last_correct::numeric / v_last) >= 0.75)
                  AND ((v_first_correct::numeric / v_first) < 0.5);
  END IF;

  -- Hardest question across all Arena runs of this quiz (this run excluded)
  SELECT qid, acc
    INTO v_hardest_qid, v_hardest_acc
    FROM (
      SELECT question_id AS qid,
             (count(*) FILTER (WHERE is_correct))::numeric / NULLIF(count(*), 0) AS acc,
             count(*) AS n
        FROM public.arena_run_answers
       WHERE quiz_id = v_quiz_id AND run_id <> p_run_id
       GROUP BY question_id
       HAVING count(*) >= 3
       ORDER BY acc ASC NULLS FIRST
       LIMIT 1
    ) hardest;
  v_hardest_n := CASE WHEN v_hardest_acc IS NULL THEN 0 ELSE 1 END;
  v_hardest_acc := COALESCE(v_hardest_acc, 0);

  SELECT AVG(response_ms)::int
    INTO v_response_avg
    FROM public.arena_run_answers WHERE run_id = p_run_id;

  RETURN jsonb_build_object(
    'total', v_total,
    'correct', v_correct,
    'fastest_ms', v_min_ms,
    'fastest_question_id', v_min_qid,
    'thirds', jsonb_build_object(
      'first', jsonb_build_object('count', v_first, 'correct', COALESCE(v_first_correct, 0)),
      'middle', jsonb_build_object('count', v_mid, 'correct', COALESCE(v_mid_correct, 0)),
      'last', jsonb_build_object('count', v_last, 'correct', COALESCE(v_last_correct, 0))
    ),
    'comeback', v_comeback,
    'hardest_question_id', v_hardest_qid,
    'hardest_accuracy_pct', ROUND((v_hardest_acc * 100)::numeric, 1),
    'hardest_sample_size', v_hardest_n,
    'avg_response_ms', v_response_avg
  );
END; $$;
GRANT EXECUTE ON FUNCTION public.get_arena_run_insights(uuid) TO authenticated;

-- 9d. get_previous_best_for_profile — the score immediately before this run
CREATE OR REPLACE FUNCTION public.get_previous_best_for_profile(
  p_quiz_id uuid, p_profile_id uuid, p_before_run_id uuid
)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT final_score
    FROM public.competition_results
   WHERE quiz_id = p_quiz_id
     AND profile_id = p_profile_id
     AND id <> p_before_run_id
   ORDER BY completed_at DESC, id DESC
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_previous_best_for_profile(uuid, uuid, uuid) TO authenticated;

-- 9e. get_arena_publication_state — editor-facing eligibility report
CREATE OR REPLACE FUNCTION public.get_arena_publication_state(p_quiz_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_quiz record;
  v_playable int;
  v_supported text[];
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_is_eligible boolean := true;
BEGIN
  SELECT q.id, q.title, q.description, q.arena_publication_status, q.arena_admin_status,
         q.archived_at, q.arena_category, q.tags, q.is_arena /* ignore — column dropped but query is a no-op if not present */
    INTO v_quiz
    FROM public.quizzes q
   WHERE q.id = p_quiz_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quiz_not_found');
  END IF;

  SELECT count(*)::int INTO v_playable
    FROM public.questions
   WHERE quiz_id = p_quiz_id AND is_playable AND question_type <> 'feedback';

  SELECT array_agg(DISTINCT question_type ORDER BY question_type)
    INTO v_supported
    FROM public.questions
   WHERE quiz_id = p_quiz_id AND is_playable AND question_type <> 'feedback';

  -- Required fields
  IF v_quiz.title IS NULL OR trim(v_quiz.title) = '' THEN
    v_errors := v_errors || jsonb_build_object('field','title','message','Title is required');
    v_is_eligible := false;
  END IF;
  IF v_quiz.description IS NULL OR trim(v_quiz.description) = '' THEN
    v_errors := v_errors || jsonb_build_object('field','description','message','Description is required');
    v_is_eligible := false;
  END IF;
  IF v_quiz.arena_category IS NULL OR trim(v_quiz.arena_category) = '' THEN
    v_errors := v_errors || jsonb_build_object('field','arena_category','message','Category is required');
    v_is_eligible := false;
  END IF;
  IF v_playable < 3 THEN
    v_errors := v_errors || jsonb_build_object(
      'field','playable_questions',
      'message','At least 3 playable questions are required for a meaningful Arena run');
    v_is_eligible := false;
  END IF;

  -- type question with empty accepted_answers
  IF EXISTS (
    SELECT 1 FROM public.questions
     WHERE quiz_id = p_quiz_id AND is_playable
       AND question_type = 'type'
       AND (accepted_answers IS NULL OR array_length(accepted_answers, 1) IS NULL OR array_length(accepted_answers, 1) = 0)
  ) THEN
    v_errors := v_errors || jsonb_build_object(
      'field','type_questions',
      'message','One or more text-answer questions have no accepted answers');
    v_is_eligible := false;
  END IF;

  -- map_pin without region and without lat/lng
  IF EXISTS (
    SELECT 1 FROM public.questions
     WHERE quiz_id = p_quiz_id AND is_playable
       AND question_type = 'map_pin'
       AND geo_region IS NULL
       AND (correct_lat IS NULL OR correct_lng IS NULL)
  ) THEN
    v_errors := v_errors || jsonb_build_object(
      'field','map_pin_questions',
      'message','Map-pin questions need either a region or coordinates');
    v_is_eligible := false;
  END IF;

  -- Recommended: cover/tags
  IF v_quiz.tags IS NULL OR trim(v_quiz.tags) = '' THEN
    v_warnings := v_warnings || jsonb_build_object('field','tags','message','Add tags to make the quiz easier to discover');
  END IF;

  RETURN jsonb_build_object(
    'current_status', v_quiz.arena_publication_status,
    'current_admin_status', v_quiz.arena_admin_status,
    'archived', v_quiz.archived_at IS NOT NULL,
    'is_eligible', v_is_eligible AND v_quiz.archived_at IS NULL,
    'errors', v_errors,
    'warnings', v_warnings,
    'playable_question_count', v_playable,
    'supported_types', COALESCE(v_supported, ARRAY[]::text[]),
    'arena_category', v_quiz.arena_category,
    'tags', v_quiz.tags
  );
END; $$;
GRANT EXECUTE ON FUNCTION public.get_arena_publication_state(uuid) TO anon, authenticated;

-- 9f. validate_arena_quiz — server-side mirror of the editor's pre-flight check
CREATE OR REPLACE FUNCTION public.validate_arena_quiz(p_quiz_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_state jsonb;
BEGIN
  v_state := public.get_arena_publication_state(p_quiz_id);
  RETURN jsonb_build_object(
    'is_eligible', COALESCE((v_state ->> 'is_eligible')::boolean, false),
    'errors', COALESCE(v_state -> 'errors', '[]'::jsonb),
    'warnings', COALESCE(v_state -> 'warnings', '[]'::jsonb),
    'playable_question_count', COALESCE((v_state ->> 'playable_question_count')::int, 0),
    'supported_types', COALESCE(v_state -> 'supported_types', '[]'::jsonb)
  );
END; $$;
GRANT EXECUTE ON FUNCTION public.validate_arena_quiz(uuid) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Creator surface (owner or admin)
-- ---------------------------------------------------------------------------

-- 10a. set_arena_publication_status
CREATE OR REPLACE FUNCTION public.set_arena_publication_status(
  p_quiz_id uuid, p_status text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_owner uuid;
  v_is_admin boolean;
  v_state jsonb;
  v_archived timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_status NOT IN ('draft','published','hidden','archived') THEN
    RAISE EXCEPTION 'invalid status %', p_status;
  END IF;
  -- 'archived' is admin-only
  IF p_status = 'archived' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT q.owner_principal_id, q.archived_at
    INTO v_owner, v_archived
    FROM public.quizzes q WHERE q.id = p_quiz_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'quiz_not_found'; END IF;

  v_is_admin := public.is_admin();
  IF NOT v_is_admin AND v_owner IS DISTINCT FROM public.principal_for_user(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- Validate before flipping to 'published' (admins bypass this)
  IF p_status = 'published' AND NOT v_is_admin THEN
    v_state := public.validate_arena_quiz(p_quiz_id);
    IF NOT COALESCE((v_state ->> 'is_eligible')::boolean, false) THEN
      RAISE EXCEPTION 'not_eligible: %', v_state;
    END IF;
  END IF;

  UPDATE public.quizzes
     SET arena_publication_status = p_status,
         arena_published_at = CASE
           WHEN p_status = 'published' THEN now()
           ELSE arena_published_at
         END
   WHERE id = p_quiz_id;

  -- Audit
  IF v_is_admin THEN
    INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action, payload)
      VALUES (p_quiz_id, auth.uid(), 'set_publication_status', jsonb_build_object('status', p_status, 'admin_override', true));
  END IF;

  RETURN public.get_arena_publication_state(p_quiz_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.set_arena_publication_status(uuid, text) TO authenticated;

-- 10b. set_arena_category (creator)
CREATE OR REPLACE FUNCTION public.set_arena_category(p_quiz_id uuid, p_category text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT q.owner_principal_id INTO v_owner FROM public.quizzes q WHERE q.id = p_quiz_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'quiz_not_found'; END IF;
  IF public.is_admin() OR v_owner = public.principal_for_user(auth.uid()) THEN
    UPDATE public.quizzes SET arena_category = NULLIF(trim(p_category), '') WHERE id = p_quiz_id;
  ELSE
    RAISE EXCEPTION 'not_authorized';
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_arena_category(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 11. Admin surface — per-action RPCs
-- ---------------------------------------------------------------------------

-- 11a. admin_set_arena_open — platform on/off
CREATE OR REPLACE FUNCTION public.admin_set_arena_open(p_open boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.platform_settings
     SET arena_open = p_open, updated_at = now(), updated_by = auth.uid()
   WHERE id = 1;
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_set_arena_open(boolean) TO authenticated;

-- 11b. admin_arena_overview
CREATE OR REPLACE FUNCTION public.admin_arena_overview()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_arena_open boolean;
  v_published int; v_hidden int; v_archived int;
  v_runs_today int; v_runs_7 int; v_runs_30 int;
  v_unique_30 int; v_repeat_30 int;
  v_poor jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  SELECT arena_open INTO v_arena_open FROM public.platform_settings WHERE id = 1;

  SELECT
    count(*) FILTER (WHERE arena_publication_status = 'published')::int,
    count(*) FILTER (WHERE arena_publication_status = 'hidden')::int,
    count(*) FILTER (WHERE arena_publication_status = 'archived')::int
    INTO v_published, v_hidden, v_archived
  FROM public.quizzes;

  SELECT
    count(*) FILTER (WHERE completed_at > now() - interval '1 day')::int,
    count(*) FILTER (WHERE completed_at > now() - interval '7 days')::int,
    count(*) FILTER (WHERE completed_at > now() - interval '30 days')::int
    INTO v_runs_today, v_runs_7, v_runs_30
  FROM public.competition_results
  WHERE session_id IS NULL;

  SELECT
    count(DISTINCT profile_id)::int,
    count(*) FILTER (WHERE runs > 1)::int
    INTO v_unique_30, v_repeat_30
  FROM (
    SELECT profile_id, count(*) AS runs
      FROM public.competition_results
     WHERE session_id IS NULL
       AND completed_at > now() - interval '30 days'
     GROUP BY profile_id
  ) u;

  -- Quizzes with poor completion: < 30% accuracy across at least 5 runs in 30d
  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb) INTO v_poor
  FROM (
    SELECT cr.quiz_id AS id, q.title, ROUND(AVG(cr.accuracy_percentage), 1) AS avg_accuracy
      FROM public.competition_results cr
      JOIN public.quizzes q ON q.id = cr.quiz_id
     WHERE cr.session_id IS NULL
       AND cr.completed_at > now() - interval '30 days'
     GROUP BY cr.quiz_id, q.title
    HAVING count(*) >= 5 AND AVG(cr.accuracy_percentage) < 30
     ORDER BY avg_accuracy ASC
     LIMIT 5
  ) p;

  RETURN jsonb_build_object(
    'arena_open', v_arena_open,
    'published_count', v_published,
    'hidden_count', v_hidden,
    'archived_count', v_archived,
    'runs_today', v_runs_today,
    'runs_7d', v_runs_7,
    'runs_30d', v_runs_30,
    'unique_players_30d', v_unique_30,
    'repeat_players_30d', v_repeat_30,
    'poor_completion_quizzes', v_poor
  );
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_overview() TO authenticated;

-- 11c. admin_arena_quizzes — moderation list (every quiz, not just published)
CREATE OR REPLACE FUNCTION public.admin_arena_quizzes(
  p_status_filter text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  id uuid, title text, description text, difficulty text,
  arena_publication_status text, arena_admin_status text,
  arena_published_at timestamptz, arena_featured_rank integer,
  arena_category text, tags text, archived_at timestamptz,
  creator_name text, play_count integer,
  playable_question_count integer, avg_accuracy numeric,
  last_played_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_filter text := NULLIF(p_status_filter, '');
  v_search text := trim(coalesce(p_search, ''));
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  RETURN QUERY
    SELECT
      q.id, q.title, q.description, q.difficulty,
      q.arena_publication_status, q.arena_admin_status,
      q.arena_published_at, q.arena_featured_rank,
      q.arena_category, q.tags, q.archived_at,
      (SELECT p.display_name FROM public.profiles p WHERE p.id = q.owner_principal_id) AS creator_name,
      q.play_count,
      (SELECT count(*)::int FROM public.questions qq
         WHERE qq.quiz_id = q.id AND qq.is_playable AND qq.question_type <> 'feedback') AS playable_question_count,
      (SELECT ROUND(AVG(cr.accuracy_percentage), 1) FROM public.competition_results cr WHERE cr.quiz_id = q.id) AS avg_accuracy,
      (SELECT MAX(cr.completed_at) FROM public.competition_results cr WHERE cr.quiz_id = q.id) AS last_played_at
    FROM public.quizzes q
   WHERE (v_filter IS NULL OR q.arena_publication_status = v_filter)
     AND (
       v_search = '' OR
       q.title ILIKE '%' || v_search || '%' OR
       q.description ILIKE '%' || v_search || '%' OR
       q.arena_category ILIKE '%' || v_search || '%' OR
       q.tags ILIKE '%' || v_search || '%'
     )
   ORDER BY q.created_at DESC
   LIMIT v_limit OFFSET v_offset;
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quizzes(text, text, int, int) TO authenticated;

-- 11d. admin_arena_quiz_detail
CREATE OR REPLACE FUNCTION public.admin_arena_quiz_detail(p_quiz_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  SELECT jsonb_build_object(
    'quiz', to_jsonb(q.*),
    'creator_name', (SELECT p.display_name FROM public.profiles p WHERE p.id = q.owner_principal_id),
    'playable_question_count', (SELECT count(*)::int FROM public.questions qq
                                 WHERE qq.quiz_id = q.id AND qq.is_playable AND qq.question_type <> 'feedback'),
    'avg_accuracy', (SELECT ROUND(AVG(cr.accuracy_percentage), 1) FROM public.competition_results cr WHERE cr.quiz_id = q.id),
    'last_played_at', (SELECT MAX(cr.completed_at) FROM public.competition_results cr WHERE cr.quiz_id = q.id),
    'moderation_log', COALESCE((
      SELECT jsonb_agg(row_to_json(m) ORDER BY m.created_at DESC)
        FROM (SELECT l.action, l.payload, l.created_at,
                     (SELECT p.display_name FROM public.profiles p WHERE p.id = l.actor_id) AS actor_name
                FROM public.arena_moderation_log l
               WHERE l.quiz_id = q.id
               ORDER BY l.created_at DESC
               LIMIT 20) m
    ), '[]'::jsonb)
  ) INTO v
  FROM public.quizzes q
  WHERE q.id = p_quiz_id;
  RETURN v;
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_detail(uuid) TO authenticated;

-- 11e. admin_arena_analytics — daily series for the chosen range
CREATE OR REPLACE FUNCTION public.admin_arena_analytics(p_days int DEFAULT 30)
RETURNS TABLE(
  day date,
  runs integer,
  unique_players integer,
  avg_score numeric,
  avg_accuracy numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    date_trunc('day', cr.completed_at)::date AS day,
    count(*)::int AS runs,
    count(DISTINCT cr.profile_id)::int AS unique_players,
    ROUND(AVG(cr.final_score), 1) AS avg_score,
    ROUND(AVG(cr.accuracy_percentage), 1) AS avg_accuracy
  FROM public.competition_results cr
  WHERE cr.session_id IS NULL
    AND cr.completed_at > now() - (p_days || ' days')::interval
  GROUP BY 1
  ORDER BY 1;
$$;
GRANT EXECUTE ON FUNCTION public.admin_arena_analytics(int) TO authenticated;

-- 11f–11m. Per-action moderation RPCs (each writes a moderation log row)
CREATE OR REPLACE FUNCTION public.admin_arena_quiz_publish(p_quiz_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.quizzes
     SET arena_publication_status = 'published',
         arena_published_at = COALESCE(arena_published_at, now())
   WHERE id = p_quiz_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'quiz_archived'; END IF;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action) VALUES (p_quiz_id, auth.uid(), 'publish');
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_publish(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_unpublish(p_quiz_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.quizzes SET arena_publication_status = 'draft' WHERE id = p_quiz_id;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action) VALUES (p_quiz_id, auth.uid(), 'unpublish');
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_unpublish(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_hide(p_quiz_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.quizzes SET arena_admin_status = 'hidden' WHERE id = p_quiz_id;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action) VALUES (p_quiz_id, auth.uid(), 'hide');
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_hide(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_unhide(p_quiz_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.quizzes SET arena_admin_status = 'visible' WHERE id = p_quiz_id;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action) VALUES (p_quiz_id, auth.uid(), 'unhide');
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_unhide(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_archive(p_quiz_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.quizzes SET arena_publication_status = 'archived' WHERE id = p_quiz_id;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action) VALUES (p_quiz_id, auth.uid(), 'archive');
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_archive(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_restore(p_quiz_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF EXISTS (SELECT 1 FROM public.quizzes WHERE id = p_quiz_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'quiz_archived';
  END IF;
  UPDATE public.quizzes SET arena_publication_status = 'published' WHERE id = p_quiz_id;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action) VALUES (p_quiz_id, auth.uid(), 'restore');
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_restore(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_feature(p_quiz_id uuid, p_rank int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.quizzes SET arena_featured_rank = p_rank WHERE id = p_quiz_id;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action, payload)
    VALUES (p_quiz_id, auth.uid(), 'feature', jsonb_build_object('rank', p_rank));
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_feature(uuid, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_unfeature(p_quiz_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  UPDATE public.quizzes SET arena_featured_rank = NULL WHERE id = p_quiz_id;
  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action) VALUES (p_quiz_id, auth.uid(), 'unfeature');
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_unfeature(uuid) TO authenticated;

-- 11n. admin_arena_run_insights — admin-readable
CREATE OR REPLACE FUNCTION public.admin_arena_run_insights(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  SELECT jsonb_build_object(
    'run', to_jsonb(cr.*),
    'profile_name', (SELECT p.display_name FROM public.profiles p WHERE p.id = cr.profile_id),
    'quiz_title', (SELECT q.title FROM public.quizzes q WHERE q.id = cr.quiz_id),
    'insights', public.get_arena_run_insights(cr.id)
  ) INTO v
  FROM public.competition_results cr
  WHERE cr.id = p_run_id;
  RETURN v;
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_arena_run_insights(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 12. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_arena_overview()                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quizzes(text, text, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_detail(uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_analytics(int)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_publish(uuid)         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_unpublish(uuid)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_hide(uuid)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_unhide(uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_archive(uuid)         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_restore(uuid)         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_feature(uuid, int)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_unfeature(uuid)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_arena_run_insights(uuid)         FROM PUBLIC, anon;

-- Post-migration sanity (read-only):
--   SELECT count(*) FROM public.quizzes WHERE is_arena IS NULL;        -- ERROR (column dropped)
--   SELECT arena_publication_status, count(*) FROM public.quizzes GROUP BY 1;
