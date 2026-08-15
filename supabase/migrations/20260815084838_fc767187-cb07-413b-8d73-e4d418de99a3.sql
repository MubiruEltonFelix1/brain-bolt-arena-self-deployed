-- 1. New ownership column
ALTER TABLE public.branding_profiles
  ADD COLUMN IF NOT EXISTS owner_principal_id uuid REFERENCES public.principals(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS branding_profiles_owner_principal_id_idx
  ON public.branding_profiles (owner_principal_id);

-- 2. Backfill (identity copy: user principals share the auth user id)
UPDATE public.branding_profiles b
SET owner_principal_id = p.id
FROM public.principals p
WHERE p.type = 'user'
  AND p.user_id = b.owner_id
  AND b.owner_principal_id IS DISTINCT FROM p.id;

-- 3. Drift protection: always derive owner_principal_id from owner_id
CREATE OR REPLACE FUNCTION public.tg_branding_sync_owner_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

DROP TRIGGER IF EXISTS branding_sync_owner_principal_trg ON public.branding_profiles;
CREATE TRIGGER branding_sync_owner_principal_trg
BEFORE INSERT OR UPDATE OF owner_id, owner_principal_id ON public.branding_profiles
FOR EACH ROW EXECUTE FUNCTION public.tg_branding_sync_owner_principal();

-- 4. Capability resolver: branding ownership via principal (legacy fallback kept)
CREATE OR REPLACE FUNCTION public.can(p_principal uuid, p_action text, p_resource uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    SELECT EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = p_resource AND q.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'competition.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.competitions c WHERE c.id = p_resource AND c.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'league.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = p_resource AND l.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'branding.manage' THEN
    -- Phase 7H: principal-aware, with legacy owner_id fallback during transition
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
$function$;

-- 5. RLS cutover to principal ownership (public read preserved)
DROP POLICY IF EXISTS "Owner can insert own branding" ON public.branding_profiles;
DROP POLICY IF EXISTS "Owner can update own branding" ON public.branding_profiles;
DROP POLICY IF EXISTS "Owner can delete own branding" ON public.branding_profiles;

CREATE POLICY "Owner can insert own branding"
ON public.branding_profiles FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = owner_id
  AND public.can('branding.create')
);

CREATE POLICY "Owner can update own branding"
ON public.branding_profiles FOR UPDATE TO authenticated
USING (owner_principal_id = public.current_principal_id())
WITH CHECK (owner_principal_id = public.current_principal_id());

CREATE POLICY "Owner can delete own branding"
ON public.branding_profiles FOR DELETE TO authenticated
USING (owner_principal_id = public.current_principal_id());