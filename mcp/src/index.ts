#!/usr/bin/env bun
// Brain Bolt MCP server entry. Run with: bun run dev  (from mcp/)
//
// Speaks MCP over stdio (JSON-RPC on stdin/stdout). All diagnostics go to
// stderr — stdout is the protocol channel and must stay clean.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config";
import { registerTools } from "./tools";

const VERSION = "0.4.0";

const config = loadConfig();

const server = new McpServer({
  name: "brainbolt-mcp",
  version: VERSION,
});

registerTools(server, config);

console.error(
  `[brainbolt-mcp] v${VERSION}` +
    ` | llm=${config.llm ? `${config.llm.model} @ ${config.llm.baseUrl}` : "not configured (set mcp/.env)"}` +
    ` | save_quiz=${config.supabase ? "enabled" : "disabled (JSON/CSV only)"}` +
    ` | lifecycle=${config.supabase ? "enabled (quiz + competition)" : "disabled"}`,
);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async (signal: string) => {
  console.error(`[brainbolt-mcp] received ${signal}, shutting down`);
  await server.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
