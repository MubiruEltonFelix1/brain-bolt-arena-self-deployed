-- =============================================================================
-- Phase 12 — Quiz Sections: session snapshots
-- -----------------------------------------------------------------------------
-- Carries the authoring-created section organization into live quiz sessions.
--
-- Adds two purely additive columns to public.sessions:
--
--   1. presentation_mode text NOT NULL DEFAULT 'flat'
--      'flat'       — one continuous question order (existing behaviour).
--      'categorized'— questions are presented grouped by section.
--      DEFAULT 'flat' means every existing session keeps today's behaviour.
--
--   2. section_snapshot jsonb
--      Immutable copy of the quiz's section structure captured at session
--      creation. Only populated for categorized sessions; NULL for flat
--      sessions and for all pre-existing sessions.
--
-- NOTHING in this migration touches gameplay:
--   * sessions.question_order keeps its flattened jsonb array-of-ids shape;
--   * no timer, scoring, answer-submission, Realtime or advancement code moves;
--   * no existing column or policy is altered or dropped;
--   * no destructive DDL.
--
-- The snapshot is immutable once written: host/player presentation derives
-- section boundaries exclusively from the saved snapshot, never from live
-- quiz sections. Editing or deleting quiz sections after a session starts
-- cannot change that session's presentation.
-- =============================================================================

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS presentation_mode text NOT NULL DEFAULT 'flat';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_presentation_mode_check'
      AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_presentation_mode_check
      CHECK (presentation_mode IN ('flat', 'categorized'));
  END IF;
END $$;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS section_snapshot jsonb;

COMMENT ON COLUMN public.sessions.presentation_mode IS
  'How questions are presented during the session: flat = continuous order, categorized = grouped by sections captured in section_snapshot.';
COMMENT ON COLUMN public.sessions.section_snapshot IS
  'Immutable section structure captured at session creation. NULL for flat sessions. Only meaningful when presentation_mode = ''categorized''.';

CREATE INDEX IF NOT EXISTS sessions_presentation_mode_idx
  ON public.sessions (presentation_mode);

-- Post-application verification (read-only, safe to re-run):
--   Every pre-existing session is flat with no snapshot:
--     SELECT count(*) FROM public.sessions WHERE presentation_mode <> 'flat';            -- 0
--     SELECT count(*) FROM public.sessions WHERE section_snapshot IS NOT NULL;           -- 0 (pre-existing)
--   Categorized sessions carry a snapshot:
--     SELECT count(*) FROM public.sessions WHERE presentation_mode = 'categorized' AND section_snapshot IS NULL; -- 0
