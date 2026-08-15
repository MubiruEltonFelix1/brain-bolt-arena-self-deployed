
DO $$ BEGIN
  CREATE TYPE public.host_request_status AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.host_request_purpose AS ENUM ('university','company','association','community','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.host_request_size AS ENUM ('1-25','26-50','51-100');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.host_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization TEXT NOT NULL,
  purpose public.host_request_purpose NOT NULL,
  expected_participants public.host_request_size NOT NULL,
  message TEXT,
  status public.host_request_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS host_requests_one_open_per_user
  ON public.host_requests(user_id) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON public.host_requests TO authenticated;
GRANT ALL ON public.host_requests TO service_role;

ALTER TABLE public.host_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own requests read" ON public.host_requests;
CREATE POLICY "own requests read" ON public.host_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_authorized_host());

DROP POLICY IF EXISTS "own requests insert" ON public.host_requests;
CREATE POLICY "own requests insert" ON public.host_requests
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "admin update requests" ON public.host_requests;
CREATE POLICY "admin update requests" ON public.host_requests
  FOR UPDATE TO authenticated
  USING (public.is_authorized_host()) WITH CHECK (public.is_authorized_host());

CREATE OR REPLACE FUNCTION public.submit_host_request(
  p_organization TEXT,
  p_purpose public.host_request_purpose,
  p_expected public.host_request_size,
  p_message TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID; v_id UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM public.host_requests WHERE user_id = v_uid AND status = 'pending') THEN
    RAISE EXCEPTION 'You already have a pending hosting request';
  END IF;
  IF public.has_active_host_authorization(v_uid) THEN
    RAISE EXCEPTION 'Your hosting access is already active';
  END IF;
  INSERT INTO public.host_requests(user_id, organization, purpose, expected_participants, message)
  VALUES (v_uid, btrim(p_organization), p_purpose, p_expected, NULLIF(btrim(p_message),''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.admin_list_host_requests(p_status public.host_request_status DEFAULT NULL)
RETURNS TABLE(
  id UUID, user_id UUID, email TEXT, display_name TEXT,
  organization TEXT, purpose public.host_request_purpose,
  expected_participants public.host_request_size, message TEXT,
  status public.host_request_status, created_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
    SELECT r.id, r.user_id, u.email::text, p.display_name,
           r.organization, r.purpose, r.expected_participants, r.message,
           r.status, r.created_at, r.reviewed_at
    FROM public.host_requests r
    JOIN auth.users u ON u.id = r.user_id
    LEFT JOIN public.profiles p ON p.id = r.user_id
    WHERE p_status IS NULL OR r.status = p_status
    ORDER BY (r.status = 'pending') DESC, r.created_at DESC
    LIMIT 500;
END $$;

CREATE OR REPLACE FUNCTION public.admin_approve_host_request(p_request_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID; v_auth_id UUID;
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT user_id INTO v_uid FROM public.host_requests WHERE id = p_request_id;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;

  UPDATE public.host_authorizations SET status='revoked'
    WHERE profile_id = v_uid AND status='active';

  INSERT INTO public.host_authorizations(profile_id, authorization_type, expires_at, granted_by, notes)
  VALUES (v_uid, 'time', now() + interval '90 days', auth.uid(), 'Approved via host request')
  RETURNING id INTO v_auth_id;

  UPDATE public.host_requests
    SET status='approved', reviewed_at=now(), reviewed_by=auth.uid()
    WHERE id = p_request_id;
  RETURN v_auth_id;
END $$;

CREATE OR REPLACE FUNCTION public.admin_reject_host_request(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_authorized_host() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.host_requests
    SET status='rejected', reviewed_at=now(), reviewed_by=auth.uid()
    WHERE id = p_request_id;
END $$;
