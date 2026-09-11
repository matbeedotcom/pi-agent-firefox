/**
 * Installer CLI: `node dist/installer/cli.js [install|status|doctor|uninstall]`
 *
 * This is a normal CLI process (not the native host), so stdout is free for
 * report output. The native host keeps stdout protocol-only.
 */
import { runCommand } from "./index.js";
const commands = new Set(["install", "status", "doctor", "uninstall"]);
const arg = (process.argv[2] ?? "status").trim();
if (!commands.has(arg)) {
    process.stderr.write("usage: pi-browser-installer [install|status|doctor|uninstall]\n");
    process.exit(2);
}
try {
    const result = await runCommand(arg, {});
    process.stdout.write(result.lines.join("\n") + "\n");
    process.exit(result.ok ? 0 : 1);
}
catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
}
//# sourceMappingURL=cli.js.map