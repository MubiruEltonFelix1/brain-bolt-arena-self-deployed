import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fetchArenaDetail, fetchPersonalBest, readPersonalBest, type ArenaQuizDetail } from "@/lib/arena";
import { useAuthUser } from "@/hooks/use-auth-user";
import { difficultyTheme, isOfficial } from "@/lib/arena-visuals";
import { ArenaArtwork, DifficultyChip, OfficialBadge } from "@/components/arena/ArenaVisuals";
import { toast } from "sonner";

export const Route = createFileRoute("/arena/$quizId/")({
  head: () => ({
    meta: [
      { title: "Arena Challenge — Brain Bolt Arena" },
      {
        name: "description",
        content:
          "Challenge details: difficulty, question count, estimated duration and average accuracy. Play the Brain Bolt Arena challenge solo.",
      },
      { property: "og:title", content: "Arena Challenge — Brain Bolt Arena" },
      {
        property: "og:description",
        content: "Difficulty, questions, duration and accuracy for this Brain Bolt Arena challenge.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ArenaDetail,
});


function ArenaDetail() {
  const { quizId } = Route.useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ArenaQuizDetail | null | "missing">(null);
  const [best, setBest] = useState<number | null>(null);
  const { user } = useAuthUser();

  useEffect(() => {
    // Signed-in players read the authoritative best from stored results;
    // guests fall back to the local cache.
    if (user) {
      fetchPersonalBest(quizId, user.id).then((b) => setBest(b ?? readPersonalBest(quizId)));
    } else {
      setBest(readPersonalBest(quizId));
    }
    fetchArenaDetail(quizId)
      .then((d) => setDetail(d ?? "missing"))
      .catch((e) => {
        toast.error(e.message ?? "Could not load this challenge");
        setDetail("missing");
      });
  }, [quizId, user]);

  if (detail === null) {
    return (
      <Shell>
        <p className="font-mono text-xs uppercase text-foreground/50">Loading challenge…</p>
      </Shell>
    );
  }

  if (detail === "missing") {
    return (
      <Shell>
        <div className="space-y-4">
          <h1 className="font-display text-4xl italic uppercase">Challenge unavailable</h1>
          <p className="font-mono text-xs uppercase text-foreground/50">
            This Arena challenge is no longer published.
          </p>
          <Link
            to="/arena"
            className="inline-block px-4 py-2 border border-volt text-volt font-mono text-xs uppercase hover:bg-volt hover:text-background transition-colors"
          >
            Browse the Arena
          </Link>
        </div>
      </Shell>
    );
  }

  const theme = difficultyTheme(detail.difficulty);
  const duration =
    detail.estimated_duration_minutes ??
    Math.max(1, Math.round((detail.question_count * (detail.time_per_question || 20)) / 60));

  return (
    <Shell>
      <article className="space-y-8">
        <header
          className="relative overflow-hidden border-2 bg-card grid md:grid-cols-[minmax(0,280px)_1fr]"
          style={{
            borderColor: theme.color,
            boxShadow: `0 24px 60px -34px color-mix(in oklab, ${theme.color} 60%, transparent)`,
          }}
        >
          <ArenaArtwork
            quizId={detail.id}
            title={detail.title}
            difficulty={detail.difficulty}
            className="h-40 md:h-full min-h-[160px]"
          />
          <div className="p-6 md:p-8 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <DifficultyChip difficulty={detail.difficulty} />
              {isOfficial(detail.creator_name) && <OfficialBadge />}
            </div>
            <h1 className="font-display text-4xl md:text-5xl italic uppercase tracking-tighter leading-[0.95]">
              {detail.title}
            </h1>
            {detail.description && (
              <p className="text-foreground/70 max-w-2xl">{detail.description}</p>
            )}
          </div>
        </header>

        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Stat label="Questions" value={String(detail.question_count)} />
          <Stat label="Est. duration" value={`~${duration} min`} />
          <Stat label="Total plays" value={detail.play_count.toLocaleString()} />
          <Stat
            label="Avg accuracy"
            value={detail.avg_accuracy != null ? `${detail.avg_accuracy}%` : "—"}
          />
          <Stat label="Category" value="General" />
          <Stat
            label="Last updated"
            value={new Date(detail.last_updated).toLocaleDateString()}
          />
        </dl>

        <div className="flex flex-wrap items-center gap-4 font-mono text-[10px] uppercase tracking-widest text-foreground/50">
          <span>Creator: {detail.creator_name ?? "Brain Bolt"}</span>
          {best != null && (
            <span className="text-volt">Your best: {best.toLocaleString()} pts</span>
          )}
        </div>

        <div className="grid gap-3 max-w-sm">
          <button
            onClick={() => navigate({ to: "/arena/$quizId/play", params: { quizId } })}
            disabled={detail.question_count === 0}
            className="w-full font-display text-2xl py-5 skew-cta active:scale-95 transition-transform disabled:opacity-50"
            style={{ background: theme.color, color: "var(--background)" }}
          >
            {detail.question_count === 0 ? "COMING SOON" : "PLAY NOW"}
          </button>
          <Link
            to="/arena"
            className="w-full text-center border border-border py-3 font-mono text-xs uppercase tracking-widest text-foreground/60 hover:text-volt hover:border-volt transition-colors"
          >
            Browse other challenges
          </Link>
        </div>

        {/* Reserved: world rankings, friends, ratings, achievements, creator page. */}
        <section className="bg-card border border-border p-5 space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Coming to the Arena
          </p>
          <p className="text-foreground/60 text-sm">
            World rankings, ratings, achievements and creator pages are on the way. Scores you
            set today keep counting toward your profile history.
          </p>
        </section>
      </article>
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border p-4">
      <dt className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
        {label}
      </dt>
      <dd className="mt-1 font-display text-2xl italic">{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-md border-b border-border">
        <Link to="/" className="flex items-center gap-2">
          <div className="size-8 bg-volt grid place-items-center skew-x-[-12deg]">
            <span className="font-display text-background text-xl italic">B</span>
          </div>
          <span className="font-display text-2xl tracking-tight italic">BRAINBOLT</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link
            to="/arena"
            className="font-mono text-xs uppercase text-foreground/60 hover:text-volt"
          >
            Arena
          </Link>
          <Link
            to="/profile"
            className="font-mono text-xs uppercase text-foreground/60 hover:text-volt"
          >
            Profile
          </Link>
        </div>
      </nav>
      <main className="max-w-4xl mx-auto px-6 pt-10 pb-24">{children}</main>
    </div>
  );
}
