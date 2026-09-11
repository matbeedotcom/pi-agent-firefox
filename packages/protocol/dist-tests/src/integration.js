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
    extensionId: "pi-browser@pi.dev",
};
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