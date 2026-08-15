ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS time_limit_sec integer,
  ADD COLUMN IF NOT EXISTS point_value integer NOT NULL DEFAULT 1000;