import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useHostStatus } from "@/hooks/use-host-status";
import { generateGameCode, seededShuffle } from "@/lib/game";
import { toast } from "sonner";
import { HostAuthorizationCard } from "@/components/HostAuthorizationCard";
import { EmptyState, SkeletonList } from "@/components/EmptyState";

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
});

type Quiz = { id: string; title: string; description: string | null; time_per_question: number; created_at: string; question_count?: number };
type League = { id: string; name: string };
type BrandingLite = { id: string; organization_name: string };

function Dashboard() {
  const { user, canHost, isAdmin, authorization, loading: hostLoading, refresh: refreshHost } = useHostStatus();
  const navigate = useNavigate();
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [brandingProfiles, setBrandingProfiles] = useState<BrandingLite[]>([]);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [loadingQuizzes, setLoadingQuizzes] = useState(true);

  async function load() {
    if (!user) return;
    const { data } = await supabase
      .from("quizzes")
      .select("id,title,description,time_per_question,created_at,questions(count)")
      .eq("owner_id", user.id)
      .is("archived_at", null)
      .order("created_at", { ascending: false });
    setLoadingQuizzes(false);
    setQuizzes(
      ((data as Array<Quiz & { questions: { count: number }[] }> | null) ?? []).map((q) => ({
        ...q,
        question_count: q.questions?.[0]?.count ?? 0,
      }))
    );
    const { data: l } = await supabase.from("leagues").select("id,name").eq("owner_id", user.id);
    setLeagues((l as League[] | null) ?? []);
    const { data: b } = await supabase
      .from("branding_profiles")
      .select("id,organization_name")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    setBrandingProfiles((b as BrandingLite[] | null) ?? []);
  }


  async function archiveQuiz(quizId: string, title: string) {
    if (!confirm(`Delete "${title}"? This can't be undone. Past sessions and scores are preserved.`)) return;
    const { error } = await supabase
      .from("quizzes")
      .update({ archived_at: new Date().toISOString() } as never)
      .eq("id", quizId);
    if (error) return toast.error(error.message);
    toast.success("Quiz deleted");
    setQuizzes((qs) => qs.filter((q) => q.id !== quizId));
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user?.id]);

  async function createQuiz() {
    if (!user) return;
    const { data, error } = await supabase
      .from("quizzes")
      .insert({ owner_id: user.id, title: "Untitled Quiz" })
      .select("id")
      .single();
    if (error || !data) return toast.error(error?.message ?? "Failed");
    navigate({ to: "/quizzes/$id", params: { id: data.id } });
  }

  async function startSession(quizId: string, opts: { teamMode: boolean; leagueId: string | null; brandingProfileId: string | null }) {
    if (!user) return;
    if (!canHost) {
      toast.error("Hosting not authorized. Contact the administrator.");
      return;
    }
    setCreatingId(quizId);
    const { data: qs } = await supabase.from("questions").select("id").eq("quiz_id", quizId).order("position");
    if (!qs || qs.length === 0) {
      setCreatingId(null);
      toast.error("Quiz has no questions yet");
      return;
    }
    const code = generateGameCode();
    const order = seededShuffle(qs.map((q) => q.id), code);
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        quiz_id: quizId,
        host_id: user.id,
        code,
        team_mode: opts.teamMode,
        league_id: opts.leagueId,
        branding_profile_id: opts.brandingProfileId,
        question_order: order,
      })
      .select("id")
      .single();
    setCreatingId(null);
    if (error || !data) {
      const msg = error?.message ?? "Failed to start";
      toast.error(/Hosting not authorized/i.test(msg) ? "Hosting not authorized. Contact the administrator." : msg);
      await refreshHost();
      return;
    }
    await refreshHost();
    navigate({ to: "/host/$sessionId", params: { sessionId: data.id } });
  }

  return (
    <HostShell title="Dashboard">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-12">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-volt">Control room</p>
            <h1 className="font-display text-5xl italic uppercase mt-1">Your quizzes</h1>
          </div>
          <button onClick={createQuiz} className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta active:scale-95">
            + NEW QUIZ
          </button>
        </div>

        <HostAuthorizationCard isAdmin={isAdmin} authorization={authorization} loading={hostLoading} />

        {loadingQuizzes ? (
          <SkeletonList rows={3} height="h-24" />
        ) : quizzes.length === 0 ? (
          <EmptyState
            eyebrow="Your control room"
            title="Build your first quiz"
            body="Quizzes are the source of every BrainBolt match. Create one, add questions, then start a live session and share the game code with your players."
          >
            <button onClick={createQuiz} className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta active:scale-95">
              + NEW QUIZ
            </button>
            <Link to="/arena" className="border border-border px-6 py-3 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors">
              See example challenges
            </Link>
          </EmptyState>
        ) : (
          <div className="grid gap-3">
            {quizzes.map((q) => (
              <QuizCard
                key={q.id}
                quiz={q}
                leagues={leagues}
                brandingProfiles={brandingProfiles}
                canHost={canHost}
                onStart={(opts) => startSession(q.id, opts)}
                onDelete={() => archiveQuiz(q.id, q.title)}
                starting={creatingId === q.id}
              />
            ))}
          </div>
        )}

        <div className="pt-8 border-t border-border">
          <div className="flex items-end justify-between">
            <h2 className="font-display text-3xl italic uppercase">Leagues</h2>
            <Link to="/leagues" className="font-mono text-xs uppercase text-volt hover:underline">
              Manage →
            </Link>
          </div>
          <p className="text-foreground/60 text-sm mt-2">
            Group recurring matches into seasons. Player nicknames carry across sessions.
          </p>
        </div>
      </div>
    </HostShell>
  );
}

function QuizCard({ quiz, leagues, brandingProfiles, canHost, onStart, onDelete, starting }: {
  quiz: Quiz;
  leagues: League[];
  brandingProfiles: BrandingLite[];
  canHost: boolean;
  onStart: (opts: { teamMode: boolean; leagueId: string | null; brandingProfileId: string | null }) => void;
  onDelete: () => void;
  starting: boolean;
}) {
  const [teamMode, setTeamMode] = useState(false);
  const [leagueId, setLeagueId] = useState<string>("");
  const [brandingId, setBrandingId] = useState<string>("");
  return (
    <div className="bg-card border border-border p-5 flex flex-col gap-4 md:flex-row md:items-center">
      <div className="flex-1">
        <Link to="/quizzes/$id" params={{ id: quiz.id }} className="font-display text-xl italic uppercase hover:text-volt">
          {quiz.title}
        </Link>
        <p className="font-mono text-xs uppercase text-foreground/40 mt-1">
          {quiz.question_count ?? 0} questions · {quiz.time_per_question}s/round
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="font-mono text-[10px] uppercase text-foreground/60 flex items-center gap-2 px-3 py-2 border border-border bg-background cursor-pointer">
          <input type="checkbox" checked={teamMode} onChange={(e) => setTeamMode(e.target.checked)} className="accent-volt" />
          Teams
        </label>
        {leagues.length > 0 && (
          <select
            value={leagueId}
            onChange={(e) => setLeagueId(e.target.value)}
            className="bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt"
          >
            <option value="">No league</option>
            {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        {brandingProfiles.length > 0 && (
          <select
            value={brandingId}
            onChange={(e) => setBrandingId(e.target.value)}
            title="Branding profile"
            className="bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt"
          >
            <option value="">BrainBolt branding</option>
            {brandingProfiles.map((b) => <option key={b.id} value={b.id}>{b.organization_name}</option>)}
          </select>
        )}
        <button
          disabled={starting || !canHost}
          title={!canHost ? "Hosting not authorized" : undefined}
          onClick={() => onStart({ teamMode, leagueId: leagueId || null, brandingProfileId: brandingId || null })}
          className="bg-volt text-background font-display text-base px-5 py-2.5 skew-cta active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {starting ? "..." : canHost ? "START" : "LOCKED"}
        </button>
        <button
          onClick={onDelete}
          title="Delete quiz"
          aria-label="Delete quiz"
          className="border border-border px-3 py-2.5 font-mono text-xs uppercase text-foreground/60 hover:border-pink-shock hover:text-pink-shock transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
