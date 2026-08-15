import type { LiveStatus } from "@/hooks/use-live-channel";

const LABEL: Record<LiveStatus, string> = {
  connecting: "CONNECTING",
  connected: "LIVE",
  reconnecting: "RECONNECTING",
  offline: "NO CONNECTION",
  error: "CONNECTION TROUBLE",
};

const DOT: Record<LiveStatus, string> = {
  connecting: "bg-amber-spark",
  connected: "bg-volt",
  reconnecting: "bg-amber-spark",
  offline: "bg-pink-shock",
  error: "bg-pink-shock",
};

/**
 * Slim, non-blocking connection indicator. Gameplay keeps running underneath —
 * the server remains authoritative while the client reconnects.
 */
export function ConnectionBanner({
  status,
  recovered,
  className = "",
}: {
  status: LiveStatus;
  recovered?: boolean;
  className?: string;
}) {
  const degraded = status !== "connected";
  if (!degraded && !recovered) return null;

  const label = recovered && !degraded ? "RECONNECTED" : LABEL[status];
  const dot = recovered && !degraded ? "bg-volt" : DOT[status];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-center gap-2 px-3 py-1.5 bg-card/90 border border-border font-mono text-[10px] uppercase tracking-widest text-foreground/70 ${className}`}
    >
      <span className={`size-2 rounded-full ${dot} ${degraded ? "animate-pulse" : ""}`} />
      <span>{label}</span>
      {degraded && <span className="text-foreground/40">· your progress is safe</span>}
    </div>
  );
}

/** Full-screen recovery-aware state for the critical live routes. */
export function LiveScreenState({
  title,
  message,
  action,
  spinner = true,
}: {
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
  spinner?: boolean;
}) {
  return (
    <div className="min-h-screen grid place-items-center bg-background px-6">
      <div className="text-center space-y-4 max-w-sm">
        {spinner && (
          <div className="mx-auto size-8 border-2 border-border border-t-volt rounded-full animate-spin" />
        )}
        <p className="font-display text-2xl italic uppercase">{title}</p>
        {message && <p className="font-mono text-xs text-foreground/50 leading-relaxed">{message}</p>}
        {action && (
          <button
            onClick={action.onClick}
            className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
