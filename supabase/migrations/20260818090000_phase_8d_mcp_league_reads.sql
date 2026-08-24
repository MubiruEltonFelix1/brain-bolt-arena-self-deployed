-- Phase 8D: service-role wrappers delegating to the app's authoritative league
-- computation (standings + season overview).
--
-- Why these exist: get_league_standings / get_league_overview are gated by
-- can_view_league(), which reads auth.uid()/is_admin() from the request JWT.
-- The MCP integration connects with the service role, which carries no JWT
-- principal — auth.uid() is NULL — so the originals only pass for public
-- leagues. These wrappers take an explicit acting principal and enforce the
-- app's own rule (owner via can(), or public visibility — note: no is_admin()
-- view-all branch, a deliberate read-safety tightening), then delegate.
-- No standings/points logic is recreated here.
--
-- Impersonation: the originals internally re-gate via can_view_league(), so
-- even a private league OWNED by the acting principal would raise after the
-- wrapper's own gate passed. Before delegating, the wrapper impersonates
-- p_principal via transaction-scoped set_config (is_local := true — PostgREST
-- runs each RPC in its own transaction, so the claim never leaks to other
-- calls or pooled connections). Both claim shapes are set to cover Supabase
-- versions that read request.jwt.claims (JSON) vs request.jwt.claim.sub
-- (scalar). Security is preserved: the wrapper's own can()/public gate runs
-- BEFORE impersonation (a rejected caller never reaches it), EXECUTE is
-- service_role-only, and SECURITY DEFINER means RLS never applies inside.
-- is_admin() resolves from user_roles for the impersonated sub — exactly the
-- app's semantics — so no admin branch becomes reachable.

CREATE OR REPLACE FUNCTION public.mcp_league_standings(p_principal uuid, p_league_id uuid)
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
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (
    public.can(p_principal, 'league.manage', p_league_id)
    OR EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = p_league_id AND l.visibility = 'public')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_principal::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', p_principal::text, true);
  RETURN QUERY SELECT * FROM public.get_league_standings(p_league_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_league_overview(p_principal uuid, p_league_id uuid)
RETURNS TABLE(
  participant_count integer,
  competitions_total integer,
  competitions_completed integer,
  competitions_upcoming integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (
    public.can(p_principal, 'league.manage', p_league_id)
    OR EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = p_league_id AND l.visibility = 'public')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_principal::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', p_principal::text, true);
  RETURN QUERY SELECT * FROM public.get_league_overview(p_league_id);
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_league_standings(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.mcp_league_overview(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.mcp_league_standings(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_league_overview(uuid, uuid) TO service_role;
