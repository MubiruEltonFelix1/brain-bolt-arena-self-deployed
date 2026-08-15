-- Phase 7D: centralized capability resolver.
-- Transitional signature: principal is a user id today, a Principal id later.

CREATE OR REPLACE FUNCTION public.can(p_principal uuid, p_action text, p_resource uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_admin boolean;
  v_host boolean;
  v_owner boolean := false;
BEGIN
  IF p_principal IS NULL THEN
    RETURN false;
  END IF;

  v_admin := public.has_role(p_principal, 'admin');

  -- Administrative capabilities require administrative authority only.
  IF p_action LIKE 'admin.%' THEN
    RETURN v_admin;
  END IF;

  -- Host capability = admin role OR host role OR active grant (Phase 7C definition).
  v_host := v_admin
         OR public.has_role(p_principal, 'host')
         OR public.has_active_host_authorization(p_principal);

  -- Creation capabilities: host capability only, no resource.
  IF p_action IN ('quiz.create','competition.create','league.create','branding.create','session.host') THEN
    RETURN v_host;
  END IF;

  -- Resource capabilities: ownership is explicit and separate from role.
  IF p_resource IS NULL THEN
    RETURN false;
  END IF;

  IF p_action IN ('quiz.edit','quiz.delete') THEN
    SELECT EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = p_resource AND q.owner_id = p_principal) INTO v_owner;
  ELSIF p_action = 'competition.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.competitions c WHERE c.id = p_resource AND c.owner_id = p_principal) INTO v_owner;
  ELSIF p_action = 'league.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = p_resource AND l.owner_id = p_principal) INTO v_owner;
  ELSIF p_action = 'branding.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.branding_profiles b WHERE b.id = p_resource AND b.owner_id = p_principal) INTO v_owner;
  ELSIF p_action = 'session.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = p_resource AND s.host_id = p_principal) INTO v_owner;
  ELSE
    RETURN false; -- unknown capability denies
  END IF;

  RETURN v_owner AND v_host;
END;
$function$;

-- Caller-identity overload: never trusts a supplied principal.
CREATE OR REPLACE FUNCTION public.can(p_action text, p_resource uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.can(auth.uid(), p_action, p_resource);
$function$;

REVOKE ALL ON FUNCTION public.can(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can(uuid, text, uuid) TO service_role;

-- Representative RLS migration: branding profile write policies only.
DROP POLICY IF EXISTS "Owner can insert own branding" ON public.branding_profiles;
CREATE POLICY "Owner can insert own branding"
ON public.branding_profiles FOR INSERT TO authenticated
WITH CHECK (auth.uid() = owner_id AND public.can('branding.create'));

DROP POLICY IF EXISTS "Owner can update own branding" ON public.branding_profiles;
CREATE POLICY "Owner can update own branding"
ON public.branding_profiles FOR UPDATE TO authenticated
USING (auth.uid() = owner_id)
WITH CHECK (auth.uid() = owner_id);
