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
import { PiBrowserProtocolError, type AcpTransportLike, type BrowserNotifyParams } from "@pi-browser/protocol";
import type { ToolSpec } from "../acp/backend.js";
import type { Logger } from "../logger.js";
/** Normalized tool result: MCP tools/call shape. */
export interface NormalizedToolResult {
    content: Array<{
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: string;
    }>;
    isError?: boolean;
}
export interface BrowserToolTransport {
    readonly kind: "legacy" | "mcp-acp";
    call(sessionId: string, tool: string, args: Record<string, unknown>): Promise<NormalizedToolResult>;
    dispose(): Promise<void>;
}
/** Convert an MCP tools/call result (or a raw object) into normalized content. */
export declare function normalizeToolResult(raw: unknown): NormalizedToolResult;
export interface LegacyTransportOptions {
    /** Base timeout for a tool; defaults come from protocol constants. */
    timeoutMs?: (tool: string) => number;
    /** Host-side backstop buffer over the timeout hint (default 5s). */
    slackMs?: number;
}
export declare class LegacyBrowserCallbackTransport implements BrowserToolTransport {
    private readonly transport;
    private readonly options;
    readonly kind: "legacy";
    constructor(transport: AcpTransportLike, options?: LegacyTransportOptions);
    call(sessionId: string, tool: string, args: Record<string, unknown>): Promise<NormalizedToolResult>;
    dispose(): Promise<void>;
}
export declare class NativeMcpOverAcpTransport implements BrowserToolTransport {
    private readonly sessionId;
    readonly kind: "mcp-acp";
    private client;
    constructor(transport: AcpTransportLike, serverId: string, log: Logger, sessionId: string);
    call(_sessionId: string, tool: string, args: Record<string, unknown>): Promise<NormalizedToolResult>;
    listTools(): Promise<import("./mcp-acp-client.js").McpToolInfo[]>;
    get connected(): boolean;
    dispose(): Promise<void>;
}
export declare function translateTransportError(err: unknown, tool: string): PiBrowserProtocolError;
export type BrowserMode = "legacy" | "mcp-acp";
interface SessionBrowserState {
    mode: BrowserMode;
    mcp?: NativeMcpOverAcpTransport;
}
/**
 * Registers browser tools on Pi sessions and routes their execution through
 * the per-session BrowserToolTransport.
 */
export declare class BrowserToolProvider {
    private readonly transport;
    private readonly log;
    private readonly sessions;
    constructor(transport: AcpTransportLike, log: Logger);
    /** Choose the transport for a session from the MCP servers the client declared. */
    selectMode(mcpServers?: unknown[]): BrowserMode;
    /**
     * Build the Pi custom-tool specs for a session. The session id is bound
     * lazily (idRef) because the backend assigns it at session creation.
     */
    createTools(idRef: {
        id?: string;
    }, mode: BrowserMode, mcpServerId?: string): ToolSpec[];
    /** Ensure per-session transport state exists (called at tool execution). */
    ensureState(sessionId: string, mode: BrowserMode, mcpServerId?: string): SessionBrowserState;
    private legacy;
    /** Handle x-pi-browser/notify (tab closed/navigated, binding changes). */
    handleNotify(params: BrowserNotifyParams): void;
    /** Release per-session state (session/close or host shutdown). */
    disposeSession(sessionId: string): Promise<void>;
    shutdown(): Promise<void>;
}
export {};
//# sourceMappingURL=provider.d.ts.map