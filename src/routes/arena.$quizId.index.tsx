import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  fetchArenaDetail,
  fetchArenaHistory,
  fetchArenaPlatformState,
  readPersonalBest,
  type ArenaPlayerHistory,
  type ArenaQuizDetail,
} from "@/lib/arena";
import { useAuthUser } from "@/hooks/use-auth-user";
import { difficultyTheme, isOfficial } from "@/lib/arena-visuals";
import {
  ArenaArtwork,
  CategoryChip,
  DifficultyChip,
  OfficialBadge,
} from "@/components/arena/ArenaVisuals";
import { toastError } from "@/lib/errors";
import { LOADING, challengeMetaLine } from "@/lib/terminology";

export const Route = createFileRoute("/arena/$quizId/")({
  head: () => ({
    meta: [
      { title: "Challenge — Brain Bolt Arena" },
      {
        name: "description",
        content:
          "What this Brain Bolt Arena challenge contains: difficulty, questions, how long it takes and your personal best.",
      },
      { property: "og:title", content: "Challenge — Brain Bolt Arena" },
      {
        property: "og:description",
        content: "Difficulty, questions, duration and your personal best for this Arena challenge.",
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
  const [history, setHistory] = useState<ArenaPlayerHistory | null>(null);
  const [platformClosed, setPlatformClosed] = useState(false);
  const [closedMessage, setClosedMessage] = useState<string | null>(null);
  const { user } = useAuthUser();

  useEffect(() => {
    // Signed-in players read their authoritative history; guests fall back to
    // the local cache from their last run on this device.
    if (user) {
      fetchArenaHistory(quizId, user.id)
        .then((h) => {
          setHistory(h);
          setBest(h?.best ?? readPersonalBest(quizId));
        })
        .catch(() => setBest(readPersonalBest(quizId)));
    } else {
      setBest(readPersonalBest(quizId));
    }
    fetchArenaDetail(quizId)
      .then((d) => setDetail(d ?? "missing"))
      .catch((e) => {
        toastError(e, { context: "challenge load", fallback: "Could not load this challenge" });
        setDetail("missing");
      });
    fetchArenaPlatformState()
      .then((s) => {
        setPlatformClosed(!s.arena_open);
        setClosedMessage(s.arena_closed_message);
      })
      .catch(() => {
        /* non-fatal — the start button is the actual gate */
      });
  }, [quizId, user]);

  if (detail === null) {
    return (
      <Shell>
        <p role="status" className="font-mono text-xs uppercase text-foreground/50">
          {LOADING.loadingChallenge}
        </p>
      </Shell>
    );
  }

  if (detail === "missing") {
    return (
      <Shell>
        <div className="space-y-4">
          <h1 className="font-display text-4xl italic uppercase">Challenge unavailable</h1>
          <p className="text-foreground/60 max-w-prose">
            This Arena challenge is no longer published. It may have been taken down by its
            creator, or replaced by a newer version.
          </p>
          <Link
            to="/arena"
            className="inline-flex min-h-11 items-center px-4 py-2 border border-volt text-volt font-mono text-xs uppercase hover:bg-volt hover:text-background transition-colors"
          >
            Back to the Arena
          </Link>
        </div>
      </Shell>
    );
  }

  const theme = difficultyTheme(detail.difficulty);
  const duration =
    detail.estimated_duration_minutes ??
    Math.max(1, Math.round((detail.question_count * (detail.time_per_question || 20)) / 60));

  const tagList = (detail.tags ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);

  const canStart = detail.question_count > 0 && !platformClosed;

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
              <CategoryChip category={detail.arena_category} />
              <DifficultyChip difficulty={detail.difficulty} />
              {isOfficial(detail.creator_name) && <OfficialBadge />}
            </div>
            <h1 className="font-display text-4xl md:text-5xl italic uppercase tracking-tighter leading-[0.95]">
              {detail.title}
            </h1>
            {detail.description && (
              <p className="text-foreground/70 max-w-2xl">{detail.description}</p>
            )}
            {tagList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {tagList.map((t) => (
                  <span
                    key={t}
                    className="font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 border border-border text-foreground/60"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </header>

        {/* What you are about to do, in the order a player actually asks it. */}
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Questions" value={String(detail.question_count)} />
          <Stat label="Takes about" value={`${duration} min`} />
          <Stat label="Players have run it" value={detail.play_count.toLocaleString()} />
          <Stat
            label="Average accuracy"
            value={detail.avg_accuracy != null ? `${detail.avg_accuracy}%` : "—"}
          />
        </dl>

        <section className="bg-card border border-border p-5 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-volt">
              Your personal best
            </h2>
            {history && (
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                {history.attempts} {history.attempts === 1 ? "run" : "runs"} so far
              </p>
            )}
          </div>

          {best == null ? (
            <p className="text-foreground/70 text-sm">
              You haven't played this challenge yet. Finish a run to set your first score — the
              Arena remembers it and shows you every run you beat it by.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                  Best score
                </p>
                <p className="font-display text-4xl italic text-volt leading-none">
                  {best.toLocaleString()}
                </p>
              </div>
              {history && (
                <>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                      Last run
                    </p>
                    <p className="font-display text-2xl italic leading-none">
                      {history.lastScore.toLocaleString()}
                    </p>
                    <p className="font-mono text-[10px] uppercase text-foreground/40 mt-1">
                      {new Date(history.lastPlayedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                  {history.bestAccuracy != null && (
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                        Best accuracy
                      </p>
                      <p className="font-display text-2xl italic leading-none">
                        {Math.round(history.bestAccuracy)}%
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {!user && best != null && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">
              Saved on this device —{" "}
              <Link to="/auth" className="text-volt hover:underline">
                sign in
              </Link>{" "}
              to keep it everywhere.
            </p>
          )}
        </section>

        <section className="bg-card border border-border p-4 space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">How scoring works</p>
          <p className="text-foreground/80 text-sm">
            Right answers score. Faster right answers score more, and a streak of correct answers
            stacks a bonus on top. Wrong answers earn nothing — there is no penalty, so always
            guess rather than leave one blank.
          </p>
        </section>

        {platformClosed && (
          <div
            role="status"
            className="border-2 border-pink-shock/30 bg-pink-shock/10 p-4 space-y-1"
          >
            <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">
              Arena closed
            </p>
            <p className="text-foreground/80 text-sm">
              {closedMessage ?? "The Arena is closed at the moment. Please check back soon."}
            </p>
          </div>
        )}

        <div className="grid gap-3 max-w-sm">
          <button
            onClick={() => navigate({ to: "/arena/$quizId/play", params: { quizId } })}
            disabled={!canStart}
            className="w-full min-h-14 font-display text-2xl italic uppercase py-5 skew-cta active:scale-95 transition-transform disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
            style={{ background: theme.color, color: "var(--background)" }}
          >
            {detail.question_count === 0
              ? "No questions yet"
              : platformClosed
                ? "Arena closed"
                : "Start Bolt"}
          </button>
          {canStart && (
            <p className="text-center text-foreground/60 text-sm">
              {challengeMetaLine({ questionCount: detail.question_count, minutes: duration })} · you
              can replay it as often as you like.
            </p>
          )}
          <Link
            to="/arena"
            className="w-full text-center border border-border py-3 font-mono text-xs uppercase tracking-widest text-foreground/60 hover:text-volt hover:border-volt transition-colors"
          >
            Find another challenge
          </Link>
        </div>

        {best != null && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">
            Beat {best.toLocaleString()} to set a new personal best.
          </p>
        )}
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
      <nav
        aria-label="Main"
        className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-md border-b border-border"
      >
        <Link to="/" className="flex items-center gap-2">
          <div className="size-8 bg-volt grid place-items-center skew-x-[-12deg]">
            <span className="font-display text-background text-xl italic">B</span>
          </div>
          <span className="font-display text-2xl tracking-tight italic">BRAINBOLT</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link to="/arena" className="font-mono text-xs uppercase text-foreground/60 hover:text-volt">
            Arena
          </Link>
          <Link to="/profile" className="font-mono text-xs uppercase text-foreground/60 hover:text-volt">
            Profile
          </Link>
        </div>
      </nav>
      <main className="max-w-4xl mx-auto px-6 pt-10 pb-24">{children}</main>
    </div>
  );
}
