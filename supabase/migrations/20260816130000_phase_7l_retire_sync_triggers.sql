-- ============================================================================
-- Phase 7L-2: Retire the transitional ownership sync triggers
-- ----------------------------------------------------------------------------
-- Removes the four BEFORE-INSERT/UPDATE triggers that kept owner_id and
-- owner_principal_id in sync during the 7H-7K transition, plus their trigger
-- functions.
--
-- !!! APPLY ORDERING (HARD GATE) !!!
--   This migration MUST be applied AFTER the application deploy that switched
--   all ownership-bearing writes (branding_profiles, leagues, quizzes,
--   competitions) from owner_id to owner_principal_id. Once the triggers are
--   gone, an insert that sets ONLY owner_id leaves owner_principal_id NULL and
--   is rejected by the principal-aware RLS WITH CHECK policies from
--   Phase 7L-1. The Phase 7L-1 bidirectional triggers were the bridge that
--   made the app switch safe; they are retired only now that no code path
--   writes the legacy field.
--
--   Precondition audit (Phase 7L §1, §6 — all confirmed):
--     * zero application writes of owner_id (src/ + MCP server migrated)
--     * zero RLS / RPC / view / function references to owner_id
--       (Phase 7L-1 removed the last ones)
--     * zero drift (owner_principal_id IS DISTINCT FROM owner_id must be 0 —
--       run before applying; Phase 7L-1's integrity gate already proved this)
--
-- ROLLBACK (fully reversible):
--   Re-create the triggers from the Phase 7L-1 migration (section 2) — they
--   are CREATE OR REPLACE functions + CREATE TRIGGER statements and re-apply
--   cleanly at any time.
-- ============================================================================

DROP TRIGGER IF EXISTS branding_sync_owner_principal_trg ON public.branding_profiles;
DROP TRIGGER IF EXISTS leagues_sync_owner_principal_trg ON public.leagues;
DROP TRIGGER IF EXISTS quizzes_sync_owner_principal_trg ON public.quizzes;
DROP TRIGGER IF EXISTS competitions_sync_owner_principal_trg ON public.competitions;

DROP FUNCTION IF EXISTS public.tg_branding_sync_owner_principal();
DROP FUNCTION IF EXISTS public.tg_leagues_sync_owner_principal();
DROP FUNCTION IF EXISTS public.tg_quizzes_sync_owner_principal();
DROP FUNCTION IF EXISTS public.tg_competitions_sync_owner_principal();

-- ---------------------------------------------------------------------------
-- Post-application verification (read-only, safe to re-run in the SQL editor)
-- All counts must be 0:
--   Rows that would have relied on the trigger (owner_principal_id NULL)
-- SELECT count(*) FROM public.branding_profiles WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.leagues          WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.quizzes          WHERE owner_principal_id IS NULL;
-- SELECT count(*) FROM public.competitions     WHERE owner_principal_id IS NULL;
--   Live ownership functions still referencing the legacy column (must be 0)
-- SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND pg_get_functiondef(p.oid) LIKE '%owner_id%';
-- ---------------------------------------------------------------------------
