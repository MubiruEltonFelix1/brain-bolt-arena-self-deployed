// Lobby UI render tests.
//
// Phase: UX/UI refinement — hosted lobby.
//
// These render the real lobby components to static markup and assert on the
// output, which is the only way to prove the acceptance criteria about the
// lobby actually hold in the DOM: the Game PIN, QR code and join URL are all
// visible together, the QR is never behind a modal, and a 100-player session
// cannot push the join information out of the layout.
//
// The components under test are deliberately router-free and hook-free so they
// render identically on the server. No DOM environment is needed.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JoinPanel } from "@/components/lobby/JoinPanel";
import { PlayerWall, type LobbyPlayer } from "@/components/lobby/PlayerWall";
import { GameStatusBadge } from "@/components/GameStatusBadge";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { lobbyLayout } from "@/lib/lobby-layout";

const CODE = "351208";
const ORIGIN = "https://play.brainbolt.app";
const JOIN_URL = `${ORIGIN}/join/${CODE}`;

const PHONE = lobbyLayout(390);
const TABLET = lobbyLayout(768);
const DESKTOP = lobbyLayout(1440);
const PROJECTOR = lobbyLayout(2560);

function renderPanel(layout = DESKTOP) {
  return renderToStaticMarkup(<JoinPanel code={CODE} joinUrl={JOIN_URL} layout={layout} />);
}

function players(n: number): LobbyPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    nickname: `Player ${i + 1}`,
  }));
}

describe("JoinPanel — join information is present and together", () => {
  test("the Game PIN is rendered, grouped for distance readability", () => {
    const html = renderPanel();
    expect(html).toContain("351 208");
    expect(html).toContain("Game Pin");
  });

  test("the Game PIN keeps its ungrouped form as a screen-reader label", () => {
    expect(renderPanel()).toContain(`aria-label="Game PIN ${CODE}"`);
  });

  test("the QR code renders as a real SVG with an accessible name", () => {
    const html = renderPanel();
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    // The <title> is the accessible text alternative for the code.
    expect(html).toContain(`<title>Join game ${CODE} — open ${JOIN_URL}</title>`);
  });

  test("the QR code is never inside a modal — no dialog is rendered in the panel", () => {
    const html = renderPanel();
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
  });

  test("the join URL is visible text, with the protocol stripped for readability", () => {
    const html = renderPanel();
    expect(html).toContain("play.brainbolt.app/join/351208");
    expect(html).toContain("Join at");
  });

  test("the join URL is announced exactly once, not duplicated for screen readers", () => {
    const html = renderPanel();
    // The visible, protocol-stripped form IS the accessible representation. A
    // second sr-only copy of the full URL made a screen reader read the same
    // address twice. (The QR's own <title> is the QR's accessible name, which is
    // a different element describing a different thing.)
    expect(html).toContain("play.brainbolt.app/join/351208");
    expect(html).not.toContain("sr-only");
  });

  test("a plain-English instruction names the QR, the link and the PIN", () => {
    const html = renderPanel();
    expect(html).toContain("Scan the QR code or visit the link and enter the Game PIN");
  });

  test("the copy and fullscreen actions are enhancements, not the only route to the QR", () => {
    const html = renderToStaticMarkup(
      <JoinPanel
        code={CODE}
        joinUrl={JOIN_URL}
        layout={DESKTOP}
        onCopyLink={() => {}}
        onEnlarge={() => {}}
      />,
    );
    expect(html).toContain("Copy join link");
    expect(html).toContain("Show QR fullscreen");
    // The QR itself is still rendered directly above them.
    expect(html).toContain("<svg");
  });

  test("the panel is labelled as a region so it can be navigated to", () => {
    const html = renderPanel();
    expect(html).toContain('aria-labelledby="lobby-join-heading"');
    expect(html).toContain('id="lobby-join-heading"');
  });

  test("the white QR plate is present — required for contrast and a quiet zone", () => {
    expect(renderPanel()).toContain("bg-white");
  });
});

describe("JoinPanel — responsive and presentation sizes", () => {
  test("390px renders the scannable minimum, not a squashed code", () => {
    const html = renderPanel(PHONE);
    expect(html).toContain(`height="${PHONE.qrSize}"`);
    expect(PHONE.qrSize).toBeGreaterThanOrEqual(160);
  });

  test("tablet renders a larger QR than the phone", () => {
    expect(TABLET.qrSize).toBeGreaterThan(PHONE.qrSize);
    expect(renderPanel(TABLET)).toContain(`height="${TABLET.qrSize}"`);
  });

  test("projector class renders the largest QR", () => {
    const html = renderPanel(PROJECTOR);
    expect(html).toContain(`height="${PROJECTOR.qrSize}"`);
    expect(PROJECTOR.qrSize).toBeGreaterThan(DESKTOP.qrSize);
  });

  test("the SVG is allowed to scale down without ever being clipped", () => {
    // width:100% + height:auto + a max-width bound is what prevents the QR
    // clipping on narrow screens while keeping the crisp edges scannable.
    const html = renderPanel(PHONE);
    expect(html).toContain("width:100%");
    expect(html).toContain("height:auto");
    expect(html).toContain(`max-width:${PHONE.qrSize}px`);
  });

  test("the join text column is allowed to shrink so the URL cannot overflow", () => {
    // `min-w-0` + `break-all` is the pair that stops a long host from pushing
    // the layout sideways.
    const html = renderPanel();
    expect(html).toContain("min-w-0");
    expect(html).toContain("break-all");
  });

  test("stacked layouts keep the PIN above the QR", () => {
    const html = renderPanel(PHONE);
    expect(html.indexOf("Game Pin")).toBeLessThan(html.indexOf("Scan to join"));
  });

  test("side-by-side layouts put the QR beside the PIN", () => {
    const html = renderPanel(DESKTOP);
    expect(html).toContain("flex-wrap");
    expect(html.indexOf("Game Pin")).toBeLessThan(html.indexOf("Scan to join"));
  });
});

describe("PlayerWall — counts and large sessions", () => {
  test("an empty session explains how players get in", () => {
    const html = renderToStaticMarkup(<PlayerWall players={[]} layout={DESKTOP} />);
    expect(html).toContain("No players yet");
    expect(html).toContain("Share the Game PIN");
  });

  test("a single player reads in the singular", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(1)} layout={DESKTOP} />);
    expect(html).toContain("1 player joined");
    expect(html).toContain("Player 1");
  });

  test("24 players are all listed with a natural headline", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(24)} layout={DESKTOP} />);
    expect(html).toContain("24 players joined");
  });

  test("a 10-player session is not truncated", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(10)} layout={DESKTOP} />);
    expect(html).toContain("Player 10");
    expect(html).not.toContain("more in the leaderboard");
  });

  test("a 30-player session is capped at the layout capacity", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(30)} layout={DESKTOP} />);
    expect(html).toContain(`Player ${DESKTOP.playerCapacity}`);
    expect(html).not.toContain(`Player ${DESKTOP.playerCapacity + 1}`);
    expect(html).toContain(`${30 - DESKTOP.playerCapacity} more in the leaderboard`);
  });

  test("a 50-player session is capped too", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(50)} layout={DESKTOP} />);
    expect(html).toContain(`${50 - DESKTOP.playerCapacity} more in the leaderboard`);
  });

  test("a 100-player session cannot grow the wall beyond capacity", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(100)} layout={DESKTOP} />);
    // The headline still tells the truth about the real count.
    expect(html).toContain("100 players joined");
    expect(html).toContain(`${100 - DESKTOP.playerCapacity} more in the leaderboard`);
    // ...while the list itself stays bounded.
    expect(html).not.toContain(`Player ${DESKTOP.playerCapacity + 1}`);
  });

  test("the projector layout shows more players than a phone", () => {
    const phone = renderToStaticMarkup(<PlayerWall players={players(20)} layout={PHONE} />);
    const projector = renderToStaticMarkup(<PlayerWall players={players(20)} layout={PROJECTOR} />);
    expect(PROJECTOR.playerCapacity).toBeGreaterThan(PHONE.playerCapacity);
    expect(phone).toContain(`${20 - PHONE.playerCapacity} more in the leaderboard`);
    expect(projector).toContain(`${20 - PROJECTOR.playerCapacity} more in the leaderboard`);
  });

  test("the count is announced politely so arrivals do not interrupt", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(7)} layout={DESKTOP} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
  });

  test("the wall is labelled as a region", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(3)} layout={DESKTOP} />);
    expect(html).toContain('aria-labelledby="lobby-players-heading"');
  });

  test("nicknames are allowed to truncate rather than break the grid", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(3)} layout={DESKTOP} />);
    expect(html).toContain("truncate");
  });
});

describe("GameStatusBadge — state is never colour-only", () => {
  test("the lobby state is spelled out in words", () => {
    const html = renderToStaticMarkup(<GameStatusBadge status="lobby" />);
    expect(html).toContain("Waiting for players");
  });

  test("running, paused and finished are all distinguishable by text alone", () => {
    expect(renderToStaticMarkup(<GameStatusBadge status="active" />)).toContain("In progress");
    expect(renderToStaticMarkup(<GameStatusBadge status="active" paused />)).toContain("Paused");
    expect(renderToStaticMarkup(<GameStatusBadge status="ended" />)).toContain("Finished");
  });

  test("a glyph accompanies the colour so tone is redundant, not load-bearing", () => {
    const html = renderToStaticMarkup(<GameStatusBadge status="active" />);
    expect(html).toContain('aria-hidden="true"');
  });

  test("an unknown status does not leak the raw value", () => {
    const html = renderToStaticMarkup(<GameStatusBadge status="internal_status_7" />);
    expect(html).not.toContain("internal_status_7");
    expect(html).toContain("Not started");
  });
});

describe("useViewportWidth — SSR safety", () => {
  // The hook must return the fallback when there is no window, because that is
  // the value the server renders. Starting the client at window.innerWidth
  // would make the first client render disagree with the server markup whenever
  // the real width differs from the fallback — a hydration mismatch that would
  // flash the wrong QR size.
  function Probe() {
    const width = useViewportWidth();
    return <span data-width={width}>{width}</span>;
  }

  test("renders the documented fallback without a window", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("1280");
  });

  test("a custom fallback is honoured", () => {
    function Custom() {
      return <span>{useViewportWidth(390)}</span>;
    }
    expect(renderToStaticMarkup(<Custom />)).toContain("390");
  });
});

describe("lobby has no internal identifiers on screen", () => {
  const FORBIDDEN = [
    "mcq",
    "true_false",
    "image_mcq",
    "image_reveal",
    "map_pin",
    "session_id",
    "participant_id",
    "is_playable",
    "arena_enabled",
  ];

  test("the join panel exposes no internal type or database identifiers", () => {
    const html = renderPanel();
    for (const token of FORBIDDEN) expect(html).not.toContain(token);
  });

  test("the player wall exposes no internal identifiers", () => {
    const html = renderToStaticMarkup(<PlayerWall players={players(12)} layout={DESKTOP} />);
    // Player ids are React keys, never rendered text.
    for (const token of ["session_id", "participant_id", "is_playable"]) {
      expect(html).not.toContain(token);
    }
  });

  test("the join panel never renders the internal session id", () => {
    const html = renderPanel();
    // Only the public six-digit PIN is exposed.
    expect(html).toContain(CODE);
    expect(html).not.toMatch(/session/i);
  });
});
