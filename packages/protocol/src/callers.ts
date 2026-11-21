/**
 * External MCP callers (openspec change `external-mcp-callers`).
 *
 * Any stdio MCP client (Claude Code, Codex, Cursor, a separate pi, ...) can
 * reach the broker's MCP server through the stdio bridge. Each such
 * connection runs as its own *caller session*: its own approvals, its own
 * REPL state, routed to whichever connected app serves the tool, and with no
 * add-on chat session needed.
 *
 * - The bridge names the caller with the `trusted-ua/caller` notification
 *   (the MCP client's `clientInfo` from `initialize`, plus process ids).
 *   Direct socket clients are named from their own `initialize`.
 * - Processes the host itself spawned (pi subagents and their MCP servers)
 *   inherit `TRUSTED_UA_HOST_CHILD=<broker instance id>`; when the value the
 *   bridge reports matches the running broker, the call keeps the old
 *   "most recently active add-on session" routing.
 * - Permission prompts for caller sessions carry `_meta.trustedUa.caller`.
 *   Add-ons show those in an approval window instead of the sidebar/Space.
 * - Before a caller's first tool call in an app, the user approves the
 *   caller for that app (stored per app + caller name). A global
 *   external-access switch (on by default) refuses every caller call.
 */
import type { AgentApplication } from "./integration.js";

/** Name of the MCP server in clients' configs (v0.4.0: "pi-browser", see legacy.ts). */
export const MCP_SERVER_NAME = "trusted-ua";

/** MCP notification the stdio bridge sends to the broker after each connect. */
export const MCP_CALLER_NOTIFICATION = "trusted-ua/caller";

/** Environment variable the broker sets for every process it spawns. */
export const HOST_CHILD_ENV = "TRUSTED_UA_HOST_CHILD";
/** v0.4.0 name of HOST_CHILD_ENV (still set, and read as a fallback). */
export const LEGACY_HOST_CHILD_ENV = "PI_BROWSER_HOST_CHILD";

/** Caller name used when a client never identified itself. */
export const UNKNOWN_CALLER_NAME = "unknown MCP client";

/** Params of the `trusted-ua/caller` notification. */
export interface CallerInfo {
  /** The MCP client's self-reported name (`clientInfo.name`). Not authenticated. */
  name: string;
  /** The MCP client's self-reported version. */
  version?: string;
  /** Process id of the stdio bridge. */
  pid?: number;
  /** Parent process id of the stdio bridge (the MCP client process). */
  ppid?: number;
  /** Value of TRUSTED_UA_HOST_CHILD the bridge inherited, if any. */
  hostChild?: string;
  /**
   * Value of TRUSTED_UA_PARENT_SESSION: the sidebar session an external ACP
   * agent's bridge belongs to (sidebar-acp-agents). Honoured only together
   * with a matching `hostChild`.
   */
  parentSession?: string;
}

/** `_meta.trustedUa.caller` on a session/request_permission for a caller session. */
export interface PermissionCallerMeta {
  name: string;
  version?: string;
}

/**
 * `_meta.trustedUa` of a session/request_permission. `tool` is set for tool
 * prompts; `callerApproval` marks the one-time "allow <caller> to use <App>
 * tools?" prompt (then `tool` is absent and `triggerTool` names the tool call
 * that needs it).
 */
export interface PermissionRequestTrustedUaMeta {
  tool?: string;
  triggerTool?: string;
  caller?: PermissionCallerMeta;
  callerApproval?: boolean;
  /** The application the caller approval is for. */
  application?: AgentApplication;
  /**
   * Set on an external ACP agent's own permission request, relayed from the
   * agent (sidebar-acp-agents): shown in the session's own UI, labelled with
   * the agent's name, never remembered by the add-on.
   */
  agent?: { id: string; name: string };
}

/**
 * Host → client notification: a permission request the client may still be
 * showing no longer needs an answer (it timed out, or its caller session
 * ended). The approval window drops it. Older add-ons ignore it.
 */
export const PERMISSION_WITHDRAWN_METHOD = "x-trusted-ua/permission_withdrawn";

export interface PermissionWithdrawnParams {
  sessionId: string;
  toolCallId: string;
  reason: "timeout" | "session_closed" | "cancelled";
}

/**
 * Host → every client: a caller session ended (its MCP connection closed).
 * Firefox releases the session's tab binding and closes its REPL-owned
 * tabs. Older add-ons ignore it.
 */
export const SESSION_ENDED_METHOD = "x-trusted-ua/session_ended";

export interface SessionEndedParams {
  sessionId: string;
}

/** Caller session ids are `mcp:<uuid>`. */
export function isCallerSessionId(sessionId: string): boolean {
  return sessionId.startsWith("mcp:");
}

/** A caller's remembered decision for one app. */
export type CallerPermissionState = "allow" | "deny";

/** Identifies one remembered caller decision. */
export interface CallerRef {
  application: AgentApplication;
  name: string;
}

/** One remembered caller decision (x-trusted-ua/permissions `callers`). */
export interface CallerPermissionEntry extends CallerRef {
  state: CallerPermissionState;
}

/** Option ids of the caller-approval prompt (same ids as tool prompts). */
export const CALLER_ALLOW_ONCE = "allow_once";
export const CALLER_ALLOW_ALWAYS = "allow_always";
export const CALLER_DENY = "reject_once";

/** Human name of an app in caller prompts ("Firefox", "Thunderbird"). */
export function applicationShortName(app: AgentApplication): string {
  return app === "thunderbird" ? "Thunderbird" : "Firefox";
}

/**
 * Normalize a self-reported caller name: trimmed, control characters
 * removed, at most 64 characters; empty becomes UNKNOWN_CALLER_NAME.
 */
export function normalizeCallerName(raw: unknown): string {
  if (typeof raw !== "string") return UNKNOWN_CALLER_NAME;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return cleaned || UNKNOWN_CALLER_NAME;
}

/** Parse `trusted-ua/caller` params (or `initialize` clientInfo) defensively. */
export function parseCallerInfo(raw: unknown): CallerInfo {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: CallerInfo = { name: normalizeCallerName(r.name) };
  if (typeof r.version === "string" && r.version.trim()) out.version = r.version.trim().slice(0, 32);
  if (typeof r.pid === "number" && Number.isInteger(r.pid)) out.pid = r.pid;
  if (typeof r.ppid === "number" && Number.isInteger(r.ppid)) out.ppid = r.ppid;
  if (typeof r.hostChild === "string" && r.hostChild) out.hostChild = r.hostChild;
  if (typeof r.parentSession === "string" && r.parentSession && r.parentSession.length <= 200) out.parentSession = r.parentSession;
  return out;
}
