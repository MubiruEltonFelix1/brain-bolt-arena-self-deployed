// Shim browser globals that pdfjs-dist (used by pdf-parse) references at
// module load time. Node.js serverless runtimes (Vercel) don't expose DOM
// APIs, so importing pdf-parse would otherwise throw before any extraction
// can run. These shims are intentionally minimal — text extraction does not
// rely on 2D transforms or DOM rendering.

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

// pdfjs-dist may probe for these at load time. Provide no-op stubs so the
// module loads; they're not used for text extraction.

if (typeof globalThis.window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}

if (typeof globalThis.document === "undefined") {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({}),
    createElementNS: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

if (typeof globalThis.navigator === "undefined") {
  (globalThis as Record<string, unknown>).navigator = { userAgent: "node" };
}

// pdfjs-dist's page render loop schedules itself with window.requestAnimationFrame
// (see _scheduleNext in pdf.mjs). Text extraction never reaches it, but
// rasterizing a page for OCR does — without this the render rejects with
// "window.requestAnimationFrame is not a function".
if (typeof (globalThis as Record<string, unknown>).requestAnimationFrame === "undefined") {
  const shimRaf = (cb: (time: number) => void): unknown =>
    setTimeout(() => cb(Date.now()), 16);
  (globalThis as Record<string, unknown>).requestAnimationFrame = shimRaf;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: unknown) =>
    clearTimeout(id as ReturnType<typeof setTimeout>);
}

if (typeof globalThis.Image === "undefined") {
  class ShimImage {}
  (globalThis as Record<string, unknown>).Image = ShimImage;
}

if (typeof globalThis.OffscreenCanvas === "undefined") {
  class ShimOffscreenCanvas {}
  (globalThis as Record<string, unknown>).OffscreenCanvas = ShimOffscreenCanvas;
}

if (typeof globalThis.HTMLCanvasElement === "undefined") {
  class ShimHTMLCanvasElement {}
  (globalThis as Record<string, unknown>).HTMLCanvasElement = ShimHTMLCanvasElement;
}
