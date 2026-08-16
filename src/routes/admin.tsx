import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useHostStatus } from "@/hooks/use-host-status";
import { toast } from "sonner";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

type AdminUser = {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  auth_id: string | null;
  authorization_type: "single" | "bundle" | "time" | null;
  remaining_sessions: number | null;
  expires_at: string | null;
  status: "active" | "expired" | "revoked" | "consumed" | null;
  is_active: boolean | null;
};

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

type Stats = {
  active_hosts: number;
  expiring_soon: number;
  single_hosts: number;
  bundle_hosts: number;
  time_hosts: number;
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

type LiveSession = {
  id: string;
  code: string;
  status: string;
  title: string;
  created_at: string;
  participants: number;
};

function AdminPage() {
  const { isAdmin, loading } = useHostStatus();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [platform, setPlatform] = useState<PlatformStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<7 | 14 | 30 | 90>(30);
  const [series, setSeries] = useState<DailyStat[]>([]);
  const [topQuizzes, setTopQuizzes] = useState<TopQuiz[]>([]);
  const [topHosts, setTopHosts] = useState<TopHost[]>([]);
  const [funnel, setFunnel] = useState<FunnelStats | null>(null);
  const [questionTypes, setQuestionTypes] = useState<QuestionTypeStat[]>([]);
  const [hours, setHours] = useState<HourStat[]>([]);
  const [liveSessions, setLiveSessions] = useState<LiveSession[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"live" | "analytics" | "users">("live");
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<number>(() => Date.now());
  // Guards against stale responses overwriting newer ones when the range
  // toggle is clicked in quick succession (7D → 90D before 7D resolves).
  const loadSeq = useRef(0);

  useEffect(() => {
    if (!loading && !isAdmin) navigate({ to: "/dashboard" });
  }, [loading, isAdmin, navigate]);

  // Live sessions poll every 10s; a separate 1s ticker re-renders the
  // "updated Xs ago" readout so the panel visibly counts down between polls.
  useEffect(() => {
    if (!isAdmin) return;
    const fetchLive = () => {
      supabase.rpc("admin_live_sessions" as never).then(({ data }) => {
        if (data) {
          setLiveSessions((data as LiveSession[] | null) ?? []);
          setLiveUpdatedAt(Date.now());
        }
      });
    };
    fetchLive();
    const t = setInterval(fetchLive, 10000);
    return () => clearInterval(t);
    /* eslint-disable-next-line */
  }, [isAdmin]);

  // One-second ticker lives inside UpdatedReadout (below) so only the readout
  // re-renders each second, never the charts.

  // Silent auto-refresh of the time-varying data every 30s so the charts and
  // KPI cards move on their own. Snapshot of loadSeq: discarded if a full
  // load() started since, and never touches `refreshing` (no flash).
  useEffect(() => {
    if (!isAdmin) return;
    const refresh = async () => {
      const seq = loadSeq.current;
      try {
        const [{ data: pl }, { data: ts }, { data: hr }] = await Promise.all([
          supabase.rpc("admin_platform_stats"),
          supabase.rpc("admin_stats_timeseries" as never, { p_days: range } as never),
          supabase.rpc("admin_stats_hours" as never, { p_days: range } as never),
        ]);
        if (seq !== loadSeq.current) return;
        if (pl) setPlatform(((pl as unknown as PlatformStats[] | null) ?? [])[0] ?? null);
        if (ts) setSeries(((ts as unknown as DailyStat[] | null) ?? []).filter((row) => row.day));
        if (hr)
          setHours(
            ((hr as unknown as HourStat[] | null) ?? []).filter((row) => Number.isFinite(row.hour)),
          );
      } catch {
        // Network blip — ignore, the next tick retries.
      }
    };
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
    /* eslint-disable-next-line */
  }, [isAdmin, range]);

  // Range-independent insights, fetched once per admin session.
  useEffect(() => {
    if (!isAdmin) return;
    Promise.all([
      supabase.rpc("admin_session_funnel" as never),
      supabase.rpc("admin_question_type_stats" as never),
    ]).then(([{ data: fn, error: e6 }, { data: qt, error: e7 }]) => {
      if (e6) toast.error(e6.message);
      if (e7) toast.error(e7.message);
      setFunnel(((fn as unknown as FunnelStats[] | null) ?? [])[0] ?? null);
      setQuestionTypes(
        ((qt as unknown as QuestionTypeStat[] | null) ?? []).filter((row) => row.question_type),
      );
    });
    /* eslint-disable-next-line */
  }, [isAdmin]);

  async function load() {
    // All figures are derived on demand from existing tables — no metrics store.
    const seq = ++loadSeq.current;
    setRefreshing(true);
    try {
      const [
        { data: list, error: e1 },
        { data: st, error: e2 },
        { data: pl },
        { data: ts, error: e3 },
        { data: tq, error: e4 },
        { data: th, error: e5 },
        { data: hr, error: e8 },
      ] = await Promise.all([
        supabase.rpc("admin_list_users", { p_search: search || undefined }),
        supabase.rpc("admin_host_stats"),
        supabase.rpc("admin_platform_stats"),
        supabase.rpc("admin_stats_timeseries" as never, { p_days: range } as never),
        supabase.rpc("admin_top_quizzes" as never, { p_limit: 5 } as never),
        supabase.rpc("admin_top_hosts" as never, { p_limit: 5 } as never),
        supabase.rpc("admin_stats_hours" as never, { p_days: range } as never),
      ]);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      if (e1) toast.error(e1.message);
      if (e2) toast.error(e2.message);
      if (e3) toast.error(e3.message);
      if (e4) toast.error(e4.message);
      if (e5) toast.error(e5.message);
      if (e8) toast.error(e8.message);
      setUsers((list as AdminUser[] | null) ?? []);
      setStats(((st as Stats[] | null) ?? [])[0] ?? null);
      setPlatform(((pl as unknown as PlatformStats[] | null) ?? [])[0] ?? null);
      setSeries(((ts as unknown as DailyStat[] | null) ?? []).filter((row) => row.day));
      setTopQuizzes(((tq as unknown as TopQuiz[] | null) ?? []).filter((row) => row.id));
      setTopHosts(((th as unknown as TopHost[] | null) ?? []).filter((row) => row.display_name));
      setHours(
        ((hr as unknown as HourStat[] | null) ?? []).filter((row) => Number.isFinite(row.hour)),
      );
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }

  useEffect(() => {
    if (isAdmin) load(); /* eslint-disable-next-line */
  }, [isAdmin, range]);

  async function grant(
    profileId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) {
    setBusy(true);
    const { error } = await supabase.rpc("admin_grant_host_authorization", {
      p_profile_id: profileId,
      p_type: type,
      p_sessions: sessions ?? undefined,
      p_expires_at: expiresAt ?? undefined,
      p_notes: undefined,
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Authorization granted");
    load();
  }

  async function revoke(authId: string) {
    if (!confirm("Revoke this hosting authorization?")) return;
    const { error } = await supabase.rpc("admin_revoke_host_authorization", { p_auth_id: authId });
    if (error) return toast.error(error.message);
    toast.success("Revoked");
    load();
  }

  async function extend(
    authId: string,
    addSessions: number | undefined,
    newExpires: string | undefined,
  ) {
    const { error } = await supabase.rpc("admin_extend_host_authorization", {
      p_auth_id: authId,
      p_add_sessions: addSessions ?? undefined,
      p_new_expires_at: newExpires ?? undefined,
    });
    if (error) return toast.error(error.message);
    toast.success("Updated");
    load();
  }

  async function convert(
    authId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) {
    const { error } = await supabase.rpc("admin_convert_host_authorization", {
      p_auth_id: authId,
      p_type: type,
      p_sessions: sessions ?? undefined,
      p_expires_at: expiresAt ?? undefined,
    });
    if (error) return toast.error(error.message);
    toast.success("Converted");
    load();
  }

  const summary = useMemo(
    () => [
      { label: "Active hosts", value: stats?.active_hosts ?? 0 },
      { label: "Expiring 7d", value: stats?.expiring_soon ?? 0 },
      { label: "Single", value: stats?.single_hosts ?? 0 },
      { label: "Bundle", value: stats?.bundle_hosts ?? 0 },
      { label: "Time-based", value: stats?.time_hosts ?? 0 },
    ],
    [stats],
  );

  // Period-over-period deltas: the last 7 days of the loaded series vs the
  // 7 days before them. Only meaningful when the range spans ≥ 14 days.
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

  function exportCsv() {
    if (series.length === 0) return;
    const headers = [
      "day",
      "new_players",
      "sessions",
      "participants",
      "answers",
      "results",
      "avg_accuracy",
      "avg_response_ms",
    ];
    const lines = series.map((d) =>
      [
        d.day,
        d.new_players,
        d.sessions,
        d.participants,
        d.answers,
        d.results,
        d.avg_accuracy ?? "",
        d.avg_response_ms ?? "",
      ].join(","),
    );
    const blob = new Blob([[headers.join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `admin-activity-${range}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading || !isAdmin) return null;

  return (
    <HostShell title="Admin">
      <div className="max-w-6xl mx-auto px-6 py-10 space-y-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-pink-shock">Restricted</p>
          <h1 className="font-display text-5xl italic uppercase mt-1">Host management</h1>
        </div>

        <div className="flex gap-1 border-b border-border pb-2">
          {(
            [
              ["live", "Live"],
              ["analytics", "Analytics"],
              ["users", "Users"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 font-display text-lg italic uppercase skew-cta transition-colors ${
                tab === key ? "bg-volt text-background" : "text-foreground/60 hover:text-volt"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "users" && (
          <>
            <section className="space-y-3">
              <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                Host authorizations
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {summary.map((s) => (
                  <div key={s.label} className="border border-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase text-foreground/50">{s.label}</p>
                    <p className="font-display text-3xl italic text-volt mt-1">{s.value}</p>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        {tab === "live" && (
          <>
            <section className="space-y-3">
              <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                Platform overview
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Registered players", value: platform?.total_players },
                  { label: "Live / open sessions", value: platform?.live_sessions },
                  { label: "Competitions", value: platform?.total_competitions },
                  { label: "Arena plays", value: platform?.arena_plays },
                  { label: "Quizzes", value: platform?.total_quizzes },
                  { label: "Arena challenges", value: platform?.arena_quizzes },
                  { label: "Sessions · 7d", value: platform?.sessions_last_7d },
                  { label: "Results · 7d", value: platform?.results_last_7d },
                ].map((m) => (
                  <div key={m.label} className="border border-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase text-foreground/50">{m.label}</p>
                    <p className="font-display text-2xl italic mt-1">
                      {m.value == null ? "—" : m.value.toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
              {platform &&
                (platform.pending_host_requests > 0 || platform.expiring_authorizations > 0) && (
                  <p className="border border-amber-spark/50 bg-amber-spark/10 p-3 font-mono text-[11px] uppercase tracking-widest text-amber-spark">
                    ⚠ {platform.pending_host_requests} pending host request(s) ·{" "}
                    {platform.expiring_authorizations} authorization(s) expiring within 14 days
                  </p>
                )}
              {trend && (
                <div className="flex flex-wrap gap-x-5 gap-y-1 border border-border bg-card px-4 py-3 font-mono text-[10px] uppercase tracking-widest">
                  <span className="text-foreground/40">Last 7d vs prior 7d</span>
                  {(
                    [
                      ["sessions", "Sessions"],
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
            </section>

            <section className="space-y-3">
              <div className="flex items-end justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className="relative flex size-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-volt opacity-60" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-volt" />
                  </span>
                  <div>
                    <p className="font-mono text-[10px] uppercase text-pink-shock">On air</p>
                    <h2 className="font-display text-3xl italic uppercase mt-1">Live sessions</h2>
                  </div>
                </div>
                <div className="text-right font-mono text-[10px] uppercase tracking-widest text-foreground/40">
                  <p>
                    {liveSessions.length} running · updated <UpdatedReadout at={liveUpdatedAt} />
                  </p>
                  <p className="mt-0.5">polls every 10s</p>
                </div>
              </div>
              {liveSessions.length === 0 ? (
                <div className="border border-border bg-card p-8 text-center font-mono text-xs uppercase text-foreground/40">
                  No sessions running right now
                </div>
              ) : (
                <div className="border border-border bg-card">
                  {liveSessions.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0 flex-wrap"
                    >
                      <span
                        className={`font-mono text-[10px] uppercase px-2 py-0.5 border ${
                          s.status === "active"
                            ? "border-volt text-volt"
                            : s.status === "lobby"
                              ? "border-cyan-jolt text-cyan-jolt"
                              : s.status === "question_results"
                                ? "border-amber-spark text-amber-spark"
                                : "border-border text-foreground/50"
                        }`}
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
            </section>
          </>
        )}

        {tab === "analytics" && (
          <>
            <section className="space-y-3">
              <div className="flex items-end justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-mono text-[10px] uppercase text-cyan-jolt">Trends</p>
                  <h2 className="font-display text-3xl italic uppercase mt-1">Activity</h2>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  <button
                    onClick={exportCsv}
                    disabled={series.length === 0}
                    className="border border-border px-3 py-1.5 font-mono text-[10px] uppercase text-foreground/60 hover:border-volt hover:text-volt disabled:opacity-40"
                  >
                    Export CSV
                  </button>
                  {([7, 14, 30, 90] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setRange(d)}
                      className={`px-3 py-1.5 font-mono text-[10px] uppercase border ${
                        range === d
                          ? "border-volt text-volt"
                          : "border-border text-foreground/60 hover:text-volt"
                      }`}
                    >
                      {d}D
                    </button>
                  ))}
                </div>
              </div>
              {refreshing && (
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">
                  Refreshing…
                </p>
              )}
              {!refreshing && series.length === 0 ? (
                <div className="border border-border bg-card p-10 text-center font-mono text-xs uppercase text-foreground/40">
                  No activity recorded in this range
                </div>
              ) : (
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
              )}
            </section>

            <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="border border-border bg-card p-4 space-y-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                  Session funnel
                </p>
                {funnel ? (
                  <>
                    <div>
                      <p className="font-display text-5xl italic text-volt">
                        {funnel.completion_rate ?? 0}%
                      </p>
                      <p className="font-mono text-[10px] uppercase text-foreground/50 mt-1">
                        of {funnel.total_sessions.toLocaleString()} sessions reached end
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
                        <span className="text-foreground/70 truncate">
                          {qt.question_type.replace(/_/g, " ")}
                        </span>
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
            </section>

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

            <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                    No sessions yet
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
                        {h.sessions.toLocaleString()} {h.sessions === 1 ? "session" : "sessions"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}

        {tab === "users" && (
          <>
            <HostRequestsPanel onChange={load} />

            <div className="flex gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && load()}
                placeholder="Search by name or email"
                className="flex-1 bg-background border border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt"
              />
              <button
                onClick={load}
                className="bg-volt text-background font-display text-base px-5 py-3 skew-cta"
              >
                SEARCH
              </button>
            </div>

            <div className="border border-border">
              {users.length === 0 ? (
                <div className="p-8 text-center text-foreground/50 font-mono text-sm uppercase">
                  No users
                </div>
              ) : (
                users.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    busy={busy}
                    onGrant={grant}
                    onRevoke={revoke}
                    onExtend={extend}
                    onConvert={convert}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>
    </HostShell>
  );
}

function ActivityCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-border bg-card p-4 space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">{title}</p>
      {children}
    </div>
  );
}

const axisTick = { fontSize: 10, fill: "var(--muted-foreground)" };
const gridStroke = "var(--border)";
const dayTick = (v: unknown) => String(v).slice(5); // YYYY-MM-DD → MM-DD

const sessionsConfig = {
  sessions: { label: "Sessions", color: "var(--volt)" },
  participants: { label: "Players joined", color: "var(--cyan-jolt)" },
} satisfies ChartConfig;

const answersConfig = {
  answers: { label: "Answers", color: "var(--amber-spark)" },
  avg_accuracy: { label: "Accuracy", color: "var(--volt)" },
} satisfies ChartConfig;

const registrationsConfig = {
  new_players: { label: "New players", color: "var(--pink-shock)" },
} satisfies ChartConfig;

const responseConfig = {
  avg_response_ms: { label: "Avg response (ms)", color: "var(--cyan-jolt)" },
} satisfies ChartConfig;

function SessionsChart({ data }: { data: DailyStat[] }) {
  return (
    <ChartContainer config={sessionsConfig} className="aspect-auto h-52">
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
          content={<ChartTooltipContent labelFormatter={(l) => formatDay(String(l))} />}
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
    </ChartContainer>
  );
}

function AnswersChart({ data }: { data: DailyStat[] }) {
  return (
    <ChartContainer config={answersConfig} className="aspect-auto h-52">
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
              labelFormatter={(l) => formatDay(String(l))}
              formatter={(value, name) =>
                value == null
                  ? "—"
                  : name === "avg_accuracy"
                    ? `${value}%`
                    : Number(value).toLocaleString()
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
    </ChartContainer>
  );
}

function RegistrationsChart({ data }: { data: DailyStat[] }) {
  return (
    <ChartContainer config={registrationsConfig} className="aspect-auto h-52">
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
          cursor={{ stroke: gridStroke }}
          content={<ChartTooltipContent labelFormatter={(l) => formatDay(String(l))} />}
        />
        <Bar
          dataKey="new_players"
          fill="var(--pink-shock)"
          fillOpacity={0.8}
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}

function ResponseChart({ data }: { data: DailyStat[] }) {
  return (
    <ChartContainer config={responseConfig} className="aspect-auto h-52">
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
          cursor={{ stroke: gridStroke }}
          content={
            <ChartTooltipContent
              labelFormatter={(l) => formatDay(String(l))}
              formatter={(value) => (value == null ? "—" : `${Number(value).toLocaleString()} ms`)}
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
    </ChartContainer>
  );
}

function formatDay(day: string) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function secondsAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

/** Self-contained 1s ticker so "updated Xs ago" counts down without
 *  re-rendering the rest of the page (charts stay cheap). */
function UpdatedReadout({ at }: { at: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{secondsAgo(at)}</>;
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const hoursConfig = {
  sessions: { label: "Sessions", color: "var(--volt)" },
  answers: { label: "Answers", color: "var(--cyan-jolt)" },
} satisfies ChartConfig;

function HoursChart({ data }: { data: HourStat[] }) {
  return (
    <ChartContainer config={hoursConfig} className="aspect-auto h-44">
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
              labelFormatter={(l) => `${Number(l) < 12 ? "am" : "pm"} ${Number(l) % 12 || 12}`}
              formatter={(value, name) =>
                value == null
                  ? "—"
                  : `${Number(value).toLocaleString()} ${name === "sessions" ? "sessions" : "answers"}`
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
  );
}

function UserRow({
  user,
  busy,
  onGrant,
  onRevoke,
  onExtend,
  onConvert,
}: {
  user: AdminUser;
  busy: boolean;
  onGrant: (
    profileId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) => void;
  onRevoke: (authId: string) => void;
  onExtend: (
    authId: string,
    addSessions: number | undefined,
    newExpires: string | undefined,
  ) => void;
  onConvert: (
    authId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"single" | "bundle" | "time">("single");
  const [sessions, setSessions] = useState(5);
  const [expires, setExpires] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  });

  const status = user.is_active
    ? user.authorization_type === "time"
      ? `Time · until ${user.expires_at ? new Date(user.expires_at).toLocaleDateString() : "—"}`
      : `${user.authorization_type ?? ""} · ${user.remaining_sessions ?? 0} left`
    : user.status
      ? `Inactive (${user.status})`
      : "No authorization";

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center justify-between p-4 gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="font-display text-lg italic uppercase truncate">
            {user.display_name || user.email}
          </p>
          <p className="font-mono text-xs text-foreground/50 truncate">{user.email}</p>
        </div>
        <div className="text-right">
          <p
            className={`font-mono text-xs uppercase ${user.is_active ? "text-volt" : "text-foreground/50"}`}
          >
            {status}
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
        >
          {open ? "Close" : "Manage"}
        </button>
      </div>

      {open && (
        <div className="bg-background/50 border-t border-border p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
            <label className="block">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
                className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs uppercase"
              >
                <option value="single">Single</option>
                <option value="bundle">Bundle</option>
                <option value="time">Time-based</option>
              </select>
            </label>
            {type === "bundle" && (
              <label className="block">
                <span className="font-mono text-[10px] uppercase text-foreground/60">Sessions</span>
                <input
                  type="number"
                  min={1}
                  value={sessions}
                  onChange={(e) => setSessions(parseInt(e.target.value) || 1)}
                  className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs"
                />
              </label>
            )}
            {type === "time" && (
              <label className="block">
                <span className="font-mono text-[10px] uppercase text-foreground/60">Expires</span>
                <input
                  type="date"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs"
                />
              </label>
            )}
            <button
              disabled={busy}
              onClick={() =>
                onGrant(
                  user.id,
                  type,
                  type === "bundle" ? sessions : type === "single" ? 1 : undefined,
                  type === "time" ? new Date(expires).toISOString() : undefined,
                )
              }
              className="bg-volt text-background font-display text-base px-4 py-2.5 skew-cta disabled:opacity-50"
            >
              GRANT / REPLACE
            </button>
          </div>

          {user.auth_id && user.is_active && (
            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
              {(user.authorization_type === "single" || user.authorization_type === "bundle") && (
                <button
                  onClick={() => {
                    const n = parseInt(prompt("Add how many sessions?", "5") || "0");
                    if (n > 0) onExtend(user.auth_id!, n, undefined);
                  }}
                  className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
                >
                  + Sessions
                </button>
              )}
              {user.authorization_type === "time" && (
                <button
                  onClick={() => {
                    const d = prompt("New expiry date (YYYY-MM-DD)?");
                    if (d) onExtend(user.auth_id!, undefined, new Date(d).toISOString());
                  }}
                  className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
                >
                  Extend expiry
                </button>
              )}
              <button
                onClick={() =>
                  onConvert(
                    user.auth_id!,
                    type,
                    type === "bundle" ? sessions : type === "single" ? 1 : undefined,
                    type === "time" ? new Date(expires).toISOString() : undefined,
                  )
                }
                className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
              >
                Convert to selected
              </button>
              <button
                onClick={() => onRevoke(user.auth_id!)}
                className="border border-pink-shock text-pink-shock px-3 py-2 font-mono text-xs uppercase hover:bg-pink-shock hover:text-background"
              >
                Revoke
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type HostRequest = {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  organization: string;
  purpose: string;
  expected_participants: string;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
};

function HostRequestsPanel({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<HostRequest[]>([]);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.rpc(
      "admin_list_host_requests" as never,
      {
        p_status: filter === "all" ? null : filter,
      } as never,
    );
    if (error) return toast.error(error.message);
    setItems((data as HostRequest[] | null) ?? []);
  }

  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, [filter]);

  async function approve(id: string) {
    setBusyId(id);
    const { error } = await supabase.rpc(
      "admin_approve_host_request" as never,
      { p_request_id: id } as never,
    );
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success("Approved · 90-day access granted");
    load();
    onChange();
  }

  async function reject(id: string) {
    if (!confirm("Reject this hosting request?")) return;
    setBusyId(id);
    const { error } = await supabase.rpc(
      "admin_reject_host_request" as never,
      { p_request_id: id } as never,
    );
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success("Rejected");
    load();
  }

  const pendingCount = items.filter((i) => i.status === "pending").length;

  return (
    <div className="border border-border bg-card">
      <div className="flex items-center justify-between p-4 border-b border-border gap-2 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase text-cyan-jolt">Host requests</p>
          <p className="font-display text-xl italic uppercase">
            {filter === "pending" ? `${pendingCount} pending` : `${items.length} ${filter}`}
          </p>
        </div>
        <div className="flex gap-1">
          {(["pending", "approved", "rejected", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase border ${
                filter === f
                  ? "border-volt text-volt"
                  : "border-border text-foreground/60 hover:text-volt"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">
          No {filter === "all" ? "" : filter} requests
        </div>
      ) : (
        <div>
          {items.map((r) => (
            <div key={r.id} className="border-b border-border last:border-b-0 p-4 space-y-2">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="font-display text-base italic uppercase truncate">
                    {r.organization}
                  </p>
                  <p className="font-mono text-[11px] text-foreground/60 truncate">
                    {r.display_name || r.email} · {r.email}
                  </p>
                  <p className="font-mono text-[10px] uppercase text-foreground/50 mt-1">
                    {r.purpose} · {r.expected_participants} ·{" "}
                    {new Date(r.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span
                  className={`font-mono text-[10px] uppercase px-2 py-1 border ${
                    r.status === "pending"
                      ? "border-cyan-jolt text-cyan-jolt"
                      : r.status === "approved"
                        ? "border-volt text-volt"
                        : "border-pink-shock text-pink-shock"
                  }`}
                >
                  {r.status}
                </span>
              </div>
              {r.message && (
                <p className="text-foreground/70 text-sm whitespace-pre-wrap">{r.message}</p>
              )}
              {r.status === "pending" && (
                <div className="flex gap-2 pt-1">
                  <button
                    disabled={busyId === r.id}
                    onClick={() => approve(r.id)}
                    className="bg-volt text-background font-display text-sm px-4 py-2 skew-cta disabled:opacity-50"
                  >
                    APPROVE
                  </button>
                  <button
                    disabled={busyId === r.id}
                    onClick={() => reject(r.id)}
                    className="border border-pink-shock text-pink-shock px-4 py-2 font-mono text-xs uppercase hover:bg-pink-shock hover:text-background disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
