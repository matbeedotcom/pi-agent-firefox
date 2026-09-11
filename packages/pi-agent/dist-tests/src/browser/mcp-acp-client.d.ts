/**
 * MCP-over-ACP client (PRODUCT.md §27–28).
 *
 * When the client (Firefox) declares an `McpServer` with `type: "acp"` in
 * session/new, the agent connects to it over the existing ACP channel via
 * mcp/connect, mcp/message, and mcp/disconnect, and speaks plain MCP
 * (initialize / tools/list / tools/call) inside mcp/message.
 */
import { MCP_PROTOCOL_VERSION, type AcpTransportLike } from "@pi-browser/protocol";
import type { Logger } from "../logger.js";
export { MCP_PROTOCOL_VERSION };
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
export interface McpAcpClientOptions {
    transport: AcpTransportLike;
    serverId: string;
    log: Logger;
    /** Per-call timeout for inner MCP requests. */
    timeoutMs?: number;
}
export declare class McpAcpClient {
    private readonly opts;
    private connectionId;
    private connecting;
    private disposed;
    constructor(opts: McpAcpClientOptions);
    get connected(): boolean;
    private connect;
    private ensureConnected;
    private innerRequest;
    listTools(): Promise<McpToolInfo[]>;
    /** Call a tool on the client's MCP server. Returns the MCP tools/call result. */
    call(tool: string, args: Record<string, unknown>): Promise<unknown>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=mcp-acp-client.d.ts.map