// src/lib/sound.ts — tiny Web Audio "game show" sound engine (no deps).
//
// All sounds are synthesized with oscillators + gain envelopes, so there are
// no audio assets to ship. The AudioContext is created lazily on the first
// user gesture (autoplay policy) and unlocked via unlockAudio().
//
// Mute preference persists under "brainbolt:sound_muted" (1 = muted).

export type SoundName =
  | "select" // answer tapped
  | "lock" // answer accepted by the server
  | "correct" // round reveal — right
  | "wrong" // round reveal — wrong
  | "reveal" // round reveal — no answer / soft
  | "tick" // countdown numerals
  | "go" // intro GO
  | "fanfare"; // final standings

const MUTE_KEY = "brainbolt:sound_muted";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** Call on the first pointerdown/keydown anywhere so later sounds play instantly. */
export function unlockAudio() {
  ensureCtx();
}

function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isSoundMuted(): boolean {
  return isMuted();
}

/** Toggles mute; returns the new "sound on" state. */
export function toggleSoundMuted(): boolean {
  const wasMuted = isMuted();
  try {
    window.localStorage.setItem(MUTE_KEY, wasMuted ? "0" : "1");
  } catch {
    /* storage unavailable — keep in-memory behavior */
  }
  // New sound-on state is the complement of the old muted flag:
  // wasMuted=true (off) → unmute → on=true; wasMuted=false (on) → mute → on=false.
  return wasMuted;
}

/**
 * One oscillator note with an exponential volume envelope.
 * start/dur are seconds from now; endFreq sweeps the pitch (for whooshes/buzzes).
 */
function note(
  freq: number,
  start: number,
  dur: number,
  opts: { type?: OscillatorType; vol?: number; endFreq?: number } = {},
) {
  const c = ensureCtx();
  if (!c || !master || isMuted()) return;
  const { type = "sine", vol = 0.6, endFreq } = opts;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const RECIPES: Record<SoundName, () => void> = {
  select: () => note(480, 0, 0.09, { type: "triangle", vol: 0.5, endFreq: 660 }),
  lock: () => {
    note(660, 0, 0.07, { type: "triangle", vol: 0.5 });
    note(990, 0.07, 0.1, { type: "triangle", vol: 0.5 });
  },
  correct: () => {
    note(523.25, 0, 0.14, { type: "sine", vol: 0.7 });
    note(659.25, 0.09, 0.14, { type: "sine", vol: 0.7 });
    note(783.99, 0.18, 0.16, { type: "sine", vol: 0.7 });
    note(1046.5, 0.28, 0.24, { type: "sine", vol: 0.3 });
  },
  wrong: () => {
    note(196, 0, 0.28, { type: "sawtooth", vol: 0.4, endFreq: 110 });
    note(147, 0.06, 0.22, { type: "sawtooth", vol: 0.3, endFreq: 98 });
  },
  reveal: () => note(240, 0, 0.3, { type: "triangle", vol: 0.35, endFreq: 880 }),
  tick: () => note(880, 0, 0.05, { type: "sine", vol: 0.35 }),
  go: () => {
    note(740, 0, 0.18, { type: "triangle", vol: 0.6, endFreq: 1100 });
    note(1320, 0.12, 0.12, { type: "sine", vol: 0.35 });
  },
  fanfare: () => {
    note(523.25, 0, 0.18, { type: "triangle", vol: 0.6 });
    note(659.25, 0.12, 0.18, { type: "triangle", vol: 0.6 });
    note(783.99, 0.24, 0.18, { type: "triangle", vol: 0.6 });
    note(1046.5, 0.36, 0.2, { type: "triangle", vol: 0.6 });
    note(523.25, 0.48, 0.5, { type: "sine", vol: 0.25 });
    note(659.25, 0.48, 0.5, { type: "sine", vol: 0.25 });
    note(783.99, 0.48, 0.5, { type: "sine", vol: 0.25 });
  },
};

export function playSound(name: SoundName) {
  if (typeof window === "undefined") return;
  ensureCtx();
  if (isMuted()) return;
  RECIPES[name]();
}

/** Vibration helper — no-op where navigator.vibrate is unavailable (desktop, iOS). */
export function haptic(pattern: number | number[]) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* unsupported — ignore */
  }
}
