
BEGIN;

-- Drop the owner_principal_id FKs (recreated at the end)
ALTER TABLE public.quizzes DROP CONSTRAINT IF EXISTS quizzes_owner_principal_id_fkey;
ALTER TABLE public.leagues DROP CONSTRAINT IF EXISTS leagues_owner_principal_id_fkey;
ALTER TABLE public.branding_profiles DROP CONSTRAINT IF EXISTS branding_profiles_owner_principal_id_fkey;

-- Disable triggers that would block or recompute during the remap
ALTER TABLE public.principals DISABLE TRIGGER principals_immutable_trg;
ALTER TABLE public.quizzes DISABLE TRIGGER quizzes_sync_owner_principal_trg;
ALTER TABLE public.leagues DISABLE TRIGGER leagues_sync_owner_principal_trg;
ALTER TABLE public.branding_profiles DISABLE TRIGGER branding_sync_owner_principal_trg;
ALTER TABLE public.sessions DISABLE TRIGGER enforce_host_authorization_trg;

-- Confirm the email so the admin can log in immediately
UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()) WHERE id = '46657234-d594-48f3-be10-c08a68482228';

-- Roles: point at the new uid
UPDATE public.user_roles SET user_id = '46657234-d594-48f3-be10-c08a68482228' WHERE user_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.user_roles SET granted_by = '46657234-d594-48f3-be10-c08a68482228' WHERE granted_by IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.host_requests SET user_id = '46657234-d594-48f3-be10-c08a68482228' WHERE user_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.host_requests SET reviewed_by = '46657234-d594-48f3-be10-c08a68482228' WHERE reviewed_by IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.host_authorizations SET profile_id = '46657234-d594-48f3-be10-c08a68482228' WHERE profile_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.host_authorizations SET granted_by = '46657234-d594-48f3-be10-c08a68482228' WHERE granted_by IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.result_claims SET claimed_by = '46657234-d594-48f3-be10-c08a68482228' WHERE claimed_by IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');

-- Content tables
UPDATE public.quizzes SET owner_id = '46657234-d594-48f3-be10-c08a68482228', owner_principal_id = '46657234-d594-48f3-be10-c08a68482228' WHERE owner_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c') OR owner_principal_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.leagues SET owner_id = '46657234-d594-48f3-be10-c08a68482228', owner_principal_id = '46657234-d594-48f3-be10-c08a68482228' WHERE owner_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c') OR owner_principal_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.branding_profiles SET owner_id = '46657234-d594-48f3-be10-c08a68482228', owner_principal_id = '46657234-d594-48f3-be10-c08a68482228' WHERE owner_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c') OR owner_principal_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.competitions SET owner_id = '46657234-d594-48f3-be10-c08a68482228' WHERE owner_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
UPDATE public.sessions SET host_id = '46657234-d594-48f3-be10-c08a68482228' WHERE host_id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');

-- Drop the old identity rows (the new account's profile+principal were created by the signup trigger)
DELETE FROM public.profiles WHERE id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');
DELETE FROM public.principals WHERE id IN ('8bb87681-8d57-4395-a341-ddafe6b0cfb8','f16b4e76-bc54-4de6-b9e8-3787673a964a','eac816fa-e881-4c66-aecb-940ce52539c4','bfd93682-9dd8-469d-9db8-2a06934afa39','210037b9-0d9b-46af-908a-e78c26ce801c');

-- Recreate the FKs
ALTER TABLE public.quizzes ADD CONSTRAINT quizzes_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;
ALTER TABLE public.leagues ADD CONSTRAINT leagues_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;
ALTER TABLE public.branding_profiles ADD CONSTRAINT branding_profiles_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

-- Re-enable triggers
ALTER TABLE public.principals ENABLE TRIGGER principals_immutable_trg;
ALTER TABLE public.quizzes ENABLE TRIGGER quizzes_sync_owner_principal_trg;
ALTER TABLE public.leagues ENABLE TRIGGER leagues_sync_owner_principal_trg;
ALTER TABLE public.branding_profiles ENABLE TRIGGER branding_sync_owner_principal_trg;
ALTER TABLE public.sessions ENABLE TRIGGER enforce_host_authorization_trg;

COMMIT;
