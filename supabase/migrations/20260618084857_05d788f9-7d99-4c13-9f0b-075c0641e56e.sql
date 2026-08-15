
create table if not exists public.participant_secrets (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  secret_token text not null unique,
  created_at timestamptz not null default now()
);

insert into public.participant_secrets (participant_id, secret_token)
  select id, secret_token from public.participants where secret_token is not null
on conflict (participant_id) do nothing;

alter table public.participants drop column if exists secret_token;

alter table public.participant_secrets enable row level security;
revoke all on public.participant_secrets from anon, authenticated;
grant all on public.participant_secrets to service_role;

drop policy if exists "participants insert open" on public.participants;
drop policy if exists "participants update open" on public.participants;
drop policy if exists "participants read all"    on public.participants;

create policy "participants public read"
  on public.participants for select using (true);

create policy "participants host update"
  on public.participants for update to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.host_id = auth.uid()))
  with check (exists (select 1 from public.sessions s where s.id = session_id and s.host_id = auth.uid()));

drop policy if exists "answers insert open" on public.answers;
drop policy if exists "answers read all"    on public.answers;

create policy "answers public read"
  on public.answers for select using (true);

drop policy if exists "standings upsert open" on public.league_standings;
drop policy if exists "standings update open" on public.league_standings;
drop policy if exists "standings read all"    on public.league_standings;

create policy "standings public read"
  on public.league_standings for select using (true);

create policy "standings owner insert"
  on public.league_standings for insert to authenticated
  with check (exists (select 1 from public.leagues l where l.id = league_id and l.owner_id = auth.uid()));

create policy "standings owner update"
  on public.league_standings for update to authenticated
  using (exists (select 1 from public.leagues l where l.id = league_id and l.owner_id = auth.uid()))
  with check (exists (select 1 from public.leagues l where l.id = league_id and l.owner_id = auth.uid()));

drop policy if exists "questions read all" on public.questions;

create policy "questions owner read"
  on public.questions for select to authenticated
  using (exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid()));

create or replace function public.get_session_questions(p_session_id uuid)
returns table (
  q_id uuid,
  q_quiz_id uuid,
  q_text text,
  q_options jsonb,
  q_position int,
  q_time_limit_sec int,
  q_point_value int
)
language plpgsql security definer set search_path = public
as $$
begin
  return query
    select q.id, q.quiz_id, q.text, q.options, q.position, q.time_limit_sec, q.point_value
    from public.questions q
    join public.sessions s on s.quiz_id = q.quiz_id
    where s.id = p_session_id
    order by q.position;
end; $$;
grant execute on function public.get_session_questions(uuid) to anon, authenticated;

create or replace function public.get_session_answer_key(p_session_id uuid)
returns table (question_id uuid, correct_index int)
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.sessions where id = p_session_id and status = 'ended') then
    raise exception 'Answer key not available until session ends';
  end if;
  return query
    select q.id, q.correct_index
    from public.questions q
    join public.sessions s on s.quiz_id = q.quiz_id
    where s.id = p_session_id;
end; $$;
grant execute on function public.get_session_answer_key(uuid) to anon, authenticated;

create or replace function public.join_session(
  p_code text,
  p_nickname text,
  p_team_id uuid default null
)
returns table (participant_id uuid, secret_token text, session_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  v_session_id uuid;
  v_status text;
  v_token text;
  v_pid uuid;
  v_nick text;
begin
  v_nick := trim(coalesce(p_nickname, ''));
  if length(v_nick) < 2 or length(v_nick) > 32 then
    raise exception 'Nickname must be 2-32 chars';
  end if;

  select id, status into v_session_id, v_status from public.sessions where code = p_code;
  if v_session_id is null then raise exception 'Session not found'; end if;
  if v_status <> 'lobby' then raise exception 'Session is not accepting joins'; end if;

  v_token := gen_random_uuid()::text || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);

  insert into public.participants(session_id, nickname, team_id)
    values (v_session_id, v_nick, p_team_id)
    returning id into v_pid;

  insert into public.participant_secrets(participant_id, secret_token)
    values (v_pid, v_token);

  return query select v_pid, v_token, v_session_id;
end; $$;
grant execute on function public.join_session(text, text, uuid) to anon, authenticated;

create or replace function public.submit_answer(
  p_participant_id uuid,
  p_secret_token text,
  p_question_id uuid,
  p_selected_index int,
  p_response_ms int
)
returns table (
  is_correct boolean,
  points int,
  new_score int,
  new_streak int,
  correct_index int
)
language plpgsql security definer set search_path = public
as $$
declare
  v_session_id uuid;
  v_old_score int;
  v_old_streak int;
  v_status text;
  v_current_idx int;
  v_order jsonb;
  v_quiz_default int;
  v_correct int;
  v_point_value int;
  v_time_limit_sec int;
  v_time_limit_ms int;
  v_is_correct boolean;
  v_base int;
  v_speed int;
  v_subtotal int;
  v_streak_mult numeric;
  v_total int;
  v_new_streak int;
  v_resp int;
begin
  if not exists (
    select 1 from public.participant_secrets where participant_id = p_participant_id and secret_token = p_secret_token
  ) then
    raise exception 'Unauthorized';
  end if;

  select session_id, score, streak into v_session_id, v_old_score, v_old_streak
    from public.participants where id = p_participant_id;

  select s.status, s.current_question_index, s.question_order, q.time_per_question
    into v_status, v_current_idx, v_order, v_quiz_default
    from public.sessions s join public.quizzes q on q.id = s.quiz_id
    where s.id = v_session_id;
  if v_status <> 'active' then raise exception 'Session not active'; end if;
  if v_order is null or v_current_idx < 0
     or (v_order ->> v_current_idx)::uuid <> p_question_id then
    raise exception 'Not the current question';
  end if;

  if exists (
    select 1 from public.answers where participant_id = p_participant_id and question_id = p_question_id
  ) then
    raise exception 'Already answered';
  end if;

  select correct_index, point_value, coalesce(time_limit_sec, v_quiz_default)
    into v_correct, v_point_value, v_time_limit_sec
    from public.questions where id = p_question_id;

  v_time_limit_ms := greatest(v_time_limit_sec, 1) * 1000;
  v_resp := greatest(0, least(p_response_ms, v_time_limit_ms));
  v_is_correct := (p_selected_index = v_correct);

  if v_is_correct then
    v_base := round(v_point_value * 0.5);
    v_speed := round(v_point_value * 0.5 * (1.0 - v_resp::numeric / v_time_limit_ms));
    v_subtotal := v_base + v_speed;
    v_streak_mult := 1 + least(v_old_streak, 5) * 0.1;
    v_total := round(v_subtotal * v_streak_mult);
    v_new_streak := v_old_streak + 1;
  else
    v_total := 0;
    v_new_streak := 0;
  end if;

  insert into public.answers (session_id, participant_id, question_id, selected_index, is_correct, response_ms, points)
    values (v_session_id, p_participant_id, p_question_id, p_selected_index, v_is_correct, v_resp, v_total);

  update public.participants
    set score = v_old_score + v_total, streak = v_new_streak
    where id = p_participant_id;

  return query select v_is_correct, v_total, v_old_score + v_total, v_new_streak, v_correct;
end; $$;
grant execute on function public.submit_answer(uuid, text, uuid, int, int) to anon, authenticated;
