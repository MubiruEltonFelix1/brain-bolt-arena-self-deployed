import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Layout, LogOut, Monitor, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { signOutUser } from "@/lib/auth-state";
import { toast } from "sonner";
import { SectionKey, SECTIONS, PLATFORM_SECTIONS, OPERATIONS_SECTIONS } from "./types";
import { SectionNav } from "./SectionNav";

/**
 * Mission Control page header: title, description, mobile section selector,
 * and sign-out. Rendered above the section content on every page.
 */
export function MissionControlHeader({
  activeSection,
  onSectionChange,
}: {
  activeSection: SectionKey;
  onSectionChange: (key: SectionKey) => void;
}) {
  const current = SECTIONS[activeSection];

  function handleSignOut() {
    void signOutUser().then(() => {
      toast.success("Signed out");
    });
  }

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="size-8 shrink-0 bg-volt grid place-items-center skew-x-[-4deg]">
            <Monitor className="size-5 text-background" />
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">
              Mission Control
            </p>
            <h1 className="font-display text-4xl italic uppercase tracking-tight">
              {current.label}
            </h1>
          </div>
        </div>

        {/* Mobile: compact section selector */}
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

        <div className="hidden md:flex items-center gap-2">
          <Link to="/" className="font-mono text-xs uppercase text-foreground/50 hover:text-volt">
            Back to Arena
          </Link>
        </div>

        <button
          onClick={handleSignOut}
          className="hidden sm:flex items-center gap-2 border border-border px-4 py-2 font-mono text-xs uppercase text-foreground/50 hover:text-pink-shock hover:border-pink-shock transition-colors"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
      </div>

      <p className="mt-2 text-sm text-foreground/60 max-w-2xl">{current.description}</p>

      <div className="mt-4 flex items-center gap-2 px-4 py-2 bg-background/30 border border-border/50 rounded-md text-sm font-mono uppercase text-foreground/50">
        <Layout className="size-3.5 shrink-0" />
        <span>Admin — {current.label}</span>
        <ChevronRight className="size-3.5 shrink-0" />
        <span>Platform administration</span>
      </div>
    </div>
  );
}

/**
 * Mission Control layout: desktop section sidebar + main content area.
 * On mobile the sidebar is hidden; sections are switched via state managed by
 * the route component (see admin.tsx).
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
  return (
    <div className="flex h-full w-full min-h-[600px]">
      {/* Desktop: persistent section navigation sidebar */}
      <aside className="hidden md:flex flex-col w-72 border-r border-border bg-background/50">
        <div className="flex items-center gap-2 px-4 py-4 border-b border-border">
          <div className="size-6 shrink-0 bg-volt grid place-items-center skew-x-[-4deg]">
            <Layout className="size-4 text-background" />
          </div>
          <span className="font-display text-lg italic uppercase tracking-tight">Control</span>
        </div>
        <SectionNav activeSection={activeSection} onSectionChange={onSectionChange} />
      </aside>

      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="p-6 sm:p-8">{children}</div>
      </div>
    </div>
  );
}
