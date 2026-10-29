// Server-side PDF + image extraction for the Phase 10 prep pipeline.
//
// - pdf-parse (PDF.js-based) extracts native text per page from text-based
//   PDFs, preserving page numbers as provenance anchors.
// - Content-type validation inspects actual file bytes (magic numbers), never
//   trusting the extension or browser-provided MIME type.
// - Image uploads are treated as single-page sources; their text is recovered
//   by the OCR/multimodal stage (Claude Haiku), not here.
//
// All limits (size, pages, dimensions) are enforced by the calling server fn
// before storage; this module only extracts and reports what it can read.

// pdfjs-dist (bundled by pdf-parse) references browser globals (DOMMatrix,
// window, document, ...) at module load time, and a bare side-effect import is
// tree-shaken out because package.json declares sideEffects:false. Import the
// installer as a binding and call it inside extractPdf, before pdf-parse loads.
import { installDomShims } from "@/lib/ai/dom-shim.server";

/**
 * pdf.js loads its worker with `import(this.workerSrc)`, and this build defaults
 * workerSrc to the RELATIVE path "./pdf.worker.mjs" (see pdf.mjs:21179). Once
 * the server bundle relocates the module into a chunk directory, that relative
 * import has no file to resolve and the parse fails with:
 *   Setting up fake worker failed: "Cannot find module .../pdf.worker.mjs"
 *
 * Before that import, pdf.js checks `globalThis.pdfjsWorker?.WorkerMessageHandler`
 * (pdf.mjs:21356), and pdf.worker.mjs assigns exactly that global at load. So
 * importing the worker module explicitly — which also puts it in the bundle
 * graph instead of a runtime file lookup — removes the file dependency.
 *
 * Must run before any PDFParse/getDocument call.
 */
let pdfWorkerReady: Promise<void> | null = null;

export function ensurePdfWorker(): Promise<void> {
  pdfWorkerReady ??= (async () => {
    installDomShims();
    const g = globalThis as Record<string, unknown>;
    try {
      const mod = (await import("pdfjs-dist/legacy/build/pdf.worker.mjs")) as {
        WorkerMessageHandler?: unknown;
      };
      // A bundler may flatten this namespace to the handler itself, so accept
      // either shape. pdf.js requires an OBJECT carrying a WorkerMessageHandler
      // property (pdf.mjs:21358) — assigning the bare handler would silently
      // regress to the missing-file import.
      const handler = mod?.WorkerMessageHandler ?? (mod as unknown);
      const existing = g.pdfjsWorker as { WorkerMessageHandler?: unknown } | undefined;
      if (!existing || typeof existing.WorkerMessageHandler === "undefined") {
        if (typeof handler !== "undefined") {
          g.pdfjsWorker = { WorkerMessageHandler: handler };
        }
      }
    } catch (e) {
      console.error("[pdf] failed to preload the pdf.js worker module", e);
    }
  })();
  return pdfWorkerReady;
}

export type ExtractedPage = {
  page: number; // 1-based
  text: string;
  section: string | null; // best-guess section heading from the page
};

export type ExtractionResult = {
  pages: ExtractedPage[];
  pageCount: number;
  /** True when the document has no usable native text (scanned/image-based). */
  needsOcr: boolean;
  /** Low-confidence / unreadable pages (page numbers). */
  unreadablePages: number[];
  error: string | null;
};

const MIN_CHARS_PER_PAGE_FOR_TEXT = 20; // below this, treat page as image-like

/**
 * Magic-number signatures for the formats we accept. Validated against the
 * raw file bytes so a renamed .exe can't slip through as a "pdf".
 */
const FILE_SIGNATURES: Array<{ mime: string; ext: string; magic: Buffer }> = [
  { mime: "application/pdf", ext: ".pdf", magic: Buffer.from("%PDF", "ascii") },
  { mime: "image/png", ext: ".png", magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { mime: "image/jpeg", ext: ".jpg", magic: Buffer.from([0xff, 0xd8, 0xff]) },
  { mime: "image/webp", ext: ".webp", magic: Buffer.from("RIFF", "ascii") },
];

/** Detect the real MIME type of a file from its first bytes. Returns null for unknown/unsafe. */
export function detectMimeType(buffer: Buffer): { mime: string; ext: string } | null {
  for (const sig of FILE_SIGNATURES) {
    if (
      buffer.length >= sig.magic.length &&
      buffer.subarray(0, sig.magic.length).equals(sig.magic)
    ) {
      // WEBP shares the "RIFF" prefix with other RIFF formats; confirm WEBP.
      if (sig.mime === "image/webp") {
        const riff = buffer.subarray(0, 12).toString("latin1");
        if (!riff.startsWith("RIFF") || !riff.includes("WEBP")) return null;
      }
      return { mime: sig.mime, ext: sig.ext };
    }
  }
  return null;
}

/** The set of MIME types the prep pipeline accepts. */
export const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/**
 * Extract text from a PDF buffer, page by page, using pdf-parse's page-wise
 * text API. Returns per-page text plus page count. Flags pages with almost
 * no extractable text as needing OCR. Never throws — failures are reported
 * via the result's `error` field.
 *
 * pdf-parse is loaded dynamically here (not at module top level) so that the
 * DOM shim above has already run and defined DOMMatrix before pdfjs-dist
 * evaluates. This avoids a ReferenceError in serverless runtimes that lack
 * DOM APIs.
 */
export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    pages: [],
    pageCount: 0,
    needsOcr: false,
    unreadablePages: [],
    error: null,
  };

  // Shim globals and resolve the pdf.js worker before pdf-parse evaluates.
  await ensurePdfWorker();
  const { PDFParse } = await import("pdf-parse");

  try {
    const pdf = new PDFParse({ data: buffer });
    // Sequential, not Promise.all: pdf-parse v2 keeps per-document worker
    // state, and running getInfo() and getText() concurrently on one instance
    // rejects with "The object can not be cloned."
    const info = await pdf.getInfo();
    const text = await pdf.getText();
    result.pageCount = info.total;

    for (const pt of text.pages) {
      const page = pt.num;
      const t = pt.text ?? "";
      const isUnreadable = t.length < MIN_CHARS_PER_PAGE_FOR_TEXT;
      result.pages.push({ page, text: t, section: detectSection(t) });
      if (isUnreadable) result.unreadablePages.push(page);
    }

    const readable = result.pages.filter((p) => p.text.length >= MIN_CHARS_PER_PAGE_FOR_TEXT);
    // needsOcr when most pages have no usable native text.
    result.needsOcr = readable.length === 0 || readable.length < Math.ceil(result.pageCount * 0.4);
  } catch (e: unknown) {
    result.error = e instanceof Error ? e.message : "PDF extraction failed";
    result.needsOcr = true;
  }

  return result;
}

/** Heuristic: grab the first short line as a candidate section heading. */
function detectSection(text: string): string | null {
  const firstLine = text.trim().split(/\n/)[0];
  if (!firstLine) return null;
  const trimmed = firstLine.trim();
  // A heading-like line is short, not sentence-case-heavy, and ends without a period.
  if (trimmed.length >= 3 && trimmed.length <= 80 && !trimmed.endsWith(".")) {
    return trimmed;
  }
  return null;
}

/**
 * Extract an image upload as a single-page source with no native text (OCR
 * happens in the multimodal stage). Returns needsOcr=true so the pipeline
 * routes it to Claude Haiku.
 */
export function extractImage(_buffer: Buffer, mime: string): ExtractionResult {
  return {
    pages: [{ page: 1, text: "", section: null }],
    pageCount: 1,
    needsOcr: true,
    unreadablePages: [1],
    error: null,
  };
}
