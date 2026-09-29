-- Phase 9D.2 — P0-A: replace high-frequency gameplay fan-out with Broadcast.
--
-- Audit finding (Phase 9D.1): every answer writes 2 WAL rows (`answers` INSERT +
-- `participants` UPDATE) and every subscribed client received one row event per
-- write through `postgres_changes`, which the Realtime server must authorize
-- per subscriber per change. Measured collapse: 100% delivery ≤40 subscribers;
-- 67% at 50; 33% at 75/100 (stream silent after the first question).
--
-- Design (brief §3–§13, §21):
--   * Postgres stays authoritative — this migration only changes TRANSPORT.
--   * High-frequency gameplay traffic (join / answer / answer-row / team) moves
--     to Realtime Broadcast published by DATABASE TRIGGERS via `realtime.send()`.
--     Publication is therefore server-side only: there is no INSERT policy on
--     `realtime.messages` for `anon`/`authenticated`, so a client cannot publish
--     (spoof) authoritative gameplay events (brief §5).
--   * Low-frequency authoritative transitions (`sessions` UPDATE — start,
--     reveal, advance, pause, end) STAY on `postgres_changes`, unchanged. They
--     are 1–3 events per question, and the client resync path already covers a
--     missed one.
--   * `participants`, `answers` and `teams` are REMOVED from the
--     `supabase_realtime` publication, so the WAL fan-out path no longer exists
--     for them at all.
--   * Private session topic `session:<session_id>`: clients receive; only
--     trusted server-side logic (triggers, running as definer) publishes.
--     `realtime.messages` carries exactly ONE policy — SELECT for anon +
--     authenticated on `session:%` topics. No client INSERT policy.
--   * Payloads are minimal (ids + the changed values), never whole rows
--     (brief §6). Clients keep their existing coalesced refetch behaviour for
--     anything else they need.
--   * Broadcast failures can never break gameplay: every trigger swallows its
--     own errors and the underlying write proceeds (brief §18).
--
-- Rollback (§35): call `public.restore_gameplay_publication()` below, then
-- revert the client routes to the previous `postgres_changes` bindings (kept in
-- git history). No table data or scoring depends on this migration.

-- ---------------------------------------------------------------------------
-- 1. Private-channel authorization: subscribers may RECEIVE session topics.
--    `realtime.topic()` = the channel name the client joins (`session:<uuid>`).
--    Deliberately NO insert policy for anon/authenticated → clients cannot
--    publish. The DB triggers publish through `realtime.send()` (definer).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "session broadcast read" ON realtime.messages;
CREATE POLICY "session broadcast read" ON realtime.messages
  FOR SELECT TO anon, authenticated
  USING (realtime.topic() LIKE 'session:%');

-- Defense in depth (brief §5/§33): `realtime.send` ships with EXECUTE granted to
-- PUBLIC. Verified on this project (2026-09-26): the `realtime` schema is NOT
-- exposed through PostgREST ("Invalid schema: realtime") and a forged
-- `channel.send` on a private topic is denied server-side (no INSERT policy) —
-- a subscriber received 0 forged events. On this project the function is owned
-- by `supabase_realtime_admin` (REVOKE from `postgres` is a no-op here), so the
-- reachability of the admin schema IS the second lock. Keep this statement for
-- environments where the running role owns the function.
REVOKE EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. One trigger function for all four high-frequency events.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_broadcast_game_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session uuid;
  v_payload jsonb;
  v_event text;
BEGIN
  -- Broadcast must never break the write path (brief §18).
  BEGIN
    IF TG_TABLE_NAME = 'participants' THEN
      v_session := COALESCE(NEW.session_id, OLD.session_id);
      IF TG_OP = 'INSERT' THEN
        v_event := 'game:join';
        v_payload := jsonb_build_object('participant_id', NEW.id);
      ELSIF TG_OP = 'UPDATE' THEN
        -- Only genuine answer activity (score/streak moved) is high-frequency.
        -- Team assignment, avatar/profile edits etc. are refreshed by the
        -- clients' coalesced refetch and do not need an event.
        IF NEW.score IS NOT DISTINCT FROM OLD.score
           AND NEW.streak IS NOT DISTINCT FROM OLD.streak THEN
          RETURN NEW;
        END IF;
        v_event := 'game:answer';
        v_payload := jsonb_build_object('participant_id', NEW.id, 'score', NEW.score, 'streak', NEW.streak);
      ELSE
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'answers' THEN
      v_session := NEW.session_id;
      v_event := 'game:answer_row';
      v_payload := jsonb_build_object(
        'participant_id', NEW.participant_id,
        'question_id', NEW.question_id,
        'is_correct', NEW.is_correct
      );
    ELSIF TG_TABLE_NAME = 'teams' THEN
      v_session := COALESCE(NEW.session_id, OLD.session_id);
      v_event := 'game:team';
      v_payload := jsonb_build_object('team_id', COALESCE(NEW.id, OLD.id));
    ELSE
      RETURN NEW;
    END IF;

    IF v_session IS NOT NULL THEN
      PERFORM realtime.send(v_payload, v_event, 'session:' || v_session::text, true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never fail the write because a broadcast could not be sent
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS participants_broadcast_game_event ON public.participants;
CREATE TRIGGER participants_broadcast_game_event
  AFTER INSERT OR UPDATE ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.tg_broadcast_game_event();

DROP TRIGGER IF EXISTS answers_broadcast_game_event ON public.answers;
CREATE TRIGGER answers_broadcast_game_event
  AFTER INSERT ON public.answers
  FOR EACH ROW EXECUTE FUNCTION public.tg_broadcast_game_event();

DROP TRIGGER IF EXISTS teams_broadcast_game_event ON public.teams;
CREATE TRIGGER teams_broadcast_game_event
  AFTER INSERT OR UPDATE OR DELETE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.tg_broadcast_game_event();

-- ---------------------------------------------------------------------------
-- 3. Publication diet — remove the per-row WAL fan-out tables. `sessions`
--    (transitions) stays on postgres_changes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['answers', 'participants', 'teams'] LOOP
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- Rollback helper: put the publication back exactly as it was pre-9D.2.
CREATE OR REPLACE FUNCTION public.restore_gameplay_publication()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'participants') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.participants;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'answers') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.answers;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'teams') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.teams;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_gameplay_publication() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Post-migration verification (read-only, manual):
--   SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
--   --   expect: sessions only
--   SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'realtime' AND tablename = 'messages';
--   --   expect: one SELECT policy; NO insert policy
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid IN ('public.participants'::regclass, 'public.answers'::regclass, 'public.teams'::regclass)
--      AND NOT tgisinternal;
-- ---------------------------------------------------------------------------
