import type { ReactNode } from "react";

/**
 * One empty-state treatment for every surface. Always answers three things:
 * what this area is, why it's empty, and what to do next.
 */
export function EmptyState({
  eyebrow,
  title,
  body,
  children,
  tone = "volt",
}: {
  eyebrow?: string;
  title: string;
  body: string;
  children?: ReactNode;
  tone?: "volt" | "cyan-jolt" | "pink-shock";
}) {
  const color = `var(--${tone})`;
  return (
    <div className="relative overflow-hidden border-2 border-dashed border-border p-8 sm:p-10 text-center">
      <span
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background: `radial-gradient(70% 60% at 50% 0%, color-mix(in oklab, ${color} 8%, transparent), transparent 70%)`,
        }}
      />
      <div className="relative space-y-4">
        <div
          className="mx-auto size-12 grid place-items-center skew-x-[-12deg]"
          style={{ background: color }}
        >
          <span className="font-display text-background text-2xl italic leading-none">B</span>
        </div>
        {eyebrow && (
          <p className="font-mono text-[10px] uppercase tracking-widest" style={{ color }}>
            {eyebrow}
          </p>
        )}
        <p className="font-display text-2xl italic uppercase text-foreground/85">{title}</p>
        <p className="text-foreground/60 text-sm max-w-md mx-auto">{body}</p>
        {children && <div className="flex flex-wrap gap-3 justify-center pt-1">{children}</div>}
      </div>
    </div>
  );
}

/** Lightweight, motion-safe placeholder used while a list is loading. */
export function SkeletonList({
  rows = 3,
  height = "h-24",
  className = "",
}: {
  rows?: number;
  height?: string;
  className?: string;
}) {
  return (
    <div className={`grid gap-3 ${className}`} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={`bg-card border border-border ${height} motion-safe:animate-pulse`}
        />
      ))}
    </div>
  );
}
