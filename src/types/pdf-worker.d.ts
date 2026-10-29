// pdfjs-dist ships its worker as a bare .mjs file with no type declarations.
// We import it directly (see ensurePdfWorker in pdf-extraction.server.ts) so the
// module lands in the server bundle instead of being resolved from disk at
// runtime, which fails once Nitro relocates the chunk.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
