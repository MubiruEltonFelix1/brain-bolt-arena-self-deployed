// Extraction tests — no network. Verifies mime detection from magic bytes and
// that pdf-parse feeds page-wise text through. A real PDF buffer isn't easily
// constructed by hand, so the PDF path is covered by an end-to-end eval fixture
// instead; here we assert the type/size/page validation surface and mime sniff.

import { describe, expect, test } from "bun:test";
import { detectMimeType, ACCEPTED_MIME_TYPES, extractImage } from "@/lib/ai/pdf-extraction.server";
import { installDomShims } from "@/lib/ai/dom-shim.server";

describe("ai / extraction: mime detection from magic bytes", () => {
  test("pdf signature detected", () => {
    const buf = Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(10)]);
    expect(detectMimeType(buf)).toEqual({ mime: "application/pdf", ext: ".pdf" });
  });

  test("png signature detected", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMimeType(buf)).toEqual({ mime: "image/png", ext: ".png" });
  });

  test("jpeg signature detected", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectMimeType(buf)).toEqual({ mime: "image/jpeg", ext: ".jpg" });
  });

  test("webp signature detected (RIFF + WEBP)", () => {
    const riff = Buffer.from("RIFF", "ascii");
    const size = Buffer.alloc(4);
    const webp = Buffer.from("WEBP", "ascii");
    const buf = Buffer.concat([riff, size, webp]);
    expect(detectMimeType(buf)).toEqual({ mime: "image/webp", ext: ".webp" });
  });

  test("ribbon without WEBP is rejected", () => {
    const buf = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVIX")]);
    expect(detectMimeType(buf)).toBeNull();
  });

  test("empty buffer rejected", () => {
    expect(detectMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe("ai / extraction: accepted MIME types", () => {
  test("contains the four supported formats", () => {
    expect(ACCEPTED_MIME_TYPES.has("application/pdf")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("image/png")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("image/jpeg")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("image/webp")).toBe(true);
  });
});

describe("ai / extraction: image upload", () => {
  test("image is treated as a single-page OCR-needed source", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const res = extractImage(buf, "image/png");
    expect(res.pageCount).toBe(1);
    expect(res.pages[0].page).toBe(1);
    expect(res.pages[0].text).toBe("");
    expect(res.needsOcr).toBe(true);
    expect(res.unreadablePages).toEqual([1]);
    expect(res.error).toBeNull();
  });
});

describe("ai / dom shim: must not fake browser document state", () => {
  // Regression guard: stubbing `document` made server-rendered components that
  // probe for it take the browser path. sonner's <Toaster/> read
  // `document.documentElement.getAttribute("dir")` on an undefined
  // documentElement and returned HTTP 500 for every page in production.
  test("leaves document and window exactly as it found them", () => {
    const g = globalThis as Record<string, unknown>;
    const documentBefore = g.document;
    const windowBefore = g.window;

    installDomShims();

    expect(g.document).toBe(documentBefore);
    expect(g.window).toBe(windowBefore);
  });

  test("still provides what pdfjs actually needs", () => {
    const g = globalThis as Record<string, unknown>;
    installDomShims();
    expect(typeof g.DOMMatrix).toBe("function");
    expect(typeof g.requestAnimationFrame).toBe("function");
    expect(typeof g.cancelAnimationFrame).toBe("function");
  });
});
