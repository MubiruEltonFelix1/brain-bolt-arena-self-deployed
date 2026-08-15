CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT now();
$$;

GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated, service_role;