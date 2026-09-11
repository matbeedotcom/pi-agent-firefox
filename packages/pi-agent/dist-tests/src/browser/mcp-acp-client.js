/**
 * MCP-over-ACP client (PRODUCT.md §27–28).
 *
 * When the client (Firefox) declares an `McpServer` with `type: "acp"` in
 * session/new, the agent connects to it over the existing ACP channel via
 * mcp/connect, mcp/message, and mcp/disconnect, and speaks plain MCP
 * (initialize / tools/list / tools/call) inside mcp/message.
 */
import { CLIENT_METHODS, PI_BROWSER, } from "@pi-browser/protocol";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export class McpAcpClient {
    opts;
    connectionId;
    connecting;
    disposed = false;
    constructor(opts) {
        this.opts = opts;
    }
    get connected() {
        return this.connectionId !== undefined;
    }
    async connect() {
        const { transport, log, serverId } = this.opts;
        log.info(`mcp/connect serverId=${serverId}`);
        const res = (await transport.request(CLIENT_METHODS.mcp_connect, { serverId }, this.opts.timeoutMs));
        const connectionId = res.connectionId;
        // MCP handshake inside the ACP channel.
        await this.innerRequest(connectionId, "initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "pi-browser-agent", version: PI_BROWSER.version },
        });
        // MCP "initialized" notification; the ACP mcp/message method is a
        // request, so expect (and ignore) an empty result.
        await this.innerRequest(connectionId, "notifications/initialized", undefined);
        this.connectionId = connectionId;
        log.info(`mcp connected: ${connectionId}`);
    }
    async ensureConnected() {
        if (this.disposed)
            throw new Error("mcp client disposed");
        if (this.connectionId)
            return this.connectionId;
        if (!this.connecting)
            this.connecting = this.connect().catch((err) => {
                this.connecting = undefined;
                throw err;
            });
        await this.connecting;
        return this.connectionId;
    }
    innerRequest(connectionId, method, params) {
        return this.opts.transport.request(CLIENT_METHODS.mcp_message, { connectionId, method, ...(params !== undefined ? { params } : {}) }, this.opts.timeoutMs);
    }
    async listTools() {
        const connectionId = await this.ensureConnected();
        const res = (await this.innerRequest(connectionId, "tools/list"));
        return res.tools ?? [];
    }
    /** Call a tool on the client's MCP server. Returns the MCP tools/call result. */
    async call(tool, args) {
        const connectionId = await this.ensureConnected();
        return await this.innerRequest(connectionId, "tools/call", { name: tool, arguments: args });
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const connectionId = this.connectionId;
        this.connectionId = undefined;
        if (connectionId) {
            try {
                await this.opts.transport.request(CLIENT_METHODS.mcp_disconnect, { connectionId }, this.opts.timeoutMs);
            }
            catch {
                // Connection already gone; nothing to clean up.
            }
        }
    }
}
//# sourceMappingURL=mcp-acp-client.js.map