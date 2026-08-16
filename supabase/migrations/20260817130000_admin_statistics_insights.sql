-- Admin statistics insights: session funnel, question-type performance,
-- peak hours, live sessions, and arena challenge health.
-- Same conventions as admin_statistics_timeseries: derived on demand,
-- SECURITY DEFINER, gated by public.is_admin(), authenticated-only.

-- Session funnel: how many sessions actually complete vs die in the lobby,
-- plus average session size and average active duration (first answer to last
-- answer, sessions with at least two answers).
CREATE OR REPLACE FUNCTION public.admin_session_funnel()
RETURNS TABLE (
  total_sessions bigint,
  completed_sessions bigint,
  abandoned_sessions bigint,
  completion_rate numeric,
  avg_session_size numeric,
  avg_duration_seconds numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.sessions),
    (SELECT count(*) FROM public.sessions WHERE status = 'ended'),
    (SELECT count(*) FROM public.sessions WHERE status <> 'ended'),
    (SELECT ROUND(100.0 * count(*) FILTER (WHERE status = 'ended') / NULLIF(count(*), 0), 1)
       FROM public.sessions),
    (SELECT ROUND(avg(c), 1)
       FROM (SELECT count(*) c FROM public.participants GROUP BY session_id) sizes),
    (SELECT ROUND(avg(EXTRACT(EPOCH FROM (mx - mn))), 0)
       FROM (SELECT min(a.created_at) mn, max(a.created_at) mx
               FROM public.answers a GROUP BY a.session_id HAVING count(*) > 1) spans)
  WHERE public.is_admin();
$$;

REVOKE ALL ON FUNCTION public.admin_session_funnel() FROM public;
GRANT EXECUTE ON FUNCTION public.admin_session_funnel() TO authenticated;

-- Answer volume and accuracy per question type (feedback excluded, matching
-- record_competition_results).
CREATE OR REPLACE FUNCTION public.admin_question_type_stats()
RETURNS TABLE (
  question_type text,
  answers bigint,
  accuracy numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.question_type,
         count(*)::bigint,
         ROUND(count(*) FILTER (WHERE a.is_correct)::numeric / NULLIF(count(*), 0) * 100, 1)
  FROM public.answers a
  JOIN public.questions q ON q.id = a.question_id
  WHERE q.question_type <> 'feedback' AND public.is_admin()
  GROUP BY q.question_type
  ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_question_type_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.admin_question_type_stats() TO authenticated;

-- Sessions and answers bucketed by hour of day (0-23) over the last p_days
-- days, for spotting peak activity windows.
CREATE OR REPLACE FUNCTION public.admin_stats_hours(p_days integer DEFAULT 30)
RETURNS TABLE (
  hour integer,
  sessions bigint,
  answers bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT h.hour,
    (SELECT count(*) FROM public.sessions s
      WHERE EXTRACT(hour FROM s.created_at)::int = h.hour
        AND s.created_at >= current_date - (p_days - 1)),
    (SELECT count(*) FROM public.answers a
      WHERE EXTRACT(hour FROM a.created_at)::int = h.hour
        AND a.created_at >= current_date - (p_days - 1))
  FROM generate_series(0, 23) AS h(hour)
  WHERE public.is_admin()
  ORDER BY h.hour;
$$;

REVOKE ALL ON FUNCTION public.admin_stats_hours(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_stats_hours(integer) TO authenticated;

-- What's running right now: non-ended sessions with code, quiz title, and
-- current participant count, newest first.
CREATE OR REPLACE FUNCTION public.admin_live_sessions()
RETURNS TABLE (
  id uuid,
  code text,
  status text,
  title text,
  created_at timestamptz,
  participants bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.code, s.status, q.title, s.created_at,
    (SELECT count(*) FROM public.participants p WHERE p.session_id = s.id)::bigint
  FROM public.sessions s
  JOIN public.quizzes q ON q.id = s.quiz_id
  WHERE s.status <> 'ended' AND public.is_admin()
  ORDER BY s.created_at DESC
  LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.admin_live_sessions() FROM public;
GRANT EXECUTE ON FUNCTION public.admin_live_sessions() TO authenticated;

-- Most-played quizzes (play_count is incremented on every session launch),
-- extended with arena challenge health: average final score and accuracy from
-- competition_results, so too-easy / too-hard challenges are visible.
-- DROP + CREATE: RETURNS TABLE gains two columns, which CREATE OR REPLACE
-- rejects in Postgres (repo precedent: get_session_questions migrations).
DROP FUNCTION IF EXISTS public.admin_top_quizzes(integer);
CREATE FUNCTION public.admin_top_quizzes(p_limit integer DEFAULT 5)
RETURNS TABLE (
  id uuid,
  title text,
  plays bigint,
  is_arena boolean,
  avg_score numeric,
  avg_accuracy numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.id, q.title, COALESCE(q.play_count, 0)::bigint, q.is_arena,
    (SELECT ROUND(avg(r.final_score), 0) FROM public.competition_results r WHERE r.quiz_id = q.id),
    (SELECT ROUND(avg(r.accuracy_percentage), 1) FROM public.competition_results r WHERE r.quiz_id = q.id)
  FROM public.quizzes q
  WHERE q.archived_at IS NULL AND public.is_admin()
  ORDER BY COALESCE(q.play_count, 0) DESC, q.created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.admin_top_quizzes(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_top_quizzes(integer) TO authenticated;
