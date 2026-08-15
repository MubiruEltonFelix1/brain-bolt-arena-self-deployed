import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useAuthUser } from "@/hooks/use-auth-user";
import { toast } from "sonner";

export const Route = createFileRoute("/leagues/$id")({
  component: LeagueDetail,
});

type LeagueStatus = "draft" | "registration_open" | "active" | "completed";
type LeagueVisibility = "public" | "private";
type League = {
  id: string;
  name: string;
  description: string | null;
  season: string | null;
  owner_id: string;
  status: LeagueStatus;
  visibility: LeagueVisibility;
  start_date: string | null;
  end_date: string | null;
  cover_image_url: string | null;
  points_first: number;
  points_second: number;
  points_third: number;
  points_participation: number;
  archived_at: string | null;
};
type Standing = {
  standing_position: number;
  profile_id: string;
  display_name: string;
  avatar_id: string | null;
  league_points: number;
  competitions_played: number;
  wins: number;
  podiums: number;
  total_score: number;
  avg_accuracy: number | null;
};
type Overview = {
  participant_count: number;
  competitions_total: number;
  competitions_completed: number;
  competitions_upcoming: number;
};
type LeagueCompetition = {
  id: string;
  title: string;
  status: string;
  scheduled_start_at: string | null;
  session_id: string | null;
};
type LeagueQuiz = { id: string; quiz_id: string; position: number; quiz: { id: string; title: string } };
type Quiz = { id: string; title: string };

const STATUS_LABEL: Record<LeagueStatus, string> = {
  draft: "Draft",
  registration_open: "Registration Open",
  active: "Active",
  completed: "Completed",
};
const VALID_NEXT: Record<LeagueStatus, LeagueStatus[]> = {
  draft: ["registration_open", "active"],
  registration_open: ["active", "draft"],
  active: ["completed"],
  completed: [],
};

function LeagueDetail() {
  const { id } = Route.useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [league, setLeague] = useState<League | null>(null);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [comps, setComps] = useState<LeagueCompetition[]>([]);
  const [leagueQuizzes, setLeagueQuizzes] = useState<LeagueQuiz[]>([]);
  const [myQuizzes, setMyQuizzes] = useState<Quiz[]>([]);
  const [addQuizId, setAddQuizId] = useState("");
  const [editing, setEditing] = useState(false);

  async function load() {
    const { data: l } = await supabase.from("leagues").select("*").eq("id", id).maybeSingle();
    if (!l) return navigate({ to: "/leagues" });
    setLeague(l as League);
    const [{ data: s }, { data: ov }, { data: cs }, { data: lq }] = await Promise.all([
      supabase.rpc("get_league_standings", { p_league_id: id }),
      supabase.rpc("get_league_overview", { p_league_id: id }),
      supabase
        .from("competitions")
        .select("id,title,status,scheduled_start_at,session_id")
        .eq("league_id", id)
        .order("scheduled_start_at", { ascending: true, nullsFirst: false }),
      supabase
        .from("league_quizzes")
        .select("id,quiz_id,position,quiz:quizzes(id,title)")
        .eq("league_id", id)
        .order("position"),
    ]);
    setStandings((s as Standing[] | null) ?? []);
    setOverview((Array.isArray(ov) ? (ov[0] as Overview) : null) ?? null);
    setComps((cs as LeagueCompetition[] | null) ?? []);
    setLeagueQuizzes((lq as unknown as LeagueQuiz[] | null) ?? []);
  }

  async function loadMyQuizzes() {
    if (!user) return;
    const { data } = await supabase
      .from("quizzes")
      .select("id,title")
      .eq("owner_id", user.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false });
    setMyQuizzes((data as Quiz[] | null) ?? []);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { loadMyQuizzes(); /* eslint-disable-next-line */ }, [user?.id]);

  useEffect(() => {
    const ch = supabase
      .channel(`league:${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "competitions", filter: `league_id=eq.${id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line
  }, [id]);

  async function changeStatus(next: LeagueStatus) {
    const { error } = await supabase.from("leagues").update({ status: next } as never).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success(`Status → ${STATUS_LABEL[next]}`);
    load();
  }

  async function addQuiz() {
    if (!addQuizId) return;
    if (leagueQuizzes.some((q) => q.quiz_id === addQuizId)) return toast.error("Quiz already in league");
    const nextPos = (leagueQuizzes.at(-1)?.position ?? -1) + 1;
    const { error } = await supabase.from("league_quizzes").insert({
      league_id: id, quiz_id: addQuizId, position: nextPos,
    } as never);
    if (error) return toast.error(error.message);
    setAddQuizId("");
    load();
  }

  async function removeQuiz(lqId: string) {
    if (!confirm("Remove this quiz from the league? The original quiz is not deleted.")) return;
    const { error } = await supabase.from("league_quizzes").delete().eq("id", lqId);
    if (error) return toast.error(error.message);
    load();
  }

  async function move(lqId: string, dir: -1 | 1) {
    const idx = leagueQuizzes.findIndex((q) => q.id === lqId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= leagueQuizzes.length) return;
    const a = leagueQuizzes[idx]; const b = leagueQuizzes[swapIdx];
    // Two-step swap to avoid unique-index conflicts if you ever add one on position
    const { error: e1 } = await supabase.from("league_quizzes").update({ position: b.position } as never).eq("id", a.id);
    const { error: e2 } = await supabase.from("league_quizzes").update({ position: a.position } as never).eq("id", b.id);
    if (e1 || e2) return toast.error((e1 || e2)!.message);
    load();
  }

  async function toggleArchive() {
    if (!league) return;
    const next = league.archived_at ? null : new Date().toISOString();
    const { error } = await supabase
      .from("leagues")
      .update({ archived_at: next, ...(next ? { status: "completed" as const } : {}) } as never)
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success(next ? "Season archived" : "Season reopened");
    load();
  }

  async function deleteLeague() {
    if (!confirm("Delete this league? All standings and quiz attachments will be removed.")) return;
    await supabase.from("leagues").delete().eq("id", id);
    navigate({ to: "/leagues" });
  }

  if (!league) return <HostShell><div className="p-12 font-mono text-sm">LOADING...</div></HostShell>;

  const isOwner = user?.id === league.owner_id;
  const attachedIds = new Set(leagueQuizzes.map((q) => q.quiz_id));
  const availableQuizzes = myQuizzes.filter((q) => !attachedIds.has(q.id));

  return (
    <HostShell title="League">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        <Link to="/leagues" className="font-mono text-xs uppercase text-foreground/60 hover:text-volt">← All leagues</Link>

        {league.cover_image_url && (
          <img src={league.cover_image_url} alt={league.name} className="w-full max-h-56 object-cover border border-border" />
        )}

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="font-mono text-xs uppercase text-volt">{STATUS_LABEL[league.status]} · {league.visibility}</p>
            <h1 className="font-display text-5xl italic uppercase">{league.name}</h1>
            {league.description && <p className="text-foreground/70 text-sm mt-2 max-w-xl">{league.description}</p>}
            {(league.start_date || league.end_date) && (
              <p className="font-mono text-xs uppercase text-foreground/40 mt-2">
                {league.start_date ?? "—"} → {league.end_date ?? "—"}
              </p>
            )}
          </div>
          {isOwner && (
            <div className="flex flex-col gap-2 items-end">
              <button onClick={() => setEditing((e) => !e)} className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt">
                {editing ? "Close editor" : "Edit league"}
              </button>
              {VALID_NEXT[league.status].length > 0 && (
                <div className="flex gap-2">
                  {VALID_NEXT[league.status].map((s) => (
                    <button key={s} onClick={() => changeStatus(s)}
                      className="bg-volt text-background font-mono text-[10px] uppercase px-3 py-2 skew-cta">
                      → {STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {isOwner && editing && <EditLeagueForm league={league} onSaved={() => { setEditing(false); load(); }} />}

        {/* Overview stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Status" value={league.archived_at ? "Archived" : STATUS_LABEL[league.status]} />
          <StatCard label="Competitions" value={`${overview?.competitions_completed ?? 0}/${overview?.competitions_total ?? 0}`} />
          <StatCard label="Participants" value={String(overview?.participant_count ?? 0)} />
          <StatCard label="Scoring" value={`${league.points_first}/${league.points_second}/${league.points_third}`} />
        </div>

        {/* Season progress */}
        {overview && overview.competitions_total > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between font-mono text-[10px] uppercase text-foreground/50">
              <span>Season progress</span>
              <span>{overview.competitions_completed} of {overview.competitions_total} played</span>
            </div>
            <div className="h-2 bg-card border border-border">
              <div className="h-full bg-volt" style={{ width: `${Math.round((overview.competitions_completed / Math.max(1, overview.competitions_total)) * 100)}%` }} />
            </div>
          </div>
        )}

        {/* League competitions */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="font-mono text-xs uppercase text-foreground/60 border-l-4 border-volt pl-3">
              Competitions · {comps.length}
            </p>
            {isOwner && (
              <Link to="/competitions" className="font-mono text-[10px] uppercase text-volt hover:underline">
                + Schedule a competition
              </Link>
            )}
          </div>
          {comps.length === 0 ? (
            <div className="border-2 border-dashed border-border p-8 text-center text-foreground/40 text-sm">
              No competitions in this league yet. Schedule one and pick this league.
            </div>
          ) : (
            <div className="bg-card border border-border divide-y divide-border">
              {comps.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="font-mono text-[10px] uppercase px-2 py-0.5 border border-border text-foreground/50">
                    {c.status.replace("_", " ")}
                  </span>
                  <span className="flex-1 font-bold truncate">{c.title}</span>
                  <span className="font-mono text-[10px] uppercase text-foreground/40">
                    {c.scheduled_start_at ? new Date(c.scheduled_start_at).toLocaleString() : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quiz schedule */}
        <div className="space-y-2">
          <p className="font-mono text-xs uppercase text-foreground/60 border-l-4 border-volt pl-3">
            Quiz schedule · {leagueQuizzes.length}
          </p>

          {isOwner && availableQuizzes.length > 0 && (
            <div className="bg-card border border-border p-3 flex gap-2">
              <select
                value={addQuizId}
                onChange={(e) => setAddQuizId(e.target.value)}
                className="flex-1 bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt"
              >
                <option value="">Select a quiz to add…</option>
                {availableQuizzes.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
              </select>
              <button onClick={addQuiz} disabled={!addQuizId}
                className="bg-volt text-background font-mono text-xs uppercase px-4 py-2 skew-cta disabled:opacity-40">
                + ADD
              </button>
            </div>
          )}

          {leagueQuizzes.length === 0 ? (
            <div className="border-2 border-dashed border-border p-8 text-center text-foreground/40 text-sm">
              No quizzes attached yet.
            </div>
          ) : (
            <div className="bg-card border border-border divide-y divide-border">
              {leagueQuizzes.map((lq, i) => (
                <div key={lq.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="font-display text-xl italic w-8 text-volt">{String(i + 1).padStart(2, "0")}</span>
                  <Link to="/quizzes/$id" params={{ id: lq.quiz_id }} className="flex-1 font-bold hover:text-volt">
                    {lq.quiz?.title ?? "(missing quiz)"}
                  </Link>
                  {isOwner && (
                    <div className="flex gap-1">
                      <button onClick={() => move(lq.id, -1)} disabled={i === 0}
                        className="border border-border px-2 py-1 font-mono text-xs hover:border-volt disabled:opacity-30">↑</button>
                      <button onClick={() => move(lq.id, 1)} disabled={i === leagueQuizzes.length - 1}
                        className="border border-border px-2 py-1 font-mono text-xs hover:border-volt disabled:opacity-30">↓</button>
                      <button onClick={() => removeQuiz(lq.id)}
                        className="border border-border px-2 py-1 font-mono text-xs hover:border-pink-shock hover:text-pink-shock">✕</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Standings — derived from completed competition results */}
        <div className="space-y-2">
          <p className="font-mono text-xs uppercase text-foreground/60 border-l-4 border-volt pl-3">
            Standings · {standings.length}
          </p>
          {standings.length === 0 ? (
            <div className="border-2 border-dashed border-border p-8 text-center text-foreground/40 text-sm">
              No completed competitions in this league yet.
            </div>
          ) : (
            <div className="bg-card border border-border divide-y divide-border">
              {standings.map((s) => {
                const accent = s.standing_position === 1 ? "volt" : s.standing_position === 2 ? "cyan-jolt" : s.standing_position === 3 ? "amber-spark" : "foreground";
                return (
                  <div key={s.profile_id} className="flex items-center gap-4 px-5 py-4">
                    <span className={`font-display text-2xl italic w-10 text-${accent}`}>{String(s.standing_position).padStart(2, "0")}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold truncate">{s.display_name}</p>
                      <p className="font-mono text-[10px] uppercase text-foreground/40">
                        {s.competitions_played} played · {s.wins}W · {s.podiums} podium{s.podiums === 1 ? "" : "s"} · {s.total_score.toLocaleString()} pts scored
                        {s.avg_accuracy != null && ` · ${s.avg_accuracy}% acc`}
                      </p>
                    </div>
                    <span className="font-display text-xl italic">{s.league_points}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="font-mono text-[10px] uppercase text-foreground/30">
            Points: 1st {league.points_first} · 2nd {league.points_second} · 3rd {league.points_third} · participation {league.points_participation}.
            Ties break on wins, podiums, total score, then accuracy.
          </p>
        </div>

        {/* Coming Soon placeholders */}
        <div className="grid md:grid-cols-2 gap-3">
          <PlaceholderCard title="Registration" note="Player sign-ups and rosters coming soon." />
          <PlaceholderCard title="Statistics" note="Deep league analytics coming soon." />
        </div>

        {isOwner && (
          <div className="pt-8 border-t border-border">
            <button onClick={toggleArchive} className="font-mono text-xs uppercase text-foreground/60 hover:text-volt mr-6">
              {league.archived_at ? "Reopen season" : "Archive season"}
            </button>
            <button onClick={deleteLeague} className="font-mono text-xs uppercase text-pink-shock hover:underline">
              Delete league
            </button>
          </div>
        )}
      </div>
    </HostShell>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border p-4">
      <p className="font-mono text-[10px] uppercase text-foreground/50">{label}</p>
      <p className="font-display text-2xl italic uppercase mt-1">{value}</p>
    </div>
  );
}

function PlaceholderCard({ title, note }: { title: string; note: string }) {
  return (
    <div className="border-2 border-dashed border-border p-6">
      <p className="font-mono text-[10px] uppercase text-volt">Coming soon</p>
      <p className="font-display text-xl italic uppercase mt-1">{title}</p>
      <p className="text-foreground/50 text-xs mt-2">{note}</p>
    </div>
  );
}

function EditLeagueForm({ league, onSaved }: { league: League; onSaved: () => void }) {
  const [name, setName] = useState(league.name);
  const [description, setDescription] = useState(league.description ?? "");
  const [startDate, setStartDate] = useState(league.start_date ?? "");
  const [endDate, setEndDate] = useState(league.end_date ?? "");
  const [visibility, setVisibility] = useState<LeagueVisibility>(league.visibility);
  const [coverUrl, setCoverUrl] = useState(league.cover_image_url ?? "");
  const [p1, setP1] = useState(league.points_first);
  const [p2, setP2] = useState(league.points_second);
  const [p3, setP3] = useState(league.points_third);
  const [pp, setPp] = useState(league.points_participation);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.from("leagues").update({
      name: name.trim(),
      description: description.trim() || null,
      start_date: startDate || null,
      end_date: endDate || null,
      visibility,
      cover_image_url: coverUrl.trim() || null,
      points_first: Math.max(0, p1),
      points_second: Math.max(0, p2),
      points_third: Math.max(0, p3),
      points_participation: Math.max(0, pp),
    } as never).eq("id", league.id);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("League updated");
    onSaved();
  }

  return (
    <form onSubmit={save} className="bg-card border border-border p-5 grid gap-3 md:grid-cols-2">
      <input value={name} onChange={(e) => setName(e.target.value)} required
        className="md:col-span-2 bg-background border border-border px-4 py-3 font-mono text-sm uppercase focus:outline-none focus:border-volt" />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
        className="md:col-span-2 bg-background border border-border px-4 py-3 font-mono text-xs focus:outline-none focus:border-volt" />
      <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
        className="bg-background border border-border px-3 py-2 font-mono text-xs focus:outline-none focus:border-volt" />
      <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
        className="bg-background border border-border px-3 py-2 font-mono text-xs focus:outline-none focus:border-volt" />
      <select value={visibility} onChange={(e) => setVisibility(e.target.value as LeagueVisibility)}
        className="bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt">
        <option value="private">Private</option>
        <option value="public">Public</option>
      </select>
      <input placeholder="Cover image URL" value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)}
        className="bg-background border border-border px-3 py-2 font-mono text-xs focus:outline-none focus:border-volt" />
      <div className="md:col-span-2 grid grid-cols-4 gap-2">
        {([["1st", p1, setP1], ["2nd", p2, setP2], ["3rd", p3, setP3], ["Part.", pp, setPp]] as const).map(([label, val, set]) => (
          <label key={label} className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-foreground/60">{label} points</span>
            <input type="number" min={0} value={val} onChange={(e) => set(Number(e.target.value))}
              className="bg-background border border-border px-3 py-2 font-mono text-xs focus:outline-none focus:border-volt" />
          </label>
        ))}
      </div>
      <button disabled={busy} className="md:col-span-2 bg-volt text-background font-display text-base py-3 skew-cta disabled:opacity-50">
        SAVE CHANGES
      </button>
    </form>
  );
}
