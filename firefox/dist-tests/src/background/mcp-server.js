/**
 * Firefox MCP server for browser tools (PRODUCT.md §26–28, Phase 5).
 *
 * Firefox is simultaneously the ACP client and the MCP server provider: it
 * declares an ACP-transport MCP server in session/new/resume/load, then
 * answers the agent's mcp/connect, mcp/message, and mcp/disconnect over the
 * existing ACP channel. The MCP surface (tools/list, tools/call) is the same
 * regardless of transport, so migrating away from x-pi-browser/tool changes
 * only the wire path.
 */
import { BROWSER_TOOLS, CONTROL_TOOLS, MCP_PROTOCOL_VERSION, PI_BROWSER, isControlTool, } from "@pi-browser/protocol";
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
function controlTextResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
            },
        ],
    };
}
export class McpServer {
    dispatcher;
    control;
    connections = new Map();
    /** serverId -> session that declared it. */
    serverSessions = new Map();
    nextConnection = 0;
    nextServer = 0;
    /**
     * Declare a pending ACP-transport MCP server for an upcoming session
     * (session/new has no sessionId yet; resolved on response).
     */
    declarePending() {
        const serverId = `fb-${++this.nextServer}-${Math.random().toString(36).slice(2, 8)}`;
        return {
            serverId,
            resolve: (sessionId) => {
                this.serverSessions.set(serverId, sessionId);
            },
            discard: () => {
                this.serverSessions.delete(serverId);
            },
        };
    }
    /** Declare directly for a known session (resume/load responses). */
    declareFor(sessionId) {
        const serverId = `fb-${++this.nextServer}-${Math.random().toString(36).slice(2, 8)}`;
        this.serverSessions.set(serverId, sessionId);
        return serverId;
    }
    async handleConnect(req) {
        const sessionId = this.serverSessions.get(req.serverId);
        if (!sessionId) {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `unknown MCP server id: ${req.serverId}`);
        }
        const connectionId = `conn-${++this.nextConnection}`;
        this.connections.set(connectionId, { connectionId, sessionId, initialized: false });
        return { connectionId };
    }
    async handleMessage(req) {
        const conn = this.connections.get(req.connectionId);
        if (!conn) {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `unknown connection: ${req.connectionId}`);
        }
        switch (req.method) {
            case "initialize": {
                const params = (req.params ?? {});
                return {
                    protocolVersion: params.protocolVersion ?? MCP_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "pi-browser-firefox", version: PI_BROWSER.version },
                };
            }
            case "notifications/initialized":
                conn.initialized = true;
                return {};
            case "tools/list":
                return {
                    tools: [...BROWSER_TOOLS, ...CONTROL_TOOLS].map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                    })),
                };
            case "tools/call": {
                const params = (req.params ?? {});
                if (!conn.initialized) {
                    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, "MCP session not initialized");
                }
                if (!params.name) {
                    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, "tools/call missing name");
                }
                if (isControlTool(params.name)) {
                    if (!this.control) {
                        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `control tool not available on this server: ${params.name}`);
                    }
                    const result = await this.control(params.name, params.arguments ?? {});
                    return controlTextResult(result);
                }
                return (await this.dispatcher.handleToolCall({
                    sessionId: conn.sessionId,
                    tool: params.name,
                    arguments: params.arguments ?? {},
                }));
            }
            default:
                throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `unknown MCP method: ${req.method}`);
        }
    }
    async handleDisconnect(req) {
        this.connections.delete(req.connectionId);
    }
    constructor(dispatcher, control = undefined) {
        this.dispatcher = dispatcher;
        this.control = control;
    }
}
