# Phase 12.2 (planned) — Session Snapshot for Categorized Quizzes

**Status: NOT IMPLEMENTED.** This is the design doc for the next phase. Nothing below changes
the running system yet; it exists so Phase 2 can be scoped against the Phase 12 foundation laid
in `supabase/migrations/20261007000000_phase_12_quiz_sections.sql`.

## What Phase 12 already gives you

- `quizzes.question_flow` (`flat` | `categorized`, default `flat`).
- `public.quiz_sections` (id, quiz_id, title, position, created_at).
- `questions.section_id` (nullable FK, ON DELETE SET NULL, composite FK to `quiz_sections(quiz_id, id)`).
- RLS + grants on `quiz_sections` mirroring `questions`.
- Authoring UI in `src/routes/quizzes.$id.tsx` (flow toggle, section manager, per-question section dropdown, export CSV).
- Pre-start gate in `src/routes/dashboard.tsx` (`categorizedStartBlock`) and shared rules in `src/lib/quiz/sections.ts` (`validateQuizSections`).
- CSV import honors `section` on categorized quizzes only; never switches mode.

**Gameplay today still consumes `sessions.question_order`** — a flattened `string[]` of question ids.
Nothing in Phase 12 touched timers, scoring, answer submission, Realtime, or question advancement.

## Phase 2 goal

Render a categorized quiz's questions grouped by section during play, while keeping the existing
`current_question_index`-into-`question_order` engine intact. No nested question order replaces the
flat array.

## Session-level changes (documented plan)

### New/changed `sessions` columns

| Column | Type | Meaning |
|--------|------|---------|
| `presentation_mode` | `text` NOT NULL DEFAULT 'flat' | `flat` (one continuous order) or `categorized` (sectioned). Copied from `quizzes.question_flow` at session creation. Frozen for the life of the session. |
| `section_snapshot` | `jsonb` | The authoring-time section structure, frozen at session creation so a later section rename/reorder/delete can never alter a live or historical session. |

### section_snapshot shape

A deterministic JSON array of section objects, one per quiz section, in canonical order
(position, created_at, id):

```json
[
  {
    "id": "<uuid>",
    "title": "Round 1",
    "position": 0,
    "question_ids": ["q-uuid-...", "..."],
    "feedback_ids": ["q-uuid-...", "..."]
  }
]
```

- `question_ids`: playable scored questions belonging to the section, ordered by `questions.position`.
- `feedback_ids`: playable feedback questions belonging to the section, ordered by `questions.position` (feedback within its section; still excluded from scoring).
- Sections with zero questions still appear (empty sections are permitted at authoring; they render as skipped section headers during play).
- Ungrouped playable feedback questions: appended as a final `{ id: null, title: "Ungrouped", position: -1, question_ids: [], feedback_ids: [...] }` entry — matches the existing "feedback slides play last" convention in `host.$sessionId.tsx`.

### Session creation changes

**`src/routes/dashboard.tsx` `startSession`** (hosted path) — this is the one call site that builds `question_order` today:

1. After fetching playable questions and before the `question_order` insert, look up `quizzes.question_flow`.
2. If `categorized`:
   - Load `quiz_sections` for the quiz (ordered canonically).
   - Run `validateQuizSections` (already imported). If not `ok`, toast `validation.errors[0].message` and abort — do **not** create the session. This is the gate; Phase 12's `categorizedStartBlock` already does this validation inline.
   - Build `section_snapshot` from sections + the playable questions.
   - Build `question_order` as a flattened array: for each section in snapshot order, its `question_ids` then its `feedback_ids`; then the final ungrouped feedback entry. This keeps `current_question_index` meaningful as an index into a flat array.
   - Set `presentation_mode = 'categorized'` on the insert.
3. If `flat` (or missing): identical behavior to today — shuffled playable ids, `presentation_mode` defaults to `'flat'`, no `section_snapshot`.

**`prepare_competition_session_internal`** (autonomous/competition path, `src/lib/api/prep.functions.ts` + migration RPC): same logic, but server-side. The RPC receives only `p_competition_id`, so it must read `quizzes.question_flow` and `quiz_sections` itself and compute the flattened order + snapshot inside the transaction before the `INSERT INTO public.sessions(...)`.

### Transaction boundary

The session creation must be a single logical unit:

```
BEGIN;
  -- lock the quiz row so sections can't be mid-reorder
  SELECT * FROM quizzes WHERE id = ... FOR UPDATE;
  -- load sections + playable questions
  -- validate (reject on error)
  -- compute section_snapshot + flattened question_order
  INSERT INTO sessions (..., presentation_mode, section_snapshot, question_order) VALUES (...);
COMMIT;
```

`supabase-js` wraps each request in an implicit transaction, so the dashboard path is already atomic as long as the load→validate→insert happens in one handler. The competition RPC is `SECURITY DEFINER` and already single-statement-scoped; add the validation + snapshot computation before its existing `INSERT`.

### Backward compatibility

- `presentation_mode` defaults `'flat'` and `section_snapshot` is nullable, so every existing session (and every session created from a flat quiz) is byte-identical to today.
- `host.$sessionId.tsx` / `play.$sessionId.tsx` reads: `orderedIds = session.question_order ?? questions.map(...)` stays valid because `question_order` remains a flat id array. The `presentation_mode`/`section_snapshot` columns are additive reads used only by the section-aware host/player UI (Phase 2 UI work, not this doc).
- `advance_question_internal` lazy backfill and `startGame` backfill are unchanged; they write `question_order` only, never `section_snapshot`.

### What Phase 2 does NOT do

- Does not change `current_question_index` semantics (still an index into the flat array).
- Does not alter timers, scoring, Realtime, answer submission, or question advancement.
- Does not modify the host/player round loop.
- Does not delete or repurpose `question_order`.

### Files expected to change in Phase 2

1. `supabase/migrations/<next>_phase_12_quiz_sections_session_snapshot.sql` — `presentation_mode`, `section_snapshot` columns on `sessions`; RLS policies (inherit existing session policies); grants.
2. `scripts/migration-markers.mjs` — entry for the new migration.
3. `src/integrations/supabase/types.ts` — `presentation_mode`, `section_snapshot` on `sessions` Row/Insert/Update.
4. `src/routes/dashboard.tsx` — `startSession` builds snapshot + snapshot-driven order for categorized quizzes (reuse `validateQuizSections` + `groupQuestions`).
5. `src/lib/api/prep.functions.ts` / the `prepare_competition_session_internal` RPC — same computation server-side for autonomous sessions.
6. `src/lib/quiz/sections.ts` — optional `buildSectionSnapshot(sections, questions)` helper centralizing the snapshot shape (shared by dashboard + RPC test fixtures).
7. Host/player routes — read `presentation_mode`/`section_snapshot` to render section headers (UI only, out of scope for this data foundation doc).
