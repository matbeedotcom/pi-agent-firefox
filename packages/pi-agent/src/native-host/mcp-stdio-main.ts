/**
 * Entry point of the Pi Browser stdio MCP server (see mcp-stdio-bridge.ts).
 * Launched by MCP clients via the `/pi-browser mcp install` config entry:
 *   { "command": "<node>", "args": ["<pkg>/dist/native-host/mcp-stdio-main.js"] }
 */
import { runMcpStdioBridge } from "./mcp-stdio-bridge.js";

await runMcpStdioBridge({
  input: process.stdin,
  output: process.stdout,
  log: (line) => process.stderr.write(`[pi-browser mcp] ${line}\n`),
});
process.exit(0);
