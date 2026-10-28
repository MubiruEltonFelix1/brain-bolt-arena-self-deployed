import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Layout, LogOut, Monitor, Power, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { signOutUser } from "@/lib/auth-state";
import { toast } from "sonner";
import { SectionKey, SECTIONS, PLATFORM_SECTIONS, OPERATIONS_SECTIONS } from "./types";
import { SectionNav } from "./SectionNav";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * Mission Control page header: title + description in one cohesive block.
 * No breadcrumb, no redundant actions — the sidebar already shows location,
 * and sign-out lives in the sidebar footer.
 */
export function MissionControlHeader({
  activeSection,
  onSectionChange,
}: {
  activeSection: SectionKey;
  onSectionChange: (key: SectionKey) => void;
}) {
  const current = SECTIONS[activeSection];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="size-8 shrink-0 bg-volt grid place-items-center skew-x-[-4deg]">
          <Monitor className="size-5 text-background" />
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">
            Mission Control
          </p>
          <h1 className="font-display text-5xl italic uppercase tracking-tight mb-1">
            {current.label}
          </h1>
          <p className="text-sm text-foreground/60 max-w-2xl">
            {current.description}
          </p>
        </div>
      </div>

      {/* Mobile section selector */}
      <div className="md:hidden flex items-center gap-2">
        <select
          value={activeSection}
          onChange={(e) => onSectionChange(e.target.value as SectionKey)}
          className="bg-background border border-border px-3 py-2 font-mono text-xs uppercase text-foreground/80 focus:outline-none focus:border-volt rounded-md"
        >
          {[...PLATFORM_SECTIONS, ...OPERATIONS_SECTIONS].map((key) => {
            const s = SECTIONS[key];
            return (
              <option key={key} value={key} disabled={!s.implemented}>
                {s.label}
                {!s.implemented ? " (coming soon)" : ""}
              </option>
            );
          })}
        </select>
      </div>
    </div>
  );
}

/**
 * Mission Control layout: full-screen control panel.
 * Desktop: persistent section navigation sidebar + main content area.
 * Mobile: sidebar hidden; sections switched via state in admin.tsx.
 * The top global navigation (HostShell) is intentionally NOT rendered here —
 * Mission Control is a standalone admin surface.
 */
export function MissionControlShell({
  activeSection,
  onSectionChange,
  children,
}: {
  activeSection: SectionKey;
  onSectionChange: (key: SectionKey) => void;
  children: ReactNode;
}) {
  function handleSignOut() {
    void signOutUser().then(() => {
      toast.success("Signed out");
    });
  }

  return (
    <div className="flex h-full w-full min-h-[700px]">
      {/* Desktop: persistent section navigation sidebar */}
      <aside className="hidden md:flex flex-col w-72 border-r border-border bg-background/50">
        <div className="flex items-center gap-2 px-4 py-4 border-b border-border bg-background/30">
          <div className="size-6 shrink-0 grid place-items-center">
            <Monitor className="size-4 text-foreground/60" />
          </div>
          <span className="font-display text-sm italic uppercase tracking-tighter text-foreground/50">
            Control
          </span>
        </div>
        <SectionNav activeSection={activeSection} onSectionChange={onSectionChange} />

        {/* Sidebar footer: sign out */}
        <div className="mt-auto px-4 py-4 border-t border-border">
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 border border-border px-3 py-2 font-mono text-xs uppercase text-foreground/50 hover:text-pink-shock hover:border-pink-shock transition-colors"
          >
            <Power className="size-4" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 overflow-y-auto min-w-0">
        <ErrorBoundary>
          <div className="p-6 sm:p-8">{children}</div>
        </ErrorBoundary>
      </div>
    </div>
  );
}
