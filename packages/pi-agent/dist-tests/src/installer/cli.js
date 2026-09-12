/**
 * Installer CLI: `node dist/installer/cli.js [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]`
 *
 * The app target selects which Mozilla applications the shared `com.matbee.agent`
 * host is registered for (plan §23). Default: `mozilla` (both).
 *
 * This is a normal CLI process (not the native host), so stdout is free for
 * report output. The native host keeps stdout protocol-only.
 */
import { runCommand } from "./index.js";
const commands = new Set(["install", "status", "doctor", "uninstall"]);
const appTargets = new Set(["firefox", "thunderbird", "mozilla"]);
const command = (process.argv[2] ?? "status").trim();
const appArg = (process.argv[3] ?? "mozilla").trim();
if (!commands.has(command) || !appTargets.has(appArg)) {
    process.stderr.write("usage: pi-agent-installer [install|status|doctor|uninstall] [firefox|thunderbird|mozilla]\n");
    process.exit(2);
}
try {
    const result = await runCommand(command, { apps: appArg });
    process.stdout.write(result.lines.join("\n") + "\n");
    process.exit(result.ok ? 0 : 1);
}
catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
}
//# sourceMappingURL=cli.js.map