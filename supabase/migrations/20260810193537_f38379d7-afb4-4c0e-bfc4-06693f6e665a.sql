-- Read-only helper: describe what a game code refers to, without exposing
-- private competition rows through the public Data API.
CREATE OR REPLACE FUNCTION public.lookup_game_code(p_code text)
RETURNS TABLE (
  session_id uuid,
  code text,
  session_status text,
  quiz_title text,
  team_mode boolean,
  kind text,
  competition_title text,
  scheduled_start_at timestamptz,
  lobby_opens_at timestamptz,
  autonomous boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.code,
    s.status,
    q.title,
    s.team_mode,
    CASE WHEN c.id IS NULL THEN 'hosted' ELSE 'scheduled' END,
    c.title,
    c.scheduled_start_at,
    CASE WHEN c.scheduled_start_at IS NULL THEN NULL
         ELSE c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds) END,
    COALESCE(c.autonomous, false)
  FROM public.sessions s
  JOIN public.quizzes q ON q.id = s.quiz_id
  LEFT JOIN public.competitions c ON c.session_id = s.id
  WHERE s.code = p_code
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.lookup_game_code(text) FROM public;
GRANT EXECUTE ON FUNCTION public.lookup_game_code(text) TO anon, authenticated;

-- Admin-only derived operational overview. No new storage: all counts are
-- computed from existing tables at call time.
CREATE OR REPLACE FUNCTION public.admin_platform_stats()
RETURNS TABLE (
  total_players bigint,
  total_quizzes bigint,
  arena_quizzes bigint,
  total_competitions bigint,
  live_sessions bigint,
  sessions_last_7d bigint,
  arena_plays bigint,
  results_last_7d bigint,
  pending_host_requests bigint,
  active_host_authorizations bigint,
  expiring_authorizations bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.profiles),
    (SELECT count(*) FROM public.quizzes WHERE archived_at IS NULL),
    (SELECT count(*) FROM public.quizzes WHERE is_arena AND archived_at IS NULL),
    (SELECT count(*) FROM public.competitions),
    (SELECT count(*) FROM public.sessions WHERE status NOT IN ('ended')),
    (SELECT count(*) FROM public.sessions WHERE created_at > now() - interval '7 days'),
    (SELECT COALESCE(sum(play_count), 0) FROM public.quizzes WHERE is_arena),
    (SELECT count(*) FROM public.competition_results WHERE completed_at > now() - interval '7 days'),
    (SELECT count(*) FROM public.host_requests WHERE status = 'pending'),
    (SELECT count(*) FROM public.host_authorizations WHERE status = 'active'),
    (SELECT count(*) FROM public.host_authorizations
       WHERE status = 'active' AND expires_at IS NOT NULL
         AND expires_at BETWEEN now() AND now() + interval '14 days')
  WHERE public.is_admin();
$$;

REVOKE ALL ON FUNCTION public.admin_platform_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.admin_platform_stats() TO authenticated;