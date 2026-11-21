/**
 * External ACP agents for sidebar sessions (openspec sidebar-acp-agents).
 *
 * Broker-wide: one agent process per agent id, shared by every session on
 * that agent, whichever app (Firefox, Thunderbird) owns the session (D2).
 * The manager:
 * - starts an agent on its first session and initializes it once;
 * - routes the agent's updates and permission requests to the session's
 *   relay (and so to the client that owns it);
 * - keeps the session index for `session/list` and reopening (D5);
 * - gives each session the pi-browser stdio bridge, tied to it by a token
 *   in PI_BROWSER_PARENT_SESSION (D6);
 * - stops idle agents and restarts them on demand (D2a);
 * - turns missing commands, logins and crashes into readable errors (D8).
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_CHILD_ENV,
  PARENT_SESSION_ENV,
  PI_BROKER,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  type AgentsResult,
  type SessionUpdate,
} from "@pi-browser/protocol";
import type { Logger } from "../../logger.js";
import { AgentConnection, AgentRpcError, AgentStoppedError } from "./connection.js";
import { AgentRegistry, type AgentSpec } from "./registry.js";
import { AcpRelaySession, type RelayHost, type RelayOwner } from "./relay-session.js";
import { AgentSessionIndex, type AgentSessionEntry } from "./session-index.js";

/** ACP's "authentication required" error code. */
const AUTH_REQUIRED_CODE = -32000;

/** Updates kept for a session the agent reports before its id is registered. */
const MAX_EARLY_UPDATES = 200;

export interface ExternalAgentsOptions {
  log: Logger;
  registry?: AgentRegistry;
  index?: AgentSessionIndex;
  /** Broker instance id (PI_BROWSER_HOST_CHILD for the bridge). */
  instanceId?: string;
  /** The stdio bridge launch (default: this package's mcp-stdio-main.js with this node). */
  bridgeLaunch?: { command: string; args: string[] };
  /** Prompt timeout of the add-on's permission UI (default 120 s). */
  permissionTimeoutMs?: () => number;
  /** Clock (tests). */
  now?: () => number;
  /** How often idle agents are checked (default 60 s); 0 = no timer (tests call checkIdle). */
  idleCheckMs?: number;
  /** Grace period between closing an agent's stdin and killing it. */
  stopGraceMs?: number;
}

/** Default bridge launch: `node <pkg>/dist/native-host/mcp-stdio-main.js` (same as the installers). */
export function defaultBridgeLaunch(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("../../native-host/mcp-stdio-main.js", import.meta.url))],
  };
}

export class ExternalAgents implements RelayHost {
  readonly log: Logger;
  readonly registry: AgentRegistry;
  readonly index: AgentSessionIndex;
  private readonly conns = new Map<string, AgentConnection>();
  private readonly starting = new Map<string, Promise<AgentConnection>>();
  private readonly sessions = new Map<string, AcpRelaySession>();
  private readonly tokens = new Map<string, string>();
  private readonly early = new Map<string, SessionUpdate[]>();
  private readonly instanceId: string | undefined;
  private readonly bridge: { command: string; args: string[] };
  private readonly promptTimeout: () => number;
  private readonly now: () => number;
  private readonly stopGraceMs: number | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(opts: ExternalAgentsOptions) {
    this.log = opts.log;
    this.registry = opts.registry ?? new AgentRegistry();
    this.index = opts.index ?? new AgentSessionIndex();
    this.instanceId = opts.instanceId;
    this.bridge = opts.bridgeLaunch ?? defaultBridgeLaunch();
    this.promptTimeout = opts.permissionTimeoutMs ?? (() => 120_000);
    this.now = opts.now ?? Date.now;
    this.stopGraceMs = opts.stopGraceMs;
    const every = opts.idleCheckMs ?? 60_000;
    if (every > 0) {
      this.idleTimer = setInterval(() => this.checkIdle(), every);
      this.idleTimer.unref?.();
    }
  }

  // ------------------------------------------------------------------
  // Listing
  // ------------------------------------------------------------------

  list(): AgentsResult {
    return this.registry.list();
  }

  /** The indexed entry of an external-agent session (load/resume, list). */
  entry(sessionId: string): AgentSessionEntry | undefined {
    return this.index.get(sessionId);
  }

  isAgentSession(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.index.get(sessionId) !== undefined;
  }

  /** Open relay for a session id, if any. */
  session(sessionId: string): AcpRelaySession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Sidebar session a bridge's PI_BROWSER_PARENT_SESSION token names. */
  resolveParentToken(token: string): string | undefined {
    return this.tokens.get(token);
  }

  /** Whether an agent's process is running (status, tests). */
  isRunning(agentId: string): boolean {
    return this.conns.get(agentId)?.alive === true;
  }

  runningPid(agentId: string): number | undefined {
    const c = this.conns.get(agentId);
    return c?.alive ? c.pid : undefined;
  }

  // ------------------------------------------------------------------
  // RelayHost
  // ------------------------------------------------------------------

  liveConnection(agentId: string): AgentConnection | undefined {
    const c = this.conns.get(agentId);
    return c?.alive ? c : undefined;
  }

  connection(agentId: string): Promise<AgentConnection> {
    const live = this.liveConnection(agentId);
    if (live) return Promise.resolve(live);
    const pending = this.starting.get(agentId);
    if (pending) return pending;
    const start = this.startAgent(agentId).finally(() => this.starting.delete(agentId));
    this.starting.set(agentId, start);
    return start;
  }

  private async startAgent(agentId: string): Promise<AgentConnection> {
    const resolved = this.registry.resolve(agentId);
    if (!resolved.ok) {
      const name = resolved.spec?.name ?? agentId;
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.ACP_INITIALIZATION_FAILED, `${name} is not available: ${resolved.reason}`);
    }
    const spec = resolved.spec;
    const conn: AgentConnection = new AgentConnection({
      spec,
      executable: resolved.executable,
      log: this.log,
      now: this.now,
      ...(this.stopGraceMs !== undefined ? { stopGraceMs: this.stopGraceMs } : {}),
      handlers: {
        onNotification: (method, params) => this.onAgentNotification(spec, method, params),
        onRequest: (method, params) => this.onAgentRequest(spec, method, params),
        onExit: ({ code, signal, expected }) => {
          if (this.conns.get(agentId) === conn) this.conns.delete(agentId);
          const what = code !== null ? `exit code ${code}` : `signal ${signal ?? "?"}`;
          for (const s of this.sessions.values()) {
            if (s.agentId !== agentId || s.dormant) continue;
            s.markStopped(expected ? undefined : `${spec.name} stopped (${what}). Your next message restarts it.`);
          }
        },
      },
    });
    this.conns.set(agentId, conn);
    try {
      await conn.start();
    } catch (err) {
      if (this.conns.get(agentId) === conn) this.conns.delete(agentId);
      void conn.stop();
      throw this.describeError(agentId, err, "start");
    }
    return conn;
  }

  mcpServers(session: AcpRelaySession): unknown[] {
    const env = [{ name: PARENT_SESSION_ENV, value: session.parentToken }];
    if (this.instanceId) env.unshift({ name: HOST_CHILD_ENV, value: this.instanceId });
    // Some agents start MCP servers with a trimmed environment (Codex keeps
    // only a few inherited variables), so name the broker's run dir here
    // instead of relying on inheritance.
    env.push({
      name: "PI_BROWSER_BROKER_DIR",
      value: process.env.PI_BROWSER_BROKER_DIR || path.join(homedir(), ".pi", PI_BROKER.runDir),
    });
    return [{ name: "pi-browser", command: this.bridge.command, args: [...this.bridge.args], env }];
  }

  permissionTimeoutMs(): number {
    return this.promptTimeout();
  }

  touchIndex(session: AcpRelaySession, title?: string, firstPrompt?: string): void {
    if (firstPrompt !== undefined) {
      const t = firstPrompt.replace(/\s+/g, " ").trim().slice(0, 80);
      if (t) this.index.setTitleIfMissing(session.id, t);
      return;
    }
    this.index.upsert({ sessionId: session.id, agent: session.agentId, cwd: session.cwd, ...(title ? { title } : {}) });
  }

  describeError(agentId: string, err: unknown, action: string): PiBrowserProtocolError {
    if (err instanceof PiBrowserProtocolError) return err;
    const spec = this.registry.load().specs.find((s) => s.id === agentId);
    const name = spec?.name ?? agentId;
    if (err instanceof AgentRpcError && isAuthError(err)) {
      return new PiBrowserProtocolError(
        PI_BROWSER_ERROR.ACP_INITIALIZATION_FAILED,
        `${name} needs you to log in: ${spec?.loginHint ?? "log in with the agent's own CLI"}, then try again`,
      );
    }
    if (err instanceof AgentStoppedError) return new PiBrowserProtocolError(PI_BROWSER_ERROR.ACP_INITIALIZATION_FAILED, err.message);
    const message = err instanceof Error ? err.message : String(err);
    return new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${name} could not ${action}: ${message}`);
  }

  forget(session: AcpRelaySession): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    this.tokens.delete(session.parentToken);
  }

  // ------------------------------------------------------------------
  // Agent → relay routing
  // ------------------------------------------------------------------

  private onAgentNotification(spec: AgentSpec, method: string, params: unknown): void {
    if (method !== "session/update") {
      this.log.debug(`agent ${spec.id}: ignoring ${method}`);
      return;
    }
    const p = params as { sessionId?: unknown; update?: unknown } | undefined;
    if (typeof p?.sessionId !== "string" || typeof p.update !== "object" || p.update === null) return;
    const relay = this.sessions.get(p.sessionId);
    if (relay && relay.agentId === spec.id) {
      relay.handleUpdate(p.update as SessionUpdate);
      return;
    }
    // Updates for a session whose session/new hasn't answered yet.
    const list = this.early.get(p.sessionId) ?? [];
    if (list.length < MAX_EARLY_UPDATES) list.push(p.update as SessionUpdate);
    this.early.set(p.sessionId, list);
  }

  private async onAgentRequest(spec: AgentSpec, method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
      const relay = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
      if (!relay || relay.agentId !== spec.id) return { outcome: { outcome: "cancelled" } };
      return relay.handlePermission(params);
    }
    // No client file system or terminals (not advertised in initialize).
    throw new AgentRpcError(-32601, `method not supported by this client: ${method}`);
  }

  // ------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------

  private register(relay: AcpRelaySession): void {
    this.sessions.set(relay.id, relay);
    this.tokens.set(relay.parentToken, relay.id);
    const early = this.early.get(relay.id);
    this.early.delete(relay.id);
    for (const u of early ?? []) relay.handleUpdate(u);
  }

  private nameOf(agentId: string): string {
    return this.registry.nameOf(agentId);
  }

  /** Create a session on an agent. */
  async createSession(agentId: string, cwd: string, owner: RelayOwner): Promise<AcpRelaySession> {
    const conn = await this.connection(agentId);
    const release = conn.hold();
    try {
      const token = randomUUID();
      // The bridge env needs the token before the agent assigns the id: a
      // placeholder relay supplies it, and the real one is registered below.
      const placeholder = new AcpRelaySession(this, "", agentId, this.nameOf(agentId), cwd, owner, token);
      let result: { sessionId?: unknown };
      try {
        result = await conn.request<{ sessionId?: unknown }>("session/new", { cwd, mcpServers: this.mcpServers(placeholder) });
      } catch (err) {
        throw this.describeError(agentId, err, "start a session");
      }
      if (typeof result?.sessionId !== "string" || !result.sessionId) {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${this.nameOf(agentId)} returned no session id`);
      }
      if (this.sessions.has(result.sessionId)) {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, `session ${result.sessionId} is already open`);
      }
      const relay = new AcpRelaySession(this, result.sessionId, agentId, this.nameOf(agentId), cwd, owner, token);
      relay.applySessionResult(result);
      this.index.upsert({ sessionId: relay.id, agent: agentId, cwd });
      this.register(relay);
      this.log.info(`agent ${agentId}: session/new -> ${relay.id} cwd=${cwd}`);
      return relay;
    } finally {
      release();
    }
  }

  /**
   * Reopen an indexed session (session/load or session/resume from the
   * add-on). A session already open for the same client is handed back with
   * its transcript re-sent; one open in another app is refused.
   */
  async openSession(sessionId: string, owner: RelayOwner, how: "load" | "resume", cwdHint?: string): Promise<AcpRelaySession> {
    const open = this.sessions.get(sessionId);
    if (open) {
      if (open.owner.transport !== owner.transport) {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, `session ${sessionId} is open in another app`);
      }
      if (how === "load") open.replayTranscript();
      return open;
    }
    const entry = this.index.get(sessionId);
    if (!entry) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
    const name = this.nameOf(entry.agent);
    const conn = await this.connection(entry.agent);
    if (!conn.init?.loadSession) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.SESSION_NOT_FOUND,
        `This session can't be reopened with ${name}: it doesn't support loading sessions. Start a new session.`,
      );
    }
    const release = conn.hold();
    try {
      const relay = new AcpRelaySession(this, sessionId, entry.agent, name, cwdHint || entry.cwd, owner, randomUUID());
      // Register first: session/load replays the history as updates.
      this.register(relay);
      try {
        const result = await conn.request("session/load", { sessionId, cwd: relay.cwd, mcpServers: this.mcpServers(relay) });
        relay.applySessionResult(result);
      } catch (err) {
        this.forget(relay);
        throw this.describeError(entry.agent, err, "reopen the session");
      }
      this.log.info(`agent ${entry.agent}: session/${how} -> ${sessionId}`);
      return relay;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------
  // Idle stop (D2a)
  // ------------------------------------------------------------------

  /** Stop agents idle past their timeout whose open sessions can all be reloaded. */
  checkIdle(): string[] {
    const stopped: string[] = [];
    for (const [agentId, conn] of this.conns) {
      if (!conn.alive) continue;
      const minutes = conn.spec.idleTimeoutMinutes;
      if (!(minutes > 0)) continue;
      if (conn.busy) continue;
      if (this.now() - conn.lastActivity < minutes * 60_000) continue;
      const open = [...this.sessions.values()].filter((s) => s.agentId === agentId && !s.dormant);
      const reloadable = open.every((s) => conn.init?.loadSession === true && this.index.get(s.id) !== undefined);
      if (!reloadable) continue;
      this.log.info(`agent ${agentId}: idle for ${minutes} min; stopping (${open.length} session(s) kept, reloaded on the next request)`);
      for (const s of open) s.markStopped();
      this.conns.delete(agentId);
      void conn.stop();
      stopped.push(agentId);
    }
    return stopped;
  }

  /** Stop every agent (host shutdown). */
  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const conns = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(conns.map((c) => c.stop().catch(() => undefined)));
  }
}

function isAuthError(err: AgentRpcError): boolean {
  if (err.code === AUTH_REQUIRED_CODE && /auth|log ?in|sign ?in|credential|api key/i.test(err.message)) return true;
  return /authenticat(ion|e) required|not (logged|signed) in|please (log|sign) in|unauthori[sz]ed/i.test(err.message);
}
