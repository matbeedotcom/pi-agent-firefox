/**
 * `/pi-browser mcp` — register the pi-browser MCP server in Pi's global
 * MCP config (`~/.pi/agent/mcp.json`).
 *
 * The broker process (native-host/main.js) exposes the browser tools as an
 * MCP server on a private unix socket (PI_BROKER.mcpSocketFile in the
 * 0700 run dir under $HOME). pi-mcp-adapter speaks MCP over unix sockets
 * natively, so the config entry is just { socket, directTools } — no
 * wrapper process needed.
 *
 * Sub-commands (mirroring the host commands):
 *   mcp [install]   write/update the pi-browser entry (idempotent)
 *   mcp status      report the configured entry vs. the expected one
 *   mcp uninstall   remove the pi-browser entry
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PI_BROKER } from "@pi-browser/protocol";
import type { CommandResult } from "./index.js";

export const MCP_SERVER_NAME = "pi-browser";

export type McpSubcommand = "install" | "status" | "uninstall";

/** Broker MCP socket path for this home dir (matches mcp-server.ts default). */
export function mcpSocketPath(homeDir: string): string {
  return path.join(homeDir, ".pi", PI_BROKER.runDir, PI_BROKER.mcpSocketFile);
}

/** Pi's global MCP config (pi-mcp-adapter's getAgentPath("mcp.json")). */
export function mcpConfigPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "mcp.json");
}

export function mcpServerEntry(homeDir: string): Record<string, unknown> {
  return { socket: mcpSocketPath(homeDir), directTools: true };
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
    // corrupt file: treat as missing (install rewrites; status reports the issue)
  }
  return null;
}

function writeConfig(file: string, config: McpConfigFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function runMcpCommand(sub: McpSubcommand, homeDir: string): CommandResult {
  const file = mcpConfigPath(homeDir);
  const entry = mcpServerEntry(homeDir);

  switch (sub) {
    case "install": {
      const config = readConfig(file) ?? {};
      const servers =
        config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
          ? (config.mcpServers as Record<string, Record<string, unknown>>)
          : {};
      const existing = servers[MCP_SERVER_NAME];
      const already =
        existing && JSON.stringify(existing) === JSON.stringify(entry);
      servers[MCP_SERVER_NAME] = entry;
      config.mcpServers = servers;
      writeConfig(file, config);
      const lines = [
        `mcp: ${already ? "already configured" : "configured"} in ${file}`,
        `  server: ${MCP_SERVER_NAME} → ${entry.socket} (directTools)`,
      ];
      if (!already) {
        lines.push("  start the broker (the host does this on add-on connect) — new Pi sessions pick the config up at startup");
        lines.push("  subagent agents reference the tools as `mcp:pi-browser/<tool>` in their frontmatter tools list");
      }
      return { ok: true, lines };
    }
    case "status": {
      if (!existsSync(file)) {
        return {
          ok: false,
          lines: [
            `mcp: not configured (${file} missing)`,
            `  run /pi-browser mcp to register the ${MCP_SERVER_NAME} server`,
          ],
        };
      }
      const config = readConfig(file);
      if (!config) {
        return { ok: false, lines: [`mcp: ${file} exists but is not valid JSON — run /pi-browser mcp to rewrite it`] };
      }
      const existing = config.mcpServers?.[MCP_SERVER_NAME];
      if (!existing) {
        return {
          ok: false,
          lines: [
            `mcp: ${file} has no ${MCP_SERVER_NAME} entry`,
            `  run /pi-browser mcp to add it`,
          ],
        };
      }
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        return {
          ok: false,
          lines: [
            `mcp: STALE entry in ${file} — run /pi-browser mcp to update`,
            `  current: ${JSON.stringify(existing)}`,
            `  expected: ${JSON.stringify(entry)}`,
          ],
        };
      }
      return { ok: true, lines: [`mcp: OK — ${MCP_SERVER_NAME} → ${existing.socket} in ${file}`] };
    }
    case "uninstall": {
      const config = readConfig(file);
      if (!config || !config.mcpServers?.[MCP_SERVER_NAME]) {
        return { ok: true, lines: [`mcp: nothing to remove (${MCP_SERVER_NAME} not configured)`] };
      }
      delete config.mcpServers[MCP_SERVER_NAME];
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
