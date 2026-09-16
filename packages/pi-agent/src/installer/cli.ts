/**
 * Installer CLI: `node dist/installer/cli.js [install|status|doctor|uninstall|mcp] [firefox|thunderbird|mozilla]`
 * For `mcp`, the second argument is a sub-command: [install|status|uninstall].
 *
 * The app target selects which Mozilla applications the shared `com.matbee.agent`
 * host is registered for (plan §23). Default: `mozilla` (both).
 *
 * This is a normal CLI process (not the native host), so stdout is free for
 * report output. The native host keeps stdout protocol-only.
 */
import { runCommand, type InstallerCommand, type InstallerSubcommand } from "./index.js";
import type { InstallAppTarget } from "./common.js";

const commands: ReadonlySet<string> = new Set(["install", "status", "doctor", "uninstall", "mcp"]);
const appTargets: ReadonlySet<string> = new Set(["firefox", "thunderbird", "mozilla"]);
const mcpSubs: ReadonlySet<string> = new Set(["install", "status", "uninstall"]);

const command = (process.argv[2] ?? "status").trim();
const secondArg = (process.argv[3] ?? (command === "mcp" ? "install" : "mozilla")).trim();

if (!commands.has(command)) {
  process.stderr.write("usage: pi-browser-installer [install|status|doctor|uninstall|mcp] [firefox|thunderbird|mozilla] (mcp: [install|status|uninstall])\n");
  process.exit(2);
}
const sub = command === "mcp" ? secondArg : undefined;
if (sub !== undefined && !mcpSubs.has(sub)) {
  process.stderr.write("usage: pi-browser-installer mcp [install|status|uninstall]\n");
  process.exit(2);
}
const appArg = command === "mcp" ? "mozilla" : secondArg;

if (!appTargets.has(appArg)) {
  process.stderr.write("usage: pi-browser-installer [install|status|doctor|uninstall|mcp] [firefox|thunderbird|mozilla]\n");
  process.exit(2);
}

try {
  const result = await runCommand(command as InstallerCommand, { apps: appArg as InstallAppTarget }, (sub as InstallerSubcommand) ?? "install");
  process.stdout.write(result.lines.join("\n") + "\n");
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
