import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuthUser } from "@/hooks/use-auth-user";
import { HostShell } from "@/components/host-shell";
import { AvatarPicker } from "@/components/AvatarPicker";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { DEFAULT_AVATAR_ID, resolveAvatar } from "@/lib/avatar";
import {
  computeStats,
  personalBest,
  ordinal,
  isSoloRun,
  placementLabel,
  type CompetitionRow,
  type PlayerStats,
} from "@/lib/player-stats";
import { toast } from "sonner";

export const Route = createFileRoute("/profile")({
  component: ProfilePage,
  head: () => ({
    meta: [
      { title: "Player Profile · BrainBolt" },
      { name: "description", content: "Your BrainBolt player identity: avatar, competition stats, personal best and recent matches." },
      { property: "og:title", content: "Player Profile · BrainBolt" },
      { property: "og:description", content: "Your BrainBolt player identity: avatar, competition stats, personal best and recent matches." },
      { property: "og:type", content: "profile" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type MyLeague = {
  league_id: string;
  name: string;
  status: string;
  archived_at: string | null;
  standing_position: number;
  league_points: number;
  competitions_played: number;
  last_played_at: string | null;
};

type Profile = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  avatar_id: string | null;
  created_at: string;
  username_updated_at: string | null;
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ProfilePage() {
  const { user, loading: authLoading } = useAuthUser();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [avatarId, setAvatarId] = useState<string>(DEFAULT_AVATAR_ID);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const [history, setHistory] = useState<CompetitionRow[]>([]);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [myLeagues, setMyLeagues] = useState<MyLeague[]>([]);

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/auth" });
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("get_my_leagues");
      if (!cancelled) setMyLeagues((data as MyLeague[] | null) ?? []);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      let { data } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (!data) {
        const fallback =
          (user.user_metadata?.display_name as string) ||
          (user.user_metadata?.full_name as string) ||
          (user.user_metadata?.name as string) ||
          user.email?.split("@")[0] ||
          "Player";
        const ins = await supabase
          .from("profiles")
          .insert({ id: user.id, display_name: fallback, avatar_id: DEFAULT_AVATAR_ID })
          .select("*")
          .single();
        data = ins.data;
      }
      if (cancelled || !data) return;
      const p = data as Profile;
      if (!p.avatar_id) {
        const seeded = resolveAvatar(null, p.id).id;
        const { data: upd } = await supabase
          .from("profiles").update({ avatar_id: seeded }).eq("id", user.id).select("*").single();
        if (upd) Object.assign(p, upd as Profile);
      }
      setProfile(p);
      setDisplayName(p.display_name ?? "");
      setUsername(p.username ?? "");
      setAvatarId(p.avatar_id ?? DEFAULT_AVATAR_ID);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Competition history + derived stats (no new tables)
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setStatsLoading(true);
      const { data: res } = await supabase
        .from("competition_results")
        .select("id,session_id,quiz_id,final_score,final_rank,total_participants,accuracy_percentage,completed_at,quizzes(title)")
        .eq("profile_id", user.id)
        .order("completed_at", { ascending: false })
        .limit(200);

      const rows: CompetitionRow[] = ((res as unknown as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
        id: r.id as string,
        session_id: r.session_id as string,
        quiz_id: r.quiz_id as string,
        final_score: r.final_score as number,
        final_rank: r.final_rank as number,
        total_participants: r.total_participants as number,
        accuracy_percentage: Number(r.accuracy_percentage ?? 0),
        completed_at: r.completed_at as string,
        quiz_title: ((r.quizzes as { title?: string } | null)?.title) ?? "Untitled quiz",
      }));

      // Answer totals: participants linked to this profile → their answers
      let answered = 0;
      let correct = 0;
      const { data: parts } = await supabase
        .from("participants")
        .select("id")
        .eq("profile_id", user.id);
      const ids = ((parts as { id: string }[] | null) ?? []).map((p) => p.id);
      if (ids.length > 0) {
        const [{ count: total }, { count: ok }] = await Promise.all([
          supabase.from("answers").select("id", { count: "exact", head: true }).in("participant_id", ids),
          supabase.from("answers").select("id", { count: "exact", head: true }).in("participant_id", ids).eq("is_correct", true),
        ]);
        answered = total ?? 0;
        correct = ok ?? 0;
      }

      if (cancelled) return;
      setHistory(rows);
      setStats(computeStats(rows, { answered, correct }));
      setStatsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!profile || !user) return;
    setSaving(true);
    try {
      const patch: { display_name?: string; username?: string | null; username_updated_at?: string; avatar_id?: string } = {};
      if (displayName.trim() && displayName !== profile.display_name) {
        patch.display_name = displayName.trim();
      }
      if (avatarId && avatarId !== profile.avatar_id) {
        patch.avatar_id = avatarId;
      }
      const nextUsername = username.trim() || null;
      if (nextUsername !== profile.username) {
        if (nextUsername) {
          if (!/^[a-zA-Z0-9_]{3,20}$/.test(nextUsername)) {
            throw new Error("Username: 3–20 chars, letters/numbers/underscore only.");
          }
          const { data: taken } = await supabase
            .from("profiles")
            .select("id")
            .ilike("username", nextUsername)
            .neq("id", user.id)
            .maybeSingle();
          if (taken) throw new Error("Username already taken.");
        }
        patch.username = nextUsername;
        patch.username_updated_at = new Date().toISOString();
      }
      if (Object.keys(patch).length === 0) {
        toast.info("Nothing to save");
        return;
      }
      const { data, error } = await supabase
        .from("profiles")
        .update(patch)
        .eq("id", user.id)
        .select("*")
        .single();
      if (error) throw error;
      setProfile(data as Profile);
      toast.success("Profile updated");
      setEditing(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || loading || !profile) {
    return (
      <HostShell title="Profile">
        <div className="min-h-[60vh] grid place-items-center font-mono text-foreground/40 text-sm">
          LOADING...
        </div>
      </HostShell>
    );
  }

  const joined = new Date(profile.created_at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });
  const best = personalBest(history);

  return (
    <HostShell title="Profile">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Identity header */}
        <header className="flex items-center gap-5 border border-border bg-card p-6">
          <PlayerAvatar avatarId={avatarId} seed={profile.id} size={88} />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-4xl italic uppercase tracking-tighter truncate">
              {profile.display_name}
            </h1>
            <div className="font-mono text-xs uppercase text-volt truncate">
              {profile.username ? `@${profile.username}` : "no username set"}
            </div>
            <div className="font-mono text-[10px] uppercase text-foreground/40 mt-1">
              Member since {joined}
            </div>
          </div>
          <button
            onClick={() => setEditing((v) => !v)}
            className="self-start border border-border px-4 py-2 font-mono text-[10px] uppercase text-foreground/70 hover:border-volt hover:text-volt transition-colors"
          >
            {editing ? "Close" : "Edit"}
          </button>
        </header>

        {/* Edit panel */}
        {editing && (
          <section className="border border-border bg-card p-6 space-y-6">
            <div className="space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
                Your Brain Bolt champion
              </p>
              <AvatarPicker value={avatarId} onChange={setAvatarId} columns={5} />
            </div>

            <form onSubmit={save} className="space-y-4">
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Display name</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={40}
                  required
                  className="mt-1 w-full bg-background border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
                />
              </label>

              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Username</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/\s+/g, ""))}
                  placeholder="letters, numbers, underscore"
                  className="mt-1 w-full bg-background border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
                />
                <span className="block mt-1 font-mono text-[10px] uppercase text-foreground/40">
                  3–20 characters. Must be unique.
                </span>
              </label>

              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Email</span>
                <input
                  value={user?.email ?? ""}
                  disabled
                  className="mt-1 w-full bg-background/50 border border-border py-3 px-4 font-mono text-sm text-foreground/50"
                />
              </label>

              <button
                type="submit"
                disabled={saving}
                className="bg-volt text-background font-display text-xl px-8 py-3 skew-cta active:scale-95 transition-transform disabled:opacity-60"
              >
                {saving ? "SAVING..." : "SAVE"}
              </button>
            </form>
          </section>
        )}

        {/* Stats */}
        <section className="space-y-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Player statistics</h2>
          {statsLoading || !stats ? (
            <div className="border border-border bg-card p-6 font-mono text-xs uppercase text-foreground/40">Crunching numbers...</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Competitions" value={stats.played} />
              <Stat label="Wins" value={stats.won} />
              <Stat label="Podiums" value={stats.podiums} />
              <Stat label="Avg accuracy" value={`${stats.avgAccuracy}%`} />
              <Stat label="Avg score" value={stats.avgScore.toLocaleString()} />
              <Stat label="Best score" value={stats.bestScore.toLocaleString()} />
              <Stat label="Questions answered" value={stats.questionsAnswered.toLocaleString()} />
              <Stat label="Correct answers" value={stats.correctAnswers.toLocaleString()} />
            </div>
          )}
        </section>

        {/* Personal best */}
        {best && (
          <section className="space-y-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Personal best</h2>
            <div className="border-2 border-volt bg-card p-6 flex flex-wrap items-center gap-6">
              <div className="min-w-0 flex-1">
                <div className="font-display text-2xl italic uppercase truncate">{best.quiz_title}</div>
                <div className="font-mono text-[10px] uppercase text-foreground/40 mt-1">
                  {fmtDate(best.completed_at)} ·{" "}
                  {isSoloRun(best)
                    ? "Solo Arena run"
                    : `${ordinal(best.final_rank)} of ${best.total_participants}`}
                </div>
              </div>
              <div className="text-right">
                <div className="font-display text-4xl text-volt leading-none">{best.final_score.toLocaleString()}</div>
                <div className="font-mono text-[10px] uppercase text-foreground/40 mt-1">
                  {Number(best.accuracy_percentage)}% accuracy
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Leagues */}
        {myLeagues.length > 0 && (
          <section className="space-y-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Leagues</h2>
            <ul className="divide-y divide-border border border-border bg-card">
              {myLeagues.map((l) => (
                <li key={l.league_id} className="flex items-center gap-3 px-5 py-4">
                  <span className={"font-display text-2xl italic w-10 " + (l.standing_position <= 3 ? "text-volt" : "text-foreground/60")}>
                    {ordinal(l.standing_position)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to="/leagues/$id" params={{ id: l.league_id }} className="font-bold truncate hover:text-volt">
                      {l.name}
                    </Link>
                    <p className="font-mono text-[10px] uppercase text-foreground/40">
                      {l.competitions_played} competition{l.competitions_played === 1 ? "" : "s"}
                      {l.archived_at ? " · archived season" : ""}
                      {l.last_played_at ? ` · last ${fmtDate(l.last_played_at)}` : ""}
                    </p>
                  </div>
                  <span className="font-display text-xl italic">{l.league_points}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Recent competitions */}
        <section className="space-y-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Recent competitions</h2>
          {statsLoading ? null : history.length === 0 ? (
            <div className="border-2 border-dashed border-border p-10 text-center space-y-3">
              <PlayerAvatar avatarId={avatarId} seed={profile.id} size={64} className="mx-auto" />
              <p className="font-display text-2xl italic uppercase text-foreground/70">No competitions yet</p>
              <p className="text-foreground/50 text-sm max-w-sm mx-auto">
                Your stats light up the moment you finish your first match. Warm up solo or jump into a hosted competition.
              </p>
              <div className="flex flex-wrap gap-3 justify-center pt-2">
                <Link to="/arena" className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta active:scale-95">
                  PLAY ARENA
                </Link>
                <Link to="/training" className="border border-border px-6 py-3 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors">
                  Training arena
                </Link>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-border border border-border bg-card">
              {history.slice(0, 10).map((r) => (
                <li key={r.id} className="flex items-center gap-4 p-4">
                  <PlayerAvatar avatarId={avatarId} seed={profile.id} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-lg italic uppercase truncate">{r.quiz_title}</div>
                    <div className="font-mono text-[10px] uppercase text-foreground/40">
                      {fmtDate(r.completed_at)} · {Number(r.accuracy_percentage)}% accuracy
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={
                        "font-display text-xl " +
                        (!isSoloRun(r) && r.final_rank <= 3 ? "text-volt" : "")
                      }
                    >
                      {placementLabel(r)}
                    </div>
                    <div className="font-mono text-[10px] uppercase text-foreground/40">
                      {r.final_score.toLocaleString()} pts
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Reserved for future sections: achievements, ratings, leagues,
            organizations, badges, cosmetics, seasonal rankings. */}
      </div>
    </HostShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="font-display text-3xl leading-none">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-foreground/40 mt-2">{label}</div>
    </div>
  );
}
