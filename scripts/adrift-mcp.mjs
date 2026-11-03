#!/usr/bin/env node
// Adrift MCP server (stdio). Lets MCP clients (Claude Code, Codex, ...) list
// and run Adrift tools against a running Adrift. See docs/MCP.md.
//
//   ADRIFT_URL      Adrift base URL (default http://127.0.0.1:3000)
//   ADMIN_API_KEY   sent as a Bearer token when set (required off-loopback)
import {
  createAdriftClient,
  createMcpServer,
  createToolHandlers,
  serveStdio,
} from "./lib/adrift-mcp-core.mjs";

const log = (msg) => process.stderr.write(`[adrift-mcp] ${msg}\n`);

const client = createAdriftClient({
  baseUrl: process.env.ADRIFT_URL || "http://127.0.0.1:3000",
  apiKey: process.env.ADMIN_API_KEY || "",
});
const pollMs = Number(process.env.ADRIFT_MCP_POLL_MS) || 2000;
const server = createMcpServer({
  handlers: createToolHandlers(client, { pollMs }),
  log,
});
serveStdio({ server });
