
-- League Engine Foundation
CREATE TYPE public.league_status AS ENUM ('draft', 'registration_open', 'active', 'completed');
CREATE TYPE public.league_visibility AS ENUM ('public', 'private');

ALTER TABLE public.leagues
  ADD COLUMN status public.league_status NOT NULL DEFAULT 'draft',
  ADD COLUMN visibility public.league_visibility NOT NULL DEFAULT 'private',
  ADD COLUMN start_date date,
  ADD COLUMN end_date date,
  ADD COLUMN cover_image_url text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER leagues_touch_updated_at
  BEFORE UPDATE ON public.leagues
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Junction table: quizzes attached to a league (ordered, no duplicates)
CREATE TABLE public.league_quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, quiz_id)
);
CREATE INDEX league_quizzes_league_pos_idx ON public.league_quizzes(league_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.league_quizzes TO authenticated;
GRANT SELECT ON public.league_quizzes TO anon;
GRANT ALL ON public.league_quizzes TO service_role;

ALTER TABLE public.league_quizzes ENABLE ROW LEVEL SECURITY;

-- Anyone can read attachments for public leagues; owners always can
CREATE POLICY "league_quizzes read public or owner" ON public.league_quizzes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.leagues l
      WHERE l.id = league_id
        AND (l.visibility = 'public' OR l.owner_id = auth.uid())
    )
  );

-- Only the league owner (and must be authorized host) may write attachments
CREATE POLICY "league_quizzes owner write" ON public.league_quizzes
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = league_id AND l.owner_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = league_id AND l.owner_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = quiz_id AND q.owner_id = auth.uid())
  );

-- Restrict writes to authorized hosts (matches quizzes pattern)
CREATE POLICY "league_quizzes host only write" ON public.league_quizzes
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

-- Allow anon to read public leagues (for future public league browsing)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='leagues' AND policyname='leagues read public') THEN
    CREATE POLICY "leagues read public" ON public.leagues
      FOR SELECT USING (visibility = 'public' OR owner_id = auth.uid());
  END IF;
END $$;

-- Validate state transitions
CREATE OR REPLACE FUNCTION public.tg_leagues_validate_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF (OLD.status = 'draft' AND NEW.status IN ('registration_open','active'))
     OR (OLD.status = 'registration_open' AND NEW.status IN ('active','draft'))
     OR (OLD.status = 'active' AND NEW.status = 'completed')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid league status transition: % -> %', OLD.status, NEW.status;
END; $$;

CREATE TRIGGER leagues_validate_transition
  BEFORE UPDATE OF status ON public.leagues
  FOR EACH ROW EXECUTE FUNCTION public.tg_leagues_validate_transition();
