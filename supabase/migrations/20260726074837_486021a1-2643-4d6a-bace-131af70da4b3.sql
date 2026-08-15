CREATE OR REPLACE FUNCTION public.record_competition_results()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total INTEGER;
BEGIN
  IF NEW.status = 'ended' AND (OLD.status IS DISTINCT FROM 'ended') THEN
    SELECT count(*) INTO v_total FROM public.participants WHERE session_id = NEW.id;

    INSERT INTO public.competition_results(
      profile_id, session_id, quiz_id, final_score, final_rank,
      total_participants, accuracy_percentage, completed_at
    )
    SELECT
      p.profile_id,
      NEW.id,
      NEW.quiz_id,
      p.score,
      ranked.rnk,
      v_total,
      COALESCE(acc.accuracy, 0),
      now()
    FROM public.participants p
    JOIN (
      SELECT id, rank() OVER (ORDER BY score DESC, joined_at ASC) AS rnk
      FROM public.participants WHERE session_id = NEW.id
    ) ranked ON ranked.id = p.id
    LEFT JOIN LATERAL (
      SELECT ROUND(
        (count(*) FILTER (WHERE a.is_correct))::numeric
        / NULLIF(count(*) FILTER (WHERE q.question_type <> 'feedback'), 0) * 100,
        2
      ) AS accuracy
      FROM public.answers a
      JOIN public.questions q ON q.id = a.question_id
      WHERE a.participant_id = p.id
    ) acc ON true
    WHERE p.session_id = NEW.id
      AND p.profile_id IS NOT NULL
    ON CONFLICT (profile_id, session_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;