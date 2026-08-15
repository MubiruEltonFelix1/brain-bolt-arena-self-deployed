export type BrandingProfile = {
  id: string;
  owner_id: string;
  organization_name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
};

export function brandingStyleVars(b: BrandingProfile | null | undefined): React.CSSProperties {
  if (!b) return {};
  const vars: Record<string, string> = {};
  if (b.primary_color) vars["--brand-primary"] = b.primary_color;
  if (b.secondary_color) vars["--brand-secondary"] = b.secondary_color;
  return vars as React.CSSProperties;
}
