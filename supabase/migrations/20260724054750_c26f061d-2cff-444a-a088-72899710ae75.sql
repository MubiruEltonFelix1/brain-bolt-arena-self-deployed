
CREATE TYPE public.competition_mode AS ENUM ('hosted','arena','scheduled');
CREATE TYPE public.competition_status AS ENUM ('draft','scheduled','lobby_open','running','completed','cancelled');
CREATE TYPE public.competition_visibility AS ENUM ('private','unlisted','public');

CREATE TABLE public.competitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quiz_id UUID NOT NULL REFERENCES public.quizzes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  mode public.competition_mode NOT NULL DEFAULT 'scheduled',
  status public.competition_status NOT NULL DEFAULT 'draft',
  visibility public.competition_visibility NOT NULL DEFAULT 'private',
  scheduled_start_at TIMESTAMPTZ,
  lobby_duration_seconds INTEGER NOT NULL DEFAULT 300 CHECK (lobby_duration_seconds BETWEEN 30 AND 3600),
  session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  league_id UUID REFERENCES public.leagues(id) ON DELETE SET NULL,
  branding_profile_id UUID REFERENCES public.branding_profiles(id) ON DELETE SET NULL,
  max_participants INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX competitions_owner_idx ON public.competitions(owner_id);
CREATE INDEX competitions_status_start_idx ON public.competitions(status, scheduled_start_at);
CREATE INDEX competitions_public_upcoming_idx ON public.competitions(scheduled_start_at)
  WHERE visibility = 'public' AND status IN ('scheduled','lobby_open','running');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitions TO authenticated;
GRANT SELECT ON public.competitions TO anon;
GRANT ALL ON public.competitions TO service_role;

ALTER TABLE public.competitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their competitions"
  ON public.competitions FOR ALL TO authenticated
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Admin can view all competitions"
  ON public.competitions FOR SELECT TO authenticated
  USING (public.is_authorized_host());

CREATE POLICY "Public competitions are viewable"
  ON public.competitions FOR SELECT TO anon, authenticated
  USING (visibility = 'public' AND status IN ('scheduled','lobby_open','running','completed'));

CREATE TRIGGER competitions_set_updated_at
  BEFORE UPDATE ON public.competitions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
