// Shim the browser globals that pdfjs-dist genuinely needs on a server.
//
// Keep this list MINIMAL. pdfjs-dist (via pdf-parse) needs DOMMatrix at module
// load, and its page render loop needs requestAnimationFrame. It does NOT need
// window or document: stubbing `document` here would make SSR-time code that
// probes `typeof document !== "undefined"` take the browser path and crash.
// sonner's <Toaster/> did exactly that — `document.documentElement` was
// undefined, which 500'd every page in production.
//
// IMPORTANT: `package.json` declares `"sideEffects": false`, so a bare
// `import "@/lib/ai/dom-shim.server"` is tree-shaken out of the SSR/Nitro
// bundle. Callers must invoke `installDomShims()` explicitly before importing
// pdfjs-dist / pdf-parse. The trailing call below only helps unbundled runs.

export function installDomShims(): void {
  if (typeof globalThis.DOMMatrix === "undefined") {
    class ShimMatrix {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      m11 = 1;
      m12 = 0;
      m13 = 0;
      m14 = 0;
      m21 = 0;
      m22 = 1;
      m23 = 0;
      m24 = 0;
      m31 = 0;
      m32 = 0;
      m33 = 1;
      m34 = 0;
      m41 = 0;
      m42 = 0;
      m43 = 0;
      m44 = 1;
      constructor(_init?: string | number[]) {}
      multiply(): ShimMatrix {
        return new ShimMatrix();
      }
      translate(): ShimMatrix {
        return new ShimMatrix();
      }
      scale(): ShimMatrix {
        return new ShimMatrix();
      }
      rotate(): ShimMatrix {
        return new ShimMatrix();
      }
      inverse(): ShimMatrix {
        return new ShimMatrix();
      }
      toFloat32Array(): Float32Array {
        return new Float32Array(16);
      }
      toFloat64Array(): Float64Array {
        return new Float64Array(16);
      }
    }
    (globalThis as Record<string, unknown>).DOMMatrix = ShimMatrix;
  }

  // pdfjs-dist's page render loop schedules itself with requestAnimationFrame
  // (see _scheduleNext in pdf.mjs). Text extraction never reaches it, but
  // rasterizing a page for OCR does — without this the render rejects with
  // "window.requestAnimationFrame is not a function".
  if (typeof (globalThis as Record<string, unknown>).requestAnimationFrame === "undefined") {
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (time: number) => void) =>
      setTimeout(() => cb(Date.now()), 16);
    (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: unknown) =>
      clearTimeout(id as ReturnType<typeof setTimeout>);
  }
}

// Best effort for unbundled callers (tests, scripts). Bundled callers must
// call installDomShims() themselves — see the note at the top.
installDomShims();
