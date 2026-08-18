import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toastError } from "@/lib/errors";
import { useAuthUser } from "@/hooks/use-auth-user";
import { fetchArenaList, fetchCompletedArenaQuizIds, type ArenaListItem } from "@/lib/arena";
import { ArenaCard, ArenaEmptyState, ArenaHero } from "@/components/arena/ArenaVisuals";

export const Route = createFileRoute("/arena/")({
  head: () => ({
    meta: [
      { title: "Brain Bolt Arena — Featured Challenges" },
      { name: "description", content: "Play curated Brain Bolt Arena challenges. Test your speed and knowledge against featured quizzes." },
      { property: "og:title", content: "Brain Bolt Arena — Featured Challenges" },
      { property: "og:description", content: "Curated quiz challenges. Pick a difficulty and jump in." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Arena,
});

function Arena() {
  const { user } = useAuthUser();
  const [items, setItems] = useState<ArenaListItem[] | null>(null);
  const [completed, setCompleted] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchArenaList()
      .then(setItems)
      .catch((e) => {
        toastError(e, { context: "arena load", fallback: "Could not load the Arena" });
        setItems([]);
      });
  }, []);

  useEffect(() => {
    if (!user) {
      setCompleted([]);
      return;
    }
    fetchCompletedArenaQuizIds(user.id).then(setCompleted);
  }, [user]);

  const featured = useMemo(
    () => (items ?? []).filter((i) => i.featured_rank != null),
    [items]
  );
  const rest = useMemo(() => (items ?? []).filter((i) => i.featured_rank == null), [items]);
  const explore = useMemo(
    () =>
      user && completed.length > 0
        ? (items ?? []).filter((i) => !completed.includes(i.id)).slice(0, 3)
        : [],
    [items, completed, user]
  );

  const hero = featured[0];
  const featuredRest = featured.slice(1);

  // Lightweight client-side search over the list the Arena already loads —
  // no extra request, no new infrastructure.
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    return (items ?? []).filter((i) =>
      [i.title, i.creator_name, i.difficulty, i.description]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q))
    );
  }, [items, q]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-md border-b border-border">
        <Link to="/" className="flex items-center gap-2">
          <div className="size-8 bg-volt grid place-items-center skew-x-[-12deg]">
            <span className="font-display text-background text-xl italic">B</span>
          </div>
          <span className="font-display text-2xl tracking-tight italic">BRAINBOLT</span>
        </Link>
        <Link
          to="/"
          className="px-4 py-1.5 border border-border font-mono text-xs hover:border-volt hover:text-volt transition-colors uppercase"
        >
          Back
        </Link>
      </nav>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-10 pb-24 space-y-14">
        <header className="space-y-3 border-l-4 border-volt pl-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">Brain Bolt Arena</p>
          <h1 className="font-display text-5xl md:text-6xl italic uppercase tracking-tighter leading-[0.9]">
            Featured<br /><span className="text-volt">Challenges</span>
          </h1>
          <p className="text-foreground/60 font-mono text-xs uppercase tracking-wide max-w-xl">
            Curated quizzes. Pick a difficulty and take on the arena.
          </p>
        </header>

        {items !== null && items.length > 0 && (
          <SearchBar value={query} onChange={setQuery} count={results?.length ?? null} total={items.length} />
        )}

        {items === null ? (
          <LoadingGrid />
        ) : results !== null ? (
          results.length === 0 ? (
            <ArenaEmptyState
              title="No challenges found"
              body={`Nothing matches "${query.trim()}". Try a different title, creator or difficulty.`}
            >
              <button
                onClick={() => setQuery("")}
                className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta active:scale-95"
              >
                CLEAR SEARCH
              </button>
            </ArenaEmptyState>
          ) : (
            <Section
              eyebrow="Search"
              title={`${results.length} result${results.length === 1 ? "" : "s"}`}
              subtitle={`Matching "${query.trim()}".`}
            >
              <CardGrid items={results} completed={completed} />
            </Section>
          )
        ) : items.length === 0 ? (
          <ArenaEmptyState
            title="The Arena is warming up"
            body="No public challenges are published yet. Try the Training Arena for an instant solo run, or join a hosted match with a game code."
          >
            <EmptyActions />
          </ArenaEmptyState>
        ) : (
          <>
            {/* Featured hero — sponsored slots reuse the same component. */}
            {hero && (
              <Section
                eyebrow="Official picks"
                title="Featured"
                subtitle="Hand-picked Brain Bolt competitions."
              >
                <div className="space-y-4">
                  <ArenaHero item={hero} />
                  {featuredRest.length > 0 && (
                    <CardGrid items={featuredRest} completed={completed} featured />
                  )}
                </div>
              </Section>
            )}

            <Section
              eyebrow="All challenges"
              title="Browse the arena"
              subtitle="Sorted by popularity."
            >
              {rest.length === 0 ? (
                <ArenaEmptyState
                  title="Nothing outside the featured set yet"
                  body="More community challenges are on the way. In the meantime, the featured competitions above are ready to play."
                />
              ) : (
                <CardGrid items={rest} completed={completed} />
              )}
            </Section>

            {explore.length > 0 && (
              <Section
                eyebrow="Based on your history"
                title="Continue exploring"
                subtitle="Challenges you haven't played yet."
              >
                <CardGrid items={explore} completed={completed} />
              </Section>
            )}
          </>
        )}

        <section className="mt-16 bg-card border border-border p-6 space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">Also available</p>
          <div className="flex flex-wrap gap-3">
            <Link
              to="/"
              className="px-4 py-2 border border-volt text-volt font-mono text-xs uppercase hover:bg-volt hover:text-background transition-colors"
            >
              Join a hosted match
            </Link>
            <Link
              to="/training"
              className="px-4 py-2 border border-cyan-jolt text-cyan-jolt font-mono text-xs uppercase hover:bg-cyan-jolt hover:text-background transition-colors"
            >
              Training arena
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}

function SearchBar({
  value,
  onChange,
  count,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  count: number | null;
  total: number;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor="arena-search" className="block font-mono text-[10px] uppercase tracking-widest text-foreground/50">
        Find a challenge
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          id="arena-search"
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search by title, creator or difficulty"
          className="flex-1 min-h-11 bg-card border-2 border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt placeholder:text-muted-foreground"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="min-h-11 px-5 border border-border font-mono text-xs uppercase text-foreground/70 hover:border-volt hover:text-volt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
          >
            Clear
          </button>
        )}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40" role="status">
        {count === null ? `${total} challenges available` : `${count} of ${total} shown`}
      </p>
    </div>
  );
}

function EmptyActions() {
  return (
    <div className="flex flex-wrap gap-3 justify-center pt-2">
      <Link to="/training" className="bg-volt text-background font-display text-lg px-6 py-3 skew-cta active:scale-95">
        TRAINING ARENA
      </Link>
      <Link
        to="/"
        className="border border-border px-6 py-3 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
      >
        Join with a code
      </Link>
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-card border-2 border-border h-72 motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

function Section({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">{eyebrow}</p>
        <h2 className="font-display text-3xl italic uppercase tracking-tight">{title}</h2>
        {subtitle && <p className="text-foreground/50 text-sm">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function CardGrid({
  items,
  completed,
  featured,
}: {
  items: ArenaListItem[];
  completed: string[];
  featured?: boolean;
}) {
  return (
    <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
      {items.map((c) => (
        <ArenaCard key={c.id} item={c} played={completed.includes(c.id)} featured={featured} />
      ))}
    </div>
  );
}
