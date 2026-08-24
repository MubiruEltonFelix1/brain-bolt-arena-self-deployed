-- Phase 8E: Geo region grading for map_pin questions.
--
-- Adds an optional region polygon to a question. When `geo_region` is set,
-- any click inside the region scores full marks; a click outside scores
-- partial credit scaled by distance to the region border. Point-radius
-- grading (correct_lat/correct_lng + max_distance_km) remains the fallback
-- for questions without a region, so existing questions are untouched.
--
-- Coordinate convention: `geo_region` is a GeoJSON geometry ("Polygon" or
-- "MultiPolygon") with [lng, lat] coordinate order, exactly as emitted by
-- src/lib/geo/country-regions.ts. The TS helpers in
-- src/lib/question-registry.ts (pointInRegion, regionBorderKm) must stay
-- behaviorally identical to geo_point_in_region / geo_region_border_km.

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS geo_region jsonb,
  ADD COLUMN IF NOT EXISTS geo_region_label text;

-- ---------------------------------------------------------------------------
-- Geo helpers (pure, no PostGIS)
-- ---------------------------------------------------------------------------

-- Even-odd ray casting over a single ring (GeoJSON [lng, lat] vertices).
CREATE OR REPLACE FUNCTION public.geo_ring_contains(
  p_lat numeric, p_lng numeric, p_ring jsonb
)
 RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
DECLARE
  n int; k int; j int;
  lat numeric; lng numeric; jlat numeric; jlng numeric;
  inside boolean := false;
BEGIN
  n := jsonb_array_length(p_ring);
  IF n < 3 THEN RETURN false; END IF;
  j := n - 1;
  FOR k IN 0 .. n - 1 LOOP
    lat := ((p_ring -> k -> 1)::text)::numeric;
    lng := ((p_ring -> k -> 0)::text)::numeric;
    jlat := ((p_ring -> j -> 1)::text)::numeric;
    jlng := ((p_ring -> j -> 0)::text)::numeric;
    IF ((lng > p_lng) <> (jlng > p_lng)) AND
       (p_lat < (jlat - lat) * (p_lng - lng) / (jlng - lng) + lat) THEN
      inside := NOT inside;
    END IF;
    j := k;
  END LOOP;
  RETURN inside;
END; $function$;

-- Point-in-region: exterior ring counts as inside; any hole containing the
-- point flips it to outside (matters for e.g. South Africa / Lesotho).
CREATE OR REPLACE FUNCTION public.geo_point_in_region(
  p_lat numeric, p_lng numeric, p_region jsonb
)
 RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
DECLARE
  v_type text; v_polys jsonb; v_coords jsonb; v_ring jsonb;
  r int; c int; n int;
  v_in_hole boolean;
BEGIN
  IF p_region IS NULL THEN RETURN false; END IF;
  v_type := p_region ->> 'type';
  IF v_type = 'Polygon' THEN
    v_polys := jsonb_build_array(p_region -> 'coordinates');
  ELSIF v_type = 'MultiPolygon' THEN
    v_polys := p_region -> 'coordinates';
  ELSE
    RETURN false;
  END IF;
  FOR r IN 0 .. jsonb_array_length(v_polys) - 1 LOOP
    v_coords := v_polys -> r;
    n := jsonb_array_length(v_coords);
    IF n = 0 THEN CONTINUE; END IF;
    -- Exterior ring (index 0)
    IF NOT public.geo_ring_contains(p_lat, p_lng, v_coords -> 0) THEN
      CONTINUE;
    END IF;
    -- Holes
    v_in_hole := false;
    FOR c IN 1 .. n - 1 LOOP
      IF public.geo_ring_contains(p_lat, p_lng, v_coords -> c) THEN
        v_in_hole := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_in_hole THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END; $function$;

-- Distance to the nearest region border segment. Each ring edge is projected
-- into an equirectangular plane around the click latitude, the click is
-- clamped onto the segment, converted back and measured with haversine —
-- a faithful point-to-segment distance at these latitudes/scales.
CREATE OR REPLACE FUNCTION public.geo_region_border_km(
  p_lat numeric, p_lng numeric, p_region jsonb
)
 RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
DECLARE
  v_type text; v_polys jsonb; v_coords jsonb; v_ring jsonb;
  v_cos numeric := GREATEST(cos(radians(p_lat)), 1e-6);
  v_px numeric := p_lng * v_cos;
  v_py numeric := p_lat;
  v_min numeric := NULL;
  v_d numeric;
  r int; c int; k int; n int;
  ax numeric; ay numeric; bx numeric; ey numeric;
  dx numeric; dy numeric; denom numeric; t numeric;
  cx numeric; cy numeric;
BEGIN
  IF p_region IS NULL THEN RETURN NULL; END IF;
  v_type := p_region ->> 'type';
  IF v_type = 'Polygon' THEN
    v_polys := jsonb_build_array(p_region -> 'coordinates');
  ELSIF v_type = 'MultiPolygon' THEN
    v_polys := p_region -> 'coordinates';
  ELSE
    RETURN NULL;
  END IF;
  FOR r IN 0 .. jsonb_array_length(v_polys) - 1 LOOP
    v_coords := v_polys -> r;
    FOR c IN 0 .. jsonb_array_length(v_coords) - 1 LOOP
      v_ring := v_coords -> c;
      n := jsonb_array_length(v_ring);
      IF n < 2 THEN CONTINUE; END IF;
      ax := ((v_ring -> 0 -> 0)::text)::numeric * v_cos;
      ay := ((v_ring -> 0 -> 1)::text)::numeric;
      FOR k IN 1 .. n - 1 LOOP
        bx := ((v_ring -> k -> 0)::text)::numeric * v_cos;
        ey := ((v_ring -> k -> 1)::text)::numeric;
        dx := bx - ax;
        dy := ey - ay;
        denom := dx * dx + dy * dy;
        t := 0;
        IF denom > 0 THEN
          t := LEAST(1, GREATEST(0, ((v_px - ax) * dx + (v_py - ay) * dy) / denom));
        END IF;
        cx := ax + t * dx;
        cy := ay + t * dy;
        v_d := public.haversine_km(p_lat, p_lng, cy, cx / v_cos);
        IF v_min IS NULL OR v_d < v_min THEN v_min := v_d; END IF;
        ax := bx;
        ay := ey;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN v_min;
END; $function$;

-- ---------------------------------------------------------------------------
-- submit_geo_answer: region-aware grading (live play)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_geo_answer(
  p_participant_id uuid, p_secret_token text, p_question_id uuid,
  p_lat numeric, p_lng numeric, p_response_ms integer
)
 RETURNS TABLE(accepted boolean, distance_km numeric, points integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session_id uuid; v_quiz_id uuid; v_status text; v_order jsonb;
  v_idx int; v_revealed boolean; v_expected_qid uuid;
  v_lat numeric; v_lng numeric; v_max_km numeric;
  v_region jsonb;
  v_point_value int; v_time_limit_sec int; v_time_limit_ms int;
  v_double boolean; v_quiz_default int; v_resp int;
  v_dist numeric; v_correctness numeric; v_speed_ratio numeric;
  v_border numeric; v_inside boolean := false;
  v_total int; v_is_correct boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.participant_secrets
    WHERE participant_id = p_participant_id AND secret_token = p_secret_token) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT p.session_id INTO v_session_id
    FROM public.participants p WHERE p.id = p_participant_id FOR UPDATE;
  IF v_session_id IS NULL THEN RAISE EXCEPTION 'Participant not found'; END IF;

  SELECT s.status, s.question_order, s.current_question_index, s.current_question_revealed, s.quiz_id, q.time_per_question
    INTO v_status, v_order, v_idx, v_revealed, v_quiz_id, v_quiz_default
  FROM public.sessions s JOIN public.quizzes q ON q.id = s.quiz_id
  WHERE s.id = v_session_id;

  IF v_status <> 'active' THEN RAISE EXCEPTION 'Session not active'; END IF;
  IF v_revealed THEN RAISE EXCEPTION 'Round already closed'; END IF;

  IF v_order IS NULL OR jsonb_typeof(v_order) <> 'array' OR jsonb_array_length(v_order) = 0 THEN
    SELECT jsonb_agg(q.id ORDER BY q.position) INTO v_order
      FROM public.questions q WHERE q.quiz_id = v_quiz_id;
    UPDATE public.sessions SET question_order = v_order WHERE id = v_session_id;
  END IF;

  IF v_idx < 0 OR v_idx >= jsonb_array_length(v_order) THEN RAISE EXCEPTION 'No active question'; END IF;
  v_expected_qid := (v_order ->> v_idx)::uuid;
  IF v_expected_qid <> p_question_id THEN RAISE EXCEPTION 'Not the current question'; END IF;

  IF EXISTS (SELECT 1 FROM public.answers a
    WHERE a.participant_id = p_participant_id AND a.question_id = p_question_id) THEN
    RAISE EXCEPTION 'Already answered';
  END IF;

  SELECT q.correct_lat, q.correct_lng, COALESCE(q.max_distance_km, 5000),
         q.geo_region,
         COALESCE(q.point_value, 1000),
         COALESCE(q.time_limit_sec, v_quiz_default, 30),
         COALESCE(q.double_points, false)
    INTO v_lat, v_lng, v_max_km, v_region, v_point_value, v_time_limit_sec, v_double
    FROM public.questions q WHERE q.id = p_question_id AND q.quiz_id = v_quiz_id;
  IF v_lat IS NULL OR v_lng IS NULL THEN RAISE EXCEPTION 'Not a map question'; END IF;

  v_time_limit_ms := GREATEST(v_time_limit_sec, 1) * 1000;
  v_resp := GREATEST(0, LEAST(COALESCE(p_response_ms, 0), v_time_limit_ms));
  v_dist := public.haversine_km(v_lat, v_lng, p_lat, p_lng);
  IF v_region IS NOT NULL THEN
    -- Region mode: inside = full marks; outside = falloff by border distance.
    v_inside := public.geo_point_in_region(p_lat, p_lng, v_region);
    IF v_inside THEN
      v_correctness := 1;
      v_border := 0;
    ELSE
      v_border := public.geo_region_border_km(p_lat, p_lng, v_region);
      v_correctness := GREATEST(0, 1 - COALESCE(v_border, 0) / GREATEST(v_max_km, 1));
    END IF;
    -- In region mode distance_km means "distance from the border" (0 = inside).
    v_dist := v_border;
  ELSE
    v_correctness := GREATEST(0, 1 - v_dist / GREATEST(v_max_km, 1));
  END IF;
  v_speed_ratio := 1.0 - v_resp::numeric / v_time_limit_ms;
  v_total := ROUND(v_point_value * v_correctness * (0.5 + 0.5 * v_speed_ratio));
  IF v_double THEN v_total := v_total * 2; END IF;
  v_is_correct := v_correctness >= 0.9;

  INSERT INTO public.answers(session_id, participant_id, question_id, selected_index, is_correct, response_ms, points, answer_value)
  VALUES (v_session_id, p_participant_id, p_question_id, -1, v_is_correct, v_resp, v_total,
          jsonb_build_object('lat', p_lat, 'lng', p_lng, 'distance_km', v_dist,
                             'inside_region', v_inside, 'border_distance_km', v_border));

  UPDATE public.participants SET score = score + v_total,
    streak = CASE WHEN v_is_correct THEN streak + 1 ELSE 0 END
    WHERE id = p_participant_id;

  RETURN QUERY SELECT true, v_dist, v_total;
END; $function$;

-- ---------------------------------------------------------------------------
-- evaluate_question_answer: region-aware grading (Arena runs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_question_answer(
  p_question_id uuid, p_answer jsonb, p_response_ms int, p_streak int)
RETURNS TABLE(is_correct boolean, correctness numeric, points int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q public.questions%ROWTYPE; v_limit_ms int; v_default int;
  v_c numeric := 0; v_ok boolean := false; v_graded boolean := false;
  v_tol numeric; v_norm text; v_arr jsonb; v_n int; v_hit int := 0; i int;
BEGIN
  SELECT * INTO q FROM public.questions WHERE id = p_question_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT time_per_question INTO v_default FROM public.quizzes WHERE id = q.quiz_id;
  v_limit_ms := GREATEST(COALESCE(q.time_limit_sec, v_default, 20), 1) * 1000;

  IF q.question_type = 'feedback' THEN
    RETURN QUERY SELECT false, 0::numeric, 0; RETURN;
  ELSIF q.question_type = 'ordering' THEN
    v_graded := true;
    v_arr := COALESCE(p_answer -> 'order', '[]'::jsonb);
    v_n := jsonb_array_length(COALESCE(q.options, '[]'::jsonb));
    IF v_n > 0 AND jsonb_array_length(v_arr) = v_n THEN
      FOR i IN 0..v_n-1 LOOP
        IF (v_arr ->> i)::int = i THEN v_hit := v_hit + 1; END IF;
      END LOOP;
      v_c := v_hit::numeric / v_n;
    END IF;
    v_ok := v_c >= 1;
  ELSIF (q.geo_region IS NOT NULL
         OR (q.correct_lat IS NOT NULL AND q.correct_lng IS NOT NULL))
        AND p_answer ? 'lat' AND p_answer ? 'lng' THEN
    v_graded := true;
    IF q.geo_region IS NOT NULL THEN
      -- Region mode: inside = full marks; outside = falloff by border distance.
      IF public.geo_point_in_region(
           (p_answer ->> 'lat')::numeric, (p_answer ->> 'lng')::numeric, q.geo_region) THEN
        v_c := 1;
      ELSE
        v_c := GREATEST(0, 1 - COALESCE(public.geo_region_border_km(
                 (p_answer ->> 'lat')::numeric, (p_answer ->> 'lng')::numeric, q.geo_region), 0)
               / GREATEST(COALESCE(q.max_distance_km, 5000), 1));
      END IF;
    ELSE
      v_c := GREATEST(0, 1 - public.haversine_km(
               q.correct_lat, q.correct_lng,
               (p_answer ->> 'lat')::numeric, (p_answer ->> 'lng')::numeric)
             / GREATEST(COALESCE(q.max_distance_km, 5000), 1));
    END IF;
    v_ok := v_c >= 0.9;
  ELSIF q.correct_number IS NOT NULL AND p_answer ? 'value' THEN
    v_graded := true;
    v_tol := q.number_tolerance;
    IF v_tol IS NULL OR v_tol <= 0 THEN
      v_tol := GREATEST(ABS(COALESCE(q.number_max, q.correct_number)
                          - COALESCE(q.number_min, q.correct_number)) * 0.25, 1);
    END IF;
    v_c := GREATEST(0, 1 - ABS((p_answer ->> 'value')::numeric - q.correct_number) / v_tol);
    v_ok := v_c >= 0.9;
  ELSIF q.accepted_answers IS NOT NULL AND array_length(q.accepted_answers, 1) > 0 THEN
    v_norm := public.normalize_text_answer(p_answer ->> 'text');
    v_ok := v_norm <> '' AND EXISTS (
      SELECT 1 FROM unnest(q.accepted_answers) a(val)
       WHERE public.normalize_text_answer(a.val) = v_norm);
    v_c := CASE WHEN v_ok THEN 1 ELSE 0 END;
  ELSE
    v_ok := (p_answer ->> 'selected_index') IS NOT NULL
            AND (p_answer ->> 'selected_index')::int = q.correct_index;
    v_c := CASE WHEN v_ok THEN 1 ELSE 0 END;
  END IF;

  RETURN QUERY SELECT v_ok, v_c,
    public.score_answer(COALESCE(q.point_value, 1000), p_response_ms, v_limit_ms,
                        p_streak, v_c, COALESCE(q.double_points, false), v_graded);
END; $$;

-- ---------------------------------------------------------------------------
-- get_my_round_result: expose the region to the player reveal (answer-safe:
-- only after the round is revealed)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_my_round_result(uuid, text, uuid);
CREATE OR REPLACE FUNCTION public.get_my_round_result(
  p_participant_id uuid, p_secret_token text, p_question_id uuid
)
RETURNS TABLE(
  answered boolean, selected_index integer, is_correct boolean, points integer,
  correct_index integer, total_score integer, answer_value jsonb,
  correct_lat numeric, correct_lng numeric, correct_number numeric,
  correct_text text, text_submission text,
  geo_region jsonb, geo_region_label text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session_id uuid; v_revealed boolean; v_status text;
        v_correct int; v_score int;
        v_lat numeric; v_lng numeric; v_num numeric;
        v_accepted text[]; v_correct_text text;
        v_region jsonb; v_region_label text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.participant_secrets
    WHERE participant_id = p_participant_id AND secret_token = p_secret_token) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  SELECT p.session_id, p.score INTO v_session_id, v_score
    FROM public.participants p WHERE p.id = p_participant_id;
  SELECT s.current_question_revealed, s.status INTO v_revealed, v_status
    FROM public.sessions s WHERE s.id = v_session_id;
  IF NOT (COALESCE(v_revealed,false) OR v_status = 'ended') THEN
    RAISE EXCEPTION 'Round not revealed yet';
  END IF;
  SELECT q.correct_index, q.correct_lat, q.correct_lng, q.correct_number, q.accepted_answers,
         q.geo_region, q.geo_region_label
    INTO v_correct, v_lat, v_lng, v_num, v_accepted, v_region, v_region_label
    FROM public.questions q WHERE q.id = p_question_id;
  v_correct_text := CASE WHEN v_accepted IS NOT NULL AND array_length(v_accepted,1) > 0
                         THEN v_accepted[1] ELSE NULL END;
  RETURN QUERY
    SELECT (a.id IS NOT NULL), a.selected_index, a.is_correct, a.points,
           v_correct, v_score, a.answer_value, v_lat, v_lng, v_num,
           v_correct_text, a.text_submission,
           v_region, v_region_label
      FROM (SELECT 1) d
      LEFT JOIN public.answers a
        ON a.participant_id = p_participant_id AND a.question_id = p_question_id;
END; $$;

-- ---------------------------------------------------------------------------
-- get_arena_questions: expose region to the Arena client (preview grading +
-- reveal label)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_arena_questions(uuid);
CREATE OR REPLACE FUNCTION public.get_arena_questions(p_quiz_id uuid)
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
  q_accepted_answers text[],
  q_geo_region jsonb,
  q_geo_region_label text
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
    qq.correct_number, qq.number_min, qq.number_max, qq.number_tolerance, qq.accepted_answers,
    qq.geo_region, qq.geo_region_label
  from questions qq
  join quizzes q on q.id = qq.quiz_id
  where qq.quiz_id = p_quiz_id
    and q.is_arena = true
    and q.archived_at is null
    and qq.question_type <> 'feedback'
  order by qq.position asc
$$;

grant execute on function public.get_arena_questions(uuid) to anon, authenticated;
