-- ============================================================================
-- Phase 7L-3: Retire the legacy owner_id columns (individually reversible)
-- ----------------------------------------------------------------------------
-- Drops the legacy user-id ownership columns from the four ownership-bearing
-- tables. This is the final step of the Phase 7L retirement sequence.
--
-- !!! APPLY ORDERING (HARD GATE) !!!
--   MUST be applied AFTER:
--     1. Phase 7L-1 (authorization completion) — removed every RLS/RPC/
--        function reference to owner_id; PostgreSQL additionally refuses to
--        drop a column still referenced by any policy or SQL-language
--        function (safety net).
--     2. The application deploy that switched all reads/writes/guards to
--        owner_principal_id (zero client references).
--     3. Phase 7L-2 (sync trigger retirement) — no trigger maintains the
--        column anymore.
--   Each DROP is individually reversible; the rollback SQL for each column is
--   inlined below.
--
-- ROLLBACK (per table, in order):
--   ALTER TABLE public.branding_profiles
--     ADD COLUMN owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
--   UPDATE public.branding_profiles b SET owner_id = p.user_id
--     FROM public.principals p WHERE p.id = b.owner_principal_id AND p.type = 'user';
--   (same pattern for leagues, quizzes, competitions)
--   NOTE: rows owned by organization/platform/partner principals have no
--   legacy user id and remain NULL after rollback — the legacy column cannot
--   represent them. This is expected and is why the column is being retired.
-- ============================================================================

-- 1. Branding profiles
ALTER TABLE public.branding_profiles DROP COLUMN IF EXISTS owner_id;

-- 2. Leagues
ALTER TABLE public.leagues DROP COLUMN IF EXISTS owner_id;

-- 3. Quizzes (also drops the quizzes_owner_id_fkey -> auth.users FK and the
--    dependent index, if any)
ALTER TABLE public.quizzes DROP COLUMN IF EXISTS owner_id;

-- 4. Competitions
ALTER TABLE public.competitions DROP COLUMN IF EXISTS owner_id;

-- ---------------------------------------------------------------------------
-- Post-application verification (read-only, safe to re-run in the SQL editor)
-- All counts must be 0:
--   Any lingering reference to the retired column (functions + policies)
-- SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND pg_get_functiondef(p.oid) LIKE '%owner_id%';
-- SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public' AND (pg_get_expr(polqual, polrelid) LIKE '%owner_id%' OR pg_get_expr(polwithcheck, polrelid) LIKE '%owner_id%');
--   The column is gone
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name IN ('branding_profiles','leagues','quizzes','competitions')
--     AND column_name = 'owner_id';
--   Every row still has exactly one principal owner
-- SELECT count(*) FROM public.branding_profiles WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.leagues          WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.quizzes          WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.competitions     WHERE owner_principal_id IS NULL;
-- ---------------------------------------------------------------------------
