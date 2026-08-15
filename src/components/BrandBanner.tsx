import type { BrandingProfile } from "@/lib/branding";

type Props = {
  branding: BrandingProfile | null | undefined;
  variant?: "banner" | "compact";
  className?: string;
};

/**
 * Displays sponsor / organization branding alongside a persistent
 * "Powered by BrainBolt" tag. Renders nothing when no branding is set.
 */
export function BrandBanner({ branding, variant = "banner", className = "" }: Props) {
  if (!branding) return null;
  const primary = branding.primary_color ?? "var(--volt)";

  if (variant === "compact") {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        {branding.logo_url && (
          <img
            src={branding.logo_url}
            alt=""
            className="h-6 w-6 object-contain rounded-sm bg-white/5 p-0.5"
          />
        )}
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/70 truncate">
          {branding.organization_name}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-widest text-foreground/30">
          · Powered by BrainBolt
        </span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 border-l-4 pl-3 pr-4 py-2 bg-card/60 ${className}`}
      style={{ borderColor: primary }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {branding.logo_url && (
          <img
            src={branding.logo_url}
            alt=""
            className="h-8 w-8 object-contain rounded-sm bg-white/5 p-1 shrink-0"
          />
        )}
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Presented by
          </p>
          <p className="font-display text-sm italic uppercase truncate" style={{ color: primary }}>
            {branding.organization_name}
          </p>
        </div>
      </div>
      <p className="font-mono text-[9px] uppercase tracking-widest text-foreground/40 shrink-0">
        Powered by ⚡ BrainBolt
      </p>
    </div>
  );
}
