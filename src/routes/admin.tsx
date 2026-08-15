import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
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
  title: string;
  plays: number;
  is_arena: boolean;
};

type TopHost = {
  display_name: string;
  sessions: number;
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
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!loading && !isAdmin) navigate({ to: "/dashboard" });
  }, [loading, isAdmin, navigate]);

  async function load() {
    // All figures are derived on demand from existing tables — no metrics store.
    setRefreshing(true);
    try {
      const [{ data: list, error: e1 }, { data: st, error: e2 }, { data: pl }, { data: ts, error: e3 }, { data: tq, error: e4 }, { data: th, error: e5 }] = await Promise.all([
        supabase.rpc("admin_list_users", { p_search: search || undefined }),
        supabase.rpc("admin_host_stats"),
        supabase.rpc("admin_platform_stats"),
        supabase.rpc("admin_stats_timeseries" as never, { p_days: range } as never),
        supabase.rpc("admin_top_quizzes" as never, { p_limit: 5 } as never),
        supabase.rpc("admin_top_hosts" as never, { p_limit: 5 } as never),
      ]);
      if (e1) toast.error(e1.message);
      if (e2) toast.error(e2.message);
      if (e3) toast.error(e3.message);
      if (e4) toast.error(e4.message);
      if (e5) toast.error(e5.message);
      setUsers((list as AdminUser[] | null) ?? []);
      setStats(((st as Stats[] | null) ?? [])[0] ?? null);
      setPlatform(((pl as unknown as PlatformStats[] | null) ?? [])[0] ?? null);
      setSeries(((ts as unknown as DailyStat[] | null) ?? []).filter((row) => row.day));
      setTopQuizzes(((tq as unknown as TopQuiz[] | null) ?? []).filter((row) => row.title));
      setTopHosts(((th as unknown as TopHost[] | null) ?? []).filter((row) => row.display_name));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { if (isAdmin) load(); /* eslint-disable-next-line */ }, [isAdmin, range]);

  async function grant(profileId: string, type: "single" | "bundle" | "time", sessions: number | undefined, expiresAt: string | undefined) {
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

  async function extend(authId: string, addSessions: number | undefined, newExpires: string | undefined) {
    const { error } = await supabase.rpc("admin_extend_host_authorization", {
      p_auth_id: authId,
      p_add_sessions: addSessions ?? undefined,
      p_new_expires_at: newExpires ?? undefined,
    });
    if (error) return toast.error(error.message);
    toast.success("Updated");
    load();
  }

  async function convert(authId: string, type: "single" | "bundle" | "time", sessions: number | undefined, expiresAt: string | undefined) {
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

  const summary = useMemo(() => [
    { label: "Active hosts", value: stats?.active_hosts ?? 0 },
    { label: "Expiring 7d", value: stats?.expiring_soon ?? 0 },
    { label: "Single", value: stats?.single_hosts ?? 0 },
    { label: "Bundle", value: stats?.bundle_hosts ?? 0 },
    { label: "Time-based", value: stats?.time_hosts ?? 0 },
  ], [stats]);

  if (loading || !isAdmin) return null;

  return (
    <HostShell title="Admin">
      <div className="max-w-6xl mx-auto px-6 py-10 space-y-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-pink-shock">Restricted</p>
          <h1 className="font-display text-5xl italic uppercase mt-1">Host management</h1>
        </div>

        <section className="space-y-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Host authorizations</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {summary.map((s) => (
              <div key={s.label} className="border border-border bg-card p-4">
                <p className="font-mono text-[10px] uppercase text-foreground/50">{s.label}</p>
                <p className="font-display text-3xl italic text-volt mt-1">{s.value}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Platform overview</h2>
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
          {platform && (platform.pending_host_requests > 0 || platform.expiring_authorizations > 0) && (
            <p className="border border-amber-spark/50 bg-amber-spark/10 p-3 font-mono text-[11px] uppercase tracking-widest text-amber-spark">
              ⚠ {platform.pending_host_requests} pending host request(s) ·{" "}
              {platform.expiring_authorizations} authorization(s) expiring within 14 days
            </p>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <p className="font-mono text-[10px] uppercase text-cyan-jolt">Trends</p>
              <h2 className="font-display text-3xl italic uppercase mt-1">Activity</h2>
            </div>
            <div className="flex gap-1">
              {([7, 14, 30, 90] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setRange(d)}
                  className={`px-3 py-1.5 font-mono text-[10px] uppercase border ${
                    range === d ? "border-volt text-volt" : "border-border text-foreground/60 hover:text-volt"
                  }`}
                >
                  {d}D
                </button>
              ))}
            </div>
          </div>
          {refreshing && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">Refreshing…</p>
          )}
          {series.length === 0 ? (
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
          <div className="border border-border bg-card">
            <div className="p-4 border-b border-border">
              <p className="font-mono text-[10px] uppercase text-volt">Leaderboard</p>
              <h3 className="font-display text-xl italic uppercase mt-1">Top quizzes</h3>
            </div>
            {topQuizzes.length === 0 ? (
              <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">No plays yet</div>
            ) : (
              topQuizzes.map((q, i) => (
                <div key={q.title} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
                  <span className="font-display text-xl italic text-volt w-6 shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-display text-sm italic uppercase truncate">{q.title}</p>
                  </div>
                  {q.is_arena && (
                    <span className="font-mono text-[9px] uppercase border border-volt/30 text-volt px-1.5 py-0.5">Arena</span>
                  )}
                  <span className="font-mono text-xs text-foreground/70">{q.plays.toLocaleString()}</span>
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
              <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">No sessions yet</div>
            ) : (
              topHosts.map((h, i) => (
                <div key={h.display_name} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
                  <span className="font-display text-xl italic text-cyan-jolt w-6 shrink-0">{i + 1}</span>
                  <p className="flex-1 min-w-0 font-display text-sm italic uppercase truncate">{h.display_name}</p>
                  <span className="font-mono text-xs text-foreground/70">
                    {h.sessions.toLocaleString()} {h.sessions === 1 ? "session" : "sessions"}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <HostRequestsPanel onChange={load} />

        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Search by name or email"
            className="flex-1 bg-background border border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt"
          />
          <button onClick={load} className="bg-volt text-background font-display text-base px-5 py-3 skew-cta">
            SEARCH
          </button>
        </div>

        <div className="border border-border">
          {users.length === 0 ? (
            <div className="p-8 text-center text-foreground/50 font-mono text-sm uppercase">No users</div>
          ) : users.map((u) => (
            <UserRow key={u.id} user={u} busy={busy} onGrant={grant} onRevoke={revoke} onExtend={extend} onConvert={convert} />
          ))}
        </div>
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
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} tick={axisTick} tickFormatter={dayTick} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={36} tick={axisTick} />
        <ChartTooltip
          cursor={{ stroke: gridStroke }}
          content={<ChartTooltipContent labelFormatter={(l) => formatDay(String(l))} />}
        />
        <Area dataKey="sessions" type="monotone" stroke="var(--volt)" strokeWidth={2} fill="url(#adminSessions)" />
        <Area dataKey="participants" type="monotone" stroke="var(--cyan-jolt)" strokeWidth={2} fill="url(#adminParticipants)" />
      </AreaChart>
    </ChartContainer>
  );
}

function AnswersChart({ data }: { data: DailyStat[] }) {
  return (
    <ChartContainer config={answersConfig} className="aspect-auto h-52">
      <ComposedChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} tick={axisTick} tickFormatter={dayTick} minTickGap={24} />
        <YAxis yAxisId="count" tickLine={false} axisLine={false} width={36} tick={axisTick} />
        <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} tickLine={false} axisLine={false} width={36} tick={axisTick} tickFormatter={(v) => `${v}%`} />
        <ChartTooltip
          cursor={{ stroke: gridStroke }}
          content={
            <ChartTooltipContent
              labelFormatter={(l) => formatDay(String(l))}
              formatter={(value, name) => (name === "avg_accuracy" ? `${value}%` : Number(value).toLocaleString())}
            />
          }
        />
        <Bar yAxisId="count" dataKey="answers" fill="var(--amber-spark)" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
        <Line yAxisId="pct" dataKey="avg_accuracy" type="monotone" stroke="var(--volt)" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ChartContainer>
  );
}

function RegistrationsChart({ data }: { data: DailyStat[] }) {
  return (
    <ChartContainer config={registrationsConfig} className="aspect-auto h-52">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} tick={axisTick} tickFormatter={dayTick} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={36} tick={axisTick} />
        <ChartTooltip
          cursor={{ stroke: gridStroke }}
          content={<ChartTooltipContent labelFormatter={(l) => formatDay(String(l))} />}
        />
        <Bar dataKey="new_players" fill="var(--pink-shock)" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function ResponseChart({ data }: { data: DailyStat[] }) {
  return (
    <ChartContainer config={responseConfig} className="aspect-auto h-52">
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={gridStroke} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} tick={axisTick} tickFormatter={dayTick} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={36} tick={axisTick} />
        <ChartTooltip
          cursor={{ stroke: gridStroke }}
          content={
            <ChartTooltipContent
              labelFormatter={(l) => formatDay(String(l))}
              formatter={(value) => `${Number(value).toLocaleString()} ms`}
            />
          }
        />
        <Line dataKey="avg_response_ms" type="monotone" stroke="var(--cyan-jolt)" strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ChartContainer>
  );
}

function formatDay(day: string) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function UserRow({
  user, busy, onGrant, onRevoke, onExtend, onConvert,
}: {
  user: AdminUser;
  busy: boolean;
  onGrant: (profileId: string, type: "single" | "bundle" | "time", sessions: number | undefined, expiresAt: string | undefined) => void;
  onRevoke: (authId: string) => void;
  onExtend: (authId: string, addSessions: number | undefined, newExpires: string | undefined) => void;
  onConvert: (authId: string, type: "single" | "bundle" | "time", sessions: number | undefined, expiresAt: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"single" | "bundle" | "time">("single");
  const [sessions, setSessions] = useState(5);
  const [expires, setExpires] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1);
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
          <p className="font-display text-lg italic uppercase truncate">{user.display_name || user.email}</p>
          <p className="font-mono text-xs text-foreground/50 truncate">{user.email}</p>
        </div>
        <div className="text-right">
          <p className={`font-mono text-xs uppercase ${user.is_active ? "text-volt" : "text-foreground/50"}`}>{status}</p>
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
                  type="number" min={1} value={sessions}
                  onChange={(e) => setSessions(parseInt(e.target.value) || 1)}
                  className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs"
                />
              </label>
            )}
            {type === "time" && (
              <label className="block">
                <span className="font-mono text-[10px] uppercase text-foreground/60">Expires</span>
                <input
                  type="date" value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs"
                />
              </label>
            )}
            <button
              disabled={busy}
              onClick={() => onGrant(
                user.id, type,
                type === "bundle" ? sessions : type === "single" ? 1 : undefined,
                type === "time" ? new Date(expires).toISOString() : undefined,
              )}
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
                onClick={() => onConvert(
                  user.auth_id!, type,
                  type === "bundle" ? sessions : type === "single" ? 1 : undefined,
                  type === "time" ? new Date(expires).toISOString() : undefined,
                )}
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
    const { data, error } = await supabase.rpc("admin_list_host_requests" as never, {
      p_status: filter === "all" ? null : filter,
    } as never);
    if (error) return toast.error(error.message);
    setItems((data as HostRequest[] | null) ?? []);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  async function approve(id: string) {
    setBusyId(id);
    const { error } = await supabase.rpc("admin_approve_host_request" as never, { p_request_id: id } as never);
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success("Approved · 90-day access granted");
    load(); onChange();
  }

  async function reject(id: string) {
    if (!confirm("Reject this hosting request?")) return;
    setBusyId(id);
    const { error } = await supabase.rpc("admin_reject_host_request" as never, { p_request_id: id } as never);
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
                filter === f ? "border-volt text-volt" : "border-border text-foreground/60 hover:text-volt"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">No {filter === "all" ? "" : filter} requests</div>
      ) : (
        <div>
          {items.map((r) => (
            <div key={r.id} className="border-b border-border last:border-b-0 p-4 space-y-2">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="font-display text-base italic uppercase truncate">{r.organization}</p>
                  <p className="font-mono text-[11px] text-foreground/60 truncate">
                    {r.display_name || r.email} · {r.email}
                  </p>
                  <p className="font-mono text-[10px] uppercase text-foreground/50 mt-1">
                    {r.purpose} · {r.expected_participants} · {new Date(r.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span className={`font-mono text-[10px] uppercase px-2 py-1 border ${
                  r.status === "pending" ? "border-cyan-jolt text-cyan-jolt"
                  : r.status === "approved" ? "border-volt text-volt"
                  : "border-pink-shock text-pink-shock"
                }`}>{r.status}</span>
              </div>
              {r.message && <p className="text-foreground/70 text-sm whitespace-pre-wrap">{r.message}</p>}
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

