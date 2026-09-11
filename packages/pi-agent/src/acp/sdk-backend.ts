/**
 * Production Pi backend: Pi SDK `createAgentSession()` in-process
 * (PRODUCT.md §6 "Preferred long-term implementation").
 *
 * Each ACP session maps to one independent Pi `AgentSession` with its own
 * SessionManager (persistence, cwd, model state). The ACP boundary never
 * exposes the SDK directly.
 */
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

/** The concrete Model type as returned by ModelRuntime.getModel. */
export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
import type {
  BackendEvent,
  BackendPromptResult,
  BackendSession,
  BackendToolResult,
  CreateSessionOptions,
  ImageAttachment,
  ListedSession,
  ModelOption,
  OpenSessionOptions,
  PiBackend,
  ToolSpec,
} from "./backend.js";
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import type { Logger } from "../logger.js";

interface PiBackendOptions {
  log: Logger;
  /** Override Pi's agent dir (tests); defaults to getAgentDir() semantics. */
  agentDir?: string;
  /** Override model runtime paths (tests). */
  authPath?: string;
  modelsPath?: string;
}

export class PiSdkBackend implements PiBackend {
  private modelRuntime: ModelRuntime | undefined;
  private runtimePromise: Promise<void>;
  private sessions = new Set<BackendSession>();
  readonly thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

  constructor(private readonly opts: PiBackendOptions) {
    this.runtimePromise = this.initRuntime().catch((err) => {
      opts.log.error("failed to initialize model runtime", err);
      throw err;
    });
  }

  get ready(): Promise<void> {
    return this.runtimePromise;
  }

  private async initRuntime(): Promise<void> {
    if (this.modelRuntime) return;
    this.modelRuntime = await ModelRuntime.create({
      ...(this.opts.authPath ? { authPath: this.opts.authPath } : {}),
      ...(this.opts.modelsPath ? { modelsPath: this.opts.modelsPath } : {}),
    });
    this.opts.log.info("model runtime ready");
  }

  private async runtime(): Promise<ModelRuntime> {
    await this.initRuntime();
    return this.modelRuntime as ModelRuntime;
  }

  private settingsManager(): SettingsManager {
    return SettingsManager.inMemory({});
  }

  async createSession(opts: CreateSessionOptions): Promise<BackendSession> {
    const modelRuntime = await this.runtime();
    const sessionManager = SessionManager.create(opts.cwd);
    const session = await this.spawnSession({
      cwd: opts.cwd,
      sessionManager,
      modelRuntime,
      customTools: opts.customTools,
      modelValueId: opts.modelValueId,
      thinkingLevel: opts.thinkingLevel,
    });
    this.opts.log.info(`created session ${session.sessionId} cwd=${opts.cwd}`);
    return session;
  }

  async openSession(opts: OpenSessionOptions): Promise<BackendSession> {
    const modelRuntime = await this.runtime();
    const info = (await SessionManager.listAll()).find((s) => s.id === opts.sessionId);
    if (!info) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.SESSION_NOT_FOUND,
        `Pi session not found: ${opts.sessionId}`,
      );
    }
    const sessionManager = SessionManager.open(info.path);
    const session = await this.spawnSession({
      cwd: info.cwd || process.cwd(),
      sessionManager,
      modelRuntime,
      customTools: opts.customTools,
      modelValueId: undefined, // restored from the session file
      thinkingLevel: undefined,
    });
    this.opts.log.info(`opened session ${session.sessionId} from ${info.path}`);
    return session;
  }

  private async spawnSession(args: {
    cwd: string;
    sessionManager: ReturnType<typeof SessionManager.create>;
    modelRuntime: ModelRuntime;
    customTools?: ToolSpec[];
    modelValueId?: string;
    thinkingLevel?: string;
  }): Promise<BackendSession> {
    const { cwd, sessionManager, modelRuntime, customTools, modelValueId, thinkingLevel } = args;
    const options: Record<string, unknown> = {
      cwd,
      sessionManager,
      modelRuntime,
      settingsManager: this.settingsManager(),
    };
    if (this.opts.agentDir) options.agentDir = this.opts.agentDir;
    if (modelValueId) {
      const model = this.resolveModel(modelValueId);
      if (model) options.model = model;
    }
    if (thinkingLevel) options.thinkingLevel = thinkingLevel;
    if (customTools && customTools.length > 0) {
      options.customTools = customTools.map((t) => this.toPiTool(t));
    }

    let agentSession: AgentSession;
    try {
      const created = await createAgentSession(options as never);
      agentSession = created.session;
      if (created.modelFallbackMessage) {
        this.opts.log.warn(`session ${agentSession.sessionId}: ${created.modelFallbackMessage}`);
      }
    } catch (err) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.PI_START_FAILED,
        `failed to start Pi session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.wrapSession(agentSession, cwd);
  }

  private resolveModel(valueId: string): PiModel | undefined {
    const rt = this.modelRuntime;
    if (!rt) return undefined;
    const slash = valueId.indexOf("/");
    if (slash <= 0) return undefined;
    const provider = valueId.slice(0, slash);
    const modelId = valueId.slice(slash + 1);
    return rt.getModel(provider, modelId);
  }

  private toPiTool(spec: ToolSpec) {
    return defineTool({
      name: spec.name,
      label: spec.label ?? spec.name,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (toolCallId, params, signal) => {
        const result: BackendToolResult = await spec.execute(toolCallId, params as Record<string, unknown>, signal);
        return { content: result.content, details: result.details };
      },
    });
  }

  private wrapSession(agentSession: AgentSession, cwd: string): BackendSession {
    let abortRequested = false;
    const session: BackendSession = {
      get sessionId() {
        return agentSession.sessionId;
      },
      get cwd() {
        return cwd;
      },
      get isStreaming() {
        return agentSession.isStreaming;
      },
      get modelValueId() {
        const m = agentSession.model;
        return m ? `${m.provider}/${m.id}` : undefined;
      },
      get thinkingLevel() {
        return agentSession.thinkingLevel;
      },
      prompt: async (text, images): Promise<BackendPromptResult> => {
        abortRequested = false;
        const opts = images && images.length > 0
          ? { images: images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, mediaType: i.mimeType, data: i.data } })) }
          : undefined;
        try {
          await agentSession.prompt(text, opts as never);
        } catch (err) {
          // A prompt that is rejected outright (not an aborted turn) is a
          // protocol-level failure the client should see.
          throw new PiBrowserProtocolError(
            PI_BROWSER_ERROR.INTERNAL,
            `prompt failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return { aborted: abortRequested };
      },
      abort: async () => {
        abortRequested = true;
        try {
          await agentSession.abort();
        } catch (err) {
          this.opts.log.warn("abort failed", err);
        }
      },
      setModel: async (valueId) => {
        const model = this.resolveModel(valueId);
        if (!model) {
          throw new PiBrowserProtocolError(
            PI_BROWSER_ERROR.ACP_CAPABILITY_UNSUPPORTED,
            `unknown model: ${valueId}`,
          );
        }
        await agentSession.setModel(model);
      },
      setThinkingLevel: (level) => {
        agentSession.setThinkingLevel(level as never);
      },
      subscribe: (listener) => {
        return agentSession.subscribe((event) => {
          for (const mapped of mapBackendEvent(event)) listener(mapped);
        });
      },
      getHistory: async () => {
        const out: Array<{ role: "user" | "assistant"; text: string }> = [];
        for (const msg of agentSession.messages as unknown as Array<Record<string, unknown>>) {
          const role = msg.role as string | undefined;
          if (role === "user") {
            const content = msg.content;
            const text =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? (content as Array<{ type?: string; text?: string }>)
                      .filter((c) => c?.type === "text" && typeof c.text === "string")
                      .map((c) => c.text as string)
                      .join("")
                  : "";
            if (text) out.push({ role: "user", text });
          } else if (role === "assistant") {
            const content = msg.content as Array<{ type?: string; text?: string }> | undefined;
            const text = Array.isArray(content)
              ? content
                  .filter((c) => c?.type === "text" && typeof c.text === "string")
                  .map((c) => c.text as string)
                  .join("")
              : "";
            if (text) out.push({ role: "assistant", text });
          }
        }
        return out;
      },
      dispose: () => {
        this.sessions.delete(session);
        try {
          agentSession.dispose();
        } catch (err) {
          this.opts.log.warn("session dispose failed", err);
        }
      },
    };
    this.sessions.add(session);
    return session;
  }

  async listSessions(cwd?: string): Promise<ListedSession[]> {
    await this.initRuntime();
    const all = await SessionManager.listAll();
    const filtered = cwd ? all.filter((s) => s.cwd === cwd) : all;
    return filtered
      .map((s) => ({
        sessionId: s.id,
        cwd: s.cwd,
        updatedAt: s.modified.toISOString(),
        title: s.name || (s.firstMessage ? s.firstMessage.slice(0, 80) : undefined),
        messageCount: s.messageCount,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async listModels(): Promise<ModelOption[]> {
    const rt = await this.runtime();
    const models = await rt.getAvailable();
    return models.map((m) => ({
      valueId: `${m.provider}/${m.id}`,
      name: m.name ?? m.id,
    }));
  }

  dispose(): void {
    for (const s of [...this.sessions]) s.dispose();
    this.sessions.clear();
  }
}

/**
 * Map Pi `AgentSessionEvent`s to normalized `BackendEvent`s.
 * Returns an empty array for events with no ACP counterpart.
 */
export function mapBackendEvent(event: unknown): BackendEvent[] {
  const ev = event as {
    type?: string;
    assistantMessageEvent?: { type?: string; delta?: string };
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    partialResult?: unknown;
    result?: unknown;
    isError?: boolean;
  };
  switch (ev.type) {
    case "message_update": {
      const inner = ev.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        return [{ type: "text_delta", delta: inner.delta }];
      }
      if (inner?.type === "thinking_delta" && typeof inner.delta === "string") {
        return [{ type: "thinking_delta", delta: inner.delta }];
      }
      return [];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool_start",
          toolCallId: ev.toolCallId ?? "",
          toolName: ev.toolName ?? "tool",
          args: ev.args ?? {},
        },
      ];
    case "tool_execution_update":
      return [
        {
          type: "tool_update",
          toolCallId: ev.toolCallId ?? "",
          toolName: ev.toolName ?? "tool",
          partial: ev.partialResult,
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_end",
          toolCallId: ev.toolCallId ?? "",
          toolName: ev.toolName ?? "tool",
          result: ev.result,
          isError: ev.isError === true,
        },
      ];
    default:
      return [];
  }
}
