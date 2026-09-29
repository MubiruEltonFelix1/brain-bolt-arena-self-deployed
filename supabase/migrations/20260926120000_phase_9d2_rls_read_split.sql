-- Phase 9D.2 — P0-C: split session/asset READ access from host-only MUTATION access.
--
-- Defect (proven by the Phase 9D.1 audit, reproduced live):
--   20260718000327 created four RESTRICTIVE policies with `FOR ALL TO authenticated`.
--   A restrictive policy is AND-ed with every permissive policy **for every command,
--   including SELECT**. So an authenticated user who is not an admin and holds no
--   active host_authorization could not SELECT a single row from sessions / quizzes /
--   questions / leagues:
--     * a signed-in player opening /join/<code> saw "Game not found" (sessions → null)
--     * every quiz embed on that page resolved to null
--     * arena quizzes disappeared for signed-in users
--   Guests (anon) were unaffected, which is why this stayed hidden.
--
-- The project's intended design is explicit: `docs/ARCHITECTURE_CONSTITUTION.md` §19
-- records "Blanket `true` SELECT policies on sessions, participants, answers, quizzes,
-- leagues, league_standings, branding_profiles — required by anonymous live play."
-- The `FOR ALL` shape contradicted that design by gating reads; this migration restores
-- it WITHOUT weakening any write gate: the restrictive predicate moves verbatim onto
-- INSERT (WITH CHECK), UPDATE (USING + WITH CHECK) and DELETE (USING) individually.
--
-- Security invariants preserved exactly:
--   * authenticated non-hosts still cannot INSERT / UPDATE / DELETE these rows;
--   * the permissive policies (`sessions host manage`, `quizzes manage own`, ...) are untouched;
--   * `sessions anon insert blocked` is untouched;
--   * reads fall back to the pre-existing permissive SELECT policies only
--     (no new USING (true) policy is introduced by this migration).

-- ---------------------------------------------------------------------------
-- 1. sessions
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "sessions host only write" ON public.sessions;

CREATE POLICY "sessions host only insert" ON public.sessions AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "sessions host only update" ON public.sessions AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "sessions host only delete" ON public.sessions AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. quizzes (the /join and /play pages embed quizzes(title) — a direct dependency
--    of the sessions read fix above; identical defect, identical split)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "quizzes host only write" ON public.quizzes;

CREATE POLICY "quizzes host only insert" ON public.quizzes AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "quizzes host only update" ON public.quizzes AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "quizzes host only delete" ON public.quizzes AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. questions (same class; read side remains owner-only via "questions owner read",
--    so this split cannot widen question visibility beyond the owner)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "questions host only write" ON public.questions;

CREATE POLICY "questions host only insert" ON public.questions AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "questions host only update" ON public.questions AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "questions host only delete" ON public.questions AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. leagues (same class; reads fall back to the permissive `leagues read all`)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "leagues host only write" ON public.leagues;

CREATE POLICY "leagues host only insert" ON public.leagues AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "leagues host only update" ON public.leagues AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "leagues host only delete" ON public.leagues AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

-- ---------------------------------------------------------------------------
-- Post-migration verification (read-only, run manually):
--   SELECT tablename, policyname, cmd, permissive FROM pg_policies
--    WHERE schemaname='public' AND policyname LIKE '% host only %' ORDER BY tablename, policyname;
--   -- expect: no `FOR ALL` restrictive rows remain; 12 split rows (insert/update/delete per table)
--
--   -- as a signed-in NON-host user (JWT probe):
--   --   sessions select by code  -> row returned (was: null)
--   --   update on someone's session -> 0 rows (writes still gated)
-- ---------------------------------------------------------------------------
