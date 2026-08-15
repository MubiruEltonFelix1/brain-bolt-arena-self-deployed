-- Phase 7F: Principal Abstraction Foundation (additive only)

DO $$ BEGIN
  CREATE TYPE public.principal_type AS ENUM ('user','organization','platform','partner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.principals (
  id uuid PRIMARY KEY,
  type public.principal_type NOT NULL,
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT principals_user_link_chk CHECK (
    (type = 'user' AND user_id IS NOT NULL) OR (type <> 'user' AND user_id IS NULL)
  ),
  CONSTRAINT principals_user_identity_chk CHECK (type <> 'user' OR id = user_id)
);

GRANT SELECT ON public.principals TO authenticated;
GRANT ALL ON public.principals TO service_role;

ALTER TABLE public.principals ENABLE ROW LEVEL SECURITY;

-- Read-only, self-scoped. No INSERT/UPDATE/DELETE policies exist: the table is
-- writable only by service_role and SECURITY DEFINER functions.
DROP POLICY IF EXISTS "Users can view their own principal" ON public.principals;
CREATE POLICY "Users can view their own principal"
  ON public.principals FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Immutability: the user<->principal link and the type can never change once set.
CREATE OR REPLACE FUNCTION public.tg_principals_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.type <> OLD.type OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'principals.id/type/user_id are immutable';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS principals_immutable_trg ON public.principals;
CREATE TRIGGER principals_immutable_trg
  BEFORE UPDATE ON public.principals
  FOR EACH ROW EXECUTE FUNCTION public.tg_principals_immutable();

-- Seed: exactly one user principal per existing auth user, id-identical.
INSERT INTO public.principals (id, type, user_id)
SELECT u.id, 'user', u.id FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- New signups get a principal alongside their profile.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'display_name',
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.principals (id, type, user_id)
  VALUES (NEW.id, 'user', NEW.id)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Canonical resolution helpers.
CREATE OR REPLACE FUNCTION public.principal_for_user(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id FROM public.principals p
  WHERE p.type = 'user' AND p.user_id = p_user;
$$;

CREATE OR REPLACE FUNCTION public.user_for_principal(p_principal uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id FROM public.principals p
  WHERE p.id = p_principal AND p.type = 'user';
$$;

CREATE OR REPLACE FUNCTION public.current_principal_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.principal_for_user(auth.uid());
$$;

REVOKE ALL ON FUNCTION public.principal_for_user(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_for_principal(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_principal_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.principal_for_user(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_for_principal(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_principal_id() TO authenticated, service_role;

-- can(...): resolve the acting identity through Principal, outcomes unchanged.
CREATE OR REPLACE FUNCTION public.can(p_principal uuid, p_action text, p_resource uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user  uuid;
  v_admin boolean;
  v_host  boolean;
  v_owner boolean := false;
BEGIN
  IF p_principal IS NULL THEN
    RETURN false;
  END IF;

  -- Transitional resolution: the argument may be a user principal id or, during
  -- migration, a raw auth user id. Both resolve to the same acting user because
  -- user principals are seeded 1:1 with identical ids.
  SELECT p.user_id INTO v_user
  FROM public.principals p
  WHERE p.type = 'user' AND (p.id = p_principal OR p.user_id = p_principal)
  LIMIT 1;

  IF v_user IS NULL THEN
    v_user := p_principal; -- pre-principal fallback; preserves Phase 7E behaviour
  END IF;

  v_admin := public.has_role(v_user, 'admin');

  IF p_action LIKE 'admin.%' THEN
    RETURN v_admin;
  END IF;

  v_host := v_admin
         OR public.has_role(v_user, 'host')
         OR public.has_active_host_authorization(v_user);

  IF p_action IN ('quiz.create','competition.create','league.create','branding.create','session.host') THEN
    RETURN v_host;
  END IF;

  IF p_resource IS NULL THEN
    RETURN false;
  END IF;

  IF p_action IN ('quiz.edit','quiz.delete') THEN
    SELECT EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = p_resource AND q.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'competition.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.competitions c WHERE c.id = p_resource AND c.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'league.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.leagues l WHERE l.id = p_resource AND l.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'branding.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.branding_profiles b WHERE b.id = p_resource AND b.owner_id = v_user) INTO v_owner;
  ELSIF p_action = 'session.manage' THEN
    SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = p_resource AND s.host_id = v_user) INTO v_owner;
  ELSE
    RETURN false;
  END IF;

  RETURN v_owner AND v_host;
END;
$$;

REVOKE ALL ON FUNCTION public.can(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can(uuid, text, uuid) TO service_role;
