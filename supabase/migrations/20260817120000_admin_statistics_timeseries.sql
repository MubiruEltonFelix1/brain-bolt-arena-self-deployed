-- Admin statistics: daily activity series + leaderboards for the /admin page.
-- All figures are derived on demand from existing tables — no metrics store.

-- Indexes so the per-day window scans in the timeseries below stay sargable
-- (answers is the largest table and is scanned 90x for a 90-day range).
CREATE INDEX IF NOT EXISTS profiles_created_at_idx ON public.profiles(created_at);
CREATE INDEX IF NOT EXISTS sessions_created_at_idx ON public.sessions(created_at);
CREATE INDEX IF NOT EXISTS participants_joined_at_idx ON public.participants(joined_at);
CREATE INDEX IF NOT EXISTS answers_created_at_idx ON public.answers(created_at);
CREATE INDEX IF NOT EXISTS competition_results_completed_at_idx ON public.competition_results(completed_at);

-- Daily activity buckets for the last p_days days (inclusive of today).
-- Every day in the range is returned, including zero-activity days, so charts
-- get a complete time axis. Accuracy and response time exclude feedback
-- questions, matching record_competition_results().
CREATE OR REPLACE FUNCTION public.admin_stats_timeseries(p_days integer DEFAULT 30)
RETURNS TABLE (
  day date,
  new_players bigint,
  sessions bigint,
  participants bigint,
  answers bigint,
  results bigint,
  avg_accuracy numeric,
  avg_response_ms numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    d.day::date,
    (SELECT count(*) FROM public.profiles p
      WHERE p.created_at >= d.day AND p.created_at < d.day + interval '1 day'),
    (SELECT count(*) FROM public.sessions s
      WHERE s.created_at >= d.day AND s.created_at < d.day + interval '1 day'),
    (SELECT count(*) FROM public.participants pa
      WHERE pa.joined_at >= d.day AND pa.joined_at < d.day + interval '1 day'),
    (SELECT count(*) FROM public.answers a
      WHERE a.created_at >= d.day AND a.created_at < d.day + interval '1 day'),
    (SELECT count(*) FROM public.competition_results r
      WHERE r.completed_at >= d.day AND r.completed_at < d.day + interval '1 day'),
    (SELECT ROUND(count(*) FILTER (WHERE a.is_correct)::numeric
            / NULLIF(count(*), 0) * 100, 1)
       FROM public.answers a
       JOIN public.questions q ON q.id = a.question_id
      WHERE a.created_at >= d.day AND a.created_at < d.day + interval '1 day'
        AND q.question_type <> 'feedback'),
    (SELECT ROUND(avg(a.response_ms), 0)
       FROM public.answers a
       JOIN public.questions q ON q.id = a.question_id
      WHERE a.created_at >= d.day AND a.created_at < d.day + interval '1 day'
        AND q.question_type <> 'feedback')
  FROM generate_series(current_date - (p_days - 1), current_date, interval '1 day') AS d(day)
  WHERE public.is_admin()
  ORDER BY d.day;
$$;

REVOKE ALL ON FUNCTION public.admin_stats_timeseries(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_stats_timeseries(integer) TO authenticated;

-- Most-played quizzes (play_count is incremented on every session launch).
CREATE OR REPLACE FUNCTION public.admin_top_quizzes(p_limit integer DEFAULT 5)
RETURNS TABLE (
  id uuid,
  title text,
  plays bigint,
  is_arena boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.id, q.title, COALESCE(q.play_count, 0)::bigint, q.is_arena
  FROM public.quizzes q
  WHERE q.archived_at IS NULL AND public.is_admin()
  ORDER BY COALESCE(q.play_count, 0) DESC, q.created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.admin_top_quizzes(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_top_quizzes(integer) TO authenticated;

-- Most active hosts by sessions hosted. Grouped by host identity (sessions.host_id
-- → profiles.id), never by display name: display_name defaults to 'Host', so
-- grouping by it would collapse every default-named host into one row.
CREATE OR REPLACE FUNCTION public.admin_top_hosts(p_limit integer DEFAULT 5)
RETURNS TABLE (
  display_name text,
  sessions bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p.display_name, 'Host'), count(*)::bigint
  FROM public.sessions s
  LEFT JOIN public.profiles p ON p.id = s.host_id
  WHERE public.is_admin()
  GROUP BY s.host_id, p.display_name
  ORDER BY count(*) DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.admin_top_hosts(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_top_hosts(integer) TO authenticated;
