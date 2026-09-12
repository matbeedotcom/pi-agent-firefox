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
  version: "0.1.0",
  /**
   * Pi Browser integration protocol version (bump on breaking changes to
   * x-pi-browser/* semantics or integration metadata).
   */
  protocolVersion: 1,
  /** Browser tool schema version (bump when tool schemas change). */
  browserToolVersion: 1,
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
export type AgentCapability = "browser" | "mail" | "compose" | "attachments" | "contacts";

/** Valid agent capabilities (for parsing/normalization). */
export const AGENT_CAPABILITIES: readonly AgentCapability[] = ["browser", "mail", "compose", "attachments", "contacts"];

/** Agent-level integration identity (application-neutral). */
export const PI_AGENT = {
  /** Native Messaging host name (manifest `name`), shared by both applications. */
  nativeHost: "dev.pi.agent",
  /** Legacy host name kept for already-registered Firefox installations. */
  legacyNativeHost: "dev.pi.browser",
  /**
   * Add-on IDs the native host manifest authorizes. `pi-agent-firefox@matbee.com`
   * and `pi-agent-thunderbird@matbee.com` are the production add-on IDs (2026-09-11
   * rename from the `@pi.dev` placeholders to a domain the project owns);
   * `pi-firefox@matbee.com` remains authorized for compatibility.
   */
  authorizedExtensions: ["pi-agent-firefox@matbee.com", "pi-firefox@matbee.com", "pi-agent-thunderbird@matbee.com"],
  /** Agent integration protocol version (bump on breaking _meta.piAgent changes). */
  protocolVersion: 1,
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

/** MCP protocol version spoken inside mcp/message (MCP-over-ACP). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Default per-tool deadline the host enforces when Firefox does not answer. */
export const BROWSER_TOOL_TIMEOUT_MS = 30_000;
/** Long deadline for screenshot calls (capture can be slow on busy pages). */
export const BROWSER_SCREENSHOT_TIMEOUT_MS = 60_000;
