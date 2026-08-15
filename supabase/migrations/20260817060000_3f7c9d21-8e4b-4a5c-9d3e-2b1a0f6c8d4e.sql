-- Phase 8B: MCP write idempotency keys.
--
-- MCP write tools (save_quiz, update_quiz, add_questions, update_question,
-- remove_question, reorder_questions, archive_quiz) accept an optional
-- idempotencyKey. The key row is claimed with a unique insert; a repeated
-- request with the same key + request_hash replays the stored response
-- instead of duplicating the write. This survives MCP server restarts, which
-- is exactly the timeout/retry scenario it protects against.
--
-- Trust boundary: service_role only. No RLS policies are created, so the
-- table is not reachable by anon/authenticated at all (service_role bypasses
-- RLS). Keys are short-lived (24h) and treated as stale afterwards.

CREATE TABLE IF NOT EXISTS public.mcp_idempotency_keys (
  key text PRIMARY KEY,
  operation text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_mcp_idempotency_created_at
  ON public.mcp_idempotency_keys (created_at);

ALTER TABLE public.mcp_idempotency_keys ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.mcp_idempotency_keys FROM anon, authenticated;
GRANT ALL ON public.mcp_idempotency_keys TO service_role;
