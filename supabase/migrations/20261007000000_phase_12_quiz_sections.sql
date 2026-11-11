-- =============================================================================
-- Phase 12 — Quiz Sections (categorized quizzes), foundation only
-- -----------------------------------------------------------------------------
-- Adds the authoring-side foundation for quizzes whose questions are grouped
-- into named, ordered sections. This migration is PURELY ADDITIVE:
--
--   1. quizzes.question_flow ('flat' | 'categorized'), NOT NULL DEFAULT 'flat'.
--      Every existing quiz becomes a flat quiz. Nothing else changes.
--   2. public.quiz_sections (id, quiz_id, title, position, created_at).
--   3. questions.section_id (uuid, NULLABLE). Existing rows stay NULL, which is
--      exactly the flat-quiz state. A question with section_id NULL is valid in
--      both flows.
--
-- NOTHING in this migration touches gameplay:
--   * sessions.question_order keeps its flattened jsonb array-of-ids shape;
--   * no timer, scoring, answer-submission, Realtime or advancement code moves;
--   * no RPC is redefined;
--   * no existing RLS policy is dropped or altered;
--   * no destructive DDL — every statement is additive or guarded.
--
-- The session-level snapshot (presentation_mode + section snapshot) is deferred
-- to the next phase. See docs/QUIZ_SECTIONS_PHASE_2_SESSION_SNAPSHOT.md for the
-- exact session-creation and transaction changes that phase requires.
--
-- SEMANTIC RULES established here (mirrored in src/lib/quiz/sections.ts):
--   * Section order is deterministic: ORDER BY position, created_at, id.
--     position is NOT unique — duplicate positions are tolerated and broken by
--     the tiebreakers above, so a client reordering sections can never wedge.
--   * titles are stored as given but must be non-blank after trimming.
--   * A question may only reference a section belonging to its OWN quiz. That
--     is enforced in the database (composite FK), not just in app code.
--   * Deleting a section NULLs the section_id of its questions (ON DELETE SET
--     NULL). Questions are NEVER deleted as a side effect of section deletion.
--
-- NOT REUSED: quizzes.arena_category / quizzes.tags. Those are Arena catalogue
-- moderation metadata owned by Phase 9B/11 and are unrelated to authoring
-- structure. Section data lives only in quiz_sections.
-- =============================================================================

-- ############################################################################
-- 1. quizzes.question_flow
-- -----------------------------------------------------------------------------
-- 'flat'        — questions play in their existing continuous position order.
-- 'categorized' — questions are grouped into ordered, named sections.
-- DEFAULT 'flat' means every pre-existing quiz keeps today's behaviour byte for
-- byte, and a quiz is only in categorized mode because an owner chose it.
-- ############################################################################
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS question_flow text NOT NULL DEFAULT 'flat';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quizzes_question_flow_check'
      AND conrelid = 'public.quizzes'::regclass
  ) THEN
    ALTER TABLE public.quizzes
      ADD CONSTRAINT quizzes_question_flow_check
      CHECK (question_flow IN ('flat', 'categorized'));
  END IF;
END $$;

COMMENT ON COLUMN public.quizzes.question_flow IS
  'Authoring layout: flat = questions play in continuous position order; categorized = questions are grouped into ordered quiz_sections. Default flat preserves pre-Phase-12 behaviour.';

-- ############################################################################
-- 2. public.quiz_sections
-- ############################################################################
CREATE TABLE IF NOT EXISTS public.quiz_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  title text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.quiz_sections IS
  'Named, ordered groupings of questions for quizzes with question_flow = ''categorized''. Purely authoring-side in Phase 12; gameplay still consumes the flattened sessions.question_order.';
COMMENT ON COLUMN public.quiz_sections.title IS
  'Display name for the section. Stored trimmed; must be non-blank.';
COMMENT ON COLUMN public.quiz_sections.position IS
  'Ordering rank among the quiz''s sections. Not unique on purpose — ties are broken deterministically by (created_at, id) so client-side reordering can never conflict.';

-- Deterministic read order for the whole quiz (matches the editor query).
CREATE INDEX IF NOT EXISTS quiz_sections_quiz_idx
  ON public.quiz_sections (quiz_id, position, created_at, id);

-- Rejects blank / whitespace-only / absurdly long titles at the database, so a
-- client bug cannot persist a section the validation layer would reject anyway.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quiz_sections_title_check'
      AND conrelid = 'public.quiz_sections'::regclass
  ) THEN
    ALTER TABLE public.quiz_sections
      ADD CONSTRAINT quiz_sections_title_check
      CHECK (char_length(btrim(title)) BETWEEN 1 AND 80);
  END IF;
END $$;

-- Composite-FK target. (quiz_id, id) is unique because id is the PK, but
-- Postgres requires an explicit unique constraint on the exact referenced
-- column list — this is what lets questions pin (quiz_id, section_id) below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quiz_sections_quiz_id_id_key'
      AND conrelid = 'public.quiz_sections'::regclass
  ) THEN
    ALTER TABLE public.quiz_sections
      ADD CONSTRAINT quiz_sections_quiz_id_id_key UNIQUE (quiz_id, id);
  END IF;
END $$;

ALTER TABLE public.quiz_sections ENABLE ROW LEVEL SECURITY;

-- Grants mirror public.questions. anon gets NO access: nothing on the player
-- side reads sections in Phase 12 (the player path renders the existing
-- questions payload), so section titles are not exposed to anonymous clients.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quiz_sections TO authenticated;
GRANT ALL ON public.quiz_sections TO service_role;

-- ############################################################################
-- 3. questions.section_id
-- -----------------------------------------------------------------------------
-- NULLABLE on purpose. NULL = "not grouped", which is the only valid state for
-- every pre-existing question and stays valid for flat quizzes forever.
-- ############################################################################
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS section_id uuid;

COMMENT ON COLUMN public.questions.section_id IS
  'Optional owning section (public.quiz_sections) for categorized quizzes. NULL = ungrouped. Deleting a section NULLs this column; it never deletes the question.';

-- (a) Referential integrity + graceful section deletion. ON DELETE SET NULL is
--     what guarantees "never silently delete the questions themselves".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'questions_section_id_fkey'
      AND conrelid = 'public.questions'::regclass
  ) THEN
    ALTER TABLE public.questions
      ADD CONSTRAINT questions_section_id_fkey
      FOREIGN KEY (section_id) REFERENCES public.quiz_sections(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- (b) Cross-quiz protection: a question may only point at a section of its own
--     quiz. This is the constraint the database enforces; app code provides the
--     friendly message on top of it.
--
--     Declared DEFERRABLE INITIALLY DEFERRED for one specific reason: the
--     composite key includes quiz_id, which is NOT NULL, so an immediate check
--     would fight constraint (a)'s ON DELETE SET NULL (Postgres would try to
--     null quiz_id too and fail). Deferring to COMMIT lets (a) settle the row
--     first; at commit the pair is (quiz_id, NULL), which MATCH SIMPLE skips.
--     Cross-quiz assignments are still rejected — just at end-of-transaction,
--     which for supabase-js (one implicit transaction per request) is the same
--     HTTP response.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'questions_section_same_quiz_fkey'
      AND conrelid = 'public.questions'::regclass
  ) THEN
    ALTER TABLE public.questions
      ADD CONSTRAINT questions_section_same_quiz_fkey
      FOREIGN KEY (quiz_id, section_id)
      REFERENCES public.quiz_sections (quiz_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- Partial index: only grouped rows are ever queried by section.
CREATE INDEX IF NOT EXISTS questions_section_idx
  ON public.questions (section_id)
  WHERE section_id IS NOT NULL;

-- ############################################################################
-- 4. RLS — mirrors public.questions exactly
-- -----------------------------------------------------------------------------
-- Same two-part gate the existing questions table uses:
--   * permissive ownership policy resolved through quizzes.owner_principal_id
--     (principal-aware, identical shape to "questions manage by owner");
--   * restrictive per-command host gate, identical predicate to the Phase 9D.2
--     split on quizzes/questions (an owner without host capability cannot
--     write — the same rule that already governs question editing).
-- Reads are owner-only (matching "questions owner read"; "questions read all"
-- was dropped long ago), plus an admin branch so moderators can inspect any
-- quiz's structure. No anon policy is created because anon has no grant.
-- ############################################################################

DROP POLICY IF EXISTS "quiz_sections owner read" ON public.quiz_sections;
CREATE POLICY "quiz_sections owner read" ON public.quiz_sections
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.quizzes q
    WHERE q.id = quiz_sections.quiz_id
      AND q.owner_principal_id = public.principal_for_user(auth.uid())
  )
  OR public.is_admin()
);

DROP POLICY IF EXISTS "quiz_sections manage by owner" ON public.quiz_sections;
CREATE POLICY "quiz_sections manage by owner" ON public.quiz_sections
FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = quiz_sections.quiz_id
    AND q.owner_principal_id = public.principal_for_user(auth.uid())
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = quiz_sections.quiz_id
    AND q.owner_principal_id = public.principal_for_user(auth.uid())
));

DROP POLICY IF EXISTS "quiz_sections host only insert" ON public.quiz_sections;
CREATE POLICY "quiz_sections host only insert" ON public.quiz_sections AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

DROP POLICY IF EXISTS "quiz_sections host only update" ON public.quiz_sections;
CREATE POLICY "quiz_sections host only update" ON public.quiz_sections AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

DROP POLICY IF EXISTS "quiz_sections host only delete" ON public.quiz_sections;
CREATE POLICY "quiz_sections host only delete" ON public.quiz_sections AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

-- NOTE: questions.section_id writes are already covered by the existing
-- "questions manage by owner" + "questions host only insert/update/delete"
-- policies. No new question policy is needed and none is added — adding one
-- here would be a second, redundant gate on a table this migration does not
-- otherwise touch.

-- ############################################################################
-- 5. Post-application verification (read-only, safe to re-run)
-- -----------------------------------------------------------------------------
-- Every existing quiz is flat:
--   SELECT count(*) FROM public.quizzes WHERE question_flow <> 'flat';        -- 0
-- Every existing question is ungrouped:
--   SELECT count(*) FROM public.questions WHERE section_id IS NOT NULL;       -- 0
-- No ungrouped-question regressions in gameplay order:
--   SELECT count(*) FROM public.quizzes WHERE question_flow IS NULL;          -- 0 (NOT NULL)
-- Cross-quiz references are impossible:
--   SELECT count(*) FROM public.questions q JOIN public.quiz_sections s
--     ON s.id = q.section_id WHERE s.quiz_id <> q.quiz_id;                    -- 0
-- Policies present:
--   SELECT policyname, cmd, permissive FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'quiz_sections' ORDER BY policyname;
-- =============================================================================
