-- Phase 9D.2c — Client-side broadcast optimization.
--
-- Problem: the client still refetches ALL participants on every `game:answer`
-- and `game:join` broadcast, and the transitional fallback (9D.2b) restored the
-- WAL `postgres_changes` bindings on `participants`/`answers`/`teams`, which
-- duplicate the broadcasts. With N players each answering, that's N broadcasts
-- x N clients each doing an O(N) refetch = O(N^2) per round; the wall hits at
-- ~35 players.
--
-- Fix:
--   1. Enrich `game:join` payload with nickname/score/team_id/avatar_id so
--      clients can append the new seat optimistically instead of refetching.
--   2. Re-apply the publication diet: drop answers/participants/teams from
--      supabase_realtime so WAL fan-out stops entirely. Broadcast is the
--      single source of truth for high-frequency gameplay.
--   3. Client routes (host.$sessionId.tsx, play.$sessionId.tsx) switch from
--      full-refetch handlers to O(1) optimistic delta updates on broadcast,
--      keeping only low-frequency `sessions` UPDATE on postgres_changes.

-- 1. Enrich game:join payload so a client can append the new seat without a
--    full participants refetch. Everything else in the trigger is unchanged.
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
        v_payload := jsonb_build_object(
          'participant_id', NEW.id,
          'nickname', NEW.nickname,
          'score', NEW.score,
          'team_id', NEW.team_id,
          'avatar_id', NEW.avatar_id,
          'joined_at', NEW.joined_at
        );
      ELSIF TG_OP = 'UPDATE' THEN
        -- Only genuine answer activity (score/streak moved) is high-frequency.
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

-- 2. Re-apply the publication diet (9D.2b restored these tables).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['answers', 'participants', 'teams'] LOOP
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- Post-migration verification (read-only, manual):
--   SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
--   -- expect: sessions only
