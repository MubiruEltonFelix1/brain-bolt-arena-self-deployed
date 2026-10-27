-- Phase 10: Email & Communications (Mission Control).
--
-- Tables for the email announcement MVP. All tables are admin-only:
-- service_role bypasses RLS; anon/authenticated have no direct access.
-- Admin server functions enforce authorization via public.is_admin().
--
-- The eligible audience derives from email_subscriptions (explicit opt-in)
-- minus email_suppressions (unsubscribe / hard_bounce / complaint).
-- Anonymous players have no email in auth.users and are never eligible.

-- 1. Campaigns --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  subject text NOT NULL CHECK (length(trim(subject)) > 0),
  preview_text text NOT NULL DEFAULT '',
  content_html text NOT NULL DEFAULT '',
  content_text text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
  audience_segment text NOT NULL DEFAULT 'all_subscribers'
    CHECK (audience_segment IN ('all_subscribers', 'authenticated_players', 'hosts')),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  delivered_count integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- 2. Campaign recipients (per-recipient delivery records) ------------------

CREATE TABLE IF NOT EXISTS public.campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (length(trim(email)) > 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'accepted', 'delivered', 'bounced', 'complained', 'failed')),
  provider_message_id text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id
  ON public.campaign_recipients (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status
  ON public.campaign_recipients (status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_email
  ON public.campaign_recipients (email);

-- 3. Email subscriptions (explicit opt-in) ----------------------------------

CREATE TABLE IF NOT EXISTS public.email_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id),
  email text NOT NULL CHECK (length(trim(email)) > 0),
  subscribed boolean NOT NULL DEFAULT true,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_subscriptions_user_id
  ON public.email_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_email_subscriptions_email
  ON public.email_subscriptions (email);

-- 4. Email suppressions (unsubscribe / hard_bounce / complaint) -------------

CREATE TABLE IF NOT EXISTS public.email_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (length(trim(email)) > 0),
  reason text NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint')),
  source text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_suppressions_email
  ON public.email_suppressions (email);

-- 5. Audit log --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL CHECK (length(trim(action)) > 0),
  resource_type text NOT NULL CHECK (length(trim(resource_type)) > 0),
  resource_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id
  ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON public.audit_logs (action);

-- RLS: service_role only; clients cannot read or write these tables directly --

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.campaigns FROM anon, authenticated;
REVOKE ALL ON public.campaign_recipients FROM anon, authenticated;
REVOKE ALL ON public.email_subscriptions FROM anon, authenticated;
REVOKE ALL ON public.email_suppressions FROM anon, authenticated;
REVOKE ALL ON public.audit_logs FROM anon, authenticated;

GRANT ALL ON public.campaigns TO service_role;
GRANT ALL ON public.campaign_recipients TO service_role;
GRANT ALL ON public.email_subscriptions TO service_role;
GRANT ALL ON public.email_suppressions TO service_role;
GRANT ALL ON public.audit_logs TO service_role;
