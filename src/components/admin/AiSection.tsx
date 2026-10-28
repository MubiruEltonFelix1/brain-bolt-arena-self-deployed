import { useEffect, useState, useCallback } from "react";
import { logActionError } from "@/lib/errors";
import { Skeleton } from "@/components/ui/skeleton";
import {
  adminAiStats,
  adminAiUsageLog,
  adminAiKillSwitch,
} from "@/lib/api/ai.functions";

type AiStat = {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number | null;
  byModel: Record<string, { calls: number; cost: number }>;
  byCapability: Record<string, { calls: number; success: number }>;
};

type AiUsageRow = {
  id: string;
  principal_id: string;
  capability: string;
  model: string;
  success: boolean;
  estimated_cost_usd: number;
  error_kind: string | null;
  created_at: string;
  principals: { user_id: string | null } | null;
};

export function AiSection() {
  const [stats, setStats] = useState<AiStat | null>(null);
  const [rows, setRows] = useState<AiUsageRow[]>([]);
  const [killSwitch, setKillSwitch] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsResult, logResult] = await Promise.all([
        adminAiStats({}),
        adminAiUsageLog({ data: { limit: 50 } }),
      ]);
      if (statsResult.error) {
        logActionError(statsResult.error, "admin_ai_stats");
        setError("Failed to load AI stats. Try again.");
      } else if (statsResult.stats) {
        setStats(statsResult.stats);
      }
      if (logResult.error) {
        logActionError(logResult.error, "admin_ai_usage_log");
      } else if (logResult.rows) {
        setRows(logResult.rows);
      }
    } catch (err) {
      logActionError(err, "admin_ai_load");
      setError("Failed to load AI usage data. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefresh = async () => {
    setError(null);
    await load();
  };

  const handleKillSwitchToggle = async () => {
    if (killSwitch == null || toggling) return;
    setToggling(true);
    setError(null);
    try {
      const result = await adminAiKillSwitch({ data: { enabled: !killSwitch } });
      if (result.error) {
        logActionError(result.error, "admin_ai_kill_switch");
        setError("Failed to update kill switch. Try again.");
      } else {
        setKillSwitch(result.enabled);
      }
    } catch (err) {
      logActionError(err, "admin_ai_kill_switch");
      setError("Failed to update kill switch. Try again.");
    } finally {
      setToggling(false);
    }
  };

  const successRate =
    stats && stats.totalCalls > 0
      ? Math.round((stats.successCalls / stats.totalCalls) * 100)
      : null;

  const userLabel = (row: AiUsageRow) => {
    const uid = row.principals?.user_id;
    if (!uid) return row.principal_id.slice(0, 8);
    return uid.slice(0, 8);
  };

  return (
    <div className="space-y-6">
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

      {/* Controls strip: kill switch + refresh */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            AI controls
          </p>
          <h2 className="font-display text-3xl italic uppercase">AI usage</h2>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={killSwitch === true}
              disabled={loading || killSwitch == null || toggling}
              className="accent-volt"
              onChange={handleKillSwitchToggle}
            />
            <span className="font-mono text-xs uppercase">
              {killSwitch == null ? "Loading…" : killSwitch ? "Kill switch: ON" : "Kill switch: OFF"}
            </span>
          </label>
          {toggling && (
            <span className="font-mono text-[10px] uppercase text-foreground/40 animate-pulse">
              updating…
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="text-foreground/40 hover:text-volt disabled:opacity-50 transition-colors font-mono text-xs uppercase"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <StatCard key={i} loading label="—" value="—" accent="volt" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total generations"
            value={stats?.totalCalls ?? "—"}
            accent="volt"
            loading={false}
          />
          <StatCard
            label="Success rate"
            value={successRate === null ? "—" : `${successRate}%`}
            accent={successRate == null ? "volt" : successRate >= 90 ? "volt" : "amber-spark"}
            loading={false}
          />
          <StatCard
            label="Estimated cost (USD)"
            value={stats?.totalCostUsd != null ? `$${stats.totalCostUsd.toFixed(4)}` : "—"}
            accent="cyan-jolt"
            loading={false}
          />
          <StatCard
            label="Tokens (in / out)"
            value={
              stats?.totalInputTokens != null && stats?.totalOutputTokens != null
                ? `${stats.totalInputTokens.toLocaleString()} / ${stats.totalOutputTokens.toLocaleString()}`
                : "—"
            }
            accent="amber-spark"
            loading={false}
          />
        </div>
      )}

      {/* Model breakdown */}
      {stats && !loading && Object.keys(stats.byModel).length > 0 && (
        <div className="border border-border bg-card p-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              By model
            </p>
            <h3 className="font-display text-lg italic uppercase mt-1">Provider cost &amp; volume</h3>
          </div>
          <div className="mt-3 space-y-2">
            {Object.entries(stats.byModel).map(([model, m]) => (
              <div key={model} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border/50 last:border-b-0">
                <div>
                  <p className="font-mono text-[10px] uppercase text-foreground/70 truncate max-w-xs">
                    {model}
                  </p>
                  <p className="font-mono text-xs text-foreground/40">
                    {m.calls} generation{m.calls === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-display text-sm italic text-volt">
                    ${m.cost.toFixed(4)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent usage log */}
      <div className="border border-border bg-card">
        <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-border">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              Recent usage
            </p>
            <h2 className="font-display text-2xl italic uppercase mt-1">Usage log</h2>
          </div>
          <div className="text-right font-mono text-[10px] uppercase text-foreground/40">
            <p>{rows.length} entr${rows.length === 1 ? "y" : "ies"}</p>
          </div>
        </div>
        {loading ? (
          <div className="p-8">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-border bg-card p-8 text-center font-mono text-xs uppercase text-foreground/40">
            No AI usage recorded yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr>
                  <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">
                    Time
                  </th>
                  <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">
                    User
                  </th>
                  <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">
                    Action
                  </th>
                  <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">
                    Model
                  </th>
                  <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">
                    Cost
                  </th>
                  <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/50 last:border-b-0">
                    <td className="px-4 py-3 font-mono text-xs text-foreground/60">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground/70 truncate max-w-xs">
                      {userLabel(row)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground/70 uppercase">
                      {row.capability.replace("ai.", "")}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground/60 truncate max-w-xs">
                      {row.model}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground text-right">
                      ${Number(row.estimated_cost_usd || 0).toFixed(4)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`font-mono text-[9px] uppercase px-2 py-0.5 rounded-md ${
                          row.success
                            ? "bg-volt/10 text-volt border border-volt/30"
                            : "bg-pink-shock/10 text-pink-shock border border-pink-shock/30"
                        }`}
                      >
                        {row.success ? "OK" : row.error_kind ?? "error"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40 max-w-2xl">
        Kill switch state is reconstructed from the latest
        <span className="font-mono text-volt">ai.kill_switch_toggled</span> audit row. When ON, all
        AI question generation is blocked before any provider call is made — no tokens or cost are
        incurred.
      </p>
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