
DROP POLICY IF EXISTS "quizzes host only write" ON public.quizzes;
DROP POLICY IF EXISTS "questions host only write" ON public.questions;
DROP POLICY IF EXISTS "sessions host only write" ON public.sessions;
DROP POLICY IF EXISTS "leagues host only write" ON public.leagues;

CREATE POLICY "quizzes host only write" ON public.quizzes AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "questions host only write" ON public.questions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "sessions host only write" ON public.sessions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));

CREATE POLICY "leagues host only write" ON public.leagues AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()))
  WITH CHECK (public.is_authorized_host() OR public.has_active_host_authorization(auth.uid()));
