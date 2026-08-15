
-- ============ Host authorization system ============

CREATE TYPE public.host_auth_type AS ENUM ('single','bundle','time');
CREATE TYPE public.host_auth_status AS ENUM ('active','expired','revoked','consumed');

CREATE TABLE public.host_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  authorization_type public.host_auth_type NOT NULL,
  remaining_sessions INT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  status public.host_auth_status NOT NULL DEFAULT 'active',
  granted_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_host_auth_profile ON public.host_authorizations(profile_id, status);

GRANT SELECT ON public.host_authorizations TO authenticated;
GRANT ALL ON public.host_authorizations TO service_role;

ALTER TABLE public.host_authorizations ENABLE ROW LEVEL SECURITY;

-- Users can read their own authorizations
CREATE POLICY "Users read own host authorizations"
  ON public.host_authorizations FOR SELECT
  TO authenticated
  USING (profile_id = auth.uid() OR public.is_authorized_host());

-- Only platform admin (is_authorized_host = the hardcoded admin email) can write
CREATE POLICY "Admin manages host authorizations"
  ON public.host_authorizations FOR ALL
  TO authenticated
  USING (public.is_authorized_host())
  WITH CHECK (public.is_authorized_host());

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER host_auth_updated_at BEFORE UPDATE ON public.host_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ Helpers ============

-- Auto-expire time-based authorizations on read
CREATE OR REPLACE FUNCTION public.has_active_host_authorization(p_user UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.host_authorizations
    WHERE profile_id = p_user
      AND status = 'active'
      AND (starts_at IS NULL OR starts_at <= now())
      AND (
        (authorization_type = 'time' AND (expires_at IS NULL OR expires_at > now()))
        OR (authorization_type IN ('single','bundle') AND COALESCE(remaining_sessions,0) > 0)
      )
  );
END; $$;

-- Called from BEFORE INSERT trigger on sessions.
-- Admin bypasses. Others must have active authorization; credits are consumed here.
CREATE OR REPLACE FUNCTION public.enforce_host_authorization()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.host_authorizations%ROWTYPE; v_admin_email TEXT;
BEGIN
  -- Admin bypass (matches is_authorized_host())
  SELECT lower(email) INTO v_admin_email FROM auth.users WHERE id = NEW.host_id;
  IF v_admin_email = 'mubirueltonfelix@gmail.com' THEN
    RETURN NEW;
  END IF;

  -- Pick best active authorization: prefer time-based, else the one expiring soonest / least credits
  SELECT * INTO v_row FROM public.host_authorizations
   WHERE profile_id = NEW.host_id
     AND status = 'active'
     AND (starts_at IS NULL OR starts_at <= now())
     AND (
       (authorization_type = 'time' AND (expires_at IS NULL OR expires_at > now()))
       OR (authorization_type IN ('single','bundle') AND COALESCE(remaining_sessions,0) > 0)
     )
   ORDER BY
     CASE WHEN authorization_type = 'time' THEN 0 ELSE 1 END,
     COALESCE(remaining_sessions, 999999) ASC,
     created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hosting not authorized. Contact the administrator.' USING ERRCODE = '42501';
  END IF;

  IF v_row.authorization_type IN ('single','bundle') THEN
    UPDATE public.host_authorizations
       SET remaining_sessions = GREATEST(COALESCE(remaining_sessions,0) - 1, 0),
           status = CASE
             WHEN COALESCE(remaining_sessions,0) - 1 <= 0 THEN 'consumed'::public.host_auth_status
             ELSE status
           END
     WHERE id = v_row.id;
  END IF;

  RETURN NEW;
END; $$;

CREATE TRIGGER enforce_host_authorization_trg
  BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_host_authorization();

-- ============ Admin RPCs ============

CREATE OR REPLACE FUNCTION public.admin_list_users(p_search TEXT DEFAULT NULL)
RETURNS TABLE(id UUID, email TEXT, display_name TEXT, created_at TIMESTAMPTZ,
              auth_id UUID, authorization_type public.host_auth_type,
              remaining_sessions INT, expires_at TIMESTAMPTZ,
              status public.host_auth_status, is_active BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  SELECT u.id, u.email::text, p.display_name, u.created_at,
         h.id, h.authorization_type, h.remaining_sessions, h.expires_at, h.status,
         (h.status = 'active'
           AND (h.authorization_type = 'time' AND (h.expires_at IS NULL OR h.expires_at > now())
                OR h.authorization_type IN ('single','bundle') AND COALESCE(h.remaining_sessions,0) > 0))
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    LEFT JOIN LATERAL (
      SELECT * FROM public.host_authorizations ha
       WHERE ha.profile_id = u.id
       ORDER BY (ha.status='active') DESC, ha.created_at DESC LIMIT 1
    ) h ON true
   WHERE p_search IS NULL OR p_search = ''
      OR u.email ILIKE '%'||p_search||'%'
      OR COALESCE(p.display_name,'') ILIKE '%'||p_search||'%'
   ORDER BY u.created_at DESC
   LIMIT 500;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_grant_host_authorization(
  p_profile_id UUID,
  p_type public.host_auth_type,
  p_sessions INT DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;

  -- Revoke any existing active authorizations first
  UPDATE public.host_authorizations SET status='revoked'
    WHERE profile_id = p_profile_id AND status='active';

  INSERT INTO public.host_authorizations(profile_id, authorization_type, remaining_sessions, expires_at, granted_by, notes)
  VALUES (
    p_profile_id, p_type,
    CASE WHEN p_type = 'single' THEN 1
         WHEN p_type = 'bundle' THEN COALESCE(p_sessions, 1)
         ELSE NULL END,
    CASE WHEN p_type = 'time' THEN p_expires_at ELSE NULL END,
    auth.uid(), p_notes
  ) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_revoke_host_authorization(p_auth_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.host_authorizations SET status='revoked' WHERE id = p_auth_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_extend_host_authorization(
  p_auth_id UUID,
  p_add_sessions INT DEFAULT NULL,
  p_new_expires_at TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.host_authorizations
     SET remaining_sessions = CASE
           WHEN authorization_type IN ('single','bundle') AND p_add_sessions IS NOT NULL
             THEN COALESCE(remaining_sessions,0) + p_add_sessions
           ELSE remaining_sessions END,
         expires_at = CASE
           WHEN authorization_type = 'time' AND p_new_expires_at IS NOT NULL
             THEN p_new_expires_at
           ELSE expires_at END,
         status = 'active'
   WHERE id = p_auth_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_convert_host_authorization(
  p_auth_id UUID,
  p_type public.host_auth_type,
  p_sessions INT DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.host_authorizations
     SET authorization_type = p_type,
         remaining_sessions = CASE
           WHEN p_type = 'single' THEN 1
           WHEN p_type = 'bundle' THEN COALESCE(p_sessions,1)
           ELSE NULL END,
         expires_at = CASE WHEN p_type = 'time' THEN p_expires_at ELSE NULL END,
         status = 'active'
   WHERE id = p_auth_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_host_stats()
RETURNS TABLE(active_hosts INT, expiring_soon INT, single_hosts INT, bundle_hosts INT, time_hosts INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  SELECT
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active'),
    (SELECT count(*)::int FROM public.host_authorizations
      WHERE status='active' AND authorization_type='time'
        AND expires_at IS NOT NULL AND expires_at > now() AND expires_at < now() + interval '7 days'),
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active' AND authorization_type='single'),
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active' AND authorization_type='bundle'),
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active' AND authorization_type='time');
END; $$;

GRANT EXECUTE ON FUNCTION public.has_active_host_authorization(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_host_authorization(UUID, public.host_auth_type, INT, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_host_authorization(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_extend_host_authorization(UUID, INT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_convert_host_authorization(UUID, public.host_auth_type, INT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_host_stats() TO authenticated;
