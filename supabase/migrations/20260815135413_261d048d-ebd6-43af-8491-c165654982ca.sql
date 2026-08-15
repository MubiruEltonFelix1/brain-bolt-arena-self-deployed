-- 1. Column
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS owner_principal_id uuid REFERENCES public.principals(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_quizzes_owner_principal_id ON public.quizzes(owner_principal_id);

-- 2. Backfill (identity mapping via user principals)
UPDATE public.quizzes q
SET owner_principal_id = p.id
FROM public.principals p
WHERE p.type = 'user' AND p.user_id = q.owner_id AND q.owner_principal_id IS DISTINCT FROM p.id;

-- 3. Drift protection
CREATE OR REPLACE FUNCTION public.tg_quizzes_sync_owner_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_principal uuid;
BEGIN
  SELECT p.id INTO v_principal
  FROM public.principals p
  WHERE p.type = 'user' AND p.user_id = NEW.owner_id;

  IF v_principal IS NULL THEN
    RAISE EXCEPTION 'No user principal exists for owner_id %', NEW.owner_id;
  END IF;

  NEW.owner_principal_id := v_principal;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quizzes_sync_owner_principal_trg ON public.quizzes;
CREATE TRIGGER quizzes_sync_owner_principal_trg
BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id ON public.quizzes
FOR EACH ROW EXECUTE FUNCTION public.tg_quizzes_sync_owner_principal();

-- 4. Quiz ownership policy (principal-first, legacy fallback). Public read + host restrictive policies untouched.
DROP POLICY IF EXISTS "quizzes manage own" ON public.quizzes;
CREATE POLICY "quizzes manage own" ON public.quizzes
FOR ALL
USING (
  owner_principal_id = public.principal_for_user(auth.uid())
  OR (owner_principal_id IS NULL AND auth.uid() = owner_id)
)
WITH CHECK (auth.uid() = owner_id);

-- 5. Questions inherit quiz ownership (no own ownership column)
DROP POLICY IF EXISTS "questions manage by owner" ON public.questions;
CREATE POLICY "questions manage by owner" ON public.questions
FOR ALL
USING (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = questions.quiz_id
    AND (q.owner_principal_id = public.principal_for_user(auth.uid())
         OR (q.owner_principal_id IS NULL AND q.owner_id = auth.uid()))
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = questions.quiz_id
    AND (q.owner_principal_id = public.principal_for_user(auth.uid())
         OR (q.owner_principal_id IS NULL AND q.owner_id = auth.uid()))
));

DROP POLICY IF EXISTS "questions owner read" ON public.questions;
CREATE POLICY "questions owner read" ON public.questions
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.quizzes q
  WHERE q.id = questions.quiz_id
    AND (q.owner_principal_id = public.principal_for_user(auth.uid())
         OR (q.owner_principal_id IS NULL AND q.owner_id = auth.uid()))
));

-- 6. Capability layer: quiz ownership branch only
CREATE OR REPLACE FUNCTION public.can(p_principal uuid, p_action text, p_resource uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user  uuid;
  v_admin boolean;
  v_host  boolean;
  v_owner boolean := false;
BEGIN
  IF p_principal IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.user_id INTO v_user
  FROM public.principals p
  WHERE p.type = 'user' AND (p.id = p_principal OR p.user_id = p_principal)
  LIMIT 1;

  IF v_user IS NULL THEN
    v_user := p_principal;
  END IF;

  v_admin := public.has_role(v_user, 'admin');

  IF p_action LIKE 'admin.%' THEN
    RETURN v_admin;
  END IF;

  v_host := v_admin
         OR public.has_role(v_user, 'host')
         OR public.has_active_host_authorization(v_user);

  IF p_action IN ('quiz.create','competition.create','league.create','branding.create','session.host') THEN
    RETURN v_host;
  END IF;

  IF p_resource IS NULL THEN
    RETURN false;
  END IF;

  IF p_action IN ('quiz.edit','quiz.delete') THEN
    -- Phase 7J: principal-aware, with legacy owner_id fallback during transition
    SELECT EXISTS (
      SELECT 1 FROM public.quizzes q
      WHERE q.id = p_resource
        AND (
          q.owner_principal_id = public.principal_for_user(v_user)
          OR (q.owner_principal_id IS NULL AND q.owner_id = v_user)
        )
    ) INTO v_owner;
  ELSIF p_action = 'competition.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.competitions c WHERE c.id = p_resource AND c.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'league.manage' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.leagues l
      WHERE l.id = p_resource
        AND (
          l.owner_principal_id = public.principal_for_user(v_user)
          OR (l.owner_principal_id IS NULL AND l.owner_id = v_user)
        )
    ) INTO v_owner;
  ELSIF p_action = 'branding.manage' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.branding_profiles b
      WHERE b.id = p_resource
        AND (
          b.owner_principal_id = public.principal_for_user(v_user)
          OR (b.owner_principal_id IS NULL AND b.owner_id = v_user)
        )
    ) INTO v_owner;
  ELSIF p_action = 'session.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = p_resource AND s.host_id = v_user) INTO v_owner;
  ELSE
    RETURN false;
  END IF;

  RETURN v_owner AND v_host;
END;
$$;