REVOKE EXECUTE ON FUNCTION public.submit_arena_run(uuid, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.submit_host_request(text, host_request_purpose, host_request_size, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.has_active_host_authorization(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_authorized_host() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_session_host(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.tg_sync_competition_from_session() FROM anon, authenticated;