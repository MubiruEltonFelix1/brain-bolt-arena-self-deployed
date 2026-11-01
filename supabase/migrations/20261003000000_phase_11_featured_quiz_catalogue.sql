-- =============================================================================
-- Phase 11 — Featured Quiz Catalogue (Arena redesign)
--
-- Adds a one-to-one metadata table on quizzes for content-verification fields
-- that do not belong on the quiz row itself: source references, verification
-- notes, and the verified-through date used by featured quizzes like the
-- Premier League season quiz.
--
-- The catalogue itself lives in `quizzes` (arena_featured_rank,
-- arena_publication_status, arena_admin_status, arena_category, tags,
-- arena_published_at already exist from Phase 9B). This table extends it with
-- editorial/verification metadata only.
--
-- Host-led competition behaviour, scoring, timers, Realtime, and the existing
-- Arena publication RPCs are NOT modified.
-- =============================================================================

-- 1. featured_quiz_metadata — one-to-one with quizzes
CREATE TABLE IF NOT EXISTS public.featured_quiz_metadata (
  quiz_id uuid PRIMARY KEY REFERENCES public.quizzes(id) ON DELETE CASCADE,
  source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  verification_notes text NOT NULL DEFAULT '',
  verified_through_date date,
  verified_through_at timestamptz,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.featured_quiz_metadata.source_references IS
  'Array of {url, title, accessed_at} objects documenting where each fact was verified.';
COMMENT ON COLUMN public.featured_quiz_metadata.verification_notes IS
  'Editor notes about how answers were cross-checked and any caveats.';
COMMENT ON COLUMN public.featured_quiz_metadata.verified_through_date IS
  'The date through which season statistics are verified (displayed to players).';
COMMENT ON COLUMN public.featured_quiz_metadata.verified_through_at IS
  'Timestamp when verification was completed.';

-- 2. Indexes
CREATE INDEX IF NOT EXISTS featured_quiz_metadata_verified_idx
  ON public.featured_quiz_metadata (verified_through_date DESC NULLS LAST);

-- 3. RLS
ALTER TABLE public.featured_quiz_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "featured_quiz_metadata public read"
  ON public.featured_quiz_metadata FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "featured_quiz_metadata admin write"
  ON public.featured_quiz_metadata FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 4. Admin RPC to update quiz presentation fields (title, description, category, difficulty, timing)

CREATE OR REPLACE FUNCTION public.admin_arena_quiz_update(
  p_quiz_id uuid,
  p_title text,
  p_description text,
  p_category text,
  p_difficulty text,
  p_time_per_question integer,
  p_estimated_duration_minutes integer
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.quizzes WHERE id = p_quiz_id) THEN
    RAISE EXCEPTION 'quiz_not_found';
  END IF;

  IF p_difficulty NOT IN ('easy', 'medium', 'hard') THEN
    RAISE EXCEPTION 'invalid difficulty';
  END IF;

  UPDATE public.quizzes
     SET title = p_title,
         description = p_description,
         arena_category = NULLIF(trim(p_category), ''),
         difficulty = p_difficulty,
         time_per_question = p_time_per_question,
         estimated_duration_minutes = p_estimated_duration_minutes
   WHERE id = p_quiz_id;

  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action, payload)
  VALUES (
    p_quiz_id, auth.uid(), 'update_quiz_fields',
    jsonb_build_object('title', p_title, 'category', p_category, 'difficulty', p_difficulty)
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.admin_arena_quiz_update(uuid, text, text, text, text, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_arena_quiz_update(uuid, text, text, text, text, integer, integer) FROM PUBLIC, anon;

-- 5. Admin RPCs for metadata management

CREATE OR REPLACE FUNCTION public.admin_featured_quiz_metadata_set(
  p_quiz_id uuid,
  p_source_references jsonb,
  p_verification_notes text,
  p_verified_through_date date
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.quizzes WHERE id = p_quiz_id) THEN
    RAISE EXCEPTION 'quiz_not_found';
  END IF;

  INSERT INTO public.featured_quiz_metadata(
    quiz_id, source_references, verification_notes, verified_through_date,
    verified_through_at, updated_by, updated_at
  )
  VALUES (
    p_quiz_id,
    COALESCE(p_source_references, '[]'::jsonb),
    COALESCE(p_verification_notes, ''),
    p_verified_through_date,
    now(),
    auth.uid(),
    now()
  )
  ON CONFLICT (quiz_id) DO UPDATE SET
    source_references = EXCLUDED.source_references,
    verification_notes = EXCLUDED.verification_notes,
    verified_through_date = EXCLUDED.verified_through_date,
    verified_through_at = EXCLUDED.verified_through_at,
    updated_by = EXCLUDED.updated_by,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO public.arena_moderation_log(quiz_id, actor_id, action, payload)
  VALUES (
    p_quiz_id, auth.uid(), 'set_metadata',
    jsonb_build_object('verified_through_date', p_verified_through_date)
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.admin_featured_quiz_metadata_set(uuid, jsonb, text, date) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_featured_quiz_metadata_set(uuid, jsonb, text, date) FROM PUBLIC, anon;

-- 5. Admin RPC to read metadata (admin-only, for the edit form)

CREATE OR REPLACE FUNCTION public.admin_featured_quiz_metadata_get(p_quiz_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not_authorized'; END IF;

  SELECT jsonb_build_object(
    'source_references', COALESCE(fqm.source_references, '[]'::jsonb),
    'verification_notes', COALESCE(fqm.verification_notes, ''),
    'verified_through_date', fqm.verified_through_date,
    'verified_through_at', fqm.verified_through_at,
    'updated_by', (SELECT p.display_name FROM public.profiles p WHERE p.id = fqm.updated_by),
    'updated_at', fqm.updated_at
  ) INTO v
  FROM public.featured_quiz_metadata fqm
  WHERE fqm.quiz_id = p_quiz_id;

  IF v IS NULL THEN
    RETURN jsonb_build_object(
      'source_references', '[]'::jsonb,
      'verification_notes', '',
      'verified_through_date', null,
      'verified_through_at', null,
      'updated_by', null,
      'updated_at', null
    );
  END IF;

  RETURN v;
END; $$;

GRANT EXECUTE ON FUNCTION public.admin_featured_quiz_metadata_get(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_featured_quiz_metadata_get(uuid) FROM PUBLIC, anon;

-- =============================================================================
-- End of Phase 11 migration
-- =============================================================================
