ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS reveal_stages integer;

ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_question_type_check;
ALTER TABLE public.questions ADD CONSTRAINT questions_question_type_check
  CHECK (question_type IN ('mcq','true_false','text','number','geo','feedback','image_reveal','audio','image_mcq','map_pin','type'));

CREATE OR REPLACE FUNCTION public.get_session_questions(p_session_id uuid)
 RETURNS TABLE(q_id uuid, q_quiz_id uuid, q_text text, q_options jsonb, q_position integer, q_time_limit_sec integer, q_point_value integer, q_question_type text, q_image_url text, q_double_points boolean, q_max_distance_km numeric, q_number_min numeric, q_number_max numeric, q_reveal_stages integer, q_audio_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
    SELECT q.id, q.quiz_id, q.text, q.options, q.position, q.time_limit_sec, q.point_value,
           q.question_type, q.image_url, q.double_points,
           q.max_distance_km, q.number_min, q.number_max, q.reveal_stages, q.audio_url
      FROM public.questions q JOIN public.sessions s ON s.quiz_id = q.quiz_id
     WHERE s.id = p_session_id ORDER BY q.position;
END; $function$;