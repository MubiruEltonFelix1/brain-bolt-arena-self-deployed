import { useEffect, useState } from "react";

/**
 * Viewport width in CSS pixels, SSR-safe.
 *
 * Always starts at `fallback` — including on the client's first render — and
 * measures in an effect. Starting from `window.innerWidth` instead would make
 * the first client render disagree with the server's markup whenever the real
 * width differs from the fallback, which React reports as a hydration mismatch
 * (and which, here, would flash the wrong QR size on a phone).
 *
 * Layouts driven by this must therefore degrade sensibly at `fallback`, which is
 * the common desktop case.
 */
export function useViewportWidth(fallback = 1280): number {
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    let frame = 0;
    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(window.innerWidth));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return width;
}
