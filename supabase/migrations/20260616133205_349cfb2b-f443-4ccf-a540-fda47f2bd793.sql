
-- Profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT 'Host',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT ON public.profiles TO anon;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles read all" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles update own" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "profiles insert own" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1), 'Host'));
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Quizzes
CREATE TABLE public.quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  time_per_question int NOT NULL DEFAULT 20,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quizzes TO authenticated;
GRANT SELECT ON public.quizzes TO anon;
GRANT ALL ON public.quizzes TO service_role;
ALTER TABLE public.quizzes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quizzes read all" ON public.quizzes FOR SELECT USING (true);
CREATE POLICY "quizzes manage own" ON public.quizzes FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- Questions
CREATE TABLE public.questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  text text NOT NULL,
  options jsonb NOT NULL,
  correct_index int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_quiz_idx ON public.questions(quiz_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.questions TO authenticated;
GRANT SELECT ON public.questions TO anon;
GRANT ALL ON public.questions TO service_role;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "questions read all" ON public.questions FOR SELECT USING (true);
CREATE POLICY "questions manage by owner" ON public.questions FOR ALL
  USING (EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = quiz_id AND q.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = quiz_id AND q.owner_id = auth.uid()));

-- Leagues
CREATE TABLE public.leagues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  season text DEFAULT 'Season 1',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leagues TO authenticated;
GRANT SELECT ON public.leagues TO anon;
GRANT ALL ON public.leagues TO service_role;
ALTER TABLE public.leagues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leagues read all" ON public.leagues FOR SELECT USING (true);
CREATE POLICY "leagues manage own" ON public.leagues FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- Sessions
CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  host_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  league_id uuid REFERENCES public.leagues(id) ON DELETE SET NULL,
  code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'lobby', -- lobby | active | question_results | ended
  current_question_index int NOT NULL DEFAULT -1,
  current_question_started_at timestamptz,
  team_mode boolean NOT NULL DEFAULT false,
  question_order jsonb,  -- array of question ids in shuffled order (optional)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_code_idx ON public.sessions(code);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT SELECT, UPDATE ON public.sessions TO anon;
GRANT ALL ON public.sessions TO service_role;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sessions read all" ON public.sessions FOR SELECT USING (true);
CREATE POLICY "sessions host manage" ON public.sessions FOR ALL USING (auth.uid() = host_id) WITH CHECK (auth.uid() = host_id);
CREATE POLICY "sessions anon insert blocked" ON public.sessions FOR INSERT TO anon WITH CHECK (false);

-- Teams
CREATE TABLE public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#CCFF00',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams TO authenticated;
GRANT SELECT ON public.teams TO anon;
GRANT ALL ON public.teams TO service_role;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams read all" ON public.teams FOR SELECT USING (true);
CREATE POLICY "teams host manage" ON public.teams FOR ALL
  USING (EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND s.host_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND s.host_id = auth.uid()));

-- Participants (anonymous)
CREATE TABLE public.participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  nickname text NOT NULL,
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  score int NOT NULL DEFAULT 0,
  streak int NOT NULL DEFAULT 0,
  secret_token text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, nickname)
);
CREATE INDEX participants_session_idx ON public.participants(session_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.participants TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.participants TO anon;
GRANT ALL ON public.participants TO service_role;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "participants read all" ON public.participants FOR SELECT USING (true);
CREATE POLICY "participants insert open" ON public.participants FOR INSERT WITH CHECK (true);
CREATE POLICY "participants update open" ON public.participants FOR UPDATE USING (true) WITH CHECK (true);

-- Answers
CREATE TABLE public.answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES public.participants(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  selected_index int NOT NULL,
  is_correct boolean NOT NULL,
  response_ms int NOT NULL,
  points int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, question_id)
);
CREATE INDEX answers_session_idx ON public.answers(session_id);
GRANT SELECT, INSERT ON public.answers TO authenticated;
GRANT SELECT, INSERT ON public.answers TO anon;
GRANT ALL ON public.answers TO service_role;
ALTER TABLE public.answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "answers read all" ON public.answers FOR SELECT USING (true);
CREATE POLICY "answers insert open" ON public.answers FOR INSERT WITH CHECK (true);

-- League standings (aggregated)
CREATE TABLE public.league_standings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  nickname text NOT NULL,
  total_points int NOT NULL DEFAULT 0,
  sessions_played int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, nickname)
);
CREATE INDEX league_standings_idx ON public.league_standings(league_id, total_points DESC);
GRANT SELECT, INSERT, UPDATE ON public.league_standings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.league_standings TO anon;
GRANT ALL ON public.league_standings TO service_role;
ALTER TABLE public.league_standings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "standings read all" ON public.league_standings FOR SELECT USING (true);
CREATE POLICY "standings upsert open" ON public.league_standings FOR INSERT WITH CHECK (true);
CREATE POLICY "standings update open" ON public.league_standings FOR UPDATE USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.participants;
ALTER PUBLICATION supabase_realtime ADD TABLE public.answers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.teams;
