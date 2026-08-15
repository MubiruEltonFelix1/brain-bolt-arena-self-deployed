import { Link } from "@tanstack/react-router";
import { arenaArtwork, difficultyTheme, isOfficial } from "@/lib/arena-visuals";
import { estimatedMinutes, formatUpdated, type ArenaListItem } from "@/lib/arena";

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

/* ---------------- Metadata row ---------------- */

export function MetaGrid({ item }: { item: ArenaListItem }) {
  const minutes = estimatedMinutes(item);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 font-mono text-[10px] uppercase tracking-widest">
      <Meta label="Questions" value={String(item.question_count)} />
      <Meta label="Duration" value={`~${minutes} min`} />
      <Meta label="Plays" value={item.play_count.toLocaleString()} />
      <Meta label="Avg accuracy" value={item.avg_accuracy != null ? `${item.avg_accuracy}%` : "—"} />
    </dl>
  );
}

export function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-foreground/40">{label}</dt>
      <dd className="text-foreground/85 mt-0.5">{value}</dd>
    </div>
  );
}

/* ---------------- Featured hero ---------------- */

export function ArenaHero({
  item,
  ribbon = "Featured",
}: {
  item: ArenaListItem;
  /** Future sponsored slots reuse this exact layout with a different ribbon. */
  ribbon?: string;
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
            {item.question_count} questions · ~{minutes} min ·{" "}
            {item.play_count.toLocaleString()} plays
          </p>

          <div className="flex flex-wrap gap-3 pt-1">
            <Link
              to="/arena/$quizId"
              params={{ quizId: item.id }}
              className="inline-block px-8 py-3 font-display text-xl skew-cta active:scale-95 transition-transform focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ background: theme.color, color: "var(--background)" }}
            >
              PLAY NOW
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
}: {
  item: ArenaListItem;
  played: boolean;
  featured?: boolean;
}) {
  const theme = difficultyTheme(item.difficulty);

  return (
    <Link
      to="/arena/$quizId"
      params={{ quizId: item.id }}
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

        <div className="p-5 flex flex-col gap-4 flex-1">
          <div className="flex items-start justify-between gap-3">
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

          <MetaGrid item={item} />

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">
              Updated {formatUpdated(item.last_updated)}
            </p>
            <span
              className="font-mono text-[10px] uppercase tracking-widest transition-transform motion-safe:group-hover:translate-x-1"
              style={{ color: theme.color }}
            >
              View →
            </span>
          </div>
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
