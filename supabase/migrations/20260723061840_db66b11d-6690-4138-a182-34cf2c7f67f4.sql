
-- Phase 3: Arena foundation — minimal additive columns on quizzes
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS is_arena boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS difficulty text,
  ADD COLUMN IF NOT EXISTS estimated_duration_minutes integer,
  ADD COLUMN IF NOT EXISTS play_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.quizzes
  DROP CONSTRAINT IF EXISTS quizzes_difficulty_check;
ALTER TABLE public.quizzes
  ADD CONSTRAINT quizzes_difficulty_check
  CHECK (difficulty IS NULL OR difficulty IN ('easy','medium','hard'));

CREATE INDEX IF NOT EXISTS quizzes_is_arena_idx ON public.quizzes (is_arena) WHERE is_arena;

-- Public read access to featured Arena quizzes only (non-sensitive fields exposed by design)
DROP POLICY IF EXISTS "Arena quizzes are publicly readable" ON public.quizzes;
CREATE POLICY "Arena quizzes are publicly readable"
  ON public.quizzes
  FOR SELECT
  TO anon, authenticated
  USING (is_arena = true AND archived_at IS NULL);

GRANT SELECT ON public.quizzes TO anon;

-- Backfill play_count from historical sessions
UPDATE public.quizzes q
SET play_count = COALESCE(sub.c, 0)
FROM (
  SELECT quiz_id, COUNT(*)::int AS c FROM public.sessions GROUP BY quiz_id
) sub
WHERE q.id = sub.quiz_id;

-- Trigger to keep play_count fresh on new sessions
CREATE OR REPLACE FUNCTION public.increment_quiz_play_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.quizzes SET play_count = play_count + 1 WHERE id = NEW.quiz_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_increment_play_count ON public.sessions;
CREATE TRIGGER sessions_increment_play_count
AFTER INSERT ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.increment_quiz_play_count();

-- Seed the six curated challenges from existing quizzes
UPDATE public.quizzes SET is_arena = true, difficulty = 'easy',   estimated_duration_minutes = 3 WHERE id = '11c81a43-36b8-4b90-88d0-dd0a936eeac9';
UPDATE public.quizzes SET is_arena = true, difficulty = 'hard',   estimated_duration_minutes = 8 WHERE id = '084d5549-80c2-40d0-9d36-32347a1b195d';
UPDATE public.quizzes SET is_arena = true, difficulty = 'medium', estimated_duration_minutes = 5 WHERE id = 'b8881a1f-1cf4-41f4-82d0-eb74a3b42033';
UPDATE public.quizzes SET is_arena = true, difficulty = 'easy',   estimated_duration_minutes = 3 WHERE id = 'a5dc1620-f781-4d6a-818d-13b22a8f1c55';
UPDATE public.quizzes SET is_arena = true, difficulty = 'medium', estimated_duration_minutes = 6 WHERE id = '4ec14b3c-520e-4a7d-90b6-e24289b7057c';
UPDATE public.quizzes SET is_arena = true, difficulty = 'easy',   estimated_duration_minutes = 4 WHERE id = '57412354-a21a-481d-ba5a-241e888aa925';
