-- Fix: admin_platform_stats referenced the dropped `quizzes.is_arena` column
-- (removed in Phase 9B). Recreate it using the effective Arena visibility
-- formula (arena_publication_status = 'published' AND arena_admin_status =
-- 'visible' AND archived_at IS NULL) so Mission Control overview / live
-- sessions stats load again.
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
    (SELECT count(*) FROM public.quizzes
      WHERE arena_publication_status = 'published'
        AND arena_admin_status = 'visible'
        AND archived_at IS NULL),
    (SELECT count(*) FROM public.competitions),
    (SELECT count(*) FROM public.sessions WHERE status NOT IN ('ended')),
    (SELECT count(*) FROM public.sessions WHERE created_at > now() - interval '7 days'),
    (SELECT COALESCE(sum(play_count), 0) FROM public.quizzes
      WHERE arena_publication_status = 'published'
        AND arena_admin_status = 'visible'
        AND archived_at IS NULL),
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
