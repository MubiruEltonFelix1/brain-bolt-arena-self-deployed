-- Post-restore fixes for the new project
-- 1. Recreate the Lovable-internal role the dump's grants reference
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    CREATE ROLE sandbox_exec NOLOGIN;
  END IF;
END $$;

-- 2. Re-apply the full grant set from the dump (idempotent)
GRANT ALL ON TABLE public.host_requests TO anon;
GRANT ALL ON TABLE public.host_requests TO authenticated;
GRANT ALL ON TABLE public.host_requests TO service_role;
GRANT SELECT, INSERT ON TABLE public.host_requests TO sandbox_exec;

GRANT ALL ON TABLE public.league_quizzes TO anon;
GRANT ALL ON TABLE public.league_quizzes TO authenticated;
GRANT ALL ON TABLE public.league_quizzes TO service_role;
GRANT SELECT, INSERT ON TABLE public.league_quizzes TO sandbox_exec;

GRANT ALL ON TABLE public.league_standings TO anon;
GRANT ALL ON TABLE public.league_standings TO authenticated;
GRANT ALL ON TABLE public.league_standings TO service_role;
GRANT SELECT, INSERT ON TABLE public.league_standings TO sandbox_exec;

GRANT ALL ON TABLE public.leagues TO anon;
GRANT ALL ON TABLE public.leagues TO authenticated;
GRANT ALL ON TABLE public.leagues TO service_role;
GRANT SELECT, INSERT ON TABLE public.leagues TO sandbox_exec;

GRANT ALL ON TABLE public.quizzes TO anon;
GRANT ALL ON TABLE public.quizzes TO authenticated;
GRANT ALL ON TABLE public.quizzes TO service_role;
GRANT SELECT, INSERT ON TABLE public.quizzes TO sandbox_exec;

GRANT ALL ON TABLE public.branding_profiles TO anon;
GRANT ALL ON TABLE public.branding_profiles TO authenticated;
GRANT ALL ON TABLE public.branding_profiles TO service_role;
GRANT SELECT, INSERT ON TABLE public.branding_profiles TO sandbox_exec;

GRANT ALL ON TABLE public.competitions TO anon;
GRANT ALL ON TABLE public.competitions TO authenticated;
GRANT ALL ON TABLE public.competitions TO service_role;
GRANT SELECT, INSERT ON TABLE public.competitions TO sandbox_exec;

GRANT ALL ON TABLE public.result_claims TO anon;
GRANT ALL ON TABLE public.result_claims TO authenticated;
GRANT ALL ON TABLE public.result_claims TO service_role;
GRANT SELECT, INSERT ON TABLE public.result_claims TO sandbox_exec;

GRANT ALL ON TABLE public.user_roles TO anon;
GRANT ALL ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;
GRANT SELECT, INSERT ON TABLE public.user_roles TO sandbox_exec;

GRANT ALL ON TABLE public.principals TO anon;
GRANT ALL ON TABLE public.principals TO authenticated;
GRANT ALL ON TABLE public.principals TO service_role;
GRANT SELECT, INSERT ON TABLE public.principals TO sandbox_exec;

GRANT ALL ON TABLE public.host_authorizations TO anon;
GRANT ALL ON TABLE public.host_authorizations TO authenticated;
GRANT ALL ON TABLE public.host_authorizations TO service_role;
GRANT SELECT, INSERT ON TABLE public.host_authorizations TO sandbox_exec;

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;
GRANT SELECT, INSERT ON TABLE public.profiles TO sandbox_exec;

GRANT ALL ON TABLE public.sessions TO anon;
GRANT ALL ON TABLE public.sessions TO authenticated;
GRANT ALL ON TABLE public.sessions TO service_role;
GRANT SELECT, INSERT ON TABLE public.sessions TO sandbox_exec;

GRANT ALL ON TABLE public.participants TO anon;
GRANT ALL ON TABLE public.participants TO authenticated;
GRANT ALL ON TABLE public.participants TO service_role;
GRANT SELECT, INSERT ON TABLE public.participants TO sandbox_exec;

GRANT ALL ON TABLE public.answers TO anon;
GRANT ALL ON TABLE public.answers TO authenticated;
GRANT ALL ON TABLE public.answers TO service_role;
GRANT SELECT, INSERT ON TABLE public.answers TO sandbox_exec;

GRANT ALL ON TABLE public.competition_results TO anon;
GRANT ALL ON TABLE public.competition_results TO authenticated;
GRANT ALL ON TABLE public.competition_results TO service_role;
GRANT SELECT, INSERT ON TABLE public.competition_results TO sandbox_exec;

GRANT ALL ON TABLE public.participant_secrets TO anon;
GRANT ALL ON TABLE public.participant_secrets TO authenticated;
GRANT ALL ON TABLE public.participant_secrets TO service_role;
GRANT SELECT, INSERT ON TABLE public.participant_secrets TO sandbox_exec;

GRANT ALL ON TABLE public.teams TO anon;
GRANT ALL ON TABLE public.teams TO authenticated;
GRANT ALL ON TABLE public.teams TO service_role;
GRANT SELECT, INSERT ON TABLE public.teams TO sandbox_exec;

GRANT ALL ON TABLE public.questions TO anon;
GRANT ALL ON TABLE public.questions TO authenticated;
GRANT ALL ON TABLE public.questions TO service_role;
GRANT SELECT, INSERT ON TABLE public.questions TO sandbox_exec;

-- 3. Verify realtime membership
SELECT 'realtime: ' || pubname || ' -> ' || string_agg(schemaname || '.' || tablename, ', ' ORDER BY tablename)
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
GROUP BY pubname;
