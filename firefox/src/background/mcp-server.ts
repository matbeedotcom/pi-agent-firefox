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
import {
  BROWSER_TOOLS,
  MCP_PROTOCOL_VERSION,
  PI_BROWSER,
  type ConnectMcpRequest,
  type ConnectMcpResponse,
  type DisconnectMcpRequest,
  type MessageMcpRequest,
  type MessageMcpResponse,
} from "@pi-browser/protocol";
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import type { ToolDispatcher } from "./tool-dispatcher.js";

interface McpConnection {
  connectionId: string;
  sessionId: string;
  initialized: boolean;
}

export class McpServer {
  private connections = new Map<string, McpConnection>();
  /** serverId -> session that declared it. */
  private serverSessions = new Map<string, string>();
  private nextConnection = 0;
  private nextServer = 0;

  /**
   * Declare a pending ACP-transport MCP server for an upcoming session
   * (session/new has no sessionId yet; resolved on response).
   */
  declarePending(): { serverId: string; resolve: (sessionId: string) => void; discard: () => void } {
    const serverId = `fb-${++this.nextServer}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      serverId,
      resolve: (sessionId: string) => {
        this.serverSessions.set(serverId, sessionId);
      },
      discard: () => {
        this.serverSessions.delete(serverId);
      },
    };
  }

  /** Declare directly for a known session (resume/load responses). */
  declareFor(sessionId: string): string {
    const serverId = `fb-${++this.nextServer}-${Math.random().toString(36).slice(2, 8)}`;
    this.serverSessions.set(serverId, sessionId);
    return serverId;
  }

  async handleConnect(req: ConnectMcpRequest): Promise<ConnectMcpResponse> {
    const sessionId = this.serverSessions.get(req.serverId);
    if (!sessionId) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.MCP_UNAVAILABLE,
        `unknown MCP server id: ${req.serverId}`,
      );
    }
    const connectionId = `conn-${++this.nextConnection}`;
    this.connections.set(connectionId, { connectionId, sessionId, initialized: false });
    return { connectionId };
  }

  async handleMessage(req: MessageMcpRequest): Promise<MessageMcpResponse> {
    const conn = this.connections.get(req.connectionId);
    if (!conn) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `unknown connection: ${req.connectionId}`);
    }
    switch (req.method) {
      case "initialize": {
        const params = (req.params ?? {}) as { protocolVersion?: string };
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
          tools: BROWSER_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!conn.initialized) {
          throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, "MCP session not initialized");
        }
        if (!params.name) {
          throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, "tools/call missing name");
        }
        return (await this.dispatcher.handleToolCall({
          sessionId: conn.sessionId,
          tool: params.name,
          arguments: params.arguments ?? {},
        })) as MessageMcpResponse;
      }
      default:
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `unknown MCP method: ${req.method}`);
    }
  }

  async handleDisconnect(req: DisconnectMcpRequest): Promise<void> {
    this.connections.delete(req.connectionId);
  }

  constructor(private readonly dispatcher: ToolDispatcher) {}
}
