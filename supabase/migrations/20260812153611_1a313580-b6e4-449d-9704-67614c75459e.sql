-- Phase 7C: Role & Grant consolidation
-- Step 1: repoint every ADMIN-INTENT call site from is_authorized_host() to is_admin().
-- These are behaviour-identical today (is_authorized_host() currently == is_admin()).

-- 1a. Policies
DROP POLICY IF EXISTS "Admin can view all competitions" ON public.competitions;
CREATE POLICY "Admin can view all competitions" ON public.competitions
  FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS "Admin manages host authorizations" ON public.host_authorizations;
CREATE POLICY "Admin manages host authorizations" ON public.host_authorizations
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Users read own host authorizations" ON public.host_authorizations;
CREATE POLICY "Users read own host authorizations" ON public.host_authorizations
  FOR SELECT USING (profile_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "admin update requests" ON public.host_requests;
CREATE POLICY "admin update requests" ON public.host_requests
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "own requests read" ON public.host_requests;
CREATE POLICY "own requests read" ON public.host_requests
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());

-- duplicate policy cleanup (identical predicate, kept one)
DROP POLICY IF EXISTS "Users can read their own roles" ON public.user_roles;

-- 1b. Admin-gated RPCs: swap the gate, keep bodies otherwise untouched.
CREATE OR REPLACE FUNCTION public.admin_approve_host_request(p_request_id uuid, p_authorization_type public.host_auth_type, p_sessions integer DEFAULT NULL::integer, p_days integer DEFAULT NULL::integer, p_notes text DEFAULT NULL::text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_user uuid; v_auth uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT user_id INTO v_user FROM public.host_requests WHERE id = p_request_id;
  IF v_user IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_auth := public.admin_grant_host_authorization(v_user, p_authorization_type, p_sessions, p_days, p_notes);
  UPDATE public.host_requests
     SET status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
   WHERE id = p_request_id;
  RETURN v_auth;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_reject_host_request(p_request_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.host_requests
     SET status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid()
   WHERE id = p_request_id;
END; $function$;

-- Step 2: unify the transitional host predicate.
-- admin role OR host role OR active (non-expired, non-revoked, quota-remaining) grant.
CREATE OR REPLACE FUNCTION public.is_authorized_host()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND (
       public.has_role(auth.uid(), 'admin')
       OR public.has_role(auth.uid(), 'host')
       OR public.has_active_host_authorization(auth.uid())
     );
$function$;