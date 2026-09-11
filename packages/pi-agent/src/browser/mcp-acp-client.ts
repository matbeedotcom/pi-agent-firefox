/**
 * MCP-over-ACP client (PRODUCT.md §27–28).
 *
 * When the client (Firefox) declares an `McpServer` with `type: "acp"` in
 * session/new, the agent connects to it over the existing ACP channel via
 * mcp/connect, mcp/message, and mcp/disconnect, and speaks plain MCP
 * (initialize / tools/list / tools/call) inside mcp/message.
 */
import {
  CLIENT_METHODS,
  PI_BROWSER,
  type AcpTransportLike,
  type ConnectMcpResponse,
} from "@pi-browser/protocol";
import type { Logger } from "../logger.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

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

export class McpAcpClient {
  private connectionId: string | undefined;
  private connecting: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly opts: McpAcpClientOptions) {}

  get connected(): boolean {
    return this.connectionId !== undefined;
  }

  private async connect(): Promise<void> {
    const { transport, log, serverId } = this.opts;
    log.info(`mcp/connect serverId=${serverId}`);
    const res = (await transport.request(
      CLIENT_METHODS.mcp_connect,
      { serverId },
      this.opts.timeoutMs,
    )) as ConnectMcpResponse;
    const connectionId: string = res.connectionId;

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

  private async ensureConnected(): Promise<string> {
    if (this.disposed) throw new Error("mcp client disposed");
    if (this.connectionId) return this.connectionId;
    if (!this.connecting) this.connecting = this.connect().catch((err) => {
      this.connecting = undefined;
      throw err;
    });
    await this.connecting;
    return this.connectionId as string;
  }

  private innerRequest(connectionId: string, method: string, params?: unknown): Promise<unknown> {
    return this.opts.transport.request(
      CLIENT_METHODS.mcp_message,
      { connectionId, method, ...(params !== undefined ? { params } : {}) },
      this.opts.timeoutMs,
    );
  }

  async listTools(): Promise<McpToolInfo[]> {
    const connectionId = await this.ensureConnected();
    const res = (await this.innerRequest(connectionId, "tools/list")) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  /** Call a tool on the client's MCP server. Returns the MCP tools/call result. */
  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const connectionId = await this.ensureConnected();
    return await this.innerRequest(connectionId, "tools/call", { name: tool, arguments: args });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const connectionId = this.connectionId;
    this.connectionId = undefined;
    if (connectionId) {
      try {
        await this.opts.transport.request(CLIENT_METHODS.mcp_disconnect, { connectionId }, this.opts.timeoutMs);
      } catch {
        // Connection already gone; nothing to clean up.
      }
    }
  }
}
