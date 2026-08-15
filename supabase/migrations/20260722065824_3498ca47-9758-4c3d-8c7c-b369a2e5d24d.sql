
-- Phase 2: Player Identity Integration

-- 1. Add nullable profile_id to participants
ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS participants_profile_id_idx ON public.participants(profile_id);

-- 2. Update join_session to associate authenticated users with their profile
CREATE OR REPLACE FUNCTION public.join_session(p_code text, p_nickname text, p_team_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(participant_id uuid, secret_token text, session_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session_id uuid;
  v_status text;
  v_token text;
  v_pid uuid;
  v_nick text;
  v_profile uuid;
begin
  v_nick := trim(coalesce(p_nickname, ''));
  if length(v_nick) < 2 or length(v_nick) > 32 then
    raise exception 'Nickname must be 2-32 chars';
  end if;

  select id, status into v_session_id, v_status from public.sessions where code = p_code;
  if v_session_id is null then raise exception 'Session not found'; end if;
  if v_status <> 'lobby' then raise exception 'Session is not accepting joins'; end if;

  v_token := gen_random_uuid()::text || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);

  -- If caller is authenticated and has a profile, link it (nickname flow unchanged)
  v_profile := NULL;
  IF auth.uid() IS NOT NULL THEN
    SELECT id INTO v_profile FROM public.profiles WHERE id = auth.uid();
  END IF;

  insert into public.participants(session_id, nickname, team_id, profile_id)
    values (v_session_id, v_nick, p_team_id, v_profile)
    returning id into v_pid;

  insert into public.participant_secrets(participant_id, secret_token)
    values (v_pid, v_token);

  return query select v_pid, v_token, v_session_id;
end; $function$;

-- 3. competition_results table (permanent history for authenticated players)
CREATE TABLE IF NOT EXISTS public.competition_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  quiz_id UUID NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  final_score INTEGER NOT NULL DEFAULT 0,
  final_rank INTEGER NOT NULL,
  total_participants INTEGER NOT NULL,
  accuracy_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, session_id)
);

CREATE INDEX IF NOT EXISTS competition_results_profile_idx ON public.competition_results(profile_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS competition_results_session_idx ON public.competition_results(session_id);

GRANT SELECT ON public.competition_results TO authenticated;
GRANT ALL ON public.competition_results TO service_role;

ALTER TABLE public.competition_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own competition results"
  ON public.competition_results
  FOR SELECT
  TO authenticated
  USING (auth.uid() = profile_id);

-- 4. Trigger to record competition results on session end
CREATE OR REPLACE FUNCTION public.record_competition_results()
 RETURNS TRIGGER
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_total INTEGER;
BEGIN
  IF NEW.status = 'ended' AND (OLD.status IS DISTINCT FROM 'ended') THEN
    SELECT count(*) INTO v_total FROM public.participants WHERE session_id = NEW.id;

    INSERT INTO public.competition_results(
      profile_id, session_id, quiz_id, final_score, final_rank,
      total_participants, accuracy_percentage, completed_at
    )
    SELECT
      p.profile_id,
      NEW.id,
      NEW.quiz_id,
      p.score,
      ranked.rnk,
      v_total,
      COALESCE(acc.accuracy, 0),
      now()
    FROM public.participants p
    JOIN (
      SELECT id, rank() OVER (ORDER BY score DESC, created_at ASC) AS rnk
      FROM public.participants WHERE session_id = NEW.id
    ) ranked ON ranked.id = p.id
    LEFT JOIN LATERAL (
      SELECT ROUND(
        (count(*) FILTER (WHERE a.is_correct))::numeric
        / NULLIF(count(*) FILTER (WHERE q.question_type <> 'feedback'), 0) * 100,
        2
      ) AS accuracy
      FROM public.answers a
      JOIN public.questions q ON q.id = a.question_id
      WHERE a.participant_id = p.id
    ) acc ON true
    WHERE p.session_id = NEW.id
      AND p.profile_id IS NOT NULL
    ON CONFLICT (profile_id, session_id) DO NOTHING;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sessions_record_competition_results ON public.sessions;
CREATE TRIGGER sessions_record_competition_results
  AFTER UPDATE OF status ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.record_competition_results();
