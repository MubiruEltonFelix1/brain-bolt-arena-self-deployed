#!/usr/bin/env bun
// Minimal static + SSR server for the built nitro output (no watcher, no restart loop).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC = fileURLToPath(new URL("../../.vercel/output/static", import.meta.url));
const ENTRY = new URL("../../.vercel/output/functions/__server.func/index.mjs", import.meta.url).href;
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain",
  ".map": "application/json", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".avif": "image/avif",
};

const mod = await import(ENTRY);
const handler = mod.default ?? mod;
if (typeof handler?.fetch !== "function") {
  console.error("entry has no fetch handler; exports:", Object.keys(mod));
  process.exit(1);
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname.includes(".") && !u.pathname.startsWith("/api")) {
      const f = join(STATIC, decodeURIComponent(u.pathname));
      try {
        const body = await readFile(f);
        res.writeHead(200, { "content-type": MIME[extname(f).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(body);
        return;
      } catch {}
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    const request = new Request(u, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await handler.fetch(request);
    const out = {};
    for (const [k, v] of response.headers) if (!["content-encoding", "transfer-encoding", "content-length"].includes(k.toLowerCase())) out[k] = v;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("server error:", e);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("ERR " + String(e).slice(0, 300));
  }
}).listen(PORT, () => console.log(`custom nitro server listening on :${PORT}`));
