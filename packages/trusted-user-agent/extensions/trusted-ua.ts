/**
 * Pi extension: the /trusted-ua command (see docs/VERIFICATION.md item 2).
 * `/pi-browser` is the v0.4.0 name and keeps working (openspec
 * rename-trusted-user-agent).
 *
 * Loaded by every Pi session via the package's conventional extensions/
 * directory. It only registers commands; it never starts servers or
 * touches the network at load time.
 *
 * Commands:
 *   /trusted-ua install     register the Native Messaging host (Firefox + Thunderbird)
 *   /trusted-ua status      report installation state
 *   /trusted-ua doctor      status + live host probe (framed ping)
 *   /trusted-ua uninstall   remove the registration
 *   /trusted-ua mcp [install|status|uninstall] [client]
 *                           register the trusted-ua MCP server (stdio bridge)
 *                           in an MCP client's user config: pi (default,
 *                           ~/.pi/agent/mcp.json), claude, codex, cursor,
 *                           gemini, vscode, or all
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TRUSTED_UA } from "@trusted-ua/protocol";

const VALID_COMMANDS = new Set(["install", "status", "doctor", "uninstall", "mcp"]);
const VALID_MCP_SUBS = new Set(["install", "status", "uninstall"]);
const VALID_MCP_CLIENTS = new Set(["pi", "claude", "codex", "cursor", "gemini", "vscode", "all"]);

/** Command names: the current one first, then the v0.4.0 alias. */
export const COMMAND_NAMES = ["trusted-ua", "pi-browser"] as const;

export default function (pi: ExtensionAPI) {
  for (const name of COMMAND_NAMES) {
    const usage = `/${name} mcp [install|status|uninstall] [pi|claude|codex|cursor|gemini|vscode|all]`;
    pi.registerCommand(name, {
      description:
        name === "trusted-ua"
          ? "Manage Trusted User Agent (Firefox + Thunderbird): install | status | doctor | uninstall | mcp [install|status|uninstall] [client]"
          : "Old name of /trusted-ua (Trusted User Agent): install | status | doctor | uninstall | mcp [install|status|uninstall] [client]",
      handler: async (args, ctx) => {
        const [command = "status", mcpSub, mcpClient] = (args ?? "").trim().split(/\s+/).filter(Boolean);
        if (!VALID_COMMANDS.has(command)) {
          ctx.ui.notify(
            `/${name} [install|status|doctor|uninstall|mcp [install|status|uninstall] [client]] — register, check, probe, remove, or configure the ${TRUSTED_UA.nativeHost} integration`,
            "warning",
          );
          return;
        }
        if (
          command === "mcp" &&
          ((mcpSub !== undefined && !VALID_MCP_SUBS.has(mcpSub)) || (mcpClient !== undefined && !VALID_MCP_CLIENTS.has(mcpClient)))
        ) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        try {
          const { runCommand, defaultPkgRoot } = await import("../dist/installer/index.js");
          const result = await runCommand(
            command,
            { pkgRoot: defaultPkgRoot(), ...(mcpClient ? { mcpClient } : {}) },
            mcpSub,
          );
          ctx.ui.notify(result.lines.join("\n"), result.ok ? "info" : "warning");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`/${name} ${command} failed: ${message}`, "error");
        }
      },
    });
  }
}
