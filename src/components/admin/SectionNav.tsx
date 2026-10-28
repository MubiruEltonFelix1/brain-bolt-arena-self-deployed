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
  function renderGroup(title: string, keys: SectionKey[], isFirst = false) {
    return (
      <div
        key={title}
        className={cn("space-y-1 pt-3", !isFirst && "mt-5")}
      >
        <p className="px-3 font-mono text-[9px] uppercase tracking-wider text-foreground/40">
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
                  "flex items-center gap-3 px-3.5 py-2 text-left rounded-md border text-sm transition-all",
                  active
                    ? "border-transparent bg-background/40 text-foreground border-l-2 border-volt bg-volt/5"
                    : "border-transparent text-foreground/40 hover:bg-volt/5 hover:text-volt",
                  !section.implemented && "opacity-60",
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
      {renderGroup("Platform", PLATFORM_SECTIONS, true)}
      {renderGroup("Operations", OPERATIONS_SECTIONS)}
    </nav>
  );
}
