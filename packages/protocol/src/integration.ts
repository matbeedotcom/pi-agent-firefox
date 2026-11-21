/**
 * Trusted User Agent integration protocol: identity, versioning, and the private
 * `x-trusted-ua/*` compatibility namespace.
 *
 * The private namespace is a transport compatibility layer only (see
 * PRODUCT.md §29–30). Tool names, arguments, and results are defined by
 * the MCP-compatible schemas in browser-tools.ts and must stay identical
 * when the transport migrates to MCP-over-ACP.
 */
import type { MailSearchResult } from "./mail-tools.js";

export const TRUSTED_UA = {
  /** Product name (openspec rename-trusted-user-agent; was "pi-browser"). */
  name: "trusted-ua",
  /** Package release version (npm version of trusted-user-agent). */
  version: "0.4.0",
  /**
   * Trusted User Agent integration protocol version (bump on breaking changes to
   * x-trusted-ua/* semantics or integration metadata). v2 = 2026-09-11
   * identity rename (add-on IDs to @matbee.com, host name to com.matbee.agent).
   * v3 = 2026-09-12: x-trusted-ua/tool_update — long-running tools (mail_search)
   * stream batches/progress to the host while the original x-trusted-ua/tool
   * request is still pending; MailSearchResult gains complete/sortComplete/scanned.
   */
  protocolVersion: 3,
  // 2026-11-20 (v0.3.0, external MCP callers): additive only, so the version
  // stays 3 — add-ons reject any other value, and mixed versions must keep
  // working. New: the `trusted-ua/caller` MCP notification (broker socket),
  // `_meta.trustedUa.caller` / `callerApproval` on session/request_permission,
  // the x-trusted-ua/permission_withdrawn notification, and caller /
  // externalAccess fields on x-trusted-ua/permissions|permission_set|
  // permission_clear. Older peers ignore all of them (see callers.ts).
  // 2026-11-20 (v0.4.0, sidebar ACP agents): additive again — the
  // x-trusted-ua/agents request, `_meta.trustedUa.agent` on session/new,
  // listed sessions and relayed permission requests, `parentSession` on
  // `trusted-ua/caller`, and the "cancelled" permission_withdrawn reason
  // (see agents.ts). Older peers create and see pi sessions only.
  /**
   * Browser tool schema version (bump when tool schemas change).
   * v2 = 2026-09-12: added browser_evaluate, browser_get_accessibility_tree,
   * browser_get_console, browser_get_network, browser_element_at, browser_navigate;
   * widened browser_get_dom coverage (more element kinds + per-element fields).
   * v3 = 2026-09-12: frame targeting (optional `frame` parameter on the nine
   * content-frame tools), browser_get_dom now traverses open shadow roots and
   * reports iframes/stats; new BROWSER_FRAME_NOT_FOUND error.
   * v4 = 2026-09-12: host-side `javascript` REPL tool (BROWSER-USE-REPL-PLAN.md,
   * option C) — a persistent V8 cell interpreter; `page.*`/`tabs.*` primitives
   * execute the existing browser tools against the session's current tab. The
   * tool is hosted by the native host, not by the add-on (see REPL_TOOLS).
   * v5 = 2026-09-12: REPL add-on deltas — browser_click_at, browser_focus,
   * browser_scroll, browser_type_focused (content-script interaction),
   * browser_open_tab / browser_close_tab / browser_list_tabs (REPL-owned
   * auxiliary tabs, closed at session unbind), and browser_get_accessibility_tree
   * `format: "nodes"` (structured snapshot for page.snapshot()).
   * v6 = 2026-09-12: `javascript` REPL gains an `fs` global — a workspace-
   * scoped filesystem (read/write/append/list/stat/exists/mkdir/rename/
   * unlink/rm) confined to the session's task workspace (lexical + symlink
   * escape rejection); no add-on-side change (host-side realm global).
   * v8 = 2026-09-12: mail_search became incremental — results carry
   * `complete`, `sortComplete`, and `scanned`, and long searches stream
   * partial batches over x-trusted-ua/tool_update (protocol v3).
   */
  browserToolVersion: 8,
  /** Stable Firefox Native Messaging host name (manifest `name`). */
  nativeHost: "dev.pi.browser",
  /** Stable Firefox add-on ID (gecko.id). Must match allowed_extensions. */
  extensionId: "pi-agent-firefox@matbee.com",
} as const;

// ---------------------------------------------------------------------------
// Agent-level (application-neutral) identity + capabilities
// (THUNDERBIRD-PLAN.md §2, §24, §28)
// ---------------------------------------------------------------------------

/** Mozilla applications that can attach as capability providers. */
export type AgentApplication = "firefox" | "thunderbird";

/** Capability domains a client exposes to Pi (THUNDERBIRD-PLAN.md §28). */
export type AgentCapability = "browser" | "mail" | "compose" | "attachments" | "contacts" | "mailModify";

/** Valid agent capabilities (for parsing/normalization). */
export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "browser",
  "mail",
  "compose",
  "attachments",
  "contacts",
  "mailModify",
];

/** Agent-level integration identity (application-neutral). */
export const TRUSTED_UA_HOST = {
  /**
   * Native Messaging host name (manifest `name`), shared by both
   * applications. 2026-09-11: renamed from the `dev.pi.*` placeholders to a
   * name under the project-owned matbee domain.
   */
  nativeHost: "com.matbee.agent",
  /** Legacy host name kept for already-registered Firefox installations. */
  legacyNativeHost: "dev.pi.browser",
  /**
   * Add-on IDs the native host manifest authorizes. `pi-agent-firefox@matbee.com`
   * and `pi-agent-thunderbird@matbee.com` are the production add-on IDs (2026-09-11
   * rename from the `@pi.dev` placeholders to a domain the project owns);
   * `pi-firefox@matbee.com` remains authorized for compatibility.
   */
  authorizedExtensions: ["pi-agent-firefox@matbee.com", "pi-firefox@matbee.com", "pi-agent-thunderbird@matbee.com"],
  /**
   * Agent integration protocol version (bump on breaking _meta.trustedUaAgent
   * changes). v2 = 2026-09-11 identity rename.
   */
  protocolVersion: 2,
} as const;

/** Client identity declared in the integration hello. */
export interface AgentClientIdentity {
  application: AgentApplication;
  extensionId: string;
  version: string;
}

/**
 * Integration hello (THUNDERBIRD-PLAN.md §24). Sent by the client in the
 * ACP `initialize` params under `_meta.trustedUaAgent`.
 */
export interface AgentHello {
  type: "trusted-ua.hello";
  client: AgentClientIdentity;
  capabilities: AgentCapability[];
}

/** `_meta.trustedUaAgent` exchanged during ACP initialization. */
export interface TrustedUaAgentMeta {
  version: string;
  protocolVersion: number;
  /** Which client is attached (host echo of the hello). */
  application?: AgentApplication;
  /** Capabilities the host accepts from this client. */
  capabilities: AgentCapability[];
  /**
   * Union of capabilities across ALL connected clients (broker mode) as of
   * initialize — the session tool surface (plan §29). Lets the add-on UI
   * show peer-app capabilities (e.g. browsing from the mail client). Absent
   * on legacy hosts and in standalone single-app mode (use `capabilities`).
   * Live changes arrive via x-trusted-ua/capabilities_changed.
   */
  connectedCapabilities?: AgentCapability[];
}

export const TRUSTED_UA_AGENT_META: TrustedUaAgentMeta = {
  version: TRUSTED_UA.version,
  protocolVersion: TRUSTED_UA_HOST.protocolVersion,
  capabilities: [],
};

/** Filter an arbitrary list down to known capabilities, preserving order. */
export function normalizeCapabilities(values: unknown): AgentCapability[] {
  if (!Array.isArray(values)) return [];
  const out: AgentCapability[] = [];
  for (const v of values) {
    if (typeof v === "string" && (AGENT_CAPABILITIES as readonly string[]).includes(v) && !out.includes(v as AgentCapability)) {
      out.push(v as AgentCapability);
    }
  }
  return out;
}

/**
 * Parse the integration hello from ACP `initialize` params.
 * Returns undefined when absent/malformed (legacy clients); the caller
 * falls back to browser compatibility defaults.
 */
export function parseAgentHello(params: unknown): AgentHello | undefined {
  const meta = (params as { _meta?: { trustedUaAgent?: unknown } } | null | undefined)?._meta?.trustedUaAgent;
  if (typeof meta !== "object" || meta === null) return undefined;
  const m = meta as Record<string, unknown>;
  const client = m.client as Record<string, unknown> | undefined;
  if (typeof client?.application !== "string" || client.application !== "firefox" && client.application !== "thunderbird") {
    return undefined;
  }
  return {
    type: "trusted-ua.hello",
    client: {
      application: client.application,
      extensionId: typeof client.extensionId === "string" ? client.extensionId : "",
      version: typeof client.version === "string" ? client.version : "",
    },
    capabilities: normalizeCapabilities(m.capabilities),
  };
}

/** Build the `_meta.trustedUaAgent` client hello block for ACP `initialize` params. */
export function buildAgentHelloMeta(hello: Omit<AgentHello, "type">): { trustedUaAgent: AgentHello } {
  return {
    trustedUaAgent: {
      type: "trusted-ua.hello",
      client: hello.client,
      capabilities: normalizeCapabilities(hello.capabilities),
    },
  };
}

/**
 * Broker/relay private IPC (THUNDERBIRD-PLAN.md §26–27).
 *
 * One host process is the broker (owns the ACP agent + Pi sessions); later
 * app connections attach to it as relays over private OS IPC (Unix socket,
 * no localhost TCP). Native Messaging remains the externally visible
 * Mozilla security boundary — the relay only forwards bytes.
 */
export const TRUSTED_UA_BROKER = {
  /** Run directory name under $HOME (0700; env TRUSTED_UA_BROKER_DIR overrides). */
  runDir: "run",
  /** Unix socket file name inside the run directory (0600). */
  socketFile: "agent-broker.sock",
  /**
   * MCP server socket file name inside the run directory (0600). Exposes
   * the browser tools as a plain MCP server (JSONL JSON-RPC) so separate
   * pi-subagent child processes — which have no ACP channel and no
   * in-process tool bridge — can reach them over MCP.
   */
  mcpSocketFile: "agent-broker-mcp.sock",
  /** Broker state file name inside the run directory (0600: pid + token). */
  stateFile: "agent-broker.json",
  /** First frame a relay sends after connecting (carries the token). */
  handshake: "pi.broker.handshake",
  /** First frame the broker sends back once the token is accepted. */
  handshakeAck: "pi.broker.handshakeAck",
  /** Broker IPC protocol version (bump on breaking handshake changes). */
  version: 1,
} as const;

/** Metadata exchanged during ACP initialization (PRODUCT.md §45). */
export interface TrustedUaMeta {
  version: string;
  protocolVersion: number;
  browserToolVersion: number;
  /**
   * Where the host provisions per-task workspaces (initialize only; e.g.
   * ~/.pi/workspaces). A session created with an empty cwd gets a fresh
   * directory under it — the add-on UIs show this as the default working
   * directory. Optional: older hosts omit it.
   */
  workspaceRoot?: string;
}

export const TRUSTED_UA_META: TrustedUaMeta = {
  version: TRUSTED_UA.version,
  protocolVersion: TRUSTED_UA.protocolVersion,
  browserToolVersion: TRUSTED_UA.browserToolVersion,
};

/** Private extension methods (PRODUCT.md §30). Never used for ACP session semantics. */
export const X_TRUSTED_UA = {
  /** Firefox → host: liveness/version probe used by /trusted-ua status|doctor. */
  ping: "x-trusted-ua/ping",
  /** Host → Firefox: browser tool invocation (legacy compatibility transport). */
  tool: "x-trusted-ua/tool",
  /** Firefox → host: browser-side notifications (tab closed/navigated, binding changed). */
  notify: "x-trusted-ua/notify",
  /**
   * Host → session-owner client: a tool's approval prompt is being shown in
   * ANOTHER app (cross-app routing). The owner's UI is where the user is
   * watching the session, so it should draw attention to where the prompt
   * actually is (e.g. "approval needed in the mail client"). The owner
   * displays it; it does NOT answer it (the executing client owns the
   * canonical session/request_permission round-trip).
   */
  permission_prompted: "x-trusted-ua/permission_prompted",
  /**
   * Client → host: incremental progress for a tool call that is still
   * pending (the x-trusted-ua/tool request has not answered yet). The host
   * maps batches onto ACP session/update tool_call_update so the model can
   * see results before the final answer; the final tool response is
   * unchanged, so clients that ignore updates stay compatible.
   * The update never authorizes anything — it only reports results of the
   * already-approved call.
   */
  tool_update: "x-trusted-ua/tool_update",
  /**
   * Host → all clients: the set of connected capability providers changed
   * (a peer app connected or disconnected). Carries the current union so
   * each UI can update its "capabilities:" line. Display-only; additive —
   * legacy hosts never send it and clients ignore it when absent.
   */
  capabilities_changed: "x-trusted-ua/capabilities_changed",
  /**
   * Client → host: fetch the permission configuration — every approval-
   * gated tool with its persistent "always allow" state. The add-on
   * Configuration page renders from this (PRODUCT.md §55).
   */
  permissions: "x-trusted-ua/permissions",
  /**
   * Client → host: set one tool's persistent state (ask | deny | allow)
   * from the Configuration page.
   */
  permission_set: "x-trusted-ua/permission_set",
  /**
   * Client → host: clear the persistent "always allow" state of one tool
   * (or of every tool when `tool` is omitted).
   */
  permission_clear: "x-trusted-ua/permission_clear",
  /**
   * Client → host: compile a page plan for a verified source identity
   * (skills-runtime-design.md §2, §7). The source identity is supplied by
   * the addon coordinator, never a page payload.
   */
  skills_plan: "x-trusted-ua/skills_plan",
  /**
   * Client → host: submit a verified skill event. Responds with an ack:
   * accepted (jobs launched), no-match, stale-plan (re-plan), unavailable,
   * or duplicate (coordinator redelivery).
   */
  skills_event: "x-trusted-ua/skills_event",
  /** Client → host: cancel pending skill work for one interaction. */
  skills_cancel: "x-trusted-ua/skills_cancel",
  /** Client → host: probe the skill runtime (queue, live plans, stats). */
  skills_status: "x-trusted-ua/skills_status",
  /**
   * Host → client: resolve a contextRef against the coordinator's bounded
   * snapshot store (privacy by request: only the requested fields return).
   */
  skills_context: "x-trusted-ua/skills_context",
  /**
   * Host → client: deliver a skill job outcome for a submitted event. The
   * coordinator routes it to the gate/UI and acks delivery; the request ID
   * makes delivery explicit (design §7: results require request IDs).
   */
  skills_result: "x-trusted-ua/skills_result",
  /**
   * Client → host: the agents a new session can run on (built-in pi plus
   * configured external ACP agents), with availability. See agents.ts.
   */
  agents: "x-trusted-ua/agents",
} as const;

/** Params for x-trusted-ua/ping (Firefox → host). */
export interface PingParams {
  clientVersion?: string;
}

/** Result for x-trusted-ua/ping. */
export interface PingResult {
  pong: true;
  meta: TrustedUaMeta;
  /** Whether the host reached a Pi SDK model runtime (diagnostic only). */
  backendReady: boolean;
}

/** Params for x-trusted-ua/tool (host → Firefox). */
export interface BrowserToolCallParams {
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Soft timeout hint for the Firefox side; the host also enforces its own deadline. */
  timeoutMs?: number;
  /**
   * Stable id for this call, generated by the host. The client echoes it in
   * x-trusted-ua/tool_update notifications so the host can route updates to
   * the pending call (and reject updates for unknown calls). Older clients
   * never send updates, so it is optional on the wire.
   */
  toolCallId?: string;
}

/** Params for x-trusted-ua/tool_update (client → host). */
export interface BrowserToolUpdateParams {
  sessionId: string;
  /** Matches the tool call currently executing in this session. */
  toolCallId: string;
  /** Only long-running tools stream updates today. */
  tool: "mail_search";
  /**
   * Monotonic per-tool-call sequence number (client-assigned, starting at 1).
   * The host rejects gaps and duplicates to keep the stream ordered.
   */
  sequence?: number;
  update:
    | { kind: "batch"; result: MailSearchResult }
    | {
        kind: "progress";
        scanned: number;
        /** Wall-clock age of the search (since the first call), client-measured. */
        elapsedMs?: number;
        /** Duration of the most recently drained backend page, client-measured. */
        pageMs?: number;
      }
    | { kind: "complete" };
}

/**
 * Firefox → host notification payload. Allows the host to invalidate
 * per-session state (e.g. element references) without waiting for a tool
 * call to fail.
 */
export type BrowserNotifyEvent = "tab_closed" | "tab_navigated" | "binding_changed" | "binding_removed";

export interface BrowserNotifyParams {
  sessionId: string;
  event: BrowserNotifyEvent;
  data?: Record<string, unknown>;
}

/** Params for x-trusted-ua/capabilities_changed (host → client). */
export interface CapabilitiesChangedParams {
  /** Union of all connected clients' capabilities (canonical order). */
  capabilities: AgentCapability[];
}

/** Params for x-trusted-ua/permission_prompted (host → session-owner client). */
export interface PermissionPromptedParams {
  sessionId: string;
  /** The tool call the approval belongs to (matches the session/update stream). */
  toolCallId: string;
  /** The tool being approved. */
  tool: string;
  /** The application whose UI is showing the approval prompt. */
  application: AgentApplication;
}

/** Human-facing name for an application (permission banners, prompts). */
export function applicationDisplayName(app: AgentApplication): string {
  return app === "thunderbird" ? "Thunderbird (mail)" : "Firefox (browser)";
}

/** MCP protocol version spoken inside mcp/message (MCP-over-ACP). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Default per-tool deadline the host enforces when Firefox does not answer. */
export const BROWSER_TOOL_TIMEOUT_MS = 30_000;
/** Long deadline for screenshot calls (capture can be slow on busy pages). */
export const BROWSER_SCREENSHOT_TIMEOUT_MS = 60_000;
/** Long deadline for file downloads (images/videos can be several MB). */
export const BROWSER_DOWNLOAD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Permission configuration (PRODUCT.md §55) — client ↔ host
// ---------------------------------------------------------------------------

/** Tool group the Configuration page renders (labels live in permission.ts). */
export type PermissionToolGroup =
  | "browser"
  | "repl"
  | "control"
  | "mail"
  | "compose"
  | "mail-mutations"
  | "contacts";

/**
 * One approval-gated tool as reported by x-trusted-ua/permissions.
 * `state` is the tool's persistent decision: "ask" (prompt every time),
 * "deny" (refuse without asking) or "allow" (always approved). `managedBy`
 * marks tools whose grant is owned by the application (not the host store)
 * — e.g. browser_evaluate, where Firefox's revocable `userScripts`
 * permission is authoritative; such rows have no toggle. `note` carries an
 * extra explanation for rows without a toggle.
 */
export interface PermissionConfigTool {
  name: string;
  description: string;
  group: PermissionToolGroup;
  /** Persistent decision (host store); "ask" = no entry. */
  state: PermissionToolState;
  /** Set when the application owns the grant (row is informational only). */
  managedBy?: AgentApplication;
  /** Extra one-line note for the Configuration page (e.g. per-primitive gating). */
  note?: string;
}

/** Result for x-trusted-ua/permissions. */
export interface PermissionConfigResult {
  tools: PermissionConfigTool[];
  /**
   * External MCP callers (v0.3.0+ hosts; absent from older hosts): whether
   * other apps may use the tools over MCP at all (default true).
   */
  externalAccess?: boolean;
  /** Remembered caller decisions, per app (v0.3.0+ hosts). */
  callers?: import("./callers.js").CallerPermissionEntry[];
}

/**
 * A tool's persistent permission state (Configuration page, PRODUCT.md
 * §55). "ask" is the default: the user is prompted on every call. "deny"
 * refuses the tool without asking (structured BROWSER_PERMISSION_DENIED).
 * "allow" approves every call without asking.
 */
export type PermissionToolState = "ask" | "deny" | "allow";

/** Params for x-trusted-ua/permission_set. */
export interface PermissionSetParams {
  /** Set one tool's state (with `state`). */
  tool?: string;
  state?: PermissionToolState;
  /** Set one caller's decision for one app (with `state`; "ask" forgets it). */
  caller?: import("./callers.js").CallerRef;
  /** Turn external MCP access on or off. */
  externalAccess?: boolean;
}

/** Result for x-trusted-ua/permission_set (echoes what was set). */
export interface PermissionSetResult {
  tool?: string;
  state?: PermissionToolState;
  caller?: import("./callers.js").CallerRef;
  externalAccess?: boolean;
}

/**
 * Params for x-trusted-ua/permission_clear: `tool` clears one tool,
 * `caller` forgets one caller decision, neither clears every tool decision
 * (caller decisions are kept).
 */
export interface PermissionClearParams {
  tool?: string;
  caller?: import("./callers.js").CallerRef;
}

/** Result for x-trusted-ua/permission_clear. */
export interface PermissionClearResult {
  cleared: string[];
}
