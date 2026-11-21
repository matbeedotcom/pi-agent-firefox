/**
 * In-process tool bridge (subagent browser access).
 *
 * Pi subagent sessions are created INSIDE the process that owns the parent
 * session (pi-subagents: "A child is a pi AgentSession created inside the
 * process that owns it"). In the Trusted User Agent topology that process is the
 * native-host broker, which owns the ACP agent, the Pi sessions and the
 * connection to the connected app (Firefox).
 *
 * The broker installs a BrowserToolBridge here at startup. A Pi extension
 * loaded into a (subagent) session — see extensions/trusted-ua-tools.ts —
 * reads the bridge from this same module instance and registers the browser
 * tools with execution routed through the normal provider path (routing,
 * permission prompts, activity tracking). The bridge is undefined outside a
 * broker process, so the extension registers nothing in a plain pi session.
 */
import type { AgentApplication, CallerInfo } from "@trusted-ua/protocol";
import type { BrowserMode, NormalizedToolResult } from "./browser/provider.js";

/** Per-ACP-session routing context captured when the session opened. */
export interface BridgeSessionContext {
  ownerClientId?: string;
  ownerApplication: AgentApplication;
  mode: BrowserMode;
  mcpServerId?: string;
  /**
   * Set for caller sessions: an external MCP client (Claude Code, Codex, ...)
   * connected to the broker's MCP server. Such a session has no owner app;
   * calls go through the caller gate (external access + per-app approval).
   */
  caller?: CallerInfo;
}

export interface BrowserToolBridge {
  /** Remember the routing context for a newly opened ACP session. */
  registerSession(sessionId: string, ctx: BridgeSessionContext): void;
  /** Mark a session as the most recently active (prompt traffic). */
  touchSession(sessionId: string): void;
  /** Drop the context when a session closes. */
  closeSession(sessionId: string): void;
  /**
   * The sidebar session a bridge's TRUSTED_UA_PARENT_SESSION token names
   * (an external ACP agent's bridge, openspec sidebar-acp-agents D6), if it
   * is open. Callers must already have checked the host-child marker.
   */
  resolveParentSession?(token: string): string | undefined;
  /**
   * Execute one tool through the provider's standard routing + approval
   * path. Omitted sessionId falls back to the most recently active ACP
   * session (the one the user is driving in the add-on UI). With `caller`,
   * `sessionId` names a caller session (`mcp:<uuid>`, one per MCP
   * connection) that needs no ACP session; closeSession(sessionId) ends it.
   */
  call(opts: {
    tool: string;
    args: Record<string, unknown>;
    sessionId?: string;
    toolCallId?: string;
    caller?: CallerInfo;
  }): Promise<NormalizedToolResult>;
}

let bridge: BrowserToolBridge | undefined;

export function setBrowserToolBridge(b: BrowserToolBridge | undefined): void {
  bridge = b;
}

export function getBrowserToolBridge(): BrowserToolBridge | undefined {
  return bridge;
}
