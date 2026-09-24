// Lobby layout + join-information tests.
//
// Phase: UX/UI refinement — the hosted lobby.
//
// These are the pure rules behind the lobby's presentation. They exist because
// the lobby is the one screen that has to work on a phone held by a host AND on
// a projector across a hall, and because a 100-player session must never be able
// to push the join information off the screen.

import { describe, expect, test } from "bun:test";
import {
  LOBBY_BREAKPOINTS,
  MIN_QR_PX,
  displayJoinUrl,
  formatGameCode,
  joinInstruction,
  joinUrlFor,
  lobbyLayout,
  playerWallSlice,
} from "@/lib/lobby-layout";

/** The four resolutions the acceptance criteria name explicitly. */
const TARGETS = {
  phone: 390,
  tablet: 768,
  desktop: 1440,
  projector: 2560,
} as const;

describe("lobbyLayout — resolution targets", () => {
  test("390px (host phone) stays usable and stacks", () => {
    const l = lobbyLayout(TARGETS.phone);
    expect(l.sideBySide).toBe(false);
    expect(l.presentation).toBe(false);
    expect(l.playerColumns).toBe(2);
    expect(l.qrSize).toBe(MIN_QR_PX);
    expect(l.playerCapacity).toBeGreaterThanOrEqual(4);
  });

  test("tablet width gets a bigger QR and three player columns", () => {
    const l = lobbyLayout(TARGETS.tablet);
    expect(l.playerColumns).toBe(3);
    expect(l.qrSize).toBeGreaterThanOrEqual(MIN_QR_PX);
  });

  test("desktop puts the join info beside the player wall", () => {
    const l = lobbyLayout(TARGETS.desktop);
    expect(l.sideBySide).toBe(true);
    expect(l.playerColumns).toBe(3);
  });

  test("projector class turns on the presentation layout", () => {
    const l = lobbyLayout(TARGETS.projector);
    expect(l.presentation).toBe(true);
    expect(l.qrSize).toBeGreaterThan(lobbyLayout(TARGETS.desktop).qrSize);
    expect(l.playerColumns).toBe(4);
  });

  test("the QR code is never rendered below the scannable floor", () => {
    for (const w of [0, 200, 320, 390, 480, 639, 640, 1024, 1400, 1920, 3840]) {
      expect(lobbyLayout(w).qrSize).toBeGreaterThanOrEqual(MIN_QR_PX);
    }
  });

  test("QR size grows monotonically with viewport width — nothing shrinks on a bigger screen", () => {
    const widths = [0, 390, 640, 800, 1024, 1280, 1440, 1920, 2200, 2560];
    const sizes = widths.map((w) => lobbyLayout(w).qrSize);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });

  test("player capacity is always bounded — a big session can never grow the wall without limit", () => {
    for (const w of [390, 768, 1440, 2560]) {
      const cap = lobbyLayout(w).playerCapacity;
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(16);
    }
  });

  test("the Game PIN never shrinks as the screen grows", () => {
    // pinClass must escalate: the projector class offers the largest size.
    const phone = lobbyLayout(TARGETS.phone).pinClass;
    const projector = lobbyLayout(TARGETS.projector).pinClass;
    expect(phone).not.toBe(projector);
    expect(projector).toContain("8rem");
  });

  test("a non-finite width falls back to the desktop layout instead of throwing", () => {
    const l = lobbyLayout(Number.NaN);
    expect(l.qrSize).toBeGreaterThanOrEqual(MIN_QR_PX);
    expect(l.sideBySide).toBe(true);
  });

  test("breakpoints are ordered phone < tablet < desktop < projector", () => {
    expect(LOBBY_BREAKPOINTS.phone).toBeLessThan(LOBBY_BREAKPOINTS.tablet);
    expect(LOBBY_BREAKPOINTS.tablet).toBeLessThan(LOBBY_BREAKPOINTS.desktop);
    expect(LOBBY_BREAKPOINTS.desktop).toBeLessThan(LOBBY_BREAKPOINTS.projector);
  });
});

describe("playerWallSlice — large sessions", () => {
  const players = Array.from({ length: 100 }, (_, i) => `p${i}`);

  test("shows everything when the session fits", () => {
    const { visible, hiddenCount } = playerWallSlice(players.slice(0, 5), 16);
    expect(visible.length).toBe(5);
    expect(hiddenCount).toBe(0);
  });

  test("caps a 100-player session and reports the remainder", () => {
    const { visible, hiddenCount } = playerWallSlice(players, 16);
    expect(visible.length).toBe(16);
    expect(hiddenCount).toBe(84);
    expect(visible[0]).toBe("p0");
  });

  test("30 and 50 player sessions are also capped", () => {
    expect(playerWallSlice(players.slice(0, 30), 12).hiddenCount).toBe(18);
    expect(playerWallSlice(players.slice(0, 50), 12).hiddenCount).toBe(38);
  });

  test("an empty session renders nothing and hides nothing", () => {
    const { visible, hiddenCount } = playerWallSlice([], 8);
    expect(visible).toEqual([]);
    expect(hiddenCount).toBe(0);
  });

  test("a zero capacity never overflows", () => {
    const { visible, hiddenCount } = playerWallSlice(players, 0);
    expect(visible).toEqual([]);
    expect(hiddenCount).toBe(100);
  });

  test("the returned slice is a copy — the caller cannot mutate the source list", () => {
    const source = ["a", "b"];
    const { visible } = playerWallSlice(source, 8);
    visible.push("c");
    expect(source).toEqual(["a", "b"]);
  });
});

describe("Game PIN formatting", () => {
  test("splits six digits for distance readability", () => {
    expect(formatGameCode("351208")).toBe("351 208");
  });

  test("handles an already-grouped value", () => {
    expect(formatGameCode("351 208")).toBe("351 208");
  });

  test("handles four and five digit codes", () => {
    expect(formatGameCode("1234")).toBe("12 34");
    expect(formatGameCode("12345")).toBe("123 45");
  });

  test("leaves short codes alone", () => {
    expect(formatGameCode("12")).toBe("12");
    expect(formatGameCode("")).toBe("");
  });

  test("strips any non-digit a player might paste", () => {
    expect(formatGameCode("351-208")).toBe("351 208");
    expect(formatGameCode("PIN 351208")).toBe("351 208");
  });
});

describe("join URL + instruction", () => {
  test("builds the player-facing join URL", () => {
    expect(joinUrlFor("https://play.brainbolt.app", "351208")).toBe(
      "https://play.brainbolt.app/join/351208",
    );
  });

  test("tolerates a trailing slash on the origin", () => {
    expect(joinUrlFor("https://play.brainbolt.app/", "351208")).toBe(
      "https://play.brainbolt.app/join/351208",
    );
  });

  test("the displayed URL drops the protocol so it stays short on a projector", () => {
    expect(displayJoinUrl("https://play.brainbolt.app/join/351208")).toBe(
      "play.brainbolt.app/join/351208",
    );
    expect(displayJoinUrl("http://localhost:3000/join/1")).toBe("localhost:3000/join/1");
  });

  test("the instruction names all three ways to join", () => {
    const text = joinInstruction("351208");
    expect(text).toContain("QR");
    expect(text.toLowerCase()).toContain("link");
    expect(text).toContain("Game PIN");
    expect(text).toContain("351 208");
  });
});
