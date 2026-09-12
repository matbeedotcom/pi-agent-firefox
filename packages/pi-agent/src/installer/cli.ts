/**
 * Installer CLI: `node dist/installer/cli.js [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]`
 *
 * The app target selects which Mozilla applications the shared `dev.pi.agent`
 * host is registered for (plan §23). Default: `mozilla` (both).
 *
 * This is a normal CLI process (not the native host), so stdout is free for
 * report output. The native host keeps stdout protocol-only.
 */
import { runCommand, type InstallerCommand } from "./index.js";
import type { InstallAppTarget } from "./common.js";

const commands: ReadonlySet<string> = new Set(["install", "status", "doctor", "uninstall"]);
const appTargets: ReadonlySet<string> = new Set(["firefox", "thunderbird", "mozilla"]);

const command = (process.argv[2] ?? "status").trim();
const appArg = (process.argv[3] ?? "mozilla").trim();

if (!commands.has(command) || !appTargets.has(appArg)) {
  process.stderr.write("usage: pi-agent-installer [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]\n");
  process.exit(2);
}

try {
  const result = await runCommand(command as InstallerCommand, { apps: appArg as InstallAppTarget });
  process.stdout.write(result.lines.join("\n") + "\n");
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
