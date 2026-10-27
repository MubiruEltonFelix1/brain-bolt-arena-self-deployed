import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toastError, logActionError } from "@/lib/errors";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart,
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

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

type DailyStat = {
  day: string;
  new_players: number;
  sessions: number;
  participants: number;
  answers: number;
  results: number;
  avg_accuracy: number | null;
  avg_response_ms: number | null;
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

function formatDay(day: string) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const axisTick = { fontSize: 10, fill: "var(--muted-foreground)" };
const gridStroke = "var(--border)";

const sessionsConfig = {
  sessions: { label: "Games", color: "var(--volt)" },
  participants: { label: "Players joined", color: "var(--cyan-jolt)" },
};

const answersConfig = {
  answers: { label: "Answers", color: "var(--amber-spark)" },
  avg_accuracy: { label: "Accuracy", color: "var(--volt)" },
};

const registrationsConfig = {
  new_players: { label: "New players", color: "var(--pink-shock)" },
};

const responseConfig = {
  avg_response_ms: { label: "Avg response (ms)", color: "var(--cyan-jolt)" },
};

function SessionsChart({ data }: { data: DailyStat[] }) {
  return (
    <div className="aspect-auto h-52">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="adminSessions" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--volt)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--volt)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="adminParticipants" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--cyan-jolt)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--cyan-jolt)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={axisTick}
            tickFormatter={dayTick}
            minTickGap={24}
          />
          <YAxis tickLine={false} axisLine={false} width={36} tick={axisTick} />
          <ChartTooltip
            cursor={{ stroke: gridStroke }}
            content={
              <ChartTooltipContent labelFormatter={(l: string | number) => formatDay(String(l))} />
            }
          />
          <Area
            dataKey="sessions"
            type="monotone"
            stroke="var(--volt)"
            strokeWidth={2}
            fill="url(#adminSessions)"
          />
          <Area
            dataKey="participants"
            type="monotone"
            stroke="var(--cyan-jolt)"
            strokeWidth={2}
            fill="url(#adminParticipants)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function AnswersChart({ data }: { data: DailyStat[] }) {
  return (
    <div className="aspect-auto h-52">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={axisTick}
            tickFormatter={dayTick}
            minTickGap={24}
          />
          <YAxis yAxisId="count" tickLine={false} axisLine={false} width={36} tick={axisTick} />
          <YAxis
            yAxisId="pct"
            orientation="right"
            domain={[0, 100]}
            tickLine={false}
            axisLine={false}
            width={36}
            tick={axisTick}
            tickFormatter={(v) => `${v}%`}
          />
          <ChartTooltip
            cursor={{ stroke: gridStroke }}
            content={
              <ChartTooltipContent
                labelFormatter={(l: string | number) => formatDay(String(l))}
                formatter={(value: unknown, name: string | number) =>
                  value == null
                    ? "—"
                    : name === "avg_accuracy"
                      ? `${Number(value as number)}%`
                      : `${(value as number).toLocaleString()}`
                }
              />
            }
          />
          <Bar
            yAxisId="count"
            dataKey="answers"
            fill="var(--amber-spark)"
            fillOpacity={0.8}
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="pct"
            dataKey="avg_accuracy"
            type="monotone"
            stroke="var(--volt)"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function RegistrationsChart({ data }: { data: DailyStat[] }) {
  return (
    <div className="aspect-auto h-52">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={axisTick}
            tickFormatter={dayTick}
            minTickGap={24}
          />
          <YAxis tickLine={false} axisLine={false} width={36} tick={axisTick} />
          <ChartTooltip
            content={
              <ChartTooltipContent labelFormatter={(l: string | number) => formatDay(String(l))} />
            }
          />
          <Bar
            dataKey="new_players"
            fill="var(--pink-shock)"
            fillOpacity={0.8}
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ResponseChart({ data }: { data: DailyStat[] }) {
  return (
    <div className="aspect-auto h-52">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={axisTick}
            tickFormatter={dayTick}
            minTickGap={24}
          />
          <YAxis tickLine={false} axisLine={false} width={36} tick={axisTick} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(l: string | number) => formatDay(String(l))}
                formatter={(value: unknown) =>
                  value == null ? "—" : `${(value as number).toLocaleString()} ms`
                }
              />
            }
          />
          <Line
            dataKey="avg_response_ms"
            type="monotone"
            stroke="var(--cyan-jolt)"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function dayTick(v: unknown) {
  return String(v).slice(5); // YYYY-MM-DD → MM-DD
}

export function AnalyticsSection() {
  const [range, setRange] = useState<7 | 14 | 30 | 90>(30);
  const [series, setSeries] = useState<DailyStat[]>([]);
  const [funnel, setFunnel] = useState<FunnelStats | null>(null);
  const [questionTypes, setQuestionTypes] = useState<QuestionTypeStat[]>([]);
  const [hours, setHours] = useState<HourStat[]>([]);
  const [topQuizzes, setTopQuizzes] = useState<TopQuiz[]>([]);
  const [topHosts, setTopHosts] = useState<TopHost[]>([]);
  const [platform, setPlatform] = useState<PlatformStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadSeq = useRef(0);

  const loadRangeData = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [{ data: ts, error: e3 }, { data: hr, error: e8 }] = await Promise.all([
      supabase.rpc("admin_stats_timeseries" as never, { p_days: range } as never),
      supabase.rpc("admin_stats_hours" as never, { p_days: range } as never),
    ]);
    if (seq !== loadSeq.current) return;
    if (ts) setSeries(((ts as unknown as DailyStat[] | null) ?? []).filter((row) => row.day));
    if (hr)
      setHours(
        ((hr as unknown as HourStat[] | null) ?? []).filter((row) => Number.isFinite(row.hour)),
      );
    if (e3) logActionError(e3, "admin_stats_timeseries");
    if (e8) logActionError(e8, "admin_stats_hours");
  }, [range]);

  const loadPlatform = useCallback(async () => {
    const { data: pl } = await supabase.rpc("admin_platform_stats");
    if (pl) setPlatform(((pl as unknown as PlatformStats[] | null) ?? [])[0] ?? null);
  }, []);

  const loadInsights = useCallback(async () => {
    const [
      { data: fn, error: e6 },
      { data: qt, error: e7 },
      { data: tq, error: e4 },
      { data: th, error: e5 },
    ] = await Promise.all([
      supabase.rpc("admin_session_funnel" as never),
      supabase.rpc("admin_question_type_stats" as never),
      supabase.rpc("admin_top_quizzes" as never, { p_limit: 5 } as never),
      supabase.rpc("admin_top_hosts" as never, { p_limit: 5 } as never),
    ]);
    if (e6) logActionError(e6, "admin_session_funnel");
    if (e7) logActionError(e7, "admin_question_type_stats");
    setFunnel(((fn as unknown as FunnelStats[] | null) ?? [])[0] ?? null);
    setQuestionTypes(
      ((qt as unknown as QuestionTypeStat[] | null) ?? []).filter((row) => row.question_type),
    );
    setTopQuizzes(((tq as unknown as TopQuiz[] | null) ?? []).filter((row) => row.id));
    setTopHosts(((th as unknown as TopHost[] | null) ?? []).filter((row) => row.display_name));
    if (e4) logActionError(e4, "admin_top_quizzes");
    if (e5) logActionError(e5, "admin_top_hosts");
  }, []);

  useEffect(() => {
    loadRangeData();
    loadPlatform();
    loadInsights();
  }, [loadRangeData, loadPlatform, loadInsights]);

  const trend = useMemo(() => {
    if (series.length < 14) return null;
    const cur = series.slice(-7);
    const prev = series.slice(-14, -7);
    const pct = (key: "sessions" | "answers" | "new_players" | "results") => {
      const c = cur.reduce((a, r) => a + r[key], 0);
      const p = prev.reduce((a, r) => a + r[key], 0);
      if (p === 0) return null;
      return Math.round(((c - p) / p) * 100);
    };
    return {
      sessions: pct("sessions"),
      answers: pct("answers"),
      new_players: pct("new_players"),
      results: pct("results"),
    };
  }, [series]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadRangeData(), loadInsights()]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Analytics
          </p>
          <h2 className="font-display text-3xl italic uppercase">Activity</h2>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-foreground/40 hover:text-volt disabled:opacity-50 transition-colors font-mono text-xs uppercase"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {([7, 14, 30, 90] as const).map((d) => (
            <button
              key={d}
              onClick={() => setRange(d)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase border ${range === d ? "border-volt text-volt" : "border-border text-foreground/60 hover:text-volt"}`}
            >
              {d}D
            </button>
          ))}
        </div>
      </div>

      {!refreshing && series.length === 0 ? (
        <div className="border border-border bg-card p-10 text-center font-mono text-xs uppercase text-foreground/40">
          No activity recorded in this range
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ActivityCard title="Sessions & players">
              <SessionsChart data={series} />
            </ActivityCard>
            <ActivityCard title="Answers & accuracy">
              <AnswersChart data={series} />
            </ActivityCard>
            <ActivityCard title="New registrations">
              <RegistrationsChart data={series} />
            </ActivityCard>
            <ActivityCard title="Avg response time">
              <ResponseChart data={series} />
            </ActivityCard>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border border-border bg-card p-4 space-y-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                Game funnel
              </p>
              {funnel ? (
                <>
                  <div>
                    <p className="font-display text-5xl italic text-volt">
                      {funnel.completion_rate ?? 0}%
                    </p>
                    <p className="font-mono text-[10px] uppercase text-foreground/50 mt-1">
                      of {funnel.total_sessions.toLocaleString()} games reached the end
                    </p>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-3 border-t border-border">
                    <div>
                      <p className="font-mono text-[10px] uppercase text-foreground/50">
                        Abandoned
                      </p>
                      <p className="font-display text-2xl italic text-pink-shock mt-1">
                        {funnel.abandoned_sessions.toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <p className="font-mono text-[10px] uppercase text-foreground/50">
                        Avg players
                      </p>
                      <p className="font-display text-2xl italic text-cyan-jolt mt-1">
                        {funnel.avg_session_size ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="font-mono text-[10px] uppercase text-foreground/50">
                        Avg duration
                      </p>
                      <p className="font-display text-2xl italic text-amber-spark mt-1">
                        {formatDuration(funnel.avg_duration_seconds)}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">
                  Loading…
                </div>
              )}
            </div>

            <div className="border border-border bg-card p-4 space-y-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                Question-type accuracy
              </p>
              {questionTypes.length === 0 ? (
                <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">
                  No answers yet
                </div>
              ) : (
                questionTypes.map((qt) => (
                  <div key={qt.question_type}>
                    <div className="flex justify-between gap-3 font-mono text-[10px] uppercase tracking-widest">
                      <span className="text-foreground/70 truncate">{qt.question_type}</span>
                      <span className="text-foreground/50 shrink-0">
                        {qt.answers.toLocaleString()} ·{" "}
                        {qt.accuracy == null ? "—" : `${qt.accuracy}%`}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 bg-background">
                      <div
                        className="h-full bg-volt"
                        style={{ width: `${Math.min(100, Math.max(0, qt.accuracy ?? 0))}%` }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <section className="space-y-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              Peak hours · {range}d
            </h2>
            {hours.length === 0 ? (
              <div className="border border-border bg-card p-8 text-center font-mono text-xs uppercase text-foreground/40">
                No data in this range
              </div>
            ) : (
              <div className="border border-border bg-card p-4">
                <HoursChart data={hours} />
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border border-border bg-card">
              <div className="p-4 border-b border-border">
                <p className="font-mono text-[10px] uppercase text-volt">Leaderboard</p>
                <h3 className="font-display text-xl italic uppercase mt-1">Top quizzes</h3>
              </div>
              {topQuizzes.length === 0 ? (
                <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">
                  No plays yet
                </div>
              ) : (
                topQuizzes.map((q, i) => (
                  <div
                    key={q.id}
                    className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0"
                  >
                    <span className="font-display text-xl italic text-volt w-6 shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="font-display text-sm italic uppercase truncate">{q.title}</p>
                      {(q.avg_score != null || q.avg_accuracy != null) && (
                        <p className="font-mono text-[10px] uppercase text-foreground/50 truncate">
                          avg {q.avg_score ?? "—"} pts · {q.avg_accuracy ?? "—"}% acc
                        </p>
                      )}
                    </div>
                    {q.is_arena && (
                      <span className="font-mono text-[9px] uppercase border border-volt/30 text-volt px-1.5 py-0.5">
                        Arena
                      </span>
                    )}
                    <span className="font-mono text-xs text-foreground/70">
                      {q.plays.toLocaleString()}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="border border-border bg-card">
              <div className="p-4 border-b border-border">
                <p className="font-mono text-[10px] uppercase text-cyan-jolt">Leaderboard</p>
                <h3 className="font-display text-xl italic uppercase mt-1">Top hosts</h3>
              </div>
              {topHosts.length === 0 ? (
                <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">
                  No games yet
                </div>
              ) : (
                topHosts.map((h, i) => (
                  <div
                    key={h.display_name}
                    className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0"
                  >
                    <span className="font-display text-xl italic text-cyan-jolt w-6 shrink-0">
                      {i + 1}
                    </span>
                    <p className="flex-1 min-w-0 font-display text-sm italic uppercase truncate">
                      {h.display_name}
                    </p>
                    <span className="font-mono text-xs text-foreground/70">
                      {h.sessions.toLocaleString()} {h.sessions === 1 ? "game" : "games"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {trend && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 border border-border bg-card px-4 py-3 font-mono text-[10px] uppercase tracking-widest">
              <span className="text-foreground/40">Last 7d vs prior 7d</span>
              {(
                [
                  ["sessions", "Games"],
                  ["answers", "Answers"],
                  ["new_players", "Players"],
                  ["results", "Results"],
                ] as const
              ).map(([key, label]) => {
                const v = trend[key];
                return (
                  <span key={key}>
                    <span className="text-foreground/60">{label}</span>{" "}
                    {v == null ? (
                      <span className="text-foreground/40">—</span>
                    ) : (
                      <span className={v >= 0 ? "text-volt" : "text-pink-shock"}>
                        {v >= 0 ? "▲" : "▼"} {Math.abs(v)}%
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ActivityCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-card p-4 space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">{title}</p>
      {children}
    </div>
  );
}

function HoursChart({ data }: { data: HourStat[] }) {
  const hoursConfig = {
    sessions: { label: "Games", color: "var(--volt)" },
    answers: { label: "Answers", color: "var(--cyan-jolt)" },
  };
  return (
    <div className="aspect-auto h-44">
      <ResponsiveContainer width="100%" height="100%">
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
      </ResponsiveContainer>
    </div>
  );
}
