
create or replace function public.get_arena_quiz_detail(p_quiz_id uuid)
returns table(
  id uuid,
  title text,
  description text,
  difficulty text,
  estimated_duration_minutes integer,
  play_count integer,
  time_per_question integer,
  created_at timestamptz,
  last_updated timestamptz,
  question_count integer,
  avg_accuracy numeric,
  creator_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    q.id,
    q.title,
    q.description,
    q.difficulty,
    q.estimated_duration_minutes,
    q.play_count,
    q.time_per_question,
    q.created_at,
    greatest(q.created_at, coalesce((select max(qq.created_at) from questions qq where qq.quiz_id = q.id), q.created_at)) as last_updated,
    (select count(*)::int from questions qq where qq.quiz_id = q.id) as question_count,
    (select round(avg(cr.accuracy_percentage), 1) from competition_results cr where cr.quiz_id = q.id) as avg_accuracy,
    (select p.display_name from profiles p where p.id = q.owner_id) as creator_name
  from quizzes q
  where q.id = p_quiz_id
    and q.is_arena = true
    and q.archived_at is null
$$;

grant execute on function public.get_arena_quiz_detail(uuid) to anon, authenticated;

create or replace function public.get_arena_questions(p_quiz_id uuid)
returns table(
  q_id uuid,
  q_position integer,
  q_text text,
  q_options jsonb,
  q_correct_index integer,
  q_time_limit_sec integer,
  q_point_value integer,
  q_question_type text,
  q_image_url text,
  q_audio_url text,
  q_double_points boolean,
  q_reveal_stages integer,
  q_correct_lat numeric,
  q_correct_lng numeric,
  q_max_distance_km numeric,
  q_correct_number numeric,
  q_number_min numeric,
  q_number_max numeric,
  q_number_tolerance numeric,
  q_accepted_answers text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    qq.id, qq.position, qq.text, qq.options, qq.correct_index, qq.time_limit_sec,
    qq.point_value, qq.question_type, qq.image_url, qq.audio_url, qq.double_points,
    qq.reveal_stages, qq.correct_lat, qq.correct_lng, qq.max_distance_km,
    qq.correct_number, qq.number_min, qq.number_max, qq.number_tolerance, qq.accepted_answers
  from questions qq
  join quizzes q on q.id = qq.quiz_id
  where qq.quiz_id = p_quiz_id
    and q.is_arena = true
    and q.archived_at is null
    and qq.question_type <> 'feedback'
  order by qq.position asc
$$;

grant execute on function public.get_arena_questions(uuid) to anon, authenticated;
