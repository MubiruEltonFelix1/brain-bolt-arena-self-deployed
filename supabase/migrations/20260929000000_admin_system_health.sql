-- Phase 11: Admin System Health (Mission Control).
--
-- Derived diagnostics on existing tables — no new tables, no metrics store.
-- All functions are SECURITY DEFINER and gated by public.is_admin().

-- ############################################################################
-- 1. Indexes so health scans stay sargable
-- ############################################################################

CREATE INDEX IF NOT EXISTS sessions_status_created_idx
  ON public.sessions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS answers_created_at_response_ms_idx
  ON public.answers(created_at DESC, response_ms);

CREATE INDEX IF NOT EXISTS sessions_current_question_started_at_idx
  ON public.sessions(current_question_started_at);

-- ############################################################################
-- 2. admin_health_overview — top-line health summary for Mission Control
-- ############################################################################

CREATE OR REPLACE FUNCTION public.admin_health_overview()
RETURNS TABLE (
  total_sessions_7d bigint,
  stuck_lobby_sessions bigint,
  frozen_active_sessions bigint,
  avg_response_ms_7d numeric,
  slow_question_sessions bigint,
  completion_rate_7d numeric,
  total_sessions_all_time bigint,
  total_players_all_time bigint,
  total_answers_all_time bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.sessions
      WHERE created_at >= now() - interval '7 days'),
    (SELECT count(*) FROM public.sessions s
      WHERE s.status = 'lobby'
        AND EXISTS (SELECT 1 FROM public.participants p WHERE p.session_id = s.id)
        AND s.created_at < now() - interval '15 minutes'),
    (SELECT count(*) FROM public.sessions s
      WHERE s.status = 'active'
        AND s.current_question_started_at IS NOT NULL
        AND s.current_question_started_at < now() - interval '10 minutes'),
    (SELECT ROUND(avg(a.response_ms), 0)
       FROM public.answers a
       JOIN public.questions q ON q.id = a.question_id
      WHERE a.created_at >= now() - interval '7 days'
        AND q.question_type <> 'feedback'),
    (SELECT count(DISTINCT a.session_id)
       FROM public.answers a
      WHERE a.created_at >= now() - interval '7 days'
        AND a.response_ms > 60000),
    (SELECT ROUND(100.0 * count(*) FILTER (WHERE status = 'ended') / NULLIF(count(*), 0), 1)
       FROM public.sessions
      WHERE created_at >= now() - interval '7 days'),
    (SELECT count(*) FROM public.sessions),
    (SELECT count(*) FROM public.participants),
    (SELECT count(*) FROM public.answers)
  WHERE public.is_admin();
$$;

REVOKE ALL ON FUNCTION public.admin_health_overview() FROM public;
GRANT EXECUTE ON FUNCTION public.admin_health_overview() TO authenticated;

-- ############################################################################
-- 3. admin_health_stuck_lobby_sessions — sessions that never left the lobby
-- ############################################################################

CREATE OR REPLACE FUNCTION public.admin_health_stuck_lobby_sessions(p_minutes_stuck integer DEFAULT 15)
RETURNS TABLE (
  session_id uuid,
  code text,
  quiz_title text,
  host_id uuid,
  participant_count bigint,
  minutes_stuck numeric,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.code,
    q.title,
    s.host_id,
    (SELECT count(*) FROM public.participants p WHERE p.session_id = s.id)::bigint,
    ROUND(EXTRACT(EPOCH FROM (now() - s.created_at)) / 60, 1)::numeric,
    s.created_at
  FROM public.sessions s
  JOIN public.quizzes q ON q.id = s.quiz_id
  WHERE s.status = 'lobby'
    AND EXISTS (SELECT 1 FROM public.participants p WHERE p.session_id = s.id)
    AND s.created_at < now() - (p_minutes_stuck * interval '1 minute')
  ORDER BY s.created_at DESC
  LIMIT 100;
$$;

REVOKE ALL ON FUNCTION public.admin_health_stuck_lobby_sessions(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_health_stuck_lobby_sessions(integer) TO authenticated;

-- ############################################################################
-- 4. admin_health_frozen_active_sessions — active sessions stuck on one question
-- ############################################################################

CREATE OR REPLACE FUNCTION public.admin_health_frozen_active_sessions(p_minutes_stuck integer DEFAULT 10)
RETURNS TABLE (
  session_id uuid,
  code text,
  quiz_title text,
  current_question_index int,
  current_question_started_at timestamptz,
  participant_count bigint,
  minutes_on_question numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.code,
    q.title,
    s.current_question_index,
    s.current_question_started_at,
    (SELECT count(*) FROM public.participants p WHERE p.session_id = s.id)::bigint,
    ROUND(EXTRACT(EPOCH FROM (now() - s.current_question_started_at)) / 60, 1)::numeric
  FROM public.sessions s
  JOIN public.quizzes q ON q.id = s.quiz_id
  WHERE s.status = 'active'
    AND s.current_question_started_at IS NOT NULL
    AND s.current_question_started_at < now() - (p_minutes_stuck * interval '1 minute')
  ORDER BY s.current_question_started_at ASC
  LIMIT 100;
$$;

REVOKE ALL ON FUNCTION public.admin_health_frozen_active_sessions(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_health_frozen_active_sessions(integer) TO authenticated;

-- ############################################################################
-- 5. admin_health_slow_questions — questions with abnormally long response times
-- ############################################################################

CREATE OR REPLACE FUNCTION public.admin_health_slow_questions(p_days integer DEFAULT 7, p_ms_threshold integer DEFAULT 60000)
RETURNS TABLE (
  question_id uuid,
  question_text text,
  session_code text,
  current_question_index int,
  answer_count bigint,
  avg_response_ms numeric,
  max_response_ms bigint,
  pct_slow_answers numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    q.id AS question_id,
    q.text AS question_text,
    s.code AS session_code,
    s.current_question_index AS current_question_index,
    count(*)::bigint AS answer_count,
    ROUND(avg(a.response_ms)::numeric, 0) AS avg_response_ms,
    max(a.response_ms) AS max_response_ms,
    ROUND(count(*) FILTER (WHERE a.response_ms > p_ms_threshold)::numeric
          * 100 / NULLIF(count(*), 0), 1) AS pct_slow_answers
  FROM public.answers a
  JOIN public.questions q ON q.id = a.question_id
  JOIN public.sessions s ON s.id = a.session_id
  WHERE a.created_at >= now() - (p_days * interval '1 day')
    AND q.question_type <> 'feedback'
  GROUP BY q.id, q.text, s.code, s.current_question_index
  HAVING ROUND(avg(a.response_ms)::numeric, 0) > p_ms_threshold / 2
  ORDER BY avg_response_ms DESC
  LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.admin_health_slow_questions(integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_health_slow_questions(integer, integer) TO authenticated;

-- ############################################################################
-- 6. admin_health_answer_gaps — sessions with long gaps between answers
--    (possible freezes where the host had to manually advance / end early)
-- ############################################################################

CREATE OR REPLACE FUNCTION public.admin_health_answer_gaps(p_days integer DEFAULT 7, p_gap_seconds integer DEFAULT 300)
RETURNS TABLE (
  session_id uuid,
  code text,
  quiz_title text,
  question_id uuid,
  gap_seconds bigint,
  participant_count bigint,
  latest_answer_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT a.session_id, a.question_id, a.created_at,
      LAG(a.created_at) OVER (PARTITION BY a.session_id ORDER BY a.created_at) AS prev_created_at,
      ROW_NUMBER() OVER (PARTITION BY a.session_id ORDER BY a.created_at DESC) AS rn
    FROM public.answers a
    WHERE a.created_at >= now() - (p_days * interval '1 day')
  ),
  gaps AS (
    SELECT session_id, question_id, created_at, prev_created_at,
      EXTRACT(EPOCH FROM (created_at - prev_created_at))::bigint AS gap_seconds,
      rn
    FROM ranked
    WHERE prev_created_at IS NOT NULL
      AND EXTRACT(EPOCH FROM (created_at - prev_created_at)) > p_gap_seconds
  )
  SELECT
    g.session_id,
    s.code,
    q.title,
    g.question_id,
    g.gap_seconds,
    (SELECT count(*) FROM public.participants p WHERE p.session_id = g.session_id)::bigint,
    g.created_at
  FROM gaps g
  JOIN public.sessions s ON s.id = g.session_id
  JOIN public.quizzes q ON q.id = s.quiz_id
  WHERE g.rn = 1
  ORDER BY g.gap_seconds DESC
  LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.admin_health_answer_gaps(integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_health_answer_gaps(integer, integer) TO authenticated;
