-- Fix objects skipped by the schema-filtered restore:
-- 1. The auth.users trigger that auto-creates profiles + principals on signup
-- 2. Storage RLS policies for quiz-images and branding-logos
-- 3. Backfill the new admin account's profile + principal

-- 1. Auth trigger (public.handle_new_user is already restored)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2a. quiz-images policies
DROP POLICY IF EXISTS "quiz-images public read" ON storage.objects;
CREATE POLICY "quiz-images public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'quiz-images');
DROP POLICY IF EXISTS "quiz-images host upload" ON storage.objects;
CREATE POLICY "quiz-images host upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'quiz-images' AND owner = auth.uid());
DROP POLICY IF EXISTS "quiz-images host update" ON storage.objects;
CREATE POLICY "quiz-images host update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'quiz-images' AND owner = auth.uid());
DROP POLICY IF EXISTS "quiz-images host delete" ON storage.objects;
CREATE POLICY "quiz-images host delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'quiz-images' AND owner = auth.uid());

-- 2b. branding-logos policies
DROP POLICY IF EXISTS "Anyone can view branding logos" ON storage.objects;
CREATE POLICY "Anyone can view branding logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'branding-logos');
DROP POLICY IF EXISTS "Authenticated hosts can upload branding logos to own folder" ON storage.objects;
CREATE POLICY "Authenticated hosts can upload branding logos to own folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'branding-logos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
DROP POLICY IF EXISTS "Owners can update own branding logos" ON storage.objects;
CREATE POLICY "Owners can update own branding logos"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'branding-logos' AND auth.uid()::text = (storage.foldername(name))[1]);
DROP POLICY IF EXISTS "Owners can delete own branding logos" ON storage.objects;
CREATE POLICY "Owners can delete own branding logos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'branding-logos' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 3. Backfill the new admin account's profile + principal
INSERT INTO public.profiles (id, display_name)
SELECT id, split_part(email, '@', 1)
FROM auth.users WHERE email = 'mubirueltonfelix@gmail.com'
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.principals (id, type, user_id)
SELECT id, 'user', id
FROM auth.users WHERE email = 'mubirueltonfelix@gmail.com'
ON CONFLICT (id) DO NOTHING;

-- Verify
SELECT 'trigger: ' || count(*) FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal;
SELECT 'storage policies: ' || count(*) FROM pg_policies WHERE schemaname = 'storage';
SELECT 'profiles: ' || count(*) FROM public.profiles;
SELECT 'principals: ' || count(*) FROM public.principals;
