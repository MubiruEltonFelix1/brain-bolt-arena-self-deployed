import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Link } from "@tanstack/react-router";
import { toastError, logActionError } from "@/lib/errors";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { SectionKey } from "./types";

type PlatformStats = {
  total_players: number;
  total_quizzes: number;
  arena_quizzes: number;
  total_competitions: number;
  live_sessions: number;
  sessions_last_7d: number;
  arena_plays: number;
  results_last_7d: number;
  pending_host_requests: number;
  active_host_authorizations: number;
  expiring_authorizations: number;
};

type LiveSession = {
  id: string;
  code: string;
  status: string;
  title: string;
  created_at: string;
  participants: number;
};

function formatNumber(n: number | null | undefined) {
  return n == null ? "—" : n.toLocaleString();
}

function statusBadge(status: string) {
  const config: Record<string, { bg: string; text: string; border: string }> = {
    active: { bg: "bg-volt/10", text: "text-volt", border: "border-volt/30" },
    lobby: { bg: "bg-cyan-jolt/10", text: "text-cyan-jolt", border: "border-cyan-jolt/30" },
    question_results: {
      bg: "bg-amber-spark/10",
      text: "text-amber-spark",
      border: "border-amber-spark/30",
    },
  };
  const c = config[status] || {
    bg: "bg-background",
    text: "text-foreground/50",
    border: "border-border",
  };
  return (
    <span
      className={`font-mono text-[9px] uppercase px-2 py-0.5 rounded-md ${c.bg} ${c.text} ${c.border}`}
    >
      {status}
    </span>
  );
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export function OverviewSection() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const { data, error: rpcError } = await supabase.rpc("admin_platform_stats");
      if (rpcError) {
        logActionError(rpcError, "admin_platform_stats");
        setError("Failed to load platform stats. Try again.");
        return;
      }
      setStats(((data as unknown as PlatformStats[] | null) ?? [])[0] ?? null);
    } catch (err) {
      logActionError(err, "admin_platform_stats");
      setError("Failed to load platform stats. Try again.");
    }
  }, []);

  const fetchLive = useCallback(async () => {
    try {
      const { data } = await supabase.rpc("admin_live_sessions" as never);
      if (data) {
        setLiveSessions((data as LiveSession[] | null) ?? []);
      }
    } catch (err) {
      logActionError(err, "admin_live_sessions");
      setError("Failed to load live sessions. Try again.");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchStats().finally(() => setLoading(false));
  }, [fetchStats]);

  // Poll live sessions every 10s, matching the existing admin behavior.
  useEffect(() => {
    fetchLive();
    const t = setInterval(fetchLive, 10000);
    return () => clearInterval(t);
  }, [fetchLive]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await fetchStats();
    } finally {
      setRefreshing(false);
    }
  };

  const pendingRequests = stats?.pending_host_requests ?? 0;
  const expiring = stats?.expiring_authorizations ?? 0;

  return (
    <div className="space-y-8">
      {error && (
        <div className="border border-pink-shock/50 bg-pink-shock/10 p-4 font-mono text-xs uppercase text-pink-shock">
          {error}
          <button
            onClick={handleRefresh}
            className="ml-3 underline underline-offset-4 hover:text-volt"
          >
            Try again
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Registered players"
          value={formatNumber(stats?.total_players)}
          accent="volt"
          loading={loading}
        />
        <StatCard
          label="Active hosts"
          value={formatNumber(stats?.active_host_authorizations)}
          accent="volt"
          loading={loading}
        />
        <StatCard
          label="Live sessions"
          value={formatNumber(stats?.live_sessions)}
          accent="cyan-jolt"
          loading={loading}
        />
        <StatCard
          label="Pending requests"
          value={formatNumber(stats?.pending_host_requests)}
          accent={pendingRequests > 0 ? "amber-spark" : "volt"}
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                Live sessions
              </p>
              <h2 className="font-display text-2xl italic uppercase">Live now</h2>
            </div>
            {refreshing && (
              <button
                onClick={handleRefresh}
                className="text-foreground/40 hover:text-volt transition-colors"
              >
                Refresh
              </button>
            )}
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-3/4" />
              ))}
            </div>
          ) : liveSessions.length === 0 ? (
            <div className="p-8 text-center font-mono text-xs uppercase text-foreground/40">
              No live sessions right now
            </div>
          ) : (
            <div className="space-y-2">
              {liveSessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between px-4 py-3 border-b border-border last:border-b-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm text-volt">{s.code}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-display text-base italic uppercase truncate">{s.title}</p>
                      <p className="font-mono text-[10px] text-foreground/50">
                        {s.participants} player{s.participants === 1 ? "" : "s"} ·{" "}
                        {timeAgo(s.created_at)}
                      </p>
                    </div>
                  </div>
                  {statusBadge(s.status)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border border-border bg-card p-6 space-y-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              Operational status
            </p>
            <h3 className="font-display text-lg italic uppercase">Warnings</h3>
          </div>
          <div className="space-y-3">
            {pendingRequests > 0 ? (
              <WarningRow
                label="Pending host requests"
                count={pendingRequests}
                accent="amber-spark"
              />
            ) : (
              <WarningRow label="Pending host requests" count={0} accent="volt" />
            )}
            {expiring > 0 ? (
              <WarningRow
                label="Authorizations expiring soon"
                count={expiring}
                accent="pink-shock"
              />
            ) : (
              <WarningRow label="Authorizations expiring soon" count={0} accent="volt" />
            )}
          </div>
        </div>
      </div>

      <QuickActions />
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  loading,
}: {
  label: string;
  value: string | number;
  accent: "volt" | "cyan-jolt" | "amber-spark" | "pink-shock";
  loading: boolean;
}) {
  const accentColors: Record<string, { bg: string; text: string }> = {
    volt: { bg: "bg-volt/10", text: "text-volt" },
    "cyan-jolt": { bg: "bg-cyan-jolt/10", text: "text-cyan-jolt" },
    "amber-spark": { bg: "bg-amber-spark/10", text: "text-amber-spark" },
    "pink-shock": { bg: "bg-pink-shock/10", text: "text-pink-shock" },
  };
  const c = accentColors[accent];
  return (
    <div className="border border-border bg-card p-5">
      <p className="font-mono text-[10px] uppercase tracking-widest {c.text}">{label}</p>
      <div className="mt-1">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <p className="font-display text-3xl italic text-foreground">{value}</p>
        )}
      </div>
    </div>
  );
}

function WarningRow({
  label,
  count,
  accent,
}: {
  label: string;
  count: number;
  accent: "volt" | "amber-spark" | "pink-shock";
}) {
  const accentColors: Record<string, { bg: string; text: string; border: string }> = {
    volt: { bg: "bg-volt/10", text: "text-volt", border: "border-volt/30" },
    "amber-spark": {
      bg: "bg-amber-spark/10",
      text: "text-amber-spark",
      border: "border-amber-spark/30",
    },
    "pink-shock": {
      bg: "bg-pink-shock/10",
      text: "text-pink-shock",
      border: "border-pink-shock/30",
    },
  };
  const c = accentColors[accent];
  const ok = count === 0;
  return (
    <div
      className={`flex items-center justify-between px-3 py-2 rounded-md border ${c.bg} ${c.border}`}
    >
      <div>
        <p className={`font-mono text-[10px] uppercase ${ok ? "text-foreground/50" : c.text}`}>
          {label}
        </p>
        <p className={`font-display text-lg italic ${ok ? "text-foreground" : c.text}`}>
          {ok ? "None" : count.toLocaleString()}
        </p>
      </div>
      <Badge variant={ok ? "secondary" : "default"} className={c.text}>
        {ok ? "OK" : count.toLocaleString()}
      </Badge>
    </div>
  );
}

function QuickActions() {
  return (
    <div className="border border-border bg-card p-6">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
          Quick actions
        </p>
        <h3 className="font-display text-lg italic uppercase">Common tasks</h3>
      </div>
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ActionButton label="Manage users" to="/admin?section=users" />
        <ActionButton label="View live sessions" to="/admin?section=live" />
        <ActionButton label="View analytics" to="/admin?section=analytics" />
        <ActionButton label="Approve host requests" to="/admin?section=users" />
      </div>
    </div>
  );
}

function ActionButton({ label, to }: { label: string; to: string }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between px-4 py-3 border border-border bg-background/30 rounded-md text-left hover:bg-volt/5 hover:border-volt/50 transition-colors"
    >
      <div>
        <p className="font-mono text-[10px] uppercase text-foreground/50 hover:text-volt transition-colors">
          {label}
        </p>
      </div>
      <span className="text-foreground/40 hover:text-volt transition-colors">→</span>
    </Link>
  );
}
