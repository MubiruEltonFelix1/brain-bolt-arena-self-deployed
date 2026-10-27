import { SectionKey, SECTIONS } from "./types";

/**
 * Placeholder for admin modules that are planned but not yet implemented.
 * Renders a clearly marked "coming soon" state with the section's intended
 * purpose. No fake data, no fabricated metrics, no speculative UI.
 */
export function PlaceholderSection({ key }: { key: SectionKey }) {
  const section = SECTIONS[key];

  const planned: Record<SectionKey, string> = {
    overview:
      "Platform operations at a glance — live sessions, user counts, and operational warnings.",
    users: "User and host authorization management.",
    live: "Monitor and manage live game sessions.",
    analytics: "Platform usage and performance trends.",
    email:
      "Campaign composer, audience selection, test sends, delivery status, and audit trail for email announcements.",
    ai: "Model usage visibility, cost tracking, usage limits, and an emergency AI kill switch.",
    health: "Scheduler status, background job health, error rates, and operational diagnostics.",
    audit:
      "Immutable trail of privileged administrative actions — who did what, when, and on which resource.",
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] text-center px-6">
      <div className="inline-flex h-16 w-16 items-center justify-center rounded-md border border-border bg-background/50 mb-6">
        <section.icon className="size-10 text-foreground/20" />
      </div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40 mb-2">
        Planned — Operations
      </p>
      <h2 className="font-display text-4xl italic uppercase tracking-tight mb-3">
        {section.label}
      </h2>
      <p className="text-foreground/60 text-sm max-w-md mb-8 leading-relaxed">{planned[key]}</p>
      <div className="border border-border/50 bg-background/30 px-4 py-3 rounded-md font-mono text-[10px] uppercase text-foreground/40">
        Coming soon — not yet implemented. No data is shown for this section.
      </div>
    </div>
  );
}
