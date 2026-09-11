/**
 * BrowserToolTransport interface + implementations (PRODUCT.md §29–30).
 *
 *   BrowserToolTransport.call(sessionId, tool, args)
 *
 *   - LegacyBrowserCallbackTransport: private x-pi-browser/tool JSON-RPC
 *     namespace over the Native Messaging connection (the working MVP
 *     transport).
 *   - NativeMcpOverAcpTransport: MCP-over-ACP (mcp/connect, mcp/message,
 *     mcp/disconnect) when the client declares an ACP-transport MCP server.
 *
 * Tool names, arguments, and results are identical across transports —
 * migrating changes only the transport.
 */
import { BROWSER_SCREENSHOT_TIMEOUT_MS, BROWSER_TOOL_TIMEOUT_MS, codeFromErrorObject, isStructuredErrorObject, PI_BROWSER_ERROR, PiBrowserProtocolError, X_PI_BROWSER, } from "@pi-browser/protocol";
import { BROWSER_TOOL_SCHEMAS } from "./schemas.js";
import { McpAcpClient } from "./mcp-acp-client.js";
export { MCP_PROTOCOL_VERSION } from "@pi-browser/protocol";
import { TransportClosedError, TransportTimeoutError } from "../native-host/transport.js";
// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
/** Convert an MCP tools/call result (or a raw object) into normalized content. */
export function normalizeToolResult(raw) {
    if (typeof raw === "object" && raw !== null && Array.isArray(raw.content)) {
        const r = raw;
        const content = [];
        for (const c of r.content) {
            if (c?.type === "text" && typeof c.text === "string")
                content.push({ type: "text", text: c.text });
            else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
                content.push({ type: "image", data: c.data, mimeType: c.mimeType });
            }
        }
        if (content.length === 0)
            content.push({ type: "text", text: "(empty result)" });
        return { content, isError: r.isError === true };
    }
    return { content: [{ type: "text", text: JSON.stringify(raw ?? null) }] };
}
function timeoutFor(tool) {
    return tool === "browser_screenshot" ? BROWSER_SCREENSHOT_TIMEOUT_MS : BROWSER_TOOL_TIMEOUT_MS;
}
export class LegacyBrowserCallbackTransport {
    transport;
    options;
    kind = "legacy";
    constructor(transport, options = {}) {
        this.transport = transport;
        this.options = options;
    }
    async call(sessionId, tool, args) {
        const timeoutMs = (this.options.timeoutMs ?? timeoutFor)(tool);
        const slackMs = this.options.slackMs ?? 5_000;
        try {
            const raw = await this.transport.request(X_PI_BROWSER.tool, { sessionId, tool, arguments: args, timeoutMs }, timeoutMs + slackMs);
            return normalizeToolResult(raw);
        }
        catch (err) {
            throw translateTransportError(err, tool);
        }
    }
    async dispose() {
        // Stateless; nothing to release.
    }
}
// ---------------------------------------------------------------------------
// MCP-over-ACP transport
// ---------------------------------------------------------------------------
export class NativeMcpOverAcpTransport {
    sessionId;
    kind = "mcp-acp";
    client;
    constructor(transport, serverId, log, sessionId) {
        this.sessionId = sessionId;
        this.client = new McpAcpClient({
            transport,
            serverId,
            log,
            timeoutMs: BROWSER_SCREENSHOT_TIMEOUT_MS + 5_000,
        });
    }
    async call(_sessionId, tool, args) {
        try {
            const raw = await this.client.call(tool, args);
            return normalizeToolResult(raw);
        }
        catch (err) {
            if (err instanceof PiBrowserProtocolError)
                throw err;
            if (isStructuredErrorObject(err)) {
                // Preserve structured codes the client sent (e.g. MCP_TOOL_NOT_FOUND).
                const code = codeFromErrorObject(err) ?? PI_BROWSER_ERROR.MCP_UNAVAILABLE;
                throw new PiBrowserProtocolError(code, err.message, { tool });
            }
            const message = err instanceof Error ? err.message : String(err);
            if (/timed out|timeout/i.test(message)) {
                throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT, `mcp tool call timed out: ${tool}`);
            }
            if (/disposed|closed/i.test(message)) {
                throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `mcp connection unavailable: ${tool}`);
            }
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `mcp tool call failed: ${message}`, { tool });
        }
    }
    async listTools() {
        return this.client.listTools();
    }
    get connected() {
        return this.client.connected;
    }
    async dispose() {
        await this.client.dispose();
    }
}
// ---------------------------------------------------------------------------
// Shared error translation
// ---------------------------------------------------------------------------
export function translateTransportError(err, tool) {
    if (err instanceof PiBrowserProtocolError)
        return err;
    if (err instanceof TransportTimeoutError) {
        return new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT, `browser tool timed out: ${tool}`);
    }
    if (err instanceof TransportClosedError) {
        return new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, "browser connection closed", { tool });
    }
    if (isStructuredErrorObject(err)) {
        const code = codeFromErrorObject(err) ?? PI_BROWSER_ERROR.INTERNAL;
        return new PiBrowserProtocolError(code, err.message, { tool });
    }
    return new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, err instanceof Error ? err.message : String(err), { tool });
}
/**
 * Registers browser tools on Pi sessions and routes their execution through
 * the per-session BrowserToolTransport.
 */
export class BrowserToolProvider {
    transport;
    log;
    sessions = new Map();
    constructor(transport, log) {
        this.transport = transport;
        this.log = log;
    }
    /** Choose the transport for a session from the MCP servers the client declared. */
    selectMode(mcpServers) {
        return mcpServers?.some((s) => typeof s === "object" && s !== null && s.type === "acp")
            ? "mcp-acp"
            : "legacy";
    }
    /**
     * Build the Pi custom-tool specs for a session. The session id is bound
     * lazily (idRef) because the backend assigns it at session creation.
     */
    createTools(idRef, mode, mcpServerId) {
        return BROWSER_TOOL_SCHEMAS.map((entry) => ({
            name: entry.name,
            label: entry.name,
            description: entry.description,
            parameters: entry.parameters,
            execute: async (toolCallId, args, _signal) => {
                const sessionId = idRef.id;
                if (!sessionId) {
                    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "browser tool invoked before session id assigned");
                }
                const state = this.ensureState(sessionId, mode, mcpServerId);
                const transport = state.mode === "mcp-acp"
                    ? state.mcp
                    : this.legacy();
                const result = await transport.call(sessionId, entry.name, args);
                if (result.isError) {
                    const text = result.content
                        .filter((c) => c.type === "text")
                        .map((c) => c.text)
                        .join("\n");
                    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, text || "browser tool failed", {
                        tool: entry.name,
                    });
                }
                return { content: result.content, details: { piBrowser: true, tool: entry.name } };
            },
        }));
    }
    /** Ensure per-session transport state exists (called at tool execution). */
    ensureState(sessionId, mode, mcpServerId) {
        let state = this.sessions.get(sessionId);
        if (!state) {
            if (mode === "mcp-acp" && mcpServerId) {
                state = {
                    mode,
                    mcp: new NativeMcpOverAcpTransport(this.transport, mcpServerId, this.log, sessionId),
                };
            }
            else {
                state = { mode };
            }
            this.sessions.set(sessionId, state);
            this.log.info(`browser state for session ${sessionId}: mode=${state.mode}`);
        }
        return state;
    }
    legacy() {
        return new LegacyBrowserCallbackTransport(this.transport);
    }
    /** Handle x-pi-browser/notify (tab closed/navigated, binding changes). */
    handleNotify(params) {
        this.log.debug(`x-pi-browser/notify ${params.event} session=${params.sessionId}`);
        // Element references are owned by the content script and validated at
        // use time (isConnected). No host-side state to invalidate today; the
        // hook exists so future transports can react (e.g. drop MCP connections
        // when the bound tab closes).
        if (params.event === "tab_closed") {
            const state = this.sessions.get(params.sessionId);
            if (state?.mcp) {
                // Keep the MCP connection: the provider tab may have other tabs
                // bound later, and reconnecting is cheap. Log only.
            }
        }
    }
    /** Release per-session state (session/close or host shutdown). */
    async disposeSession(sessionId) {
        const state = this.sessions.get(sessionId);
        if (!state)
            return;
        this.sessions.delete(sessionId);
        if (state.mcp)
            await state.mcp.dispose();
    }
    async shutdown() {
        for (const id of [...this.sessions.keys()])
            await this.disposeSession(id);
    }
}
//# sourceMappingURL=provider.js.map