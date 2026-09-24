import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toastError } from "@/lib/errors";
import { useAuthUser } from "@/hooks/use-auth-user";
import {
  fetchArenaSection,
  fetchArenaPlatformState,
  fetchPersonalBests,
  searchArenaQuizzes,
  fetchArenaList,
  type ArenaListItem,
  type ArenaSearchFilters,
  type ArenaSearchResult,
  type ArenaSection,
} from "@/lib/arena";
import { ArenaCard, ArenaEmptyState, ArenaHero, CategoryChip } from "@/components/arena/ArenaVisuals";
import { ARENA_LENGTH_FILTERS, LOADING, arenaSortLabel } from "@/lib/terminology";

export const Route = createFileRoute("/arena/")({
  head: () => ({
    meta: [
      { title: "Brain Bolt Arena — Test your knowledge. Beat your best." },
      {
        name: "description",
        content:
          "Solo quiz runs in the Brain Bolt Arena. Play featured challenges, build a streak, and chase your personal best.",
      },
      { property: "og:title", content: "Brain Bolt Arena — Test your knowledge. Beat your best." },
      {
        property: "og:description",
        content: "Solo quiz runs. Beat your personal best.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Arena,
});

/* ------------------------------------------------------------------ */
/* Hero / shell                                                        */
/* ------------------------------------------------------------------ */

function Arena() {
  const { user } = useAuthUser();

  // Platform state — closed banner reads from here
  const platform = useQuery({
    queryKey: ["arena", "platform"],
    queryFn: () => fetchArenaPlatformState(),
    staleTime: 30_000,
  });

  // "Continue exploring" + "Your best" need the signed-in profile id; the same
  // query also supplies every card's personal-best badge.
  const bests = useQuery({
    queryKey: ["arena", "personal-bests", user?.id ?? "anon"],
    queryFn: () => (user ? fetchPersonalBests(user.id) : Promise.resolve(new Map<string, number>())),
    enabled: !!user,
  });
  const personalBests = bests.data ?? new Map<string, number>();

  // 7 sections fetched in parallel via useQuery
  const sections = useArenaSections(user?.id ?? null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ArenaSearchFilters>({});

  const search = useQuery({
    queryKey: ["arena", "search", query, filters],
    queryFn: () => searchArenaQuizzes({ query, filters, limit: 24, offset: 0 }),
    enabled: searchOpen,
  });

  // Aggregate "Play Now" target: first featured, fallback to first published.
  const playNowHref = useMemo(() => {
    const featured = sections.featured.data?.[0] ?? sections.trending.data?.[0] ?? null;
    return featured ? `/arena/${featured.id}` : "/arena";
  }, [sections.featured.data, sections.trending.data]);

  const isEmpty =
    !sections.featured.isLoading &&
    !sections.trending.isLoading &&
    (sections.featured.data?.length ?? 0) === 0 &&
    (sections.trending.data?.length ?? 0) === 0 &&
    (sections.new.data?.length ?? 0) === 0;

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
        <Hero
          playNowHref={playNowHref}
          onExplore={() =>
            document.getElementById("arena-explore")?.scrollIntoView({ behavior: "smooth" })
          }
          onSearch={() => setSearchOpen(true)}
        />

        {platform.data && !platform.data.arena_open && (
          <ClosedBanner message={platform.data.arena_closed_message} />
        )}

        {!searchOpen && (
          <CategoryBar
            categories={sections.categories.map(([cat]) => cat)}
            onPick={(cat) => {
              setFilters({ ...filters, category: cat });
              setQuery("");
              setSearchOpen(true);
            }}
          />
        )}

        {!searchOpen && !isEmpty && sections.featured.isLoading && (
          <p
            role="status"
            aria-live="polite"
            className="font-mono text-xs uppercase tracking-widest text-foreground/50"
          >
            {LOADING.loadingArena}
          </p>
        )}

        {searchOpen ? (
          <SearchPanel
            query={query}
            setQuery={setQuery}
            filters={filters}
            setFilters={setFilters}
            result={search.data ?? null}
            loading={search.isLoading}
            onClose={() => {
              setSearchOpen(false);
              setQuery("");
            }}
            personalBests={personalBests}
          />
        ) : isEmpty ? (
          <ArenaEmptyState
            title="The Arena is warming up"
            body="No public Arena challenges are published yet. Try the Training Arena for an instant solo run, or join a hosted match with a game code."
          />
        ) : (
          <div id="arena-explore" className="space-y-14">
            {sections.featured.data && sections.featured.data.length > 0 && (
              <Section
                eyebrow="Official picks"
                title="Featured"
                subtitle="Hand-picked challenges ready right now."
              >
                {sections.featured.data[0] && (
                  <ArenaHero
                    item={sections.featured.data[0]}
                    personalBest={personalBests.get(sections.featured.data[0].id) ?? null}
                  />
                )}
                {sections.featured.data.length > 1 && (
                  <CardGrid
                    items={sections.featured.data.slice(1)}
                    personalBests={personalBests}
                  />
                )}
              </Section>
            )}

            {sections.trending.data && sections.trending.data.length > 0 && (
              <Section
                eyebrow="Hot right now"
                title="Trending"
                subtitle="The Arena runs that players keep coming back to."
              >
                <CardGrid items={sections.trending.data} personalBests={personalBests} />
              </Section>
            )}

            {sections.new.data && sections.new.data.length > 0 && (
              <Section
                eyebrow="Just published"
                title="New"
                subtitle="Fresh challenges from creators and the Brain Bolt team."
              >
                <CardGrid items={sections.new.data} personalBests={personalBests} />
              </Section>
            )}

            {sections.categories && sections.categories.length > 0 && (
              <CategorySections
                byCategory={sections.categories}
                personalBests={personalBests}
              />
            )}

            {sections.quick_bolts.data && sections.quick_bolts.data.length > 0 && (
              <Section
                eyebrow="Fast runs"
                title="Quick Bolts"
                subtitle="Challenges you can finish in 8 minutes or less."
              >
                <CardGrid items={sections.quick_bolts.data} personalBests={personalBests} />
              </Section>
            )}

            {sections.hard_mode.data && sections.hard_mode.data.length > 0 && (
              <Section
                eyebrow="Bring it"
                title="Hard Mode"
                subtitle="For when easy is for someone else."
              >
                <CardGrid items={sections.hard_mode.data} personalBests={personalBests} />
              </Section>
            )}

            {user && sections.continue_exploring.data && sections.continue_exploring.data.length > 0 && (
              <Section
                eyebrow="Based on your history"
                title="Continue exploring"
                subtitle="Challenges you haven't tried yet."
              >
                <CardGrid
                  items={sections.continue_exploring.data}
                  personalBests={personalBests}
                />
              </Section>
            )}

            {user && sections.your_best.data && sections.your_best.data.length > 0 && (
              <Section
                eyebrow="Your best"
                title="Crush your record"
                subtitle="Quizzes you've already played. Beat your best."
              >
                <CardGrid items={sections.your_best.data} personalBests={personalBests} />
              </Section>
            )}
          </div>
        )}

        <section className="mt-16 bg-card border border-border p-6 space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Also available
          </p>
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

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

function useArenaSections(profileId: string | null) {
  const make = (section: ArenaSection) => () =>
    fetchArenaSection(section, profileId).catch((e) => {
      toastError(e, { context: `arena section ${section}`, fallback: "Couldn't load" });
      return [];
    });

  const featured = useQuery({ queryKey: ["arena", "section", "featured"], queryFn: make("featured") });
  const trending = useQuery({ queryKey: ["arena", "section", "trending"], queryFn: make("trending") });
  const fresh = useQuery({ queryKey: ["arena", "section", "new"], queryFn: make("new") });
  const quick_bolts = useQuery({ queryKey: ["arena", "section", "quick_bolts"], queryFn: make("quick_bolts") });
  const hard_mode = useQuery({ queryKey: ["arena", "section", "hard_mode"], queryFn: make("hard_mode") });
  const continue_exploring = useQuery({
    queryKey: ["arena", "section", "continue_exploring", profileId],
    queryFn: make("continue_exploring"),
    enabled: !!profileId,
  });
  const your_best = useQuery({
    queryKey: ["arena", "section", "your_best", profileId],
    queryFn: make("your_best"),
    enabled: !!profileId,
  });

  // Category buckets derived from the full list (server doesn't expose a
  // "by category" endpoint — we derive it from get_arena_quizzes to keep
  // the catalog surface to a single RPC).
  const categories = useQuery({
    queryKey: ["arena", "categories"],
    queryFn: async () => {
      const all = await fetchArenaList();
      const map = new Map<string, ArenaListItem[]>();
      for (const item of all) {
        const cat = (item.arena_category ?? "").trim();
        if (!cat) continue;
        const arr = map.get(cat) ?? [];
        arr.push(item);
        map.set(cat, arr);
      }
      return Array.from(map.entries())
        .filter(([, items]) => items.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
    },
  });

  return {
    featured,
    trending,
    new: fresh,
    quick_bolts,
    hard_mode,
    continue_exploring,
    your_best,
    categories: categories.data ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function Hero({
  playNowHref,
  onExplore,
  onSearch,
}: {
  playNowHref: string;
  onExplore: () => void;
  onSearch: () => void;
}) {
  return (
    <header className="border-l-4 border-volt pl-4 sm:pl-6 space-y-4 sm:space-y-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
        Brain Bolt Arena
      </p>
      <h1 className="font-display text-5xl md:text-7xl italic uppercase tracking-tighter leading-[0.9]">
        BRAIN BOLT
        <br />
        <span className="text-volt">ARENA</span>
      </h1>
      <p className="text-foreground/70 font-mono text-sm sm:text-base max-w-xl">
        Test your knowledge. Beat your best. Keep climbing.
      </p>
      <div className="flex flex-wrap gap-3 pt-2">
        <Link
          to={playNowHref as never}
          className="inline-flex min-h-12 items-center bg-volt text-background font-display text-2xl uppercase italic px-7 py-3.5 skew-cta active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
        >
          Play Now
        </Link>
        <button
          onClick={onExplore}
          className="inline-flex min-h-12 items-center border border-volt px-7 py-3.5 font-display text-xl uppercase italic text-volt skew-cta transition-colors hover:bg-volt hover:text-background active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
        >
          Explore
        </button>
        <button
          onClick={onSearch}
          className="inline-flex min-h-12 items-center border border-border px-5 py-3.5 font-mono text-xs uppercase tracking-widest text-foreground/70 transition-colors hover:border-volt hover:text-volt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
          aria-label="Search Arena challenges"
        >
          Search
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

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
    <section
      className="space-y-5"
      aria-labelledby={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <div className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
          {eyebrow}
        </p>
        <h2
          id={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}
          className="font-display text-3xl italic uppercase tracking-tight"
        >
          {title}
        </h2>
        {subtitle && <p className="text-foreground/50 text-sm">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function CardGrid({
  items,
  personalBests,
}: {
  items: ArenaListItem[];
  personalBests: Map<string, number>;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((c) => (
        <ArenaCard
          key={c.id}
          item={c}
          played={personalBests.has(c.id)}
          personalBest={personalBests.get(c.id) ?? null}
        />
      ))}
    </div>
  );
}

function CategorySections({
  byCategory,
  personalBests,
}: {
  byCategory: Array<[string, ArenaListItem[]]>;
  personalBests: Map<string, number>;
}) {
  return (
    <div className="space-y-12">
      {byCategory.map(([cat, items]) => (
        <Section
          key={cat}
          eyebrow="Category"
          title={cat}
          subtitle={`${items.length} challenge${items.length === 1 ? "" : "s"}`}
        >
          <CardGrid items={items.slice(0, 6)} personalBests={personalBests} />
        </Section>
      ))}
    </div>
  );
}

/**
 * Category browse bar — the fastest route from "I fancy a quiz" to a quiz.
 * Derived from the published catalog, so an empty category never appears.
 */
function CategoryBar({
  categories,
  onPick,
}: {
  categories: string[];
  onPick: (category: string) => void;
}) {
  if (categories.length === 0) return null;
  return (
    <section aria-labelledby="arena-categories" className="space-y-4">
      <h2
        id="arena-categories"
        className="font-display text-2xl italic uppercase tracking-tight"
      >
        Browse by category
      </h2>
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => onPick(cat)}
            className="min-h-11 border border-border px-3 py-2 transition-colors hover:border-volt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
          >
            <CategoryChip category={cat} />
          </button>
        ))}
      </div>
    </section>
  );
}

function ClosedBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="border-2 border-pink-shock/40 bg-pink-shock/10 p-4 space-y-1"
    >
      <p className="font-mono text-[10px] uppercase tracking-widest text-pink-shock">
        Arena closed
      </p>
      <p className="text-foreground/80 text-sm">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Search panel                                                        */
/* ------------------------------------------------------------------ */

function SearchPanel({
  query,
  setQuery,
  filters,
  setFilters,
  result,
  loading,
  onClose,
  personalBests,
}: {
  query: string;
  setQuery: (v: string) => void;
  filters: ArenaSearchFilters;
  setFilters: (f: ArenaSearchFilters) => void;
  result: ArenaSearchResult[] | null;
  loading: boolean;
  onClose: () => void;
  personalBests: Map<string, number>;
}) {
  const total = result && result.length > 0 ? result[0].total_count : 0;
  const activeLength =
    ARENA_LENGTH_FILTERS.find((f) => f.max === filters.duration_max)?.value ?? "any";

  return (
    <div className="space-y-4 border-2 border-volt/30 bg-card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label htmlFor="arena-search-input" className="block flex-1 min-w-[200px]">
          <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Find a challenge
          </span>
          <input
            id="arena-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, description, category or tag"
            className="mt-1 w-full min-h-11 bg-background border-2 border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt placeholder:text-muted-foreground"
          />
        </label>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 px-5 border border-border font-mono text-xs uppercase text-foreground/70 hover:border-pink-shock hover:text-pink-shock focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
        >
          Close search
        </button>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <label className="block">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Difficulty</span>
          <select
            value={filters.difficulty ?? ""}
            onChange={(e) =>
              setFilters({
                ...filters,
                difficulty: (e.target.value || undefined) as ArenaSearchFilters["difficulty"],
              })
            }
            className="mt-1 w-full min-h-11 bg-background border border-border px-3 py-2 font-mono text-xs uppercase"
          >
            <option value="">Any difficulty</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>

        <label className="block">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Category</span>
          <input
            value={filters.category ?? ""}
            onChange={(e) => setFilters({ ...filters, category: e.target.value || undefined })}
            placeholder="Any category"
            className="mt-1 w-full min-h-11 bg-background border border-border px-3 py-2 font-mono text-xs"
          />
        </label>

        <label className="block">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Sort by</span>
          <select
            value={filters.sort ?? "featured"}
            onChange={(e) =>
              setFilters({
                ...filters,
                sort: e.target.value as ArenaSearchFilters["sort"],
              })
            }
            className="mt-1 w-full min-h-11 bg-background border border-border px-3 py-2 font-mono text-xs uppercase"
          >
            <option value="featured">{arenaSortLabel("featured")}</option>
            <option value="most_played">{arenaSortLabel("most_played")}</option>
            <option value="newest">{arenaSortLabel("newest")}</option>
            <option value="trending">{arenaSortLabel("trending")}</option>
          </select>
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="font-mono text-[10px] uppercase text-foreground/60">Length</legend>
        <div className="flex flex-wrap gap-2">
          {ARENA_LENGTH_FILTERS.map((f) => {
            const active = activeLength === f.value;
            return (
              <button
                key={f.value}
                type="button"
                title={f.hint}
                aria-pressed={active}
                onClick={() => setFilters({ ...filters, duration_max: f.max })}
                className={`min-h-11 border px-3 font-mono text-xs uppercase transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt ${
                  active
                    ? "border-volt bg-volt/10 text-volt"
                    : "border-border text-foreground/70 hover:border-volt hover:text-volt"
                }`}
              >
                {f.label}
                <span className="ml-2 text-foreground/40">{f.hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <p
        className="font-mono text-[10px] uppercase tracking-widest text-foreground/50"
        role="status"
        aria-live="polite"
      >
        {loading
          ? LOADING.searching
          : result == null
            ? "Type to search"
            : result.length === 0
              ? `No matches for "${query}"`
              : `Showing ${result.length} of ${total} match${total === 1 ? "" : "es"}`}
      </p>

      {result && result.length > 0 && (
        <CardGrid items={result as unknown as ArenaListItem[]} personalBests={personalBests} />
      )}

      {result && result.length === 0 && (
        <ArenaEmptyState
          title="No matches"
          body={
            query.trim() !== ""
              ? `Nothing matches "${query.trim()}". Try a different title, category or tag.`
              : "No challenges match these filters. Try widening the length or difficulty."
          }
        />
      )}
    </div>
  );
}
