/**
 * Pi extension: /pi-browser command (see docs/VERIFICATION.md item 2).
 *
 * Loaded by every Pi session via the package's conventional extensions/
 * directory. It only registers a command; it never starts servers or
 * touches the network at load time.
 *
 * Commands:
 *   /pi-browser install     register the Firefox Native Messaging host
 *   /pi-browser status      report installation state
 *   /pi-browser doctor      status + live host probe (framed ping)
 *   /pi-browser uninstall   remove the registration
 *   /pi-browser mcp [install|status|uninstall]
 *                           register the pi-browser MCP server in
 *                           ~/.pi/agent/mcp.json (subagent browser access)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_BROWSER } from "@pi-browser/protocol";

const VALID_COMMANDS = new Set(["install", "status", "doctor", "uninstall", "mcp"]);
const VALID_MCP_SUBS = new Set(["install", "status", "uninstall"]);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-browser", {
    description: "Manage the Pi Browser Firefox integration: install | status | doctor | uninstall | mcp [install|status|uninstall]",
    handler: async (args, ctx) => {
      const [command = "status", mcpSub] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (!VALID_COMMANDS.has(command)) {
        ctx.ui.notify(
          `/pi-browser [install|status|doctor|uninstall|mcp [install|status|uninstall]] — register, check, probe, remove, or configure the ${PI_BROWSER.nativeHost} Firefox integration`,
          "warning",
        );
        return;
      }
      if (command === "mcp" && mcpSub !== undefined && !VALID_MCP_SUBS.has(mcpSub)) {
        ctx.ui.notify("/pi-browser mcp [install|status|uninstall]", "warning");
        return;
      }
      try {
        const { runCommand, defaultPkgRoot } = await import("../dist/installer/index.js");
        const result = await runCommand(command, { pkgRoot: defaultPkgRoot() }, mcpSub);
        ctx.ui.notify(result.lines.join("\n"), result.ok ? "info" : "warning");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/pi-browser ${command} failed: ${message}`, "error");
      }
    },
  });
}
