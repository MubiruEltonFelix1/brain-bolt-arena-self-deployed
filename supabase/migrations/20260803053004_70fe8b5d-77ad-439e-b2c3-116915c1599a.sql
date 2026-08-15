-- 1. Guarantee at most one competition per session link
CREATE UNIQUE INDEX IF NOT EXISTS competitions_session_id_key
  ON public.competitions(session_id) WHERE session_id IS NOT NULL;

-- 2. Idempotent session preparation
CREATE OR REPLACE FUNCTION public.prepare_competition_session(
  p_competition_id uuid,
  p_force boolean DEFAULT false
)
RETURNS TABLE(session_id uuid, code text, status public.competition_status, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  c public.competitions%ROWTYPE;
  v_code text;
  v_order jsonb;
  v_session_id uuid;
  v_count int;
  v_attempt int := 0;
BEGIN
  SELECT * INTO c FROM public.competitions WHERE id = p_competition_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Competition not found'; END IF;

  IF NOT (c.owner_id = auth.uid() OR public.is_authorized_host()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Idempotency: already prepared
  IF c.session_id IS NOT NULL THEN
    RETURN QUERY
      SELECT s.id, s.code, c.status, false
        FROM public.sessions s WHERE s.id = c.session_id;
    RETURN;
  END IF;

  IF c.status IN ('cancelled', 'completed') THEN
    RAISE EXCEPTION 'Competition is % and cannot open a lobby', c.status;
  END IF;
  IF c.status = 'running' THEN
    RAISE EXCEPTION 'Competition is already running without a linked session';
  END IF;

  -- Timing gate (skippable by the owner via p_force)
  IF NOT p_force THEN
    IF c.scheduled_start_at IS NULL THEN
      RAISE EXCEPTION 'Competition has no scheduled start time';
    END IF;
    IF now() < c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds) THEN
      RAISE EXCEPTION 'Lobby time has not arrived yet';
    END IF;
  END IF;

  -- Quiz must still exist and be playable
  SELECT count(*) INTO v_count
    FROM public.questions q
    JOIN public.quizzes z ON z.id = q.quiz_id
   WHERE q.quiz_id = c.quiz_id AND z.archived_at IS NULL;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Quiz is missing, archived, or has no questions';
  END IF;

  SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
    FROM public.questions q WHERE q.quiz_id = c.quiz_id;

  -- Unique join code
  LOOP
    v_attempt := v_attempt + 1;
    v_code := lpad((100000 + floor(random() * 900000))::int::text, 6, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.code = v_code);
    IF v_attempt > 20 THEN RAISE EXCEPTION 'Could not allocate a join code'; END IF;
  END LOOP;

  INSERT INTO public.sessions(quiz_id, host_id, code, status, league_id, branding_profile_id, question_order)
  VALUES (c.quiz_id, c.owner_id, v_code, 'lobby', c.league_id, c.branding_profile_id, v_order)
  RETURNING id INTO v_session_id;

  UPDATE public.competitions
     SET session_id = v_session_id, status = 'lobby_open'
   WHERE id = c.id;

  RETURN QUERY SELECT v_session_id, v_code, 'lobby_open'::public.competition_status, true;
END; $$;

REVOKE ALL ON FUNCTION public.prepare_competition_session(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.prepare_competition_session(uuid, boolean) TO authenticated, service_role;

-- 3. Owner-scoped "due" listing
CREATE OR REPLACE FUNCTION public.list_due_competitions()
RETURNS TABLE(id uuid, title text, scheduled_start_at timestamptz, lobby_opens_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT c.id, c.title, c.scheduled_start_at,
         c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds)
    FROM public.competitions c
   WHERE c.status = 'scheduled'
     AND c.session_id IS NULL
     AND c.scheduled_start_at IS NOT NULL
     AND now() >= c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds)
     AND (c.owner_id = auth.uid() OR public.is_authorized_host())
   ORDER BY c.scheduled_start_at;
$$;

REVOKE ALL ON FUNCTION public.list_due_competitions() FROM public;
GRANT EXECUTE ON FUNCTION public.list_due_competitions() TO authenticated, service_role;

-- 4. Keep competition status in sync with its runtime session
CREATE OR REPLACE FUNCTION public.tg_sync_competition_from_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'active' THEN
      UPDATE public.competitions
         SET status = 'running', started_at = COALESCE(started_at, now())
       WHERE session_id = NEW.id AND status NOT IN ('completed','cancelled');
    ELSIF NEW.status = 'ended' THEN
      UPDATE public.competitions
         SET status = 'completed', completed_at = COALESCE(completed_at, now())
       WHERE session_id = NEW.id AND status <> 'cancelled';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sync_competition_from_session ON public.sessions;
CREATE TRIGGER sync_competition_from_session
AFTER UPDATE OF status ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.tg_sync_competition_from_session();