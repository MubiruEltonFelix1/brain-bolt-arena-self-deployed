import { useState } from "react";
import { cn } from "@/lib/utils";
import { SectionKey, SECTIONS, PLATFORM_SECTIONS, OPERATIONS_SECTIONS } from "./types";

export function SectionNav({
  activeSection,
  onSectionChange,
}: {
  activeSection: SectionKey;
  onSectionChange: (key: SectionKey) => void;
}) {
  function renderGroup(title: string, keys: SectionKey[]) {
    return (
      <div key={title} className="space-y-1">
        <p className="px-3 font-mono text-[10px] uppercase tracking-widest text-foreground/40">
          {title}
        </p>
        <div className="space-y-0.5">
          {keys.map((key) => {
            const section = SECTIONS[key];
            const Icon = section.icon;
            const active = activeSection === key;
            return (
              <button
                key={key}
                onClick={() => {
                  onSectionChange(key);
                }}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 text-left rounded-md border text-sm transition-colors",
                  active
                    ? section.implemented
                      ? "bg-volt text-background border-volt"
                      : "bg-volt/10 text-volt border-volt/30"
                    : "border-transparent text-foreground/50 hover:bg-volt/5 hover:text-volt",
                  !section.implemented && "opacity-80",
                )}
                disabled={!section.implemented}
                aria-expanded={active}
              >
                <Icon className="size-4 shrink-0" />
                <span className="font-mono text-xs uppercase leading-none">{section.label}</span>
                {!section.implemented && (
                  <span className="ml-auto font-mono text-[10px] text-foreground/40 uppercase">
                    Coming soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <nav aria-label="Mission Control sections" className="flex flex-col gap-1 px-3 py-4">
      {renderGroup("Platform", PLATFORM_SECTIONS)}
      {renderGroup("Operations", OPERATIONS_SECTIONS)}
    </nav>
  );
}
