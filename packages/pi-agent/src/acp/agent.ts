/**
 * ACP agent: implements the ACP agent-side methods over the transport
 * (PRODUCT.md §5, §17–24).
 *
 * ACP owns agent session semantics: one Native Messaging connection carries
 * one ACP connection with many independent sessions. The agent maps each
 * ACP session to one Pi backend session and streams `session/update`
 * notifications back to the client.
 */
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PI_AGENT_META,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  PI_BROWSER_META,
  X_PI_BROWSER,
  JSONRPC_ERROR,
  PROTOCOL_VERSION,
  toErrorObject,
  parseAgentHello,
  type AgentApplication,
  type AgentCapability,
  type PiAgentMeta,

  type AcpImageContent,
  type CancelNotification,
  type CloseSessionRequest,
  type ContentBlock,
  type InitializeRequest,
  type McpServer,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type ResumeSessionRequest,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SessionInfo,
  type SessionNotification,
  type SessionUpdate,
  type ToolKind,
  type BrowserToolUpdateParams,
} from "@pi-browser/protocol";
import type { AcpTransport } from "../native-host/transport.js";
import type { Logger } from "../logger.js";
import type {
  BackendEvent,
  BackendHistoryEntry,
  BackendSession,
  ListedSession,
  ModelOption,
  PiBackend,
  ToolSpec,
} from "./backend.js";
import { buildConfigOptions, CONFIG_ID_MODEL, CONFIG_ID_THINKING } from "./config-options.js";
import { isNeutralCwd, TaskWorkspace } from "../workspace.js";
import type { BrowserMode, CapabilityToolProvider } from "../browser/provider.js";
import type { ImageAttachment } from "./backend.js";
import { touchClientHeartbeat } from "../client-heartbeat.js";
import type { CapabilityRegistry } from "../capability-registry.js";

export interface AcpAgentOptions {
  backend: PiBackend;
  provider: CapabilityToolProvider;
  transport: AcpTransport;
  log: Logger;
  agentInfo: { name: string; version: string };
  /** Stable id of this client connection (broker provider registry, plan §28). */
  clientId?: string;
  /**
   * Broker provider registry. When present, this client registers its hello
   * capabilities on `initialize` and its sessions see the union of all
   * connected clients' tools (cross-app routing, plan §29).
   */
  registry?: CapabilityRegistry;
  /**
   * Root for per-task workspaces (default ~/.pi/workspaces). A session whose
   * requested cwd is neutral (empty/root/home) is provisioned a fresh
   * directory here and uses it as its cwd, so the model's file tools and the
   * `javascript` REPL share one task-scoped scratch.
   */
  workspaceRoot?: string;
}

interface SessionState {
  id: string;
  cwd: string;
  session: BackendSession;
  unsubscribe: () => void;
  configOptions: SessionConfigOption[];
  browserMode: BrowserMode;
  mcpServerId?: string;
}

function toolKindFor(toolName: string): ToolKind {
  if (toolName.startsWith("browser_get") || toolName === "browser_wait_for" || toolName === "browser_screenshot") {
    return "fetch";
  }
  if (toolName.startsWith("browser_")) return "other";
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return "read";
  if (toolName === "edit" || toolName === "write") return "edit";
  if (toolName === "bash" || toolName === "powershell") return "execute";
  return "other";
}

/** Preserve every text/image result, including mixed-output JavaScript cells. */
function toToolCallContent(result: unknown): Array<{ type: "content"; content: ContentBlock }> {
  const r = result as { content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> } | undefined;
  const blocks: Array<{ type: "content"; content: ContentBlock }> = [];
  for (const c of Array.isArray(r?.content) ? r.content : []) {
    if (c?.type === "text" && typeof c.text === "string") {
      blocks.push({ type: "content", content: { type: "text", text: c.text } });
    } else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
      blocks.push({ type: "content", content: { type: "image", data: c.data, mimeType: c.mimeType } });
    }
  }
  return blocks.length ? blocks : [{ type: "content", content: { type: "text", text: result === undefined ? "" : JSON.stringify(result) } }];
}

export class AcpAgent {
  private readonly sessions = new Map<string, SessionState>();
  /** Name of the connected client (set on initialize) — for the add-on heartbeat. */
  private clientIdentityName: string | undefined;
  /**
   * Application + capabilities from the pi.agent.hello handshake (THUNDERBIRD-PLAN.md
   * §24). Legacy clients that never send a hello default to a browser-only
   * Firefox so existing installations keep working unchanged.
   */
  private clientApplication: AgentApplication = "firefox";
  private clientCapabilities: AgentCapability[] = ["browser"];
  /** Per-task filesystem scratch (one directory per session). */
  private readonly workspaces: TaskWorkspace;

  hasCapability(cap: AgentCapability): boolean {
    return this.clientCapabilities.includes(cap);
  }

  constructor(private readonly opts: AcpAgentOptions) {
    this.workspaces = new TaskWorkspace({ root: opts.workspaceRoot });
    opts.transport.onRequest = (method, params, id) => {
      void this.handleRequest(method, params as never, id);
    };
    opts.transport.onNotification = (method, params) => {
      void this.handleNotification(method, params as never);
    };
    // Incremental tool progress (mail_search batches) → ACP tool_call_update.
    // The final tool response still completes the tool call, so clients that
    // ignore updates keep working.
    opts.provider.onToolUpdate = (sessionId, toolCallId, update) => {
      this.emitToolUpdate(sessionId, toolCallId, update);
    };
  }

  /** Map one validated tool update onto a session/update notification. */
  private emitToolUpdate(sessionId: string, toolCallId: string, update: BrowserToolUpdateParams["update"]): void {
    if (!this.sessions.has(sessionId)) return;
    if (update.kind === "batch") {
      this.sendSessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: [{ type: "content", content: { type: "text", text: JSON.stringify(update.result) } }],
      });
    } else if (update.kind === "progress") {
      this.sendSessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: [{ type: "content", content: { type: "text", text: `mail_search: scanned ${update.scanned} messages so far…` } }],
      });
    }
    // "complete" emits nothing: the final tool response is the authoritative
    // close for ACP clients.
  }

  private transport(): AcpTransport {
    return this.opts.transport;
  }

  // ------------------------------------------------------------------
  // Wire handlers
  // ------------------------------------------------------------------

  private async handleRequest(method: string, params: unknown, id: number): Promise<void> {
    try {
      switch (method) {
        case AGENT_METHODS.initialize:
          this.transport().respond(id, this.initialize(params as InitializeRequest));
          return;
        case AGENT_METHODS.session_new:
          this.transport().respond(id, await this.sessionNew(params as NewSessionRequest));
          return;
        case AGENT_METHODS.session_list:
          this.transport().respond(id, await this.sessionList(params as ListSessionsRequest));
          return;
        case AGENT_METHODS.session_resume:
          this.transport().respond(id, await this.sessionResume(params as ResumeSessionRequest));
          return;
        case AGENT_METHODS.session_load:
          this.transport().respond(id, await this.sessionLoad(params as LoadSessionRequest));
          return;
        case AGENT_METHODS.session_prompt:
          this.transport().respond(id, await this.sessionPrompt(params as PromptRequest));
          return;
        case AGENT_METHODS.session_cancel:
          this.sessionCancel(params as CancelNotification);
          this.transport().respond(id, {});
          return;
        case AGENT_METHODS.session_close:
          this.sessionClose(params as CloseSessionRequest);
          this.transport().respond(id, {});
          return;
        case AGENT_METHODS.session_set_config_option:
          this.transport().respond(id, await this.sessionSetConfigOption(params as SetSessionConfigOptionRequest));
          return;
        case X_PI_BROWSER.permissions:
          this.transport().respond(id, this.opts.provider.permissionConfig());
          return;
        case X_PI_BROWSER.permission_set: {
          const p = params as { tool?: unknown; state?: unknown };
          const tool = typeof p.tool === "string" ? p.tool : "";
          const state =
            p.state === "allow" || p.state === "deny" || p.state === "ask" ? p.state : "ask";
          this.transport().respond(id, this.opts.provider.setToolPermission(tool, state));
          return;
        }
        case X_PI_BROWSER.permission_clear: {
          const p = params as { tool?: unknown } | undefined;
          const tool = p && typeof p.tool === "string" ? p.tool : undefined;
          this.transport().respond(id, this.opts.provider.clearToolPermissions(tool));
          return;
        }
        case X_PI_BROWSER.ping: {
          const backendReady = await this.opts.backend.ready.then(() => true, () => false);
          // Refresh the add-on heartbeat (no-op for non-add-on clients), so
          // /pi-browser status|doctor can report add-on presence.
          touchClientHeartbeat(this.clientIdentityName);
          this.transport().respond(id, { pong: true, meta: PI_BROWSER_META, backendReady });
          return;
        }
        default:
          this.transport().respondError(id, {
            code: JSONRPC_ERROR.METHOD_NOT_FOUND,
            message: `unknown method: ${method}`,
          });
      }
    } catch (err) {
      this.respondFailure(id, err);
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method === X_PI_BROWSER.notify) {
      this.opts.provider.handleNotify(params as import("@pi-browser/protocol").BrowserNotifyParams);
      return;
    }
    if (method === X_PI_BROWSER.tool_update) {
      // This agent's transport IS the registered client connection (one
      // agent per client), so source-client identity is structural here;
      // the provider validates session, call identity, tool, and sequence.
      this.opts.provider.handleToolUpdate(params as BrowserToolUpdateParams, this.opts.clientId);
      return;
    }
    // ACP notifications the agent does not use are ignored by design.
    this.opts.log.debug(`ignoring notification ${method}`);
  }

  private respondFailure(id: number, err: unknown): void {
    if (err instanceof PiBrowserProtocolError) {
      this.opts.log.warn(`request failed [${err.code}] ${err.message}`);
      this.transport().respondError(id, err.toErrorObject());
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.opts.log.error(`request failed: ${message}`, err);
    this.transport().respondError(id, toErrorObject(PI_BROWSER_ERROR.INTERNAL, message));
  }

  // ------------------------------------------------------------------
  // ACP methods
  // ------------------------------------------------------------------

  /**
   * Push x-pi-browser/capabilities_changed (the current union) to this
   * client. The broker calls this for every connected client when the
   * provider set changes, so UIs update their "capabilities:" line.
   */
  notifyCapabilitiesChanged(capabilities: AgentCapability[]): void {
    this.opts.transport.notify(X_PI_BROWSER.capabilities_changed, { capabilities });
  }

  private initialize(req: InitializeRequest) {
    if (req.protocolVersion !== PROTOCOL_VERSION) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH,
        `unsupported ACP protocol version: ${req.protocolVersion} (agent supports ${PROTOCOL_VERSION})`,
      );
    }
    const hello = parseAgentHello(req);
    this.clientApplication = hello?.client.application ?? "firefox";
    this.clientCapabilities = hello ? hello.capabilities : ["browser"];
    this.opts.log.info(
      `initialize: client=${req.clientInfo?.name ?? "?"} v${req.clientInfo?.version ?? "?"} ` +
        `application=${this.clientApplication} capabilities=[${this.clientCapabilities.join(",")}] ` +
        `proto=${req.protocolVersion}`,
    );
    // Register in the broker provider registry (plan §28): this client's
    // capabilities become routable to/from every session.
    if (this.opts.registry) {
      this.opts.registry.register({
        clientId: this.opts.clientId ?? "stdio",
        application: this.clientApplication,
        capabilities: this.clientCapabilities,
        transport: this.opts.transport,
      });
    }
    // Record add-on presence (no-op for non-add-on clients like test harnesses).
    this.clientIdentityName = req.clientInfo?.name;
    touchClientHeartbeat(req.clientInfo?.name, req.clientInfo?.version, this.clientApplication);
    const piAgentMeta: PiAgentMeta = {
      ...PI_AGENT_META,
      application: this.clientApplication,
      capabilities: this.clientCapabilities,
      // Session tool surface (plan §29): the union of every connected
      // client, so the add-on UI can show peer-app capabilities (e.g.
      // browsing from the mail client). Without a registry (standalone
      // single-app mode) the union is just this client's own caps.
      connectedCapabilities: this.opts.registry
        ? this.opts.registry.allCapabilities()
        : this.clientCapabilities,
    };
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
        mcpCapabilities: { acp: true },
      },
      agentInfo: this.opts.agentInfo,
      _meta: { piBrowser: PI_BROWSER_META, piAgent: piAgentMeta },
    };
  }

  private async sessionNew(req: NewSessionRequest) {
    // A session with no meaningful requested cwd (the add-on's empty-field
    // fallback is "/") gets a fresh per-task workspace as its cwd, so the
    // model's file tools and the REPL share one task-scoped scratch.
    const cwd = isNeutralCwd(req.cwd) ? await this.workspaces.create() : req.cwd;
    const { state } = await this.openBackendSession(
      (tools) => this.opts.backend.createSession({ cwd, customTools: tools }),
      req.mcpServers,
    );
    this.opts.log.info(`session/new -> ${state.id} cwd=${state.cwd}`);
    return {
      sessionId: state.id,
      configOptions: state.configOptions,
      _meta: { piBrowser: { workspace: state.cwd } },
    };
  }

  private async sessionResume(req: ResumeSessionRequest) {
    const { state } = await this.openBackendSession(
      // Resumed sessions must keep the browser/`javascript` tool surface
      // (same as sessionNew) — dropping customTools here silently removes
      // every provider tool from the model's tool list on resume.
      (tools) =>
        this.opts.backend.openSession({ sessionId: req.sessionId, customTools: tools }),
      req.mcpServers,
      req.cwd,
    );
    this.opts.log.info(`session/resume -> ${state.id}`);
    return { configOptions: state.configOptions };
  }

  private async sessionLoad(req: LoadSessionRequest) {
    const existing = this.sessions.get(req.sessionId);
    if (existing) {
      for (const update of await this.replayHistory(existing)) this.sendSessionUpdate(existing.id, update);
      this.opts.log.info(`session/load -> ${existing.id} (already open; replayed history)`);
      return { configOptions: existing.configOptions };
    }
    const { state } = await this.openBackendSession(
      // Loaded sessions must keep the browser/`javascript` tool surface
      // (same as sessionNew) — see sessionResume.
      (tools) =>
        this.opts.backend.openSession({ sessionId: req.sessionId, customTools: tools }),
      req.mcpServers,
      req.cwd,
    );
    // Replay history as session/update notifications (ACP session/load).
    for (const update of await this.replayHistory(state)) {
      this.sendSessionUpdate(state.id, update);
    }
    this.opts.log.info(`session/load -> ${state.id}`);
    return { configOptions: state.configOptions };
  }

  private async sessionList(req: ListSessionsRequest) {
    const sessions = await this.opts.backend.listSessions(req.cwd ?? undefined);
    return {
      sessions: sessions.map(toSessionInfo),
      nextCursor: null,
    };
  }

  private async sessionPrompt(req: PromptRequest) {
    const st = this.sessions.get(req.sessionId);
    if (!st) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `unknown session: ${req.sessionId}`);
    if (st.session.isStreaming) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, `session ${req.sessionId} is busy`);
    }
    const { text, images } = extractPromptContent(req.prompt);
    if (!text && images.length === 0) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "empty prompt");
    }
    this.opts.log.info(`session/prompt ${req.sessionId} (${text.length} chars, ${images.length} images)`);
    this.opts.log.debug(`session/prompt ${req.sessionId} text=${JSON.stringify(text)}`);
    const result = await st.session.prompt(text, images.length > 0 ? images : undefined);
    return { stopReason: result.aborted ? ("cancelled" as const) : ("end_turn" as const) };
  }

  private sessionCancel(req: CancelNotification): void {
    const st = this.sessions.get(req.sessionId);
    if (!st) {
      this.opts.log.warn(`cancel for unknown session ${req.sessionId}`);
      return;
    }
    this.opts.log.info(`session/cancel ${req.sessionId}`);
    void st.session.abort();
  }

  private sessionClose(req: CloseSessionRequest): void {
    this.disposeSession(req.sessionId);
    this.opts.log.info(`session/close ${req.sessionId}`);
  }

  private async sessionSetConfigOption(req: SetSessionConfigOptionRequest) {
    const st = this.sessions.get(req.sessionId);
    if (!st) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `unknown session: ${req.sessionId}`);

    const value = req.value as string | boolean;
    if (req.configId === CONFIG_ID_MODEL) {
      if (typeof value !== "string" || !value) {
        throw new PiBrowserProtocolError("INTERNAL", "model option requires a non-empty value id");
      }
      await st.session.setModel(value);
    } else if (req.configId === CONFIG_ID_THINKING) {
      if (typeof value !== "string") {
        throw new PiBrowserProtocolError("INTERNAL", "thinking option requires a string value");
      }
      st.session.setThinkingLevel(value);
    } else {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.ACP_CAPABILITY_UNSUPPORTED, `unknown config option: ${req.configId}`);
    }

    st.configOptions = await this.currentConfigOptions(st);
    return { configOptions: st.configOptions };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Open a backend session and register all ACP-side state. Browser tools
   * are created with a lazily-bound session id because the backend assigns
   * the Pi session id at creation time.
   */
  private async openBackendSession(
    open: (customTools: ToolSpec[]) => Promise<BackendSession>,
    mcpServers: McpServer[] | undefined,
    explicitCwd?: string,
  ): Promise<{ session: BackendSession; state: SessionState }> {
    const browserMode = this.opts.provider.selectMode(mcpServers);
    const mcpServer = mcpServers?.find((s) => (s as { type?: string }).type === "acp") as
      | { serverId?: string }
      | undefined;
    const mcpServerId = mcpServer?.serverId;

    // Tools bind to the session id at execute time (id assigned below).
    const idRef: { id?: string } = {};
    // Register the tool surface the client advertised in its hello
    // (plan §19): "browser" → browser tools, "mail"/"attachments" → the
    // read-only mail tools. Legacy clients (no hello) default to browser.
    // In broker mode (registry present) the surface is instead the union of
    // ALL connected clients' capabilities (plan §29) and each call is
    // routed to the client that provides the tool.
    const tools = this.opts.provider.createTools(
      idRef,
      browserMode,
      mcpServerId,
      this.clientCapabilities,
      this.opts.registry ? (this.opts.clientId ?? "stdio") : undefined,
      this.clientApplication,
    );
    const session = await open(tools);
    idRef.id = session.sessionId;

    if (this.sessions.has(session.sessionId)) {
      session.dispose();
      this.opts.provider.disposeSession(session.sessionId);
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, `session ${session.sessionId} is already open`);
    }

    let state: SessionState = {
      id: session.sessionId,
      cwd: explicitCwd ?? session.cwd,
      session,
      unsubscribe: () => undefined,
      configOptions: [],
      browserMode,
      ...(mcpServerId ? { mcpServerId } : {}),
    };

    // The session cwd is the task's scratch: point the `javascript` REPL at it
    // so cell artifacts, checkpoints and images land with the files the model
    // writes. The REPL falls back to its own per-session dir if unbound.
    this.opts.provider.bindWorkspace(session.sessionId, state.cwd);

    // Stream backend events to the client as session/update notifications.
    state.unsubscribe = session.subscribe((event) => {
      for (const update of this.mapEvent(state.id, event)) {
        this.sendSessionUpdate(state.id, update);
      }
    });

    const models = await this.opts.backend.listModels().catch(() => [] as ModelOption[]);
    state.configOptions = buildConfigOptions({
      models,
      currentModel: session.modelValueId,
      currentThinking: session.thinkingLevel,
    });

    this.sessions.set(session.sessionId, state);
    return { session, state };
  }

  private async currentConfigOptions(st: SessionState): Promise<SessionConfigOption[]> {
    const models = await this.opts.backend.listModels().catch(() => [] as ModelOption[]);
    return buildConfigOptions({
      models,
      currentModel: st.session.modelValueId,
      currentThinking: st.session.thinkingLevel,
    });
  }

  private sendSessionUpdate(sessionId: string, update: SessionUpdate): void {
    const notification: SessionNotification = { sessionId, update };
    this.opts.transport.notify(CLIENT_METHODS.session_update, notification);
  }

  private mapEvent(sessionId: string, event: BackendEvent): SessionUpdate[] {
    // Debug-only evidence: omit image payloads and keep normal logs content-free.
    if (event.type === "tool_start") {
      this.opts.log.debug(`session/tool_start ${sessionId} ${event.toolName} ${JSON.stringify(event.args)}`);
    } else if (event.type === "tool_end") {
      this.opts.log.debug(`session/tool_end ${sessionId} ${event.toolName} isError=${event.isError} ${JSON.stringify(event.result, (key, value) => key === "data" ? "[omitted]" : value)}`);
    }
    switch (event.type) {
      case "text_delta":
        return [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.delta },
          },
        ];
      case "thinking_delta":
        return [
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.delta },
          },
        ];
      case "tool_start":
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId: event.toolCallId,
            title: event.toolName,
            kind: toolKindFor(event.toolName),
            status: "in_progress",
            rawInput: event.args ?? {},
          },
        ];
      case "tool_update": {
        const updates: SessionUpdate[] = [];
        const partial = event.partial as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const text = partial?.content
          ?.filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("");
        if (text) {
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            content: [{ type: "content", content: { type: "text", text } }],
          });
        }
        return updates;
      }
      case "tool_end":
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: event.isError ? "failed" : "completed",
            content: toToolCallContent(event.result),
            rawOutput: event.result,
          },
        ];
      default:
        return [];
    }
  }

  private async replayHistory(st: SessionState): Promise<SessionUpdate[]> {
    const messages = await st.session.getHistory?.().catch(() => []);
    if (!messages) return [];
    const updates: SessionUpdate[] = [];
    for (const msg of messages as BackendHistoryEntry[]) {
      if (msg.role === "user" || msg.role === "assistant") {
        if (msg.text) updates.push(msg.role === "user"
          ? { sessionUpdate: "user_message_chunk", content: { type: "text", text: msg.text } }
          : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: msg.text } });
        for (const call of msg.toolCalls ?? []) {
          updates.push({ sessionUpdate: "tool_call", toolCallId: call.toolCallId, title: call.toolName, kind: toolKindFor(call.toolName), status: "in_progress", rawInput: call.input ?? {} });
        }
      } else if (msg.role === "tool") {
        updates.push({ sessionUpdate: "tool_call_update", toolCallId: msg.toolCallId, status: msg.isError ? "failed" : "completed", content: toToolCallContent(msg), rawOutput: msg.content });
      }
    }
    return updates;
  }

  disposeSession(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    st.unsubscribe();
    this.sessions.delete(sessionId);
    this.opts.provider.disposeSession(sessionId);
    st.session.dispose();
  }

  /** Tear down every session (host shutdown). */
  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.disposeSession(id);
  }
}

function toSessionInfo(s: ListedSession): SessionInfo {
  return {
    sessionId: s.sessionId,
    cwd: s.cwd,
    updatedAt: s.updatedAt,
    title: s.title ?? null,
  };
}

/** Split ACP prompt content blocks into text and image attachments. */
export function extractPromptContent(prompt: ContentBlock[]): { text: string; images: ImageAttachment[] } {
  const texts: string[] = [];
  const images: ImageAttachment[] = [];
  for (const block of prompt) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "image") {
      const img = block as AcpImageContent;
      images.push({ data: img.data, mimeType: img.mimeType });
    }
    // resource/resource_link blocks: accepted but not forwarded (MVP).
  }
  return { text: texts.join("\n"), images };
}
