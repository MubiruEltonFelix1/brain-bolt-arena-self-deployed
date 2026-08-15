
CREATE TABLE public.result_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('session','arena')),
  participant_id uuid REFERENCES public.participants(id) ON DELETE CASCADE,
  quiz_id uuid REFERENCES public.quizzes(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0,
  accuracy numeric NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  claimed_at timestamptz,
  claimed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX result_claims_participant_uidx
  ON public.result_claims(participant_id) WHERE participant_id IS NOT NULL;
CREATE INDEX result_claims_open_idx
  ON public.result_claims(expires_at) WHERE claimed_at IS NULL;

GRANT ALL ON public.result_claims TO service_role;
ALTER TABLE public.result_claims ENABLE ROW LEVEL SECURITY;
-- No policies: the table is only reachable through SECURITY DEFINER functions below.

-- Ticket for a hosted-session guest. Ownership is proven with the participant
-- secret stored in that browser, never by nickname/email/display name.
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

  v_token := encode(gen_random_bytes(32), 'hex');
  INSERT INTO public.result_claims(token, kind, participant_id, quiz_id)
    VALUES (v_token, 'session', p_participant_id, v_quiz)
  ON CONFLICT (participant_id) WHERE participant_id IS NOT NULL
  DO UPDATE SET token = EXCLUDED.token, created_at = now(),
                expires_at = now() + interval '24 hours',
                claimed_at = NULL, claimed_by = NULL;
  RETURN v_token;
END; $$;

-- Ticket for a guest Arena run.
CREATE OR REPLACE FUNCTION public.create_arena_claim(p_quiz_id uuid, p_score integer, p_accuracy numeric)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_token text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.quizzes q
                 WHERE q.id = p_quiz_id AND q.is_arena = true AND q.archived_at IS NULL) THEN
    RAISE EXCEPTION 'not an arena quiz';
  END IF;
  v_token := encode(gen_random_bytes(32), 'hex');
  INSERT INTO public.result_claims(token, kind, quiz_id, score, accuracy)
    VALUES (v_token, 'arena', p_quiz_id, greatest(coalesce(p_score,0),0),
            least(greatest(coalesce(p_accuracy,0),0),100));
  RETURN v_token;
END; $$;

-- Redeem a ticket as the signed-in user. Single-use, expiring, server-authoritative.
CREATE OR REPLACE FUNCTION public.claim_result(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  c public.result_claims%ROWTYPE;
  v_uid uuid := auth.uid();
  v_session uuid; v_status text; v_total int; v_avatar text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  SELECT * INTO c FROM public.result_claims WHERE token = p_token FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Invalid claim'; END IF;
  IF c.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'Already claimed'; END IF;
  IF c.expires_at <= now() THEN RAISE EXCEPTION 'Claim expired'; END IF;

  IF c.kind = 'session' THEN
    SELECT p.session_id INTO v_session FROM public.participants p
      WHERE p.id = c.participant_id AND p.profile_id IS NULL FOR UPDATE;
    IF v_session IS NULL THEN RAISE EXCEPTION 'Already claimed'; END IF;

    SELECT avatar_id INTO v_avatar FROM public.profiles WHERE id = v_uid;
    UPDATE public.participants
       SET profile_id = v_uid, avatar_id = coalesce(avatar_id, v_avatar)
     WHERE id = c.participant_id;

    SELECT s.status INTO v_status FROM public.sessions s WHERE s.id = v_session;
    IF v_status = 'ended' THEN
      SELECT count(*) INTO v_total FROM public.participants WHERE session_id = v_session;
      INSERT INTO public.competition_results(
        profile_id, session_id, quiz_id, final_score, final_rank,
        total_participants, accuracy_percentage, completed_at)
      SELECT v_uid, v_session, s.quiz_id, p.score, ranked.rnk, v_total,
             COALESCE(acc.accuracy, 0), now()
        FROM public.participants p
        JOIN public.sessions s ON s.id = p.session_id
        JOIN (SELECT id, rank() OVER (ORDER BY score DESC, joined_at ASC) AS rnk
                FROM public.participants WHERE session_id = v_session) ranked ON ranked.id = p.id
        LEFT JOIN LATERAL (
          SELECT ROUND((count(*) FILTER (WHERE a.is_correct))::numeric
                 / NULLIF(count(*) FILTER (WHERE q.question_type <> 'feedback'), 0) * 100, 2) AS accuracy
            FROM public.answers a JOIN public.questions q ON q.id = a.question_id
           WHERE a.participant_id = p.id) acc ON true
       WHERE p.id = c.participant_id
      ON CONFLICT (profile_id, session_id) DO NOTHING;
    END IF;
  ELSE
    INSERT INTO public.competition_results(
      id, profile_id, session_id, quiz_id, final_score, final_rank,
      total_participants, accuracy_percentage, completed_at)
    VALUES (c.id, v_uid, NULL, c.quiz_id, c.score, 0, 0, c.accuracy, now())
    ON CONFLICT (id) DO NOTHING;
  END IF;

  UPDATE public.result_claims
     SET claimed_at = now(), claimed_by = v_uid
   WHERE id = c.id;

  RETURN jsonb_build_object('kind', c.kind, 'quiz_id', c.quiz_id, 'session_id', v_session);
END; $$;

REVOKE ALL ON FUNCTION public.create_session_claim(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_arena_claim(uuid, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_result(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_session_claim(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_arena_claim(uuid, integer, numeric) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_result(text) TO authenticated;
