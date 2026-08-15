import type { HostAuthorization } from "@/hooks/use-host-status";
import { Link } from "@tanstack/react-router";

export function HostAuthorizationCard({
  isAdmin,
  authorization,
  loading,
}: {
  isAdmin: boolean;
  authorization: HostAuthorization | null;
  loading: boolean;
}) {
  if (loading) return null;

  if (isAdmin) {
    return (
      <div className="border border-border bg-card p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">Admin</p>
          <p className="font-display text-lg italic uppercase mt-1">Unlimited hosting</p>
        </div>
        <p className="text-foreground/50 text-xs font-mono uppercase">Platform administrator</p>
      </div>
    );
  }

  if (!authorization) {
    return (
      <div className="border border-pink-shock/50 bg-card p-6 space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">Hosting not enabled</p>
        <h2 className="font-display text-2xl italic uppercase">Approval required</h2>
        <p className="text-foreground/70 text-sm max-w-xl">
          Hosting access requires approval. Request hosting access to create competitions.
        </p>
        <Link
          to="/request-hosting"
          className="inline-block bg-volt text-background font-display text-base px-5 py-2.5 skew-cta active:scale-95"
        >
          REQUEST HOSTING ACCESS
        </Link>
      </div>
    );
  }

  const t = authorization.authorization_type;
  const label =
    t === "single" ? "Single session"
    : t === "bundle" ? "Session bundle"
    : "Time-based access";

  const detail =
    t === "time"
      ? authorization.expires_at
        ? `Expires ${new Date(authorization.expires_at).toLocaleDateString()}`
        : "No expiry set"
      : `${authorization.remaining_sessions ?? 0} session${(authorization.remaining_sessions ?? 0) === 1 ? "" : "s"} remaining`;

  return (
    <div className="border border-volt/50 bg-card p-4 flex items-center justify-between gap-4 flex-wrap">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-volt">Hosting active</p>
        <p className="font-display text-lg italic uppercase mt-1">{label}</p>
      </div>
      <p className="font-mono text-xs uppercase text-foreground/70">{detail}</p>
    </div>
  );
}
