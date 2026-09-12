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
     * x-pi-browser/* semantics or integration metadata). v2 = 2026-09-11
     * identity rename (add-on IDs to @matbee.com, host name to com.matbee.agent).
     */
    protocolVersion: 2,
    /** Browser tool schema version (bump when tool schemas change). */
    browserToolVersion: 1,
    /** Stable Firefox Native Messaging host name (manifest `name`). */
    nativeHost: "dev.pi.browser",
    /** Stable Firefox add-on ID (gecko.id). Must match allowed_extensions. */
    extensionId: "pi-agent-firefox@matbee.com",
};
/** Valid agent capabilities (for parsing/normalization). */
export const AGENT_CAPABILITIES = ["browser", "mail", "compose", "attachments", "contacts"];
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
};
export const PI_AGENT_META = {
    version: PI_BROWSER.version,
    protocolVersion: PI_AGENT.protocolVersion,
    capabilities: [],
};
/** Filter an arbitrary list down to known capabilities, preserving order. */
export function normalizeCapabilities(values) {
    if (!Array.isArray(values))
        return [];
    const out = [];
    for (const v of values) {
        if (typeof v === "string" && AGENT_CAPABILITIES.includes(v) && !out.includes(v)) {
            out.push(v);
        }
    }
    return out;
}
/**
 * Parse the integration hello from ACP `initialize` params.
 * Returns undefined when absent/malformed (legacy clients); the caller
 * falls back to browser compatibility defaults.
 */
export function parseAgentHello(params) {
    const meta = params?._meta?.piAgent;
    if (typeof meta !== "object" || meta === null)
        return undefined;
    const m = meta;
    const client = m.client;
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
export function buildAgentHelloMeta(hello) {
    return {
        piAgent: {
            type: "pi.agent.hello",
            client: hello.client,
            capabilities: normalizeCapabilities(hello.capabilities),
        },
    };
}
export const PI_BROWSER_META = {
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
};
/** MCP protocol version spoken inside mcp/message (MCP-over-ACP). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Default per-tool deadline the host enforces when Firefox does not answer. */
export const BROWSER_TOOL_TIMEOUT_MS = 30_000;
/** Long deadline for screenshot calls (capture can be slow on busy pages). */
export const BROWSER_SCREENSHOT_TIMEOUT_MS = 60_000;
//# sourceMappingURL=integration.js.map