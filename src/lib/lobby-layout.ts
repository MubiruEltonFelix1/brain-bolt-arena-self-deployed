// Lobby layout maths.
//
// The hosted lobby is shown on everything from a 390px phone in a teacher's
// hand to a projector in a hall. Deciding how big the Game PIN, the QR code
// and the player wall should be is arithmetic, not styling — keeping it in a
// pure function means it can be unit-tested at every target resolution and it
// cannot drift between the lobby and the fullscreen view.
//
// Two hard rules encoded here:
//   1. The QR code never renders below `MIN_QR_PX` — under that it stops being
//      reliably scannable from a couple of metres away.
//   2. The player wall is capped. A 100-player session must not be able to push
//      the join information off the screen.

/** Smallest QR render size we consider scannable from a distance. */
export const MIN_QR_PX = 160;

export type PinSize = "md" | "lg" | "xl" | "display";

export type LobbyLayout = {
  /** Tailwind text-size class for the Game PIN. */
  pinClass: string;
  /** QRCodeSVG `size` prop, in px. */
  qrSize: number;
  /** Columns in the player wall. */
  playerColumns: 2 | 3 | 4;
  /**
   * How many players the wall shows before collapsing the rest into a
   * "+N more" line.
   */
  playerCapacity: number;
  /** True when join info and the player wall sit side by side. */
  sideBySide: boolean;
  /** True on projector-class displays — the presentation layout. */
  presentation: boolean;
};

/**
 * Breakpoints, in px. Named for the device the lobby actually runs on:
 *  - `phone`      ≈ a host's phone (the 390px target)
 *  - `tablet`     ≈ a tablet or small laptop
 *  - `desktop`    ≈ a normal laptop/desktop window
 *  - `projector`  ≈ a 1080p+ display driven fullscreen from across a room
 */
export const LOBBY_BREAKPOINTS = {
  phone: 0,
  tablet: 640,
  desktop: 1024,
  projector: 1920,
} as const;

export function lobbyLayout(viewportWidth: number): LobbyLayout {
  const w = Number.isFinite(viewportWidth) ? viewportWidth : LOBBY_BREAKPOINTS.desktop;

  if (w >= LOBBY_BREAKPOINTS.projector) {
    return {
      pinClass: "text-7xl md:text-8xl xl:text-[8rem]",
      qrSize: 360,
      playerColumns: 4,
      playerCapacity: 16,
      sideBySide: true,
      presentation: true,
    };
  }

  if (w >= LOBBY_BREAKPOINTS.desktop) {
    return {
      pinClass: "text-6xl lg:text-7xl",
      qrSize: 256,
      playerColumns: 3,
      playerCapacity: 12,
      sideBySide: true,
      presentation: false,
    };
  }

  if (w >= LOBBY_BREAKPOINTS.tablet) {
    return {
      pinClass: "text-5xl sm:text-6xl",
      qrSize: Math.max(MIN_QR_PX, 208),
      playerColumns: 3,
      playerCapacity: 12,
      sideBySide: false,
      presentation: false,
    };
  }

  return {
    pinClass: "text-4xl sm:text-5xl",
    qrSize: MIN_QR_PX,
    playerColumns: 2,
    playerCapacity: 8,
    sideBySide: false,
    presentation: false,
  };
}

/**
 * The slice of the player list the wall actually renders, plus how many are
 * hidden. Never returns more than `capacity` entries, so a 100-player session
 * is exactly as tall as a 16-player one.
 */
export function playerWallSlice<T>(
  players: readonly T[],
  capacity: number,
): { visible: T[]; hiddenCount: number } {
  const cap = Math.max(0, Math.floor(capacity));
  if (players.length <= cap) return { visible: [...players], hiddenCount: 0 };
  return { visible: players.slice(0, cap), hiddenCount: players.length - cap };
}

/**
 * Groups a 6-digit Game PIN for distance readability: `351208` → `351 208`.
 * Presentation only — the stored code and the join URL keep the raw digits.
 * Non-digit separators a player might type are stripped first, so a pasted
 * "351 208" still renders correctly.
 */
export function formatGameCode(code: string): string {
  const digits = code.replace(/\D/g, "");
  if (digits.length <= 3) return digits;
  const mid = Math.ceil(digits.length / 2);
  return `${digits.slice(0, mid)} ${digits.slice(mid)}`;
}

/** The instruction line under the join information. */
export function joinInstruction(code: string): string {
  return `Scan the QR code or visit the link and enter the Game PIN ${formatGameCode(code)}.`;
}

/**
 * The player-facing join URL for a game code. `origin` is passed in rather than
 * read from `window` so this stays a pure function (SSR-safe and testable).
 */
export function joinUrlFor(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/join/${code}`;
}

/** Strip the protocol so the printed URL stays short on a projector. */
export function displayJoinUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
