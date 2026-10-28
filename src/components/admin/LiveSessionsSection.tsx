import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toastError, logActionError } from "@/lib/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  ComposedChart,
  Bar,
  Line,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
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

type FunnelStats = {
  total_sessions: number;
  completed_sessions: number;
  abandoned_sessions: number;
  completion_rate: number | null;
  avg_session_size: number | null;
  avg_duration_seconds: number | null;
};

type QuestionTypeStat = {
  question_type: string;
  answers: number;
  accuracy: number | null;
};

type HourStat = {
  hour: number;
  sessions: number;
  answers: number;
};

type TopQuiz = {
  id: string;
  title: string;
  plays: number;
  is_arena: boolean;
  avg_score: number | null;
  avg_accuracy: number | null;
};

type TopHost = {
  display_name: string;
  sessions: number;
};

function formatDuration(seconds: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
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

export function LiveSessionsSection() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<number>(() => Date.now());
  const loadSeq = useRef(0);
  const [range, setRange] = useState<7 | 14 | 30 | 90>(30);
  const [series, setSeries] = useState<HourStat[]>([]);

  const fetchStats = useCallback(async () => {
    try {
      const [{ data: pl }, { data: hr }] = await Promise.all([
        supabase.rpc("admin_platform_stats"),
        supabase.rpc("admin_stats_hours" as never, { p_days: range } as never),
      ]);
      if (pl) {
        setStats(((pl as unknown as PlatformStats[] | null) ?? [])[0] ?? null);
      }
      if (hr) {
        setSeries(
          ((hr as unknown as HourStat[] | null) ?? []).filter((row) => Number.isFinite(row.hour)),
        );
      }
    } catch (err) {
      logActionError(err, "live sessions stats");
      setError("Failed to load platform stats. Try again.");
    }
  }, [range]);

  const fetchLive = useCallback(async () => {
    try {
      const { data } = await supabase.rpc("admin_live_sessions" as never);
      if (data) {
        setLiveSessions((data as LiveSession[] | null) ?? []);
        setLiveUpdatedAt(Date.now());
      }
    } catch (err) {
      logActionError(err, "live sessions list");
      setError("Failed to load live sessions. Try again.");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchStats().finally(() => setLoading(false));
  }, [fetchStats]);

  useEffect(() => {
    fetchLive();
    const t = setInterval(fetchLive, 10000);
    return () => clearInterval(t);
  }, [fetchLive]);

  const handleRefresh = async () => {
    setLoading(true);
    setError(null);
    try {
      await fetchStats();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Live Sessions
          </p>
          <h2 className="font-display text-3xl italic uppercase">Live games</h2>
        </div>
        <div className="text-right font-mono text-[10px] uppercase text-foreground/40">
          <p>
            {liveSessions.length} running · updated {secondsAgo(liveUpdatedAt)}
          </p>
          <p className="mt-0.5">polls every 10s</p>
        </div>
      </div>

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
          value={stats?.total_players ?? "—"}
          accent="volt"
          loading={loading}
        />
        <StatCard
          label="Live games now"
          value={stats?.live_sessions ?? "—"}
          accent="cyan-jolt"
          loading={loading}
        />
        <StatCard
          label="Competitions"
          value={stats?.total_competitions ?? "—"}
          accent="volt"
          loading={loading}
        />
        <StatCard
          label="Arena plays"
          value={stats?.arena_plays ?? "—"}
          accent="pink-shock"
          loading={loading}
        />
      </div>

      {stats &&
        (stats.pending_host_requests > 0 || stats.expiring_authorizations > 0 ? (
          <div className="border border-amber-spark/50 bg-amber-spark/10 p-4 font-mono text-[11px] uppercase tracking-widest text-amber-spark">
            ⚠ {stats.pending_host_requests} pending host request(s) ·{" "}
            {stats.expiring_authorizations} authorization(s) expiring within 14 days
          </div>
        ) : null)}

      <div className="border border-border bg-card">
        <div className="flex items-end justify-between gap-3 flex-wrap px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-volt opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-volt" />
            </span>
            <div>
              <p className="font-mono text-[10px] uppercase text-pink-shock">On air</p>
              <h2 className="font-display text-3xl italic uppercase mt-1">Live games</h2>
            </div>
          </div>
        </div>
        {loading ? (
          <div className="p-8">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : liveSessions.length === 0 ? (
          <div className="border border-border bg-card p-8 text-center font-mono text-xs uppercase text-foreground/40">
            No games running right now
          </div>
        ) : (
          <div className="border border-border bg-card">
            {liveSessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0 flex-wrap"
              >
                <span
                  className={`font-mono text-[10px] uppercase px-2 py-0.5 border ${s.status === "active" ? "border-volt text-volt" : s.status === "lobby" ? "border-cyan-jolt text-cyan-jolt" : s.status === "question_results" ? "border-amber-spark text-amber-spark" : "border-border text-foreground/50"}`}
                >
                  {s.status === "active"
                    ? "Live"
                    : s.status === "lobby"
                      ? "Lobby"
                      : s.status === "question_results"
                        ? "Results"
                        : s.status}
                </span>
                <span className="font-mono text-sm text-volt">{s.code}</span>
                <p className="flex-1 min-w-0 font-display text-base italic uppercase truncate">
                  {s.title}
                </p>
                <span className="font-mono text-xs text-foreground/70">
                  {s.participants} player{s.participants === 1 ? "" : "s"}
                </span>
                <span className="font-mono text-[10px] uppercase text-foreground/40">
                  {timeAgo(s.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <PeakHoursSection data={series} loading={loading} range={range} onRangeChange={setRange} />
    </div>
  );
}

function PeakHoursSection({
  data,
  loading,
  range,
  onRangeChange,
}: {
  data: HourStat[];
  loading: boolean;
  range: 7 | 14 | 30 | 90;
  onRangeChange: (v: 7 | 14 | 30 | 90) => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
        Peak hours · {range}d
      </h2>
      {loading ? (
        <div className="border border-border bg-card p-8">
          <Skeleton className="h-44 w-full" />
        </div>
      ) : data.length === 0 ? (
        <div className="border border-border bg-card p-8 text-center font-mono text-xs uppercase text-foreground/40">
          No data in this range
        </div>
      ) : (
        <div className="border border-border bg-card p-4">
          <HoursChart data={data} />
        </div>
      )}
    </section>
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
  accent: "volt" | "cyan-jolt" | "pink-shock" | "amber-spark";
  loading: boolean;
}) {
  const accentColors: Record<string, { bg: string; text: string }> = {
    volt: { bg: "bg-volt/10", text: "text-volt" },
    "cyan-jolt": { bg: "bg-cyan-jolt/10", text: "text-cyan-jolt" },
    "pink-shock": { bg: "bg-pink-shock/10", text: "text-pink-shock" },
    "amber-spark": { bg: "bg-amber-spark/10", text: "text-amber-spark" },
  };
  const c = accentColors[accent];
  return (
    <div className="border border-border bg-card p-5">
      <p className="font-mono text-[10px] uppercase tracking-widest {c.text}">{label}</p>
      <div className="mt-1">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <p className="font-display text-3xl italic text-foreground">
            {typeof value === "number" ? value.toLocaleString() : value}
          </p>
        )}
      </div>
    </div>
  );
}

function secondsAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

const axisTick = { fontSize: 10, fill: "var(--muted-foreground)" };
const gridStroke = "var(--border)";

function HoursChart({ data }: { data: HourStat[] }) {
  const hoursConfig = {
    sessions: { label: "Games", color: "var(--volt)" },
    answers: { label: "Answers", color: "var(--cyan-jolt)" },
  };
  return (
    <div className="aspect-auto h-44">
      <ChartContainer config={{}}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
          <XAxis
            dataKey="hour"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={axisTick}
            tickFormatter={(v) => `${Number(v) < 12 ? "am" : "pm"} ${Number(v) % 12 || 12}`}
            minTickGap={8}
          />
          <YAxis yAxisId="sessions" tickLine={false} axisLine={false} width={36} tick={axisTick} />
          <YAxis
            yAxisId="answers"
            orientation="right"
            tickLine={false}
            axisLine={false}
            width={36}
            tick={axisTick}
          />
          <ChartTooltip
            cursor={{ stroke: gridStroke }}
            content={
              <ChartTooltipContent
                labelFormatter={(l: string | number) =>
                  `${Number(l) < 12 ? "am" : "pm"} ${Number(l) % 12 || 12}`
                }
                formatter={(value: unknown, name: string | number) =>
                  value == null
                    ? "—"
                    : `${(value as number).toLocaleString()} ${name === "sessions" ? "games" : "answers"}`
                }
              />
            }
          />
          <Bar
            yAxisId="sessions"
            dataKey="sessions"
            fill="var(--volt)"
            fillOpacity={0.8}
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="answers"
            dataKey="answers"
            type="monotone"
            stroke="var(--cyan-jolt)"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}
