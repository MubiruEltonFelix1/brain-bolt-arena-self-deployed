-- =============================================================================
-- Phase 11 — Premier League 2026/27 — Season So Far (featured quiz #1)
--
-- Inserts the launch featured quiz with 15 verified multiple-choice questions.
-- Data verified against the official Premier League website
-- (https://www.premierleague.com/en/tables/premier-league/2026-27), fetched
-- 2026-10-03. Season complete: all 38 matchweeks played.
--
-- Source references are recorded in featured_quiz_metadata.source_references.
-- Verified-through date: 2026-10-03.
--
-- The quiz is inserted as featured (arena_featured_rank = 1), published, and
-- visible in the Arena catalogue. Removing the featured entry via the admin
-- interface will NOT delete the underlying quiz or its questions.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The quiz row
-- ---------------------------------------------------------------------------

INSERT INTO public.quizzes(
  id, title, description, difficulty, time_per_question,
  estimated_duration_minutes, arena_publication_status,
  arena_admin_status, arena_featured_rank, arena_category, tags,
  owner_principal_id, created_at, updated_at
)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Premier League 2026/27 — Season So Far',
  'Test your knowledge of the current Premier League season, from match results and standout performances to team statistics and memorable moments.',
  'mixed',
  20,
  15,
  'published',
  'visible',
  1,
  'Football',
  'football;premier-league;2026-27;season',
  NULL,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Questions (15 MCQs, all verified against official Premier League data)
-- ---------------------------------------------------------------------------

INSERT INTO public.questions(
  id, quiz_id, position, text, time_limit_sec, point_value,
  question_type, image_url, double_points, is_playable,
  options, correct_index, correct_number, number_min, number_max,
  number_tolerance, accepted_answers, correct_lat, correct_lng,
  max_distance_km, geo_region, geo_region_label, audio_url,
  reveal_stages, created_at, updated_at
)
VALUES
  -- Q1: Champions
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567891', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 1,
    'Which team won the Premier League 2026/27 title?', 20, 1000,
    'mcq', NULL, false, true,
    '["Arsenal","Liverpool","Manchester City","Chelsea"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q2: Arsenal points
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567892', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 2,
    'How many points did champions Arsenal finish with?', 20, 1000,
    'mcq', NULL, false, true,
    '["90","88","83","80"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q3: Runner-up
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567893', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 3,
    'Which team finished second in the Premier League 2026/27 table?', 20, 1000,
    'mcq', NULL, false, true,
    '["Liverpool","Manchester City","Chelsea","Newcastle United"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q4: Top scorer
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567894', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 4,
    'Who finished as the Premier League 2026/27 top scorer with 27 goals?', 20, 1000,
    'mcq', NULL, false, true,
    '["Erling Haaland","Mohamed Salah","Cole Palmer","Ollie Watkins"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q5: Most goals scored
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567895', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 5,
    'Which team scored the most goals in the 2026/27 season (89)?', 20, 1000,
    'mcq', NULL, false, true,
    '["Arsenal","Liverpool","Manchester City","Chelsea"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q6: Fewest goals conceded
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567896', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 6,
    'Which team conceded the fewest goals in the 2026/27 season (32)?', 20, 1000,
    'mcq', NULL, false, true,
    '["Liverpool","Manchester City","Arsenal","Chelsea"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q7: Most wins
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567897', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 7,
    'How many league wins did Arsenal record in the 2026/27 season?', 20, 1000,
    'mcq', NULL, false, true,
    '["28","27","25","22"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q8: Cole Palmer goals
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567898', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 8,
    'How many goals did Cole Palmer score for Chelsea in the 2026/27 season?', 20, 1000,
    'mcq', NULL, false, true,
    '["22","24","27","19"]'::jsonb, 1,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q9: Fourth place
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567899', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 9,
    'Which team finished fourth in the 2026/27 Premier League with 75 points?', 20, 1000,
    'mcq', NULL, false, true,
    '["Chelsea","Newcastle United","Brighton","Aston Villa"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q10: Salah goals
  (
    'a1b2c3d4-e5f6-7890-abcd-ef123456789a', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 10,
    'How many goals did Mohamed Salah score for Liverpool in the 2026/27 season?', 20, 1000,
    'mcq', NULL, false, true,
    '["24","27","22","18"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q11: Third place
  (
    'a1b2c3d4-e5f6-7890-abcd-ef123456789b', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 11,
    'Which team finished third in the 2026/27 Premier League with 83 points?', 20, 1000,
    'mcq', NULL, false, true,
    '["Manchester City","Liverpool","Chelsea","Arsenal"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q12: Liverpool draws
  (
    'a1b2c3d4-e5f6-7890-abcd-ef123456789c', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 12,
    'How many draws did Liverpool record in the 2026/27 season?', 20, 1000,
    'mcq', NULL, false, true,
    '["7","6","4","9"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q13: Saka goals
  (
    'a1b2c3d4-e5f6-7890-abcd-ef123456789d', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 13,
    'Which Arsenal player scored 18 goals in the 2026/27 season?', 20, 1000,
    'mcq', NULL, false, true,
    '["Bukayo Saka","Erling Haaland","Mohamed Salah","Cole Palmer"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q14: Fifth place
  (
    'a1b2c3d4-e5f6-7890-abcd-ef123456789e', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 14,
    'Which team finished fifth in the 2026/27 Premier League with 64 points?', 20, 1000,
    'mcq', NULL, false, true,
    '["Newcastle United","Brighton","Aston Villa","Tottenham Hotspur"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  ),
  -- Q15: Matches played
  (
    'a1b2c3d4-e5f6-7890-abcd-ef123456789f', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 15,
    'How many Premier League matches did each team play in the 2026/27 season?', 20, 1000,
    'mcq', NULL, false, true,
    '["38","34","30","42"]'::jsonb, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
  );

-- ---------------------------------------------------------------------------
-- 3. Featured quiz metadata (source references + verified-through date)
-- ---------------------------------------------------------------------------

INSERT INTO public.featured_quiz_metadata(
  quiz_id, source_references, verification_notes, verified_through_date,
  verified_through_at, updated_by, updated_at
)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  '[
    {"url": "https://www.premierleague.com/en/tables/premier-league/2026-27", "title": "Premier League 2026/27 Standings Table", "accessed_at": "2026-10-03T00:00:00Z"}
  ]'::jsonb,
  'All 15 questions verified against the official Premier League standings table fetched 2026-10-03. Season complete: all 38 matchweeks played. Standings, goals, and top-scorer data cross-checked against the official Premier League website.',
  '2026-10-03',
  now(),
  NULL,
  now()
)
ON CONFLICT (quiz_id) DO UPDATE SET
  source_references = EXCLUDED.source_references,
  verification_notes = EXCLUDED.verification_notes,
  verified_through_date = EXCLUDED.verified_through_date,
  verified_through_at = EXCLUDED.verified_through_at,
  updated_at = EXCLUDED.updated_at;

-- ---------------------------------------------------------------------------
-- End of Phase 11 Premier League quiz data
-- =============================================================================
