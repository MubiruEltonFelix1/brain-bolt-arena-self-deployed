
CREATE OR REPLACE FUNCTION public.is_authorized_host()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid()
      AND lower(u.email) = 'mubirueltonfelix@gmail.com'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_authorized_host() TO authenticated, anon;

DROP POLICY IF EXISTS "quizzes host only write" ON public.quizzes;
CREATE POLICY "quizzes host only write" ON public.quizzes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host())
  WITH CHECK (public.is_authorized_host());

DROP POLICY IF EXISTS "questions host only write" ON public.questions;
CREATE POLICY "questions host only write" ON public.questions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host())
  WITH CHECK (public.is_authorized_host());

DROP POLICY IF EXISTS "sessions host only write" ON public.sessions;
CREATE POLICY "sessions host only write" ON public.sessions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host())
  WITH CHECK (public.is_authorized_host());

DROP POLICY IF EXISTS "leagues host only write" ON public.leagues;
CREATE POLICY "leagues host only write" ON public.leagues
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host())
  WITH CHECK (public.is_authorized_host());
