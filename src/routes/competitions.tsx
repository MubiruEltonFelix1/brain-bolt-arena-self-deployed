import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { EmptyState, SkeletonList } from "@/components/EmptyState";
import { useHostStatus } from "@/hooks/use-host-status";
import { toast } from "sonner";


export const Route = createFileRoute("/competitions")({
  component: CompetitionsPage,
  head: () => ({
    meta: [
      { title: "Scheduled Competitions · BrainBolt" },
      { name: "description", content: "Schedule and manage upcoming BrainBolt competitions." },
      { property: "og:title", content: "Scheduled Competitions · BrainBolt" },
      { property: "og:description", content: "Schedule and manage upcoming BrainBolt competitions." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Quiz = { id: string; title: string };
type LeagueOption = { id: string; name: string };
type Competition = {
  id: string;
  title: string;
  status: "draft" | "scheduled" | "lobby_open" | "running" | "completed" | "cancelled";
  mode: "hosted" | "arena" | "scheduled";
  visibility: "private" | "unlisted" | "public";
  scheduled_start_at: string | null;
  lobby_duration_seconds: number;
  quiz_id: string;
  session_id: string | null;
  league_id: string | null;
  quizzes?: { title: string } | null;
  leagues?: { name: string } | null;
  sessions?: { code: string; status: string } | null;
};

function lobbyOpensAt(c: Competition): Date | null {
  if (!c.scheduled_start_at) return null;
  return new Date(new Date(c.scheduled_start_at).getTime() - c.lobby_duration_seconds * 1000);
}


const STATUS_COLOR: Record<Competition["status"], string> = {
  draft: "text-foreground/50 border-border",
  scheduled: "text-volt border-volt/40",
  lobby_open: "text-pink-shock border-pink-shock/40",
  running: "text-pink-shock border-pink-shock/60",
  completed: "text-foreground/40 border-border",
  cancelled: "text-foreground/30 border-border",
};

function CompetitionsPage() {
  const { user, canHost, loading: hostLoading } = useHostStatus();
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [comps, setComps] = useState<Competition[]>([]);
  const [leagues, setLeagues] = useState<LeagueOption[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);

  const navigate = useNavigate();
  const [preparingId, setPreparingId] = useState<string | null>(null);

  async function load() {
    if (!user) return;
    const [{ data: qs }, { data: cs }, { data: ls }] = await Promise.all([
      supabase.from("quizzes").select("id,title").eq("owner_id", user.id).is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("competitions").select("id,title,status,mode,visibility,scheduled_start_at,lobby_duration_seconds,quiz_id,session_id,league_id,quizzes(title),leagues(name),sessions(code,status)").eq("owner_id", user.id).order("scheduled_start_at", { ascending: true, nullsFirst: false }),
      supabase.from("leagues").select("id,name").eq("owner_id", user.id).is("archived_at", null).order("created_at", { ascending: false }),
    ]);
    setLeagues((ls as LeagueOption[] | null) ?? []);
    setQuizzes((qs as Quiz[] | null) ?? []);
    setComps((cs as unknown as Competition[] | null) ?? []);
    setLoading(false);
  }

  useEffect(() => { if (!hostLoading) load(); /* eslint-disable-next-line */ }, [user?.id, hostLoading]);

  const { upcoming, past } = useMemo(() => {
    const up: Competition[] = [];
    const pa: Competition[] = [];
    for (const c of comps) {
      if (c.status === "completed" || c.status === "cancelled") pa.push(c);
      else up.push(c);
    }
    return { upcoming: up, past: pa };
  }, [comps]);

  async function prepareSession(c: Competition, force: boolean) {
    setPreparingId(c.id);
    const { data, error } = await supabase.rpc("prepare_competition_session", {
      p_competition_id: c.id,
      p_force: force,
    });
    setPreparingId(null);
    if (error) return toast.error(error.message);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return toast.error("Could not prepare the session");
    toast.success(row.created ? `Lobby open · code ${row.code}` : `Lobby already open · code ${row.code}`);
    await load();
    navigate({ to: "/host/$sessionId", params: { sessionId: row.session_id } });
  }

  async function cancelCompetition(id: string) {
    if (!confirm("Cancel this competition?")) return;
    const { error } = await supabase
      .from("competitions")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Cancelled");
    load();
  }

  async function deleteCompetition(id: string) {
    if (!confirm("Delete this competition permanently?")) return;
    const { error } = await supabase.from("competitions").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    load();
  }


  return (
    <HostShell title="Competitions">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-10">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-volt">Scheduling</p>
            <h1 className="font-display text-5xl italic uppercase mt-1">Competitions</h1>
            <p className="text-foreground/60 text-sm mt-2 max-w-xl">
              Schedule competitions in advance. When it&apos;s time, open the lobby and launch through the normal host flow.
            </p>
          </div>
          <button
            disabled={!canHost || quizzes.length === 0}
            onClick={() => setShowForm((s) => !s)}
            className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            title={!canHost ? "Hosting not authorized" : quizzes.length === 0 ? "Create a quiz first" : undefined}
          >
            {showForm ? "CLOSE" : "+ SCHEDULE"}
          </button>
        </div>

        {showForm && (
          <CreateCompetitionForm
            quizzes={quizzes}
            leagues={leagues}
            onCreated={() => { setShowForm(false); load(); }}
          />
        )}

        <section className="space-y-4">
          <h2 className="font-display text-2xl italic uppercase">Upcoming</h2>
          {loading ? (
            <SkeletonList rows={2} height="h-28" />
          ) : upcoming.length === 0 ? (
            <EmptyState
              eyebrow="Scheduled play"
              title="Nothing on the calendar"
              body="Schedule a competition to open its lobby automatically at the right moment. Players join with the game code you share — scheduled competitions are never listed publicly."
            />
          ) : (
            <div className="grid gap-3">
              {upcoming.map((c) => (
                <CompetitionRow key={c.id} c={c} preparing={preparingId === c.id}
                  onPrepare={(force) => prepareSession(c, force)}
                  onCancel={() => cancelCompetition(c.id)} onDelete={() => deleteCompetition(c.id)} />
              ))}
            </div>
          )}
        </section>

        {past.length > 0 && (
          <section className="space-y-4 pt-6 border-t border-border">
            <h2 className="font-display text-2xl italic uppercase text-foreground/70">History</h2>
            <div className="grid gap-3">
              {past.map((c) => (
                <CompetitionRow key={c.id} c={c} preparing={false}
                  onPrepare={() => {}}
                  onCancel={() => cancelCompetition(c.id)} onDelete={() => deleteCompetition(c.id)} />
              ))}
            </div>
          </section>
        )}

        <p className="font-mono text-[10px] uppercase text-foreground/40 pt-4 border-t border-border">
          Lobbies are prepared from this page — one session per competition, safe to retry. Ad-hoc games still start from{" "}
          <Link to="/dashboard" className="text-volt underline">Quizzes</Link>.
        </p>
      </div>
    </HostShell>
  );
}

function CompetitionRow({ c, preparing, onPrepare, onCancel, onDelete }: {
  c: Competition;
  preparing: boolean;
  onPrepare: (force: boolean) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const when = c.scheduled_start_at ? new Date(c.scheduled_start_at) : null;
  const lobbyAt = lobbyOpensAt(c);
  const due = !!lobbyAt && lobbyAt.getTime() <= Date.now();
  const canPrepare = !c.session_id && c.status !== "completed" && c.status !== "cancelled" && c.status !== "running";
  return (
    <div className="bg-card border border-border p-5 flex flex-col gap-3 md:flex-row md:items-center">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-display text-xl italic uppercase truncate">{c.title}</h3>
          <span className={`font-mono text-[10px] uppercase px-2 py-0.5 border ${STATUS_COLOR[c.status]}`}>{c.status.replace("_", " ")}</span>
          <span className="font-mono text-[10px] uppercase px-2 py-0.5 border border-border text-foreground/50">{c.mode}</span>
          <span className="font-mono text-[10px] uppercase px-2 py-0.5 border border-border text-foreground/50">{c.visibility}</span>
          {c.leagues?.name && (
            <span className="font-mono text-[10px] uppercase px-2 py-0.5 border border-cyan-jolt/40 text-cyan-jolt">league · {c.leagues.name}</span>
          )}
          {c.mode === "scheduled" && c.scheduled_start_at && (
            <span className="font-mono text-[10px] uppercase px-2 py-0.5 border border-volt/40 text-volt" title="Starts and advances automatically — no browser needed">
              auto-run
            </span>
          )}
        </div>
        <p className="font-mono text-xs uppercase text-foreground/50 mt-2">
          {c.quizzes?.title ?? "—"} · starts {when ? when.toLocaleString() : "no time set"} · lobby opens {lobbyAt ? lobbyAt.toLocaleTimeString() : "—"}
        </p>

        {c.session_id && (
          <p className="font-mono text-xs uppercase text-volt mt-1">
            Join code {c.sessions?.code ?? "—"} ·{" "}
            <Link to="/host/$sessionId" params={{ sessionId: c.session_id }} className="underline">open host screen</Link>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {canPrepare && (
          <button
            disabled={preparing}
            onClick={() => onPrepare(!due)}
            className="bg-volt text-background font-mono text-xs uppercase px-3 py-2 active:scale-95 disabled:opacity-40"
            title={due ? "Lobby time reached" : "Open the lobby ahead of schedule"}
          >
            {preparing ? "Opening…" : due ? "Open lobby" : "Open early"}
          </button>
        )}
        {c.status !== "completed" && c.status !== "cancelled" && (
          <button onClick={onCancel} className="border border-border px-3 py-2 font-mono text-xs uppercase text-foreground/60 hover:border-pink-shock hover:text-pink-shock">
            Cancel
          </button>
        )}
        <button onClick={onDelete} title="Delete" aria-label="Delete" className="border border-border px-3 py-2 font-mono text-xs uppercase text-foreground/60 hover:border-pink-shock hover:text-pink-shock">
          ✕
        </button>
      </div>
    </div>
  );

}

function CreateCompetitionForm({ quizzes, leagues, onCreated }: { quizzes: Quiz[]; leagues: LeagueOption[]; onCreated: () => void }) {
  const { user } = useHostStatus();
  const [title, setTitle] = useState("");
  const [quizId, setQuizId] = useState(quizzes[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [lobbyMin, setLobbyMin] = useState(5);
  const [visibility, setVisibility] = useState<"private" | "unlisted" | "public">("private");
  const [leagueId, setLeagueId] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!title.trim() || !quizId || !date || !time) {
      toast.error("Fill title, quiz, date and time");
      return;
    }
    const localIso = new Date(`${date}T${time}`);
    if (isNaN(localIso.getTime())) return toast.error("Invalid date/time");
    if (localIso.getTime() < Date.now() - 60_000) return toast.error("Pick a future time");

    setSaving(true);
    const { error } = await supabase.from("competitions").insert({
      owner_id: user.id,
      quiz_id: quizId,
      title: title.trim(),
      mode: "scheduled",
      status: "scheduled",
      visibility,
      scheduled_start_at: localIso.toISOString(),
      league_id: leagueId || null,
      lobby_duration_seconds: Math.max(30, Math.min(3600, Math.round(lobbyMin * 60))),
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Competition scheduled");
    onCreated();
  }

  return (
    <form onSubmit={submit} className="border border-volt/40 bg-card p-6 space-y-4">
      <h2 className="font-display text-2xl italic uppercase">Schedule a competition</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Friday Night Trivia"
            className="w-full bg-background border border-border px-3 py-2 focus:outline-none focus:border-volt" />
        </label>
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Quiz</span>
          <select value={quizId} onChange={(e) => setQuizId(e.target.value)}
            className="w-full bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt">
            {quizzes.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="w-full bg-background border border-border px-3 py-2 focus:outline-none focus:border-volt" />
        </label>
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Time</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
            className="w-full bg-background border border-border px-3 py-2 focus:outline-none focus:border-volt" />
        </label>
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Lobby duration (minutes)</span>
          <input type="number" min={1} max={60} value={lobbyMin} onChange={(e) => setLobbyMin(Number(e.target.value))}
            className="w-full bg-background border border-border px-3 py-2 focus:outline-none focus:border-volt" />
        </label>
        {leagues.length > 0 && (
          <label className="space-y-1">
            <span className="font-mono text-[10px] uppercase text-foreground/60">League (optional)</span>
            <select value={leagueId} onChange={(e) => setLeagueId(e.target.value)}
              className="w-full bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt">
              <option value="">No league</option>
              {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Visibility</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}
            className="w-full bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt">
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </label>
      </div>
      <button disabled={saving} className="bg-volt text-background font-display text-base px-5 py-2.5 skew-cta active:scale-95 disabled:opacity-40">
        {saving ? "SAVING…" : "SCHEDULE COMPETITION"}
      </button>
    </form>
  );
}
