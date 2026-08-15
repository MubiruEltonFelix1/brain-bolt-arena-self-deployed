
-- 1. Allow solo (session-less) arena results in the existing history table
ALTER TABLE public.competition_results ALTER COLUMN session_id DROP NOT NULL;

-- 2. Data-driven featured arena challenges
ALTER TABLE public.quizzes ADD COLUMN IF NOT EXISTS featured_rank integer;

-- 3. Record a solo arena run (idempotent by client run id)
CREATE OR REPLACE FUNCTION public.record_arena_result(
  p_run_id uuid,
  p_quiz_id uuid,
  p_score integer,
  p_accuracy numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quizzes q
    WHERE q.id = p_quiz_id AND q.is_arena = true AND q.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not an arena quiz';
  END IF;

  INSERT INTO competition_results (
    id, profile_id, session_id, quiz_id, final_score, final_rank,
    total_participants, accuracy_percentage, completed_at
  ) VALUES (
    p_run_id, auth.uid(), NULL, p_quiz_id, greatest(p_score, 0), 0,
    0, least(greatest(coalesce(p_accuracy, 0), 0), 100), now()
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_arena_result(uuid, uuid, integer, numeric) TO authenticated;

-- 4. Arena listing with full metadata
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
    (select count(*)::int from questions qq where qq.quiz_id = q.id) as question_count,
    (select round(avg(cr.accuracy_percentage), 1) from competition_results cr where cr.quiz_id = q.id) as avg_accuracy,
    (select p.display_name from profiles p where p.id = q.owner_id) as creator_name
  from quizzes q
  where q.is_arena = true and q.archived_at is null
  order by q.featured_rank nulls last, q.play_count desc
$$;

GRANT EXECUTE ON FUNCTION public.get_arena_quizzes() TO anon, authenticated;
