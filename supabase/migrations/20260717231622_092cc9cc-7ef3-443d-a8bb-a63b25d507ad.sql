CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.branding_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_name TEXT NOT NULL,
  logo_url TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.branding_profiles TO authenticated;
GRANT SELECT ON public.branding_profiles TO anon;
GRANT ALL ON public.branding_profiles TO service_role;

ALTER TABLE public.branding_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner can insert own branding"
  ON public.branding_profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = owner_id AND public.is_authorized_host());

CREATE POLICY "Owner can update own branding"
  ON public.branding_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Owner can delete own branding"
  ON public.branding_profiles FOR DELETE
  TO authenticated
  USING (auth.uid() = owner_id);

CREATE POLICY "Branding profiles are publicly readable"
  ON public.branding_profiles FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE TRIGGER branding_profiles_updated_at
  BEFORE UPDATE ON public.branding_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

ALTER TABLE public.sessions
  ADD COLUMN branding_profile_id UUID REFERENCES public.branding_profiles(id) ON DELETE SET NULL;

CREATE POLICY "Anyone can view branding logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'branding-logos');

CREATE POLICY "Authenticated hosts can upload branding logos to own folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'branding-logos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Owners can update own branding logos"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'branding-logos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Owners can delete own branding logos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'branding-logos' AND auth.uid()::text = (storage.foldername(name))[1]);