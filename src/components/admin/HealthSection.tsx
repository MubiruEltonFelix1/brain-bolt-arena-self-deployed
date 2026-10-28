import { useEffect, useState, useCallback } from "react";
import { logActionError } from "@/lib/errors";
import { Skeleton } from "@/components/ui/skeleton";
import {
  adminHealthOverview,
  adminHealthStuckLobby,
  adminHealthFrozenActive,
  adminHealthSlowQuestions,
  adminHealthAnswerGaps,
} from "@/lib/api/ai.functions";

type HealthOverview = {
  totalSessions7d: number;
  stuckLobbySessions: number;
  frozenActiveSessions: number;
  avgResponseMs7d: number | null;
  slowQuestionSessions: number;
  completionRate7d: number | null;
};

type StuckLobbyRow = {
  session_id: string;
  code: string;
  quiz_title: string;
  host_id: string;
  participant_count: number;
  minutes_stuck: number;
  created_at: string;
};

type FrozenActiveRow = {
  session_id: string;
  code: string;
  quiz_title: string;
  current_question_index: number;
  current_question_started_at: string | null;
  participant_count: number;
  minutes_on_question: number;
};

type SlowQuestionRow = {
  question_id: string;
  question_text: string;
  session_code: string;
  current_question_index: number;
  answer_count: number;
  avg_response_ms: number;
  max_response_ms: number;
  pct_slow_answers: number;
};

type AnswerGapRow = {
  session_id: string;
  code: string;
  quiz_title: string;
  question_id: string;
  gap_seconds: number;
  participant_count: number;
  latest_answer_at: string;
};

export function HealthSection() {
  const [overview, setOverview] = useState<HealthOverview | null>(null);
  const [stuckLobby, setStuckLobby] = useState<StuckLobbyRow[]>([]);
  const [frozenActive, setFrozenActive] = useState<FrozenActiveRow[]>([]);
  const [slowQuestions, setSlowQuestions] = useState<SlowQuestionRow[]>([]);
  const [answerGaps, setAnswerGaps] = useState<AnswerGapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        overviewResult,
        stuckResult,
        frozenResult,
        slowResult,
        gapResult,
      ] = await Promise.all([
        adminHealthOverview({}),
        adminHealthStuckLobby({ data: { minutesStuck: 15 } }),
        adminHealthFrozenActive({ data: { minutesStuck: 10 } }),
        adminHealthSlowQuestions({ data: { days: 7, msThreshold: 60000 } }),
        adminHealthAnswerGaps({ data: { days: 7, gapSeconds: 300 } }),
      ]) as [
        Awaited<ReturnType<typeof adminHealthOverview>>,
        Awaited<ReturnType<typeof adminHealthStuckLobby>>,
        Awaited<ReturnType<typeof adminHealthFrozenActive>>,
        Awaited<ReturnType<typeof adminHealthSlowQuestions>>,
        Awaited<ReturnType<typeof adminHealthAnswerGaps>>,
      ];

      if (overviewResult.error) {
        logActionError(overviewResult.error, "admin_health_overview");
        setError("Failed to load health overview. Try again.");
      } else if (overviewResult.overview) {
        setOverview(overviewResult.overview);
      }

      if (stuckResult.error) {
        logActionError(stuckResult.error, "admin_health_stuck_lobby");
      } else if (stuckResult.rows) {
        setStuckLobby(stuckResult.rows as StuckLobbyRow[]);
      }

      if (frozenResult.error) {
        logActionError(frozenResult.error, "admin_health_frozen_active");
      } else if (frozenResult.rows) {
        setFrozenActive(frozenResult.rows as FrozenActiveRow[]);
      }

      if (slowResult.error) {
        logActionError(slowResult.error, "admin_health_slow_questions");
      } else if (slowResult.rows) {
        setSlowQuestions(slowResult.rows as SlowQuestionRow[]);
      }

      if (gapResult.error) {
        logActionError(gapResult.error, "admin_health_answer_gaps");
      } else if (gapResult.rows) {
        setAnswerGaps(gapResult.rows as AnswerGapRow[]);
      }
    } catch (err) {
      logActionError(err, "admin_health_load");
      setError("Failed to load health diagnostics. Try again.");
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

  const statusColor = (value: number, thresholds: { ok: number; warn: number }) => {
    if (value <= thresholds.ok) return "text-volt";
    if (value <= thresholds.warn) return "text-amber-spark";
    return "text-pink-shock";
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

      {/* Health header + refresh */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            System health
          </p>
          <h2 className="font-display text-3xl italic uppercase">Diagnostics</h2>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="text-foreground/40 hover:text-volt disabled:opacity-50 transition-colors font-mono text-xs uppercase"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Overview stat cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <StatCard key={i} loading label="—" value="—" accent="volt" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            label="Sessions (last 7d)"
            value={overview?.totalSessions7d ?? "—"}
            accent="volt"
            loading={false}
          />
          <StatCard
            label="Completion rate"
            value={
              overview?.completionRate7d != null
                ? `${overview.completionRate7d}%`
                : "—"
            }
            accent={
              overview?.completionRate7d == null
                ? "volt"
                : overview.completionRate7d >= 90
                  ? "volt"
                  : overview.completionRate7d >= 70
                    ? "amber-spark"
                    : "pink-shock"
            }
            loading={false}
          />
          <StatCard
            label="Avg response time"
            value={
              overview?.avgResponseMs7d != null
                ? `${overview.avgResponseMs7d.toFixed(0)}ms`
                : "—"
            }
            accent={
              overview?.avgResponseMs7d == null
                ? "volt"
                : overview.avgResponseMs7d <= 5000
                  ? "volt"
                  : overview.avgResponseMs7d <= 15000
                    ? "amber-spark"
                    : "pink-shock"
            }
            loading={false}
          />
        </div>
      )}

      {/* Critical issues strip */}
      {overview && !loading && (
        <div className="border border-border bg-card p-4 space-y-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              Critical issues
            </p>
            <h3 className="font-display text-lg italic uppercase mt-1">Attention needed</h3>
          </div>
          <div className="mt-3 space-y-2">
            {overview.stuckLobbySessions > 0 ? (
              <IssueRow
                label="Sessions stuck in lobby"
                count={overview.stuckLobbySessions}
                accent="amber-spark"
                detail={`${overview.stuckLobbySessions} session(s) with players waiting &gt;15 min`}
              />
            ) : (
              <IssueRow label="Sessions stuck in lobby" count={0} accent="volt" detail="None" />
            )}
            {overview.frozenActiveSessions > 0 ? (
              <IssueRow
                label="Active sessions frozen on a question"
                count={overview.frozenActiveSessions}
                accent="pink-shock"
                detail={`${overview.frozenActiveSessions} session(s) stuck &gt;10 min on one question`}
              />
            ) : (
              <IssueRow
                label="Active sessions frozen on a question"
                count={0}
                accent="volt"
                detail="None"
              />
            )}
            {overview.slowQuestionSessions > 0 ? (
              <IssueRow
                label="Sessions with slow/frozen questions"
                count={overview.slowQuestionSessions}
                accent="amber-spark"
                detail={`${overview.slowQuestionSessions} session(s) with &gt;60s answer times`}
              />
            ) : (
              <IssueRow
                label="Sessions with slow/frozen questions"
                count={0}
                accent="volt"
                detail="None"
              />
            )}
          </div>
        </div>
      )}

      {/* Stuck lobby sessions */}
      <SectionCard title="Stuck in lobby" subtitle="Players waiting, host never started">
        {loading ? (
          <div className="p-8"><Skeleton className="h-32 w-full" /></div>
        ) : stuckLobby.length === 0 ? (
          <EmptyStateMessage message="No sessions stuck in lobby." />
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Code</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Quiz</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Players</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Stuck (min)</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Started</th>
              </tr>
            </thead>
            <tbody>
              {stuckLobby.map((r) => (
                <tr key={r.session_id} className="border-b border-border/50 last:border-b-0">
                  <td className="px-4 py-3 font-mono text-xs text-volt">{r.code}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/70 truncate max-w-xs">{r.quiz_title}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground text-right">{r.participant_count}</td>
                  <td className="px-4 py-3 font-mono text-xs text-amber-spark text-right">{r.minutes_stuck}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/60">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* Frozen active sessions */}
      <SectionCard title="Frozen active sessions" subtitle="Stuck on one question for &gt;10 min">
        {loading ? (
          <div className="p-8"><Skeleton className="h-32 w-full" /></div>
        ) : frozenActive.length === 0 ? (
          <EmptyStateMessage message="No active sessions are frozen." />
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Code</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Quiz</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Q index</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">On Q (min)</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Players</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Started</th>
              </tr>
            </thead>
            <tbody>
              {frozenActive.map((r) => (
                <tr key={r.session_id} className="border-b border-border/50 last:border-b-0">
                  <td className="px-4 py-3 font-mono text-xs text-pink-shock">{r.code}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/70 truncate max-w-xs">{r.quiz_title}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/60">{r.current_question_index}</td>
                  <td className="px-4 py-3 font-mono text-xs text-pink-shock text-right">{r.minutes_on_question}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground text-right">{r.participant_count}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/60">
                    {r.current_question_started_at ? new Date(r.current_question_started_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* Slow questions */}
      <SectionCard title="Slow / frozen questions" subtitle="Avg response time &gt; threshold, last 7d">
        {loading ? (
          <div className="p-8"><Skeleton className="h-32 w-full" /></div>
        ) : slowQuestions.length === 0 ? (
          <EmptyStateMessage message="No abnormally slow questions detected." />
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Session</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Question</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Answers</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Avg (ms)</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Max (ms)</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">% slow</th>
              </tr>
            </thead>
            <tbody>
              {slowQuestions.map((r) => (
                <tr key={r.question_id} className="border-b border-border/50 last:border-b-0">
                  <td className="px-4 py-3 font-mono text-xs text-volt">{r.session_code}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/70 truncate max-w-xs">{r.question_text}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground text-right">{r.answer_count}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground text-right">{r.avg_response_ms}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/60 text-right">{r.max_response_ms}</td>
                  <td className="px-4 py-3 font-mono text-xs text-amber-spark text-right">{r.pct_slow_answers}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* Answer gaps */}
      <SectionCard title="Long answer gaps" subtitle="Possible freezes / manual advance, last 7d (&gt;5min gap)">
        {loading ? (
          <div className="p-8"><Skeleton className="h-32 w-full" /></div>
        ) : answerGaps.length === 0 ? (
          <EmptyStateMessage message="No unusual answer gaps detected." />
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Code</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Quiz</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Gap (s)</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30 text-right">Players</th>
                <th className="px-4 py-3 font-mono text-[10px] uppercase text-foreground/40 border-b border-border bg-background/30">Last answer</th>
              </tr>
            </thead>
            <tbody>
              {answerGaps.map((r) => (
                <tr key={r.session_id} className="border-b border-border/50 last:border-b-0">
                  <td className="px-4 py-3 font-mono text-xs text-volt">{r.code}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/70 truncate max-w-xs">{r.quiz_title}</td>
                  <td className="px-4 py-3 font-mono text-xs text-amber-spark text-right">{r.gap_seconds}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground text-right">{r.participant_count}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground/60">
                    {new Date(r.latest_answer_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40 max-w-2xl">
        All diagnostics are derived from live tables — no separate metrics store. "Stuck in lobby"
        means a session with players that never advanced past the lobby. "Frozen active" means an
        active session that has not advanced off one question for over 10 minutes — a likely host
        freeze or a question that never auto-advanced.
      </p>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border bg-card">
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-border">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">{subtitle}</p>
          <h2 className="font-display text-xl italic uppercase mt-1">{title}</h2>
        </div>
      </div>
      <div className="p-4">{children}</div>
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

function IssueRow({
  label,
  count,
  accent,
  detail,
}: {
  label: string;
  count: number;
  accent: "volt" | "amber-spark" | "pink-shock";
  detail: string;
}) {
  const accentColors: Record<string, { bg: string; text: string; border: string }> = {
    volt: { bg: "bg-volt/10", text: "text-volt", border: "border-volt/30" },
    "amber-spark": { bg: "bg-amber-spark/10", text: "text-amber-spark", border: "border-amber-spark/30" },
    "pink-shock": { bg: "bg-pink-shock/10", text: "text-pink-shock", border: "border-pink-shock/30" },
  };
  const c = accentColors[accent];
  const ok = count === 0;
  return (
    <div className={`flex items-center justify-between px-3 py-2 rounded-md border ${c.bg} ${c.border}`}>
      <div>
        <p className={`font-mono text-[10px] uppercase ${ok ? "text-foreground/50" : c.text}`}>{label}</p>
        <p className={`font-display text-lg italic ${ok ? "text-foreground" : c.text}`}>
          {ok ? "None" : count.toLocaleString()}
        </p>
      </div>
      <span className={`font-mono text-[10px] uppercase ${c.text}`}>{detail}</span>
    </div>
  );
}

function EmptyStateMessage({ message }: { message: string }) {
  return (
    <div className="border border-border bg-card p-8 text-center font-mono text-xs uppercase text-foreground/40">
      {message}
    </div>
  );
}