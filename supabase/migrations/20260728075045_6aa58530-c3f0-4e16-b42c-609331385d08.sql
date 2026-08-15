
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_id text;
ALTER TABLE public.participants ADD COLUMN IF NOT EXISTS avatar_id text;

CREATE OR REPLACE FUNCTION public.join_session(p_code text, p_nickname text, p_team_id uuid DEFAULT NULL::uuid, p_avatar_id text DEFAULT NULL::text)
 RETURNS TABLE(participant_id uuid, secret_token text, session_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session_id uuid;
  v_status text;
  v_token text;
  v_pid uuid;
  v_nick text;
  v_profile uuid;
  v_avatar text;
begin
  v_nick := trim(coalesce(p_nickname, ''));
  if length(v_nick) < 2 or length(v_nick) > 32 then
    raise exception 'Nickname must be 2-32 chars';
  end if;

  select id, status into v_session_id, v_status from public.sessions where code = p_code;
  if v_session_id is null then raise exception 'Session not found'; end if;
  if v_status <> 'lobby' then raise exception 'Session is not accepting joins'; end if;

  v_token := gen_random_uuid()::text || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);

  v_profile := NULL;
  v_avatar := nullif(trim(coalesce(p_avatar_id, '')), '');
  IF auth.uid() IS NOT NULL THEN
    SELECT id, coalesce(v_avatar, avatar_id) INTO v_profile, v_avatar FROM public.profiles WHERE id = auth.uid();
  END IF;

  insert into public.participants(session_id, nickname, team_id, profile_id, avatar_id)
    values (v_session_id, v_nick, p_team_id, v_profile, v_avatar)
    returning id into v_pid;

  insert into public.participant_secrets(participant_id, secret_token)
    values (v_pid, v_token);

  return query select v_pid, v_token, v_session_id;
end; $function$;
