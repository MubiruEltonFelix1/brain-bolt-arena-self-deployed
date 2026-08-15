CREATE OR REPLACE FUNCTION public.submit_answer(p_participant_id uuid, p_secret_token text, p_question_id uuid, p_selected_index integer, p_response_ms integer)
 RETURNS TABLE(is_correct boolean, points integer, new_score integer, new_streak integer, correct_index integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session_id uuid;
  v_quiz_id uuid;
  v_old_score int;
  v_old_streak int;
  v_status text;
  v_current_idx int;
  v_order jsonb;
  v_quiz_default int;
  v_expected_qid uuid;
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

  select s.status, s.current_question_index, s.question_order, s.quiz_id, q.time_per_question
    into v_status, v_current_idx, v_order, v_quiz_id, v_quiz_default
    from public.sessions s join public.quizzes q on q.id = s.quiz_id
    where s.id = v_session_id;
  if v_status <> 'active' then raise exception 'Session not active'; end if;
  if v_current_idx is null or v_current_idx < 0 then
    raise exception 'Not the current question';
  end if;

  -- Resolve the expected question id at the current index, falling back to
  -- the quiz's question list ordered by position when no explicit order is set.
  if v_order is not null and jsonb_typeof(v_order) = 'array' and jsonb_array_length(v_order) > v_current_idx then
    v_expected_qid := (v_order ->> v_current_idx)::uuid;
  else
    select id into v_expected_qid
      from public.questions
      where quiz_id = v_quiz_id
      order by position
      offset v_current_idx limit 1;
  end if;

  if v_expected_qid is null or v_expected_qid <> p_question_id then
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
end; $function$;