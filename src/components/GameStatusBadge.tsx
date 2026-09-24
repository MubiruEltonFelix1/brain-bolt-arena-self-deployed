import { gameState, type LiveGameStatus } from "@/lib/terminology";

const TONE_CLASS: Record<string, string> = {
  waiting: "text-cyan-jolt border-cyan-jolt/30 bg-cyan-jolt/15",
  live: "text-volt border-volt/30 bg-volt/10",
  paused: "text-amber-spark border-amber-spark/30 bg-amber-spark/15",
  done: "text-foreground/70 border-border bg-background",
};

const TONE_GLYPH: Record<string, string> = {
  waiting: "◌",
  live: "●",
  paused: "❙❙",
  done: "✓",
};

/**
 * "What state is this game in?" — the one component that answers it, everywhere.
 *
 * The label is always spelled out in words; colour and the glyph are
 * decorative reinforcement only, so the state is never communicated by colour
 * alone.
 */
export function GameStatusBadge({
  status,
  paused = false,
  className = "",
}: {
  status: LiveGameStatus;
  paused?: boolean;
  className?: string;
}) {
  const state = gameState(status, paused);
  return (
    <span
      className={`inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest ${TONE_CLASS[state.tone]} ${className}`}
    >
      <span aria-hidden="true">{TONE_GLYPH[state.tone]}</span>
      {state.label}
    </span>
  );
}
