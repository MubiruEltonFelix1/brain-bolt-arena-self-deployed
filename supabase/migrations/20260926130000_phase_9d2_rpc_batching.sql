-- Phase 9D.2 — P0-D: replace the host browser's N+1 league/team loops with single RPCs.
--
-- Defect (Phase 9D.1 audit, §6/§23): `finalizeLeague` in src/routes/host.$sessionId.tsx
-- ran `SELECT league_standings` + INSERT-or-UPDATE **per participant** from the host
-- browser (2xN sequential REST round trips; ~100 calls ≈ 30–60 s at real RTT for a
-- 50-player league game, all on the end-of-game path). `autoAssignTeams` ran one
-- UPDATE per unassigned participant (N calls).
--
-- This migration adds two SECURITY DEFINER RPCs that do the same work in ONE
-- transaction, preserving the exact business rules:
--   * finalize_league: for every participant of the session — add `score` to
--     `total_points` and +1 to `sessions_played`, inserting the row when absent.
--     Semantics are identical to the old select-then-update loop; the aggregate is
--     now computed from the database instead of the host's possibly-stale array.
--   * auto_assign_teams: round-robin assignment of unassigned participants over the
--     session's teams, in the same order the host UI used (score DESC), skipping
--     participants that already carry a team.
--
-- Safety additions (brief §16/§24 — idempotency where necessary):
--   * `sessions.league_finalized_at` records the single finalize claim. A duplicate
--     or racing call (double-tap, reconnect, retry) now returns `finalized=false`
--     instead of double-adding a player's points to the standings. The previous
--     client loop had no such guard.
--
-- Rollback: drop the two functions + the column; revert the host route to the
-- previous loops (kept in git history).

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS league_finalized_at timestamptz;

-- ---------------------------------------------------------------------------
-- finalize_league(p_session_id) — one transaction, one standings upsert
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.finalize_league(uuid);

CREATE OR REPLACE FUNCTION public.finalize_league(p_session_id uuid)
RETURNS TABLE(league uuid, finalized boolean, players_finalized integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_league uuid;
  v_count integer;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN
    RAISE EXCEPTION 'Not the host';
  END IF;

  -- Single-claim guard: the row lock taken by this UPDATE serializes concurrent
  -- callers for the duration of the transaction; only the first one proceeds.
  -- (Note: the OUT parameter is named `league`, not `league_id`, so the column
  -- reference below stays unambiguous inside plpgsql.)
  UPDATE public.sessions s
     SET league_finalized_at = now()
   WHERE s.id = p_session_id
     AND s.league_id IS NOT NULL
     AND s.league_finalized_at IS NULL
  RETURNING s.league_id INTO v_league;

  IF NOT FOUND THEN
    SELECT s.league_id INTO v_league FROM public.sessions s WHERE s.id = p_session_id;
    RETURN QUERY SELECT v_league, false, 0;
    RETURN;
  END IF;

  INSERT INTO public.league_standings (league_id, nickname, total_points, sessions_played, updated_at)
  SELECT v_league, p.nickname, p.score, 1, now()
    FROM public.participants p
   WHERE p.session_id = p_session_id
  ON CONFLICT (league_id, nickname) DO UPDATE
     SET total_points    = public.league_standings.total_points + EXCLUDED.total_points,
         sessions_played = public.league_standings.sessions_played + 1,
         updated_at      = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT v_league, true, v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_league(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_league(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- auto_assign_teams(p_session_id) — one statement, deterministic round-robin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_assign_teams(p_session_id uuid)
RETURNS TABLE(assignments integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_teams integer;
  v_count integer;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN
    RAISE EXCEPTION 'Not the host';
  END IF;

  SELECT count(*) INTO v_teams FROM public.teams t WHERE t.session_id = p_session_id;
  IF v_teams = 0 THEN
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  WITH t AS (
    SELECT id, (row_number() OVER (ORDER BY id)) - 1 AS rn, count(*) OVER () AS cnt
      FROM public.teams
     WHERE session_id = p_session_id
  ), p AS (
    SELECT id, (row_number() OVER (ORDER BY score DESC, id)) - 1 AS rn
      FROM public.participants
     WHERE session_id = p_session_id
       AND team_id IS NULL
  )
  UPDATE public.participants pp
     SET team_id = (SELECT t.id FROM t WHERE t.rn = (p.rn % t.cnt))
    FROM p
   WHERE pp.id = p.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_assign_teams(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_assign_teams(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Post-migration verification (read-only, manual):
--   -- 2 round trips replace 2xN / N:
--   SELECT public.finalize_league('<session-uuid>');     -- (league, true, N)
--   SELECT public.finalize_league('<session-uuid>');     -- (league, false, 0)  <- idempotent
--   SELECT public.auto_assign_teams('<session-uuid>');   -- (N)
-- ---------------------------------------------------------------------------
