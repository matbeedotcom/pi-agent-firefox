/**
 * Capability provider registry (THUNDERBIRD-PLAN.md §28).
 *
 * The broker maintains one entry per attached application connection
 * (Firefox / Thunderbird), identified by the pi.agent.hello handshake
 * (application + capabilities). Tool routing (plan §29) resolves each tool
 * call to the connected client that provides it, so a Pi session can use
 * both apps' tools in one turn.
 */
import {
  AGENT_CAPABILITIES,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  capabilitiesProvideTool,
  type AcpTransportLike,
  type AgentApplication,
  type AgentCapability,
} from "@pi-browser/protocol";
import type { Logger } from "./logger.js";

/** A connected application (capability provider) with its transport. */
export interface CapabilityClient {
  clientId: string;
  application: AgentApplication;
  capabilities: AgentCapability[];
  transport: AcpTransportLike;
}

export class CapabilityRegistry {
  private readonly clients = new Map<string, CapabilityClient>();

  constructor(private readonly log: Logger) {}

  /** Register (or re-register) a client. Returns the previous entry, if any. */
  register(client: CapabilityClient): CapabilityClient | undefined {
    const previous = this.clients.get(client.clientId);
    this.clients.set(client.clientId, client);
    this.log.info(
      `registry: ${client.clientId} ${client.application} capabilities=[${client.capabilities.join(",")}]` +
        (previous ? " (re-registered)" : "") +
        ` — connected: ${this.clients.size}`,
    );
    return previous;
  }

  /** Remove a disconnected client. Returns it if it was registered. */
  remove(clientId: string): CapabilityClient | undefined {
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    this.clients.delete(clientId);
    this.log.info(`registry: ${clientId} removed — connected: ${this.clients.size}`);
    return client;
  }

  get(clientId: string): CapabilityClient | undefined {
    return this.clients.get(clientId);
  }

  list(): CapabilityClient[] {
    return [...this.clients.values()];
  }

  get size(): number {
    return this.clients.size;
  }

  /** Union of all connected clients' capabilities (canonical order). */
  allCapabilities(): AgentCapability[] {
    const set = new Set<AgentCapability>();
    for (const c of this.clients.values()) {
      for (const cap of c.capabilities) set.add(cap);
    }
    return AGENT_CAPABILITIES.filter((c) => set.has(c));
  }

  /**
   * Client that should execute `toolName` for a session owned by
   * `ownerClientId` (plan §29): the owner when it provides the tool,
   * otherwise the first other connected client that does (cross-app
   * routing). Throws a structured error when no connected client provides
   * the tool.
   */
  resolveTarget(ownerClientId: string | undefined, toolName: string): CapabilityClient {
    const owner = ownerClientId ? this.clients.get(ownerClientId) : undefined;
    if (owner && capabilitiesProvideTool(owner.capabilities, toolName)) return owner;
    for (const client of this.clients.values()) {
      if (owner && client.clientId === owner.clientId) continue;
      if (capabilitiesProvideTool(client.capabilities, toolName)) return client;
    }
    throw new PiBrowserProtocolError(
      PI_BROWSER_ERROR.MCP_UNAVAILABLE,
      `no connected client provides tool: ${toolName}`,
      { tool: toolName },
    );
  }
}
