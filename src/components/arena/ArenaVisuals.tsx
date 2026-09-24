import { Link } from "@tanstack/react-router";
import { arenaArtwork, categoryAccentVar, difficultyTheme, isOfficial } from "@/lib/arena-visuals";
import { estimatedMinutes, type ArenaListItem } from "@/lib/arena";
import { challengeMetaLine } from "@/lib/terminology";

/* ---------------- Artwork ---------------- */

export function ArenaArtwork({
  quizId,
  title,
  difficulty,
  artwork,
  className = "",
  rounded = false,
}: {
  quizId: string;
  title: string;
  difficulty?: string | null;
  /** Future: creator / marketplace / seasonal artwork URL. */
  artwork?: string | null;
  className?: string;
  rounded?: boolean;
}) {
  const theme = difficultyTheme(difficulty);
  return (
    <div
      className={`relative overflow-hidden bg-background ${rounded ? "rounded-sm" : ""} ${className}`}
      style={{ background: theme.gradient }}
      aria-hidden={false}
    >
      <img
        src={arenaArtwork(quizId, artwork)}
        alt={`${title} artwork`}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-contain object-center p-4 drop-shadow-[0_10px_25px_rgba(0,0,0,0.45)]"
      />
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 120%, color-mix(in oklab, var(--background) 85%, transparent), transparent 60%)",
        }}
      />
    </div>
  );
}

/* ---------------- Chips & badges ---------------- */

export function DifficultyChip({ difficulty }: { difficulty?: string | null }) {
  const theme = difficultyTheme(difficulty);
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-widest px-2 py-1 border"
      style={{ color: theme.color, borderColor: theme.color, background: theme.tint }}
    >
      {theme.label}
    </span>
  );
}

export function OfficialBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground/70">
      <span className="size-4 bg-volt grid place-items-center skew-x-[-12deg]">
        <span className="font-display text-background text-[11px] italic leading-none">B</span>
      </span>
      Official
    </span>
  );
}

/**
 * Free-text category, in whichever brand accent that category hashes to. Kept
 * in one place so a category looks the same on the home page, the detail page
 * and the search results.
 */
export function CategoryChip({ category }: { category?: string | null }) {
  const label = (category ?? "").trim();
  if (!label) return null;
  const color = categoryAccentVar(label);
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-widest px-2 py-1 border"
      style={{
        color,
        borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

export function StatusChip({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-widest"
      style={{ color }}
    >
      {label}
    </span>
  );
}

/* ---------------- Featured hero ---------------- */

export function ArenaHero({
  item,
  ribbon = "Featured",
  personalBest,
}: {
  item: ArenaListItem;
  /** Future sponsored slots reuse this exact layout with a different ribbon. */
  ribbon?: string;
  personalBest?: number | null;
}) {
  const theme = difficultyTheme(item.difficulty);
  const minutes = estimatedMinutes(item);

  return (
    <article
      className="relative overflow-hidden border-2 bg-card"
      style={{
        borderColor: theme.color,
        boxShadow: `0 24px 60px -32px color-mix(in oklab, ${theme.color} 60%, transparent)`,
      }}
    >
      <div className="grid md:grid-cols-[minmax(0,320px)_1fr]">
        <ArenaArtwork
          quizId={item.id}
          title={item.title}
          difficulty={item.difficulty}
          className="h-44 md:h-full min-h-[176px]"
        />

        <div className="p-6 md:p-8 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="font-mono text-[10px] uppercase tracking-widest px-2 py-1"
              style={{ background: theme.color, color: "var(--background)" }}
            >
              {ribbon}
            </span>
            <DifficultyChip difficulty={item.difficulty} />
            <CategoryChip category={item.arena_category} />
            {isOfficial(item.creator_name) && <OfficialBadge />}
          </div>

          <div className="space-y-2">
            <h3 className="font-display text-3xl md:text-4xl italic uppercase tracking-tighter leading-[0.95]">
              {item.title}
            </h3>
            <p className="text-foreground/65 text-sm max-w-xl line-clamp-2">
              {item.description ?? "A hand-picked Brain Bolt Arena challenge."}
            </p>
          </div>

          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            {challengeMetaLine({
              questionCount: item.question_count,
              minutes,
              playCount: item.play_count,
            })}
            {personalBest != null && (
              <>
                {" · "}
                <span className="text-volt">your best {personalBest.toLocaleString()}</span>
              </>
            )}
          </p>

          <div className="flex flex-wrap gap-3 pt-1">
            <Link
              to="/arena/$quizId"
              params={{ quizId: item.id }}
              aria-label={`Play Bolt: ${item.title}`}
              className="inline-block px-8 py-3 font-display text-xl uppercase italic skew-cta active:scale-95 transition-transform focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ background: theme.color, color: "var(--background)" }}
            >
              Play Bolt
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}

/* ---------------- Premium card ---------------- */

export function ArenaCard({
  item,
  played,
  featured,
  personalBest,
}: {
  item: ArenaListItem;
  played: boolean;
  featured?: boolean;
  /** The signed-in player's best score on this challenge, when they have one. */
  personalBest?: number | null;
}) {
  const theme = difficultyTheme(item.difficulty);
  const minutes = estimatedMinutes(item);

  return (
    <Link
      to="/arena/$quizId"
      params={{ quizId: item.id }}
      aria-label={`Play Bolt: ${item.title}`}
      className="group block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
    >
      <article
        className="h-full bg-card border-2 flex flex-col overflow-hidden transition-[transform,box-shadow,border-color] duration-200 motion-safe:group-hover:-translate-y-1 active:scale-[0.99]"
        style={{
          borderColor: featured ? theme.color : "var(--border)",
          boxShadow: `0 18px 40px -34px color-mix(in oklab, ${theme.color} 70%, transparent)`,
        }}
      >
        <ArenaArtwork
          quizId={item.id}
          title={item.title}
          difficulty={item.difficulty}
          className="h-32"
        />

        <div className="p-5 flex flex-col gap-3 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <DifficultyChip difficulty={item.difficulty} />
            {featured ? (
              <StatusChip label="Featured" color={theme.color} />
            ) : played ? (
              <StatusChip label="Played" color="var(--cyan-jolt)" />
            ) : isOfficial(item.creator_name) ? (
              <OfficialBadge />
            ) : null}
          </div>

          <div className="flex-1 space-y-2">
            <h3 className="font-display text-2xl italic uppercase tracking-tight leading-tight transition-colors group-hover:text-volt">
              {item.title}
            </h3>
            <p className="text-foreground/60 text-sm line-clamp-2 min-h-[2.5rem]">
              {item.description ?? "A Brain Bolt Arena challenge."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <CategoryChip category={item.arena_category} />
            {personalBest != null && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-volt">
                Your best {personalBest.toLocaleString()}
              </span>
            )}
          </div>

          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            {challengeMetaLine({
              questionCount: item.question_count,
              minutes,
              playCount: item.play_count,
            })}
          </p>

          <span
            className="inline-flex w-full items-center justify-center border py-3 font-display text-lg italic uppercase tracking-tight transition-colors motion-safe:group-hover:bg-volt motion-safe:group-hover:text-background"
            style={{ borderColor: theme.color, color: theme.color }}
          >
            Play Bolt
          </span>
        </div>
      </article>
    </Link>
  );
}

/* ---------------- Branded empty state ---------------- */

export function ArenaEmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden border-2 border-dashed border-border p-10 text-center space-y-4">
      <span
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(70% 60% at 50% 0%, color-mix(in oklab, var(--volt) 8%, transparent), transparent 70%)",
        }}
      />
      <div className="relative space-y-4">
        <div className="mx-auto size-14 bg-volt grid place-items-center skew-x-[-12deg]">
          <span className="font-display text-background text-3xl italic leading-none">B</span>
        </div>
        <p className="font-display text-2xl italic uppercase text-foreground/80">{title}</p>
        <p className="text-foreground/55 text-sm max-w-md mx-auto">{body}</p>
        {children}
      </div>
    </div>
  );
}
