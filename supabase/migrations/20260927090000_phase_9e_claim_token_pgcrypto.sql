-- Phase 9E: repair result-claim token generation.
--
-- THE DEFECT
-- `create_session_claim` and `create_arena_claim` both mint a 256-bit ticket
-- with `encode(gen_random_bytes(32), 'hex')`, but both functions are declared
-- `SET search_path TO 'public'`. `gen_random_bytes` ships with the `pgcrypto`
-- extension, which on this project lives in the `extensions` schema. A
-- SECURITY DEFINER function with `search_path` pinned to `public` therefore
-- cannot resolve the call, and every invocation failed at runtime with:
--
--     42883  function gen_random_bytes(integer) does not exist
--
-- The result is that "Save this result" has never worked in production: the
-- guest's browser surfaced a generic "Could not prepare this result" and no
-- claim ticket was ever issued. This was invisible to the automated tests
-- because none of them execute the RPC against the live database.
--
-- THE FIX
-- Schema-qualify the call. Deliberately NOT "add extensions to the
-- search_path": widening a SECURITY DEFINER search_path is how object-hijack
-- vulnerabilities happen. Qualifying one function name is the minimal,
-- targeted change.
--
-- `gen_random_uuid()` is unaffected - it is core in PostgreSQL 13+ and resolves
-- from pg_catalog, which is why `join_session` and the rest of the engine work.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Fail loudly at migrate time rather than in a guest's browser at 3am.
DO $$
BEGIN
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION
      'pgcrypto is not reachable as extensions.gen_random_bytes(integer); result-claim token generation would fail at runtime. Check where the pgcrypto extension is installed.';
  END IF;
END $$;

-- Hosted-session guest ticket. Body is otherwise byte-for-byte the deployed
-- definition; only the token source is qualified.
CREATE OR REPLACE FUNCTION public.create_session_claim(p_participant_id uuid, p_secret_token text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_token text; v_profile uuid; v_quiz uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.participant_secrets
                 WHERE participant_id = p_participant_id AND secret_token = p_secret_token) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT p.profile_id, s.quiz_id INTO v_profile, v_quiz
    FROM public.participants p JOIN public.sessions s ON s.id = p.session_id
   WHERE p.id = p_participant_id;
  IF v_profile IS NOT NULL THEN RAISE EXCEPTION 'Already claimed'; END IF;

  SELECT token INTO v_token FROM public.result_claims
   WHERE participant_id = p_participant_id AND claimed_at IS NULL AND expires_at > now();
  IF v_token IS NOT NULL THEN RETURN v_token; END IF;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.result_claims(token, kind, participant_id, quiz_id)
    VALUES (v_token, 'session', p_participant_id, v_quiz)
  ON CONFLICT (participant_id) WHERE participant_id IS NOT NULL
  DO UPDATE SET token = EXCLUDED.token, created_at = now(),
                expires_at = now() + interval '24 hours',
                claimed_at = NULL, claimed_by = NULL;
  RETURN v_token;
END; $$;

-- Arena guest ticket. The score is still computed server-side by
-- score_arena_run; the client never supplies it.
CREATE OR REPLACE FUNCTION public.create_arena_claim(p_quiz_id uuid, p_answers jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_token text; r record;
BEGIN
  SELECT * INTO r FROM public.score_arena_run(p_quiz_id, p_answers);
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.result_claims(token, kind, quiz_id, score, accuracy)
    VALUES (v_token, 'arena', p_quiz_id, r.score, r.accuracy);
  RETURN v_token;
END; $$;

-- Grants are preserved by CREATE OR REPLACE, but re-assert them so the fix is
-- self-contained if the functions were ever recreated without them.
REVOKE ALL ON FUNCTION public.create_session_claim(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_arena_claim(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_session_claim(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_arena_claim(uuid, jsonb) TO anon, authenticated;
