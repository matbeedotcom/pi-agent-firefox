/**
 * Pi Browser integration protocol: identity, versioning, and the private
 * `x-pi-browser/*` compatibility namespace.
 *
 * The private namespace is a transport compatibility layer only (see
 * PRODUCT.md §29–30). Tool names, arguments, and results are defined by
 * the MCP-compatible schemas in browser-tools.ts and must stay identical
 * when the transport migrates to MCP-over-ACP.
 */
export declare const PI_BROWSER: {
    /** Package name. */
    readonly name: "pi-browser";
    /** Package release version (npm version of @pi-browser/agent). */
    readonly version: "0.1.0";
    /**
     * Pi Browser integration protocol version (bump on breaking changes to
     * x-pi-browser/* semantics or integration metadata).
     */
    readonly protocolVersion: 1;
    /** Browser tool schema version (bump when tool schemas change). */
    readonly browserToolVersion: 1;
    /** Stable Firefox Native Messaging host name (manifest `name`). */
    readonly nativeHost: "dev.pi.browser";
    /** Stable Firefox add-on ID (gecko.id). Must match allowed_extensions. */
    readonly extensionId: "pi-browser@pi.dev";
};
/** Mozilla applications that can attach as capability providers. */
export type AgentApplication = "firefox" | "thunderbird";
/** Capability domains a client exposes to Pi (THUNDERBIRD-PLAN.md §28). */
export type AgentCapability = "browser" | "mail" | "compose" | "attachments" | "contacts";
/** Valid agent capabilities (for parsing/normalization). */
export declare const AGENT_CAPABILITIES: readonly AgentCapability[];
/** Agent-level integration identity (application-neutral). */
export declare const PI_AGENT: {
    /** Native Messaging host name (manifest `name`), shared by both applications. */
    readonly nativeHost: "dev.pi.agent";
    /** Legacy host name kept for already-registered Firefox installations. */
    readonly legacyNativeHost: "dev.pi.browser";
    /**
     * Add-on IDs the native host manifest authorizes. `pi-browser@pi.dev` is
     * the original Firefox ID and stays authorized so existing installations
     * keep working after the host rename.
     */
    readonly authorizedExtensions: readonly ["pi-browser@pi.dev", "pi-firefox@pi.dev", "pi-thunderbird@pi.dev"];
    /** Agent integration protocol version (bump on breaking _meta.piAgent changes). */
    readonly protocolVersion: 1;
};
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
export declare const PI_AGENT_META: PiAgentMeta;
/** Filter an arbitrary list down to known capabilities, preserving order. */
export declare function normalizeCapabilities(values: unknown): AgentCapability[];
/**
 * Parse the integration hello from ACP `initialize` params.
 * Returns undefined when absent/malformed (legacy clients); the caller
 * falls back to browser compatibility defaults.
 */
export declare function parseAgentHello(params: unknown): AgentHello | undefined;
/** Build the `_meta.piAgent` client hello block for ACP `initialize` params. */
export declare function buildAgentHelloMeta(hello: Omit<AgentHello, "type">): {
    piAgent: AgentHello;
};
/** Metadata exchanged during ACP initialization (PRODUCT.md §45). */
export interface PiBrowserMeta {
    version: string;
    protocolVersion: number;
    browserToolVersion: number;
}
export declare const PI_BROWSER_META: PiBrowserMeta;
/** Private extension methods (PRODUCT.md §30). Never used for ACP session semantics. */
export declare const X_PI_BROWSER: {
    /** Firefox → host: liveness/version probe used by /pi-browser status|doctor. */
    readonly ping: "x-pi-browser/ping";
    /** Host → Firefox: browser tool invocation (legacy compatibility transport). */
    readonly tool: "x-pi-browser/tool";
    /** Firefox → host: browser-side notifications (tab closed/navigated, binding changed). */
    readonly notify: "x-pi-browser/notify";
};
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
export declare const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Default per-tool deadline the host enforces when Firefox does not answer. */
export declare const BROWSER_TOOL_TIMEOUT_MS = 30000;
/** Long deadline for screenshot calls (capture can be slow on busy pages). */
export declare const BROWSER_SCREENSHOT_TIMEOUT_MS = 60000;
//# sourceMappingURL=integration.d.ts.map