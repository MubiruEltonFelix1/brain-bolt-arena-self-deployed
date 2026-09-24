import { PlayerAvatar } from "@/components/PlayerAvatar";
import { playerCountLabel } from "@/lib/terminology";
import { playerWallSlice, type LobbyLayout } from "@/lib/lobby-layout";

export type LobbyPlayer = {
  id: string;
  nickname: string;
  avatarId?: string | null;
  teamColor?: string | null;
};

/**
 * The lobby player wall.
 *
 * Height is bounded by `layout.playerCapacity`, so 100 players look exactly as
 * tidy as 8 and the join panel can never be pushed off screen. The count is
 * announced politely so a screen reader hears arrivals without being
 * interrupted mid-sentence.
 */
export function PlayerWall({
  players,
  layout,
}: {
  players: readonly LobbyPlayer[];
  layout: LobbyLayout;
}) {
  const { visible, hiddenCount } = playerWallSlice(players, layout.playerCapacity);

  const columnClass =
    layout.playerColumns === 4
      ? "grid-cols-2 sm:grid-cols-3 xl:grid-cols-4"
      : layout.playerColumns === 3
        ? "grid-cols-2 sm:grid-cols-3"
        : "grid-cols-2";

  return (
    <section
      aria-labelledby="lobby-players-heading"
      className="border-2 border-border bg-card p-5 sm:p-6 space-y-4"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="lobby-players-heading"
          className="font-display text-2xl sm:text-3xl italic uppercase tracking-tight"
        >
          {players.length === 0 ? "No players yet" : playerCountLabel(players.length)}
        </h2>
      </div>

      {players.length === 0 ? (
        <p className="text-sm text-foreground/60">
          Share the Game PIN or the QR code above. Players appear here the moment they join.
        </p>
      ) : (
        <>
          <p className="sr-only" role="status" aria-live="polite">
            {playerCountLabel(players.length)}
          </p>
          <ul className={`grid ${columnClass} gap-2`}>
            {visible.map((p) => (
              <li
                key={p.id}
                className="flex min-w-0 items-center gap-2 border border-border bg-background/60 px-2.5 py-2 motion-safe:animate-join"
              >
                {p.teamColor && (
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0"
                    style={{ background: p.teamColor }}
                  />
                )}
                <PlayerAvatar avatarId={p.avatarId ?? null} seed={p.id} size={24} />
                <span className="truncate text-sm font-medium">{p.nickname}</span>
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              + {hiddenCount.toLocaleString()} more in the leaderboard
            </p>
          )}
        </>
      )}
    </section>
  );
}
