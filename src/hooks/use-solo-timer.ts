import { useEffect, useRef, useState } from "react";

/**
 * Local, single-player question timer used by the Arena and Training surfaces.
 *
 * The live multiplayer surfaces (host/player) deliberately do NOT use this —
 * they run on the server-authoritative clock in `question-intro-timing.ts`.
 */
export function useSoloTimer(questionKey: string, timeLimitMs: number) {
  const startedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(iv);
  }, [questionKey]);

  const elapsedMs = now - startedAt.current;
  const remainingMs = Math.max(0, timeLimitMs - elapsedMs);

  return {
    elapsedMs,
    remainingMs,
    remainingSec: Math.ceil(remainingMs / 1000),
    timedOut: remainingMs <= 0,
    /** Milliseconds since this question started — for response-time scoring. */
    responseMs: () => Date.now() - startedAt.current,
  };
}
