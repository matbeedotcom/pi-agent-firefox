/**
 * Pi Browser integration protocol: identity, versioning, and the private
 * `x-pi-browser/*` compatibility namespace.
 *
 * The private namespace is a transport compatibility layer only (see
 * PRODUCT.md §29–30). Tool names, arguments, and results are defined by
 * the MCP-compatible schemas in browser-tools.ts and must stay identical
 * when the transport migrates to MCP-over-ACP.
 */

export const PI_BROWSER = {
  /** Package name. */
  name: "pi-browser",
  /** Package release version (npm version of @pi-browser/agent). */
  version: "0.1.1",
  /**
   * Pi Browser integration protocol version (bump on breaking changes to
   * x-pi-browser/* semantics or integration metadata). v2 = 2026-09-11
   * identity rename (add-on IDs to @matbee.com, host name to com.matbee.agent).
   */
  protocolVersion: 2,
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
   */
  browserToolVersion: 6,
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
export const PI_AGENT = {
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
   * Agent integration protocol version (bump on breaking _meta.piAgent
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
 * ACP `initialize` params under `_meta.piAgent`.
 */
export interface AgentHello {
  type: "pi.agent.hello";
  client: AgentClientIdentity;
  capabilities: AgentCapability[];
}

/** `_meta.piAgent` exchanged during ACP initialization. */
export interface PiAgentMeta {
  version: string;
  protocolVersion: number;
  /** Which client is attached (host echo of the hello). */
  application?: AgentApplication;
  /** Capabilities the host accepts from this client. */
  capabilities: AgentCapability[];
}

export const PI_AGENT_META: PiAgentMeta = {
  version: PI_BROWSER.version,
  protocolVersion: PI_AGENT.protocolVersion,
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
  const meta = (params as { _meta?: { piAgent?: unknown } } | null | undefined)?._meta?.piAgent;
  if (typeof meta !== "object" || meta === null) return undefined;
  const m = meta as Record<string, unknown>;
  const client = m.client as Record<string, unknown> | undefined;
  if (typeof client?.application !== "string" || client.application !== "firefox" && client.application !== "thunderbird") {
    return undefined;
  }
  return {
    type: "pi.agent.hello",
    client: {
      application: client.application,
      extensionId: typeof client.extensionId === "string" ? client.extensionId : "",
      version: typeof client.version === "string" ? client.version : "",
    },
    capabilities: normalizeCapabilities(m.capabilities),
  };
}

/** Build the `_meta.piAgent` client hello block for ACP `initialize` params. */
export function buildAgentHelloMeta(hello: Omit<AgentHello, "type">): { piAgent: AgentHello } {
  return {
    piAgent: {
      type: "pi.agent.hello",
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
export const PI_BROKER = {
  /** Run directory name under $HOME (0700; env PI_BROWSER_BROKER_DIR overrides). */
  runDir: "run",
  /** Unix socket file name inside the run directory (0600). */
  socketFile: "agent-broker.sock",
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
export interface PiBrowserMeta {
  version: string;
  protocolVersion: number;
  browserToolVersion: number;
}

export const PI_BROWSER_META: PiBrowserMeta = {
  version: PI_BROWSER.version,
  protocolVersion: PI_BROWSER.protocolVersion,
  browserToolVersion: PI_BROWSER.browserToolVersion,
};

/** Private extension methods (PRODUCT.md §30). Never used for ACP session semantics. */
export const X_PI_BROWSER = {
  /** Firefox → host: liveness/version probe used by /pi-browser status|doctor. */
  ping: "x-pi-browser/ping",
  /** Host → Firefox: browser tool invocation (legacy compatibility transport). */
  tool: "x-pi-browser/tool",
  /** Firefox → host: browser-side notifications (tab closed/navigated, binding changed). */
  notify: "x-pi-browser/notify",
  /**
   * Host → session-owner client: a tool's approval prompt is being shown in
   * ANOTHER app (cross-app routing). The owner's UI is where the user is
   * watching the session, so it should draw attention to where the prompt
   * actually is (e.g. "approval needed in the mail client"). The owner
   * displays it; it does NOT answer it (the executing client owns the
   * canonical session/request_permission round-trip).
   */
  permission_prompted: "x-pi-browser/permission_prompted",
} as const;

/** Params for x-pi-browser/ping (Firefox → host). */
export interface PingParams {
  clientVersion?: string;
}

/** Result for x-pi-browser/ping. */
export interface PingResult {
  pong: true;
  meta: PiBrowserMeta;
  /** Whether the host reached a Pi SDK model runtime (diagnostic only). */
  backendReady: boolean;
}

/** Params for x-pi-browser/tool (host → Firefox). */
export interface BrowserToolCallParams {
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Soft timeout hint for the Firefox side; the host also enforces its own deadline. */
  timeoutMs?: number;
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

/** Params for x-pi-browser/permission_prompted (host → session-owner client). */
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
