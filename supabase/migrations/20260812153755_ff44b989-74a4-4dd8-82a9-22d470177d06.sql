CREATE OR REPLACE FUNCTION public.admin_grant_host_authorization(p_profile_id uuid, p_type host_auth_type, p_sessions integer DEFAULT NULL::integer, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id UUID;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;

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
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_revoke_host_authorization(p_auth_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.host_authorizations SET status='revoked' WHERE id = p_auth_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_extend_host_authorization(p_auth_id uuid, p_add_sessions integer DEFAULT NULL::integer, p_new_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
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
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_convert_host_authorization(p_auth_id uuid, p_type host_auth_type, p_sessions integer DEFAULT NULL::integer, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.host_authorizations
     SET authorization_type = p_type,
         remaining_sessions = CASE
           WHEN p_type = 'single' THEN 1
           WHEN p_type = 'bundle' THEN COALESCE(p_sessions,1)
           ELSE NULL END,
         expires_at = CASE WHEN p_type = 'time' THEN p_expires_at ELSE NULL END,
         status = 'active'
   WHERE id = p_auth_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_host_stats()
 RETURNS TABLE(active_hosts integer, expiring_soon integer, single_hosts integer, bundle_hosts integer, time_hosts integer)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  SELECT
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active'),
    (SELECT count(*)::int FROM public.host_authorizations
      WHERE status='active' AND authorization_type='time'
        AND expires_at IS NOT NULL AND expires_at > now() AND expires_at < now() + interval '7 days'),
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active' AND authorization_type='single'),
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active' AND authorization_type='bundle'),
    (SELECT count(*)::int FROM public.host_authorizations WHERE status='active' AND authorization_type='time');
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_list_host_requests(p_status host_request_status DEFAULT NULL::host_request_status)
 RETURNS TABLE(id uuid, user_id uuid, email text, display_name text, organization text, purpose host_request_purpose, expected_participants host_request_size, message text, status host_request_status, created_at timestamp with time zone, reviewed_at timestamp with time zone)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.admin_list_users(p_search text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, email text, display_name text, created_at timestamp with time zone, auth_id uuid, authorization_type host_auth_type, remaining_sessions integer, expires_at timestamp with time zone, status host_auth_status, is_active boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
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
END; $function$;

CREATE OR REPLACE FUNCTION public.can_view_league(p_league_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id
      AND (l.visibility = 'public' OR l.owner_id = auth.uid() OR public.is_admin())
  );
$function$;

CREATE OR REPLACE FUNCTION public.list_due_competitions()
 RETURNS TABLE(id uuid, title text, scheduled_start_at timestamp with time zone, lobby_opens_at timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT c.id, c.title, c.scheduled_start_at,
         c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds)
    FROM public.competitions c
   WHERE c.status = 'scheduled'
     AND c.session_id IS NULL
     AND c.scheduled_start_at IS NOT NULL
     AND now() >= c.scheduled_start_at - make_interval(secs => c.lobby_duration_seconds)
     AND (c.owner_id = auth.uid() OR public.is_admin())
   ORDER BY c.scheduled_start_at;
$function$;

CREATE OR REPLACE FUNCTION public.prepare_competition_session(p_competition_id uuid, p_force boolean DEFAULT false)
 RETURNS TABLE(session_id uuid, code text, status competition_status, created boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.competitions WHERE id = p_competition_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Competition not found'; END IF;
  IF NOT (v_owner = auth.uid() OR public.is_admin()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT * FROM public.prepare_competition_session_internal(p_competition_id, p_force);
END; $function$;