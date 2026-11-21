#!/usr/bin/env node
/**
 * Installer CLI — `trusted-ua` when installed from npm (`npm i -g trusted-user-agent`),
 * or `node dist/installer/cli.js` from a checkout:
 *
 *   trusted-ua [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]
 *   trusted-ua mcp [install|status|uninstall] [pi|claude|codex|cursor|gemini|vscode|all]
 *
 * The app target selects which Mozilla applications the shared `com.matbee.agent`
 * host is registered for (plan §23). Default: `mozilla` (both).
 * The mcp client selects which MCP client configs get the `trusted-ua` stdio
 * bridge entry. Default: `pi`.
 *
 * `--allow-temporary` lets install run from a temporary package root (npx
 * cache, temp dir); only tests need it.
 *
 * This is a normal CLI process (not the native host), so stdout is free for
 * report output. The native host keeps stdout protocol-only.
 */
import { runCommand, type InstallerCommand, type InstallerSubcommand } from "./index.js";
import type { InstallAppTarget } from "./common.js";
import { MCP_CLIENTS, isMcpClientTarget, type McpClientTarget } from "./mcp-clients.js";

const USAGE = [
  "usage: trusted-ua [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]",
  `       trusted-ua mcp [install|status|uninstall] [${[...MCP_CLIENTS, "all"].join("|")}]`,
].join("\n");

const commands: ReadonlySet<string> = new Set(["install", "status", "doctor", "uninstall", "mcp"]);
const appTargets: ReadonlySet<string> = new Set(["firefox", "thunderbird", "mozilla"]);
const mcpSubs: ReadonlySet<string> = new Set(["install", "status", "uninstall"]);

const argv = process.argv.slice(2);
const allowTemporary = argv.includes("--allow-temporary");
const positional = argv.filter((a) => !a.startsWith("--"));
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const command = (positional[0] ?? "status").trim();
if (!commands.has(command)) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

let sub: InstallerSubcommand = "install";
let mcpClient: McpClientTarget = "pi";
let appArg: string = "mozilla";
if (command === "mcp") {
  const s = (positional[1] ?? "install").trim();
  const c = (positional[2] ?? "pi").trim();
  if (!mcpSubs.has(s) || !isMcpClientTarget(c)) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  sub = s as InstallerSubcommand;
  mcpClient = c;
} else {
  appArg = (positional[1] ?? "mozilla").trim();
  if (!appTargets.has(appArg)) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}

try {
  const result = await runCommand(
    command as InstallerCommand,
    { apps: appArg as InstallAppTarget, mcpClient, ...(allowTemporary ? { allowTemporary } : {}) },
    sub,
  );
  process.stdout.write(result.lines.join("\n") + "\n");
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
