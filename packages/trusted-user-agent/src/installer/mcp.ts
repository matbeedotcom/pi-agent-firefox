/**
 * `/trusted-ua mcp` — register the pi-browser MCP server in Pi's global
 * MCP config (`~/.pi/agent/mcp.json`).
 *
 * The broker process (native-host/main.js) exposes the add-on tools as an
 * MCP server on a private unix socket / Windows named pipe
 * (TRUSTED_UA_BROKER.mcpSocketFile). The config entry launches the stdio bridge
 * (native-host/mcp-stdio-main.js), which every MCP client can run: pi's
 * built-in client (pi >= 1.5) only speaks stdio and HTTP. The entry is
 *   { command: <node>, args: [<bridge>], directTools: true, exposure: "deferred" }
 * — `directTools` for pi-mcp-adapter, `exposure` for pi's built-in client
 * (each ignores the other's key). mcp.json is global, so the built-in client
 * would put all ~50 tools into EVERY pi session's prompt with "direct";
 * "deferred" keeps them out until the model loads them via tool_search.
 * The user can change exposure in pi's /mcp manager: install keeps the
 * user-owned keys (exposure, toolExposure, enabled, directTools) of an
 * existing entry, and status checks only command + args.
 *
 * Sub-commands (mirroring the host commands):
 *   mcp [install]   write/update the pi-browser entry (idempotent)
 *   mcp status      report the configured entry vs. the expected one
 *   mcp uninstall   remove the pi-browser entry
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME, TRUSTED_UA_BROKER } from "@trusted-ua/protocol";
import type { CommandResult } from "./index.js";
import { ipcEndpoint } from "../native-host/broker-ipc.js";
import { homeRoot } from "../paths.js";

export { MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME };

/** An entry this package wrote (the stdio bridge, or the broker socket). */
export function isOwnEntry(e: unknown): boolean {
  const s = JSON.stringify(e ?? "");
  return s.includes("mcp-stdio-main") || s.includes("agent-broker-mcp");
}

export type McpSubcommand = "install" | "status" | "uninstall";

/** Broker MCP socket path for this home dir (matches mcp-server.ts default). */
export function mcpSocketPath(homeDir: string, platform: NodeJS.Platform = process.platform): string {
  // Windows: a named pipe (pi-mcp-adapter's socket transport accepts it).
  return ipcEndpoint(path.join(homeRoot(homeDir), TRUSTED_UA_BROKER.runDir), TRUSTED_UA_BROKER.mcpSocketFile, platform);
}

/** Pi's global MCP config (pi-mcp-adapter's getAgentPath("mcp.json")). */
export function mcpConfigPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "mcp.json");
}

export interface McpEntryOptions {
  /** Package root (holds dist/native-host/mcp-stdio-main.js). */
  pkgRoot: string;
  /** Node binary the client launches the bridge with (default: the installer's node). */
  nodePath?: string;
}

/** The stdio bridge entry point inside the package. */
export function mcpBridgePath(pkgRoot: string): string {
  return path.join(pkgRoot, "dist", "native-host", "mcp-stdio-main.js");
}

export function mcpServerEntry(opts: McpEntryOptions): Record<string, unknown> {
  return {
    command: opts.nodePath ?? process.execPath,
    args: [mcpBridgePath(opts.pkgRoot)],
    directTools: true,
    exposure: "deferred",
  };
}

/** Keys of an existing entry the user may have tuned; install keeps them. */
const USER_OWNED_KEYS = ["exposure", "toolExposure", "enabled", "directTools"] as const;

/** Same bridge launch (command + args) — the parts this installer owns. */
function sameLaunch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && a.socket === b.socket;
}

interface McpConfigFile {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function readConfig(file: string): McpConfigFile | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as McpConfigFile;
  } catch {
    // corrupt file: reported, never rewritten (install refuses; status reports it)
  }
  return null;
}

function writeConfig(file: string, config: McpConfigFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function runMcpCommand(sub: McpSubcommand, homeDir: string, entryOpts: McpEntryOptions): CommandResult {
  const file = mcpConfigPath(homeDir);
  const entry = mcpServerEntry(entryOpts);
  const describe = (e: Record<string, unknown>) =>
    typeof e.socket === "string" ? `socket ${e.socket}` : `${String(e.command)} ${(e.args as string[] | undefined)?.join(" ") ?? ""}`.trim();

  switch (sub) {
    case "install": {
      if (existsSync(file) && !readConfig(file)) {
        // Never overwrite a file we can't parse: the user's other servers live there.
        return { ok: false, lines: [`mcp: ${file} is not valid JSON — fix or remove it, then run /trusted-ua mcp again (left unchanged)`] };
      }
      const config = readConfig(file) ?? {};
      const servers =
        config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
          ? (config.mcpServers as Record<string, Record<string, unknown>>)
          : {};
      // A v0.4.0 entry under the old name is replaced (its user-owned keys kept).
      const legacy = servers[LEGACY_MCP_SERVER_NAME];
      const replacesLegacy = !!legacy && isOwnEntry(legacy);
      const existing = servers[MCP_SERVER_NAME] ?? (replacesLegacy ? legacy : undefined);
      const already = !!servers[MCP_SERVER_NAME] && sameLaunch(servers[MCP_SERVER_NAME], entry) && !replacesLegacy;
      const merged: Record<string, unknown> = { ...entry };
      if (existing) {
        for (const key of USER_OWNED_KEYS) if (key in existing) merged[key] = existing[key];
      }
      servers[MCP_SERVER_NAME] = merged;
      if (replacesLegacy) delete servers[LEGACY_MCP_SERVER_NAME];
      config.mcpServers = servers;
      writeConfig(file, config);
      const lines = [
        `mcp: ${already ? "already configured" : "configured"} in ${file}`,
        `  server: ${MCP_SERVER_NAME} → stdio bridge: ${describe(entry)}`,
      ];
      if (replacesLegacy) lines.push(`  replaced the old ${LEGACY_MCP_SERVER_NAME} entry`);
      if (!already) {
        lines.push("  new Pi sessions pick the config up at startup");
        lines.push(`  tool names: mcp__${MCP_SERVER_NAME}__<tool> (pi built-in MCP; exposure "deferred" — the model loads them via tool_search) or mcp:${MCP_SERVER_NAME}/<tool> (pi-mcp-adapter)`);
        lines.push("  works before Firefox/Thunderbird start; calls succeed once an app with the Trusted User Agent add-on is running");
      }
      return { ok: true, lines };
    }
    case "status": {
      if (!existsSync(file)) {
        return {
          ok: false,
          lines: [
            `mcp: not configured (${file} missing)`,
            `  run /trusted-ua mcp to register the ${MCP_SERVER_NAME} server`,
          ],
        };
      }
      const config = readConfig(file);
      if (!config) {
        return { ok: false, lines: [`mcp: ${file} exists but is not valid JSON — fix or remove it, then run /trusted-ua mcp`] };
      }
      const existing = config.mcpServers?.[MCP_SERVER_NAME];
      if (!existing && isOwnEntry(config.mcpServers?.[LEGACY_MCP_SERVER_NAME])) {
        return {
          ok: false,
          lines: [
            `mcp: STALE entry in ${file} — old name ${LEGACY_MCP_SERVER_NAME}; run /trusted-ua mcp install to rename it to ${MCP_SERVER_NAME}`,
          ],
        };
      }
      if (!existing) {
        return {
          ok: false,
          lines: [
            `mcp: ${file} has no ${MCP_SERVER_NAME} entry`,
            `  run /trusted-ua mcp to add it`,
          ],
        };
      }
      if (!sameLaunch(existing, entry)) {
        return {
          ok: false,
          lines: [
            `mcp: STALE entry in ${file} — run /trusted-ua mcp to update`,
            `  current: ${JSON.stringify(existing)}`,
            `  expected: ${JSON.stringify(entry)}`,
          ],
        };
      }
      return { ok: true, lines: [`mcp: OK — ${MCP_SERVER_NAME} → stdio bridge (${describe(existing)}) in ${file}`] };
    }
    case "uninstall": {
      const config = readConfig(file);
      const hasLegacy = isOwnEntry(config?.mcpServers?.[LEGACY_MCP_SERVER_NAME]);
      if (!config || !config.mcpServers || (!config.mcpServers[MCP_SERVER_NAME] && !hasLegacy)) {
        return { ok: true, lines: [`mcp: nothing to remove (${MCP_SERVER_NAME} not configured)`] };
      }
      delete config.mcpServers[MCP_SERVER_NAME];
      if (hasLegacy) delete config.mcpServers[LEGACY_MCP_SERVER_NAME];
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
        if (Object.keys(config).length === 0) {
          rmSync(file, { force: true });
          return { ok: true, lines: [`mcp: removed ${MCP_SERVER_NAME} entry and empty config ${file}`] };
        }
      }
      writeConfig(file, config);
      return { ok: true, lines: [`mcp: removed ${MCP_SERVER_NAME} entry from ${file}`] };
    }
    default: {
      throw new Error(`unknown mcp subcommand: ${sub as string}`);
    }
  }
}
