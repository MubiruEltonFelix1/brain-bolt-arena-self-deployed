ALTER TABLE public.leagues
  ADD COLUMN IF NOT EXISTS points_first integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS points_second integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS points_third integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS points_participation integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;

CREATE OR REPLACE FUNCTION public.can_view_league(p_league_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id
      AND (l.visibility = 'public' OR l.owner_id = auth.uid() OR public.is_authorized_host())
  );
$$;

CREATE OR REPLACE FUNCTION public.get_league_standings(p_league_id uuid)
RETURNS TABLE(
  standing_position integer,
  profile_id uuid,
  display_name text,
  avatar_id text,
  league_points integer,
  competitions_played integer,
  wins integer,
  podiums integer,
  total_score integer,
  avg_accuracy numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE p1 int; p2 int; p3 int; pp int;
BEGIN
  IF NOT public.can_view_league(p_league_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT points_first, points_second, points_third, points_participation
    INTO p1, p2, p3, pp FROM public.leagues WHERE id = p_league_id;

  RETURN QUERY
  WITH rows AS (
    SELECT cr.profile_id AS pid,
           cr.final_rank AS rnk,
           cr.final_score AS score,
           cr.accuracy_percentage AS acc
      FROM public.competition_results cr
      JOIN public.competitions c ON c.session_id = cr.session_id
     WHERE c.league_id = p_league_id
       AND c.status = 'completed'
       AND cr.session_id IS NOT NULL
  ), agg AS (
    SELECT r.pid,
           SUM(CASE r.rnk WHEN 1 THEN p1 WHEN 2 THEN p2 WHEN 3 THEN p3 ELSE pp END)::int AS pts,
           COUNT(*)::int AS played,
           COUNT(*) FILTER (WHERE r.rnk = 1)::int AS wins,
           COUNT(*) FILTER (WHERE r.rnk <= 3)::int AS podiums,
           SUM(r.score)::int AS total_score,
           ROUND(AVG(r.acc), 1) AS avg_acc
      FROM rows r GROUP BY r.pid
  )
  SELECT ROW_NUMBER() OVER (
           ORDER BY a.pts DESC, a.wins DESC, a.podiums DESC, a.total_score DESC,
                    a.avg_acc DESC NULLS LAST, COALESCE(p.display_name,'') ASC
         )::int,
         a.pid, COALESCE(p.display_name, 'Player'), p.avatar_id,
         a.pts, a.played, a.wins, a.podiums, a.total_score, a.avg_acc
    FROM agg a
    LEFT JOIN public.profiles p ON p.id = a.pid
   ORDER BY 1;
END; $$;

CREATE OR REPLACE FUNCTION public.get_league_overview(p_league_id uuid)
RETURNS TABLE(
  participant_count integer,
  competitions_total integer,
  competitions_completed integer,
  competitions_upcoming integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.can_view_league(p_league_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  SELECT
    (SELECT COUNT(DISTINCT cr.profile_id)::int
       FROM public.competition_results cr
       JOIN public.competitions c ON c.session_id = cr.session_id
      WHERE c.league_id = p_league_id AND c.status = 'completed'),
    (SELECT COUNT(*)::int FROM public.competitions WHERE league_id = p_league_id AND status <> 'cancelled'),
    (SELECT COUNT(*)::int FROM public.competitions WHERE league_id = p_league_id AND status = 'completed'),
    (SELECT COUNT(*)::int FROM public.competitions
      WHERE league_id = p_league_id AND status IN ('draft','scheduled','lobby_open','running'));
END; $$;

CREATE OR REPLACE FUNCTION public.get_my_leagues()
RETURNS TABLE(
  league_id uuid,
  name text,
  status league_status,
  archived_at timestamp with time zone,
  standing_position integer,
  league_points integer,
  competitions_played integer,
  last_played_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH rows AS (
    SELECT c.league_id AS lid, cr.profile_id AS pid, cr.final_rank AS rnk,
           cr.final_score AS score, cr.accuracy_percentage AS acc, cr.completed_at AS done
      FROM public.competition_results cr
      JOIN public.competitions c ON c.session_id = cr.session_id
     WHERE c.league_id IS NOT NULL AND c.status = 'completed' AND cr.session_id IS NOT NULL
  ), agg AS (
    SELECT r.lid, r.pid,
           SUM(CASE r.rnk WHEN 1 THEN l.points_first WHEN 2 THEN l.points_second
                          WHEN 3 THEN l.points_third ELSE l.points_participation END)::int AS pts,
           COUNT(*)::int AS played,
           COUNT(*) FILTER (WHERE r.rnk = 1)::int AS wins,
           COUNT(*) FILTER (WHERE r.rnk <= 3)::int AS podiums,
           SUM(r.score)::int AS total_score,
           AVG(r.acc) AS avg_acc,
           MAX(r.done) AS last_played
      FROM rows r JOIN public.leagues l ON l.id = r.lid
     GROUP BY r.lid, r.pid
  ), ranked AS (
    SELECT a.*, ROW_NUMBER() OVER (
      PARTITION BY a.lid
      ORDER BY a.pts DESC, a.wins DESC, a.podiums DESC, a.total_score DESC, a.avg_acc DESC NULLS LAST
    )::int AS pos FROM agg a
  )
  SELECT r.lid, l.name, l.status, l.archived_at, r.pos, r.pts, r.played, r.last_played
    FROM ranked r JOIN public.leagues l ON l.id = r.lid
   WHERE r.pid = v_uid
   ORDER BY r.last_played DESC NULLS LAST;
END; $$;

GRANT EXECUTE ON FUNCTION public.can_view_league(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_league_standings(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_league_overview(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_leagues() TO authenticated;