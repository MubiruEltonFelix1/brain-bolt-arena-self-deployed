import { useEffect, useState } from "react";

type Props = {
  /** Title of the section being entered (e.g. "SPORTS"). */
  title: string;
  /** How long (ms) the header remains visible before fading out. */
  dismissAfterMs?: number;
};

/**
 * Shows a "SECTION: <title>" banner when a categorized session enters a new
 * section.
 *
 * Purely presentational and client-driven: it appears when the parent route
 * detects a section boundary from the authoritative session snapshot, and
 * dismisses itself after `dismissAfterMs`. It does NOT:
 *   * count as a question,
 *   * award points,
 *   * advance the question index,
 *   * start/pause/reset the question timer,
 *   * publish its own Realtime status.
 *
 * Host and player each render this independently from the same snapshot, so
 * they stay synchronized without any extra wire protocol.
 */
export function SectionHeader({ title, dismissAfterMs = 3000 }: Props) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), dismissAfterMs);
    return () => clearTimeout(timer);
  }, [dismissAfterMs]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-label={`Section: ${title}`}
      className="flex flex-col items-center justify-center gap-3 py-6 animate-fade-in"
    >
      <p className="font-mono text-[10px] uppercase tracking-widest text-volt">Section</p>
      <h2 className="font-display text-5xl sm:text-6xl italic uppercase text-foreground">
        {title.toUpperCase()}
      </h2>
    </div>
  );
}
