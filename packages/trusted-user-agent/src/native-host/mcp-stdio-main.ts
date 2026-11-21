/**
 * Entry point of the Trusted User Agent stdio MCP server (see mcp-stdio-bridge.ts).
 * Launched by MCP clients via the `/trusted-ua mcp install` config entry:
 *   { "command": "<node>", "args": ["<pkg>/dist/native-host/mcp-stdio-main.js"] }
 */
import { runMcpStdioBridge } from "./mcp-stdio-bridge.js";

await runMcpStdioBridge({
  input: process.stdin,
  output: process.stdout,
  log: (line) => process.stderr.write(`[trusted-ua mcp] ${line}\n`),
});
process.exit(0);
