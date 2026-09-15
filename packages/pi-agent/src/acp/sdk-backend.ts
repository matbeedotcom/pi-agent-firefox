/**
 * Production Pi backend: Pi SDK agent sessions in-process
 * (PRODUCT.md §6 "Preferred long-term implementation").
 *
 * Each ACP session maps to one independent Pi `AgentSession` with its own
 * SessionManager (persistence, cwd, model state). The ACP boundary never
 * exposes the SDK directly.
 *
 * Sessions are created through the SDK's *services* layer
 * (`createAgentSessionServices` + `createAgentSessionFromServices`) so that
 * the resource loader runs exactly as it does in the pi CLI: built-in
 * extensions (the llama.cpp provider) and user-installed packages from
 * settings are loaded, and provider credentials resolve. A raw
 * `createAgentSession()` skips that layer and leaves providers unregistered.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

/** The concrete Model type as returned by ModelRuntime.getModel. */
export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** One entry of the pi package's built-in extension factory list. */
interface BuiltinExtensionFactory {
  name: string;
  factory: (pi: unknown) => void | Promise<void>;
  hidden?: boolean;
}

/**
 * Load the pi package's built-in extension factories (e.g. the llama.cpp
 * provider). The package's exports map only exposes the root entry, so the
 * dist/extensions module is imported by resolved file path.
 */
async function loadBuiltinExtensionFactories(log: Logger): Promise<BuiltinExtensionFactory[]> {
  try {
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distDir = path.dirname(fileURLToPath(mainUrl));
    const mod = (await import(path.join(distDir, "extensions", "index.js"))) as {
      builtInExtensions?: BuiltinExtensionFactory[];
    };
    return mod.builtInExtensions ?? [];
  } catch (err) {
    log.warn("failed to load built-in pi extensions (providers may be unavailable)", err);
    return [];
  }
}
import type {
  BackendEvent,
  BackendHistoryEntry,
  BackendHistoryToolCall,
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
  /** One coherent services bundle per effective session cwd (cached). */
  private servicesByCwd = new Map<string, AgentSessionServices>();
  /** Serializes resource reloads per services bundle (concurrent spawns, same cwd). */
  private reloadChains = new Map<AgentSessionServices, Promise<void>>();
  private builtinFactories: BuiltinExtensionFactory[] | undefined;
  private builtinFactoriesPromise: Promise<BuiltinExtensionFactory[]> | undefined;
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

  private builtinFactoriesOnce(): Promise<BuiltinExtensionFactory[]> {
    this.builtinFactoriesPromise ??= loadBuiltinExtensionFactories(this.opts.log).then((f) => {
      this.builtinFactories = f;
      return f;
    });
    return this.builtinFactoriesPromise;
  }

  /**
   * Get (creating on first use) the cwd-bound services for a session cwd.
   * The shared ModelRuntime lets extension-registered providers (llama.cpp
   * etc.) become visible to every session without re-loading the catalog.
   */
  private async servicesFor(cwd: string): Promise<AgentSessionServices> {
    const modelRuntime = await this.runtime();
    const existing = this.servicesByCwd.get(cwd);
    if (existing) return existing;
    const extensionFactories = await this.builtinFactoriesOnce();
    const services = await createAgentSessionServices({
      cwd,
      modelRuntime,
      ...(this.opts.agentDir ? { agentDir: this.opts.agentDir } : {}),
      resourceLoaderOptions: { extensionFactories: extensionFactories as never },
    });
    // Extension providers (e.g. llama.cpp) are registered during services
    // creation, but their model lists populate via an async refresh phase.
    // Settle the runtime before any session is spawned against it, so model
    // resolution (default model, session restore) sees the full catalog.
    try {
      await Promise.race([
        modelRuntime.getAvailable(),
        new Promise((resolve) => setTimeout(resolve, 15_000).unref?.()),
      ]);
    } catch (err) {
      this.opts.log.warn("model availability refresh failed", err);
    }
    this.servicesByCwd.set(cwd, services);
    this.opts.log.info(`session services ready for cwd=${cwd}`);
    return services;
  }

  async createSession(opts: CreateSessionOptions): Promise<BackendSession> {
    const sessionManager = SessionManager.create(opts.cwd);
    const session = await this.spawnSession({
      cwd: opts.cwd,
      sessionManager,
      customTools: opts.customTools,
      modelValueId: opts.modelValueId,
      thinkingLevel: opts.thinkingLevel,
      // Fresh session: a full resource re-scan is safe (nothing to inherit),
      // so a SKILL.md added since this cwd's services bundle was cached is
      // picked up without a host restart.
      refresh: true,
    });
    this.opts.log.info(`created session ${session.sessionId} cwd=${opts.cwd}`);
    return session;
  }

  async openSession(opts: OpenSessionOptions): Promise<BackendSession> {
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
    customTools?: ToolSpec[];
    modelValueId?: string;
    thinkingLevel?: string;
    /** Re-scan resources before spawning (create only; see refreshResources). */
    refresh?: boolean;
  }): Promise<BackendSession> {
    const { cwd, sessionManager, customTools, modelValueId, thinkingLevel, refresh } = args;
    const services = await this.servicesFor(cwd);
    if (refresh) await this.refreshResources(services);
    const options: Record<string, unknown> = { services, sessionManager };
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
      const created = await createAgentSessionFromServices(options as never);
      agentSession = created.session;
    } catch (err) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.PI_START_FAILED,
        `failed to start Pi session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const m = (agentSession as { model?: { provider?: string; id?: string } }).model;
    if (!m || m.provider === "unknown") {
      this.opts.log.warn(
        `session ${agentSession.sessionId}: no model resolved ` +
          "(provider not configured?) — prompts will fail until a model is selected",
      );
    }
    this.opts.log.info(`session ${agentSession.sessionId}: model=${m?.provider}/${m?.id}`);
    return this.wrapSession(agentSession, cwd);
  }

  /**
   * Re-scan resources (skills, prompt templates, themes, project files) before
   * a NEW session is spawned, so a SKILL.md the user added (or edited) since
   * this cwd's services bundle was cached is visible in the session's system
   * prompt — without restarting the host process. The system prompt reads
   * resourceLoader.getSkills() at session construction, so the reload must
   * happen here, not at servicesFor() time. Only createSession() does this:
   * resumed/loaded sessions keep the resource set they started with, so past
   * turns replay deterministically and resume stays cheap. Best-effort: on
   * failure the loader keeps its previous resource set and the session starts.
   * Reloads are chained per services bundle so concurrent spawns for the same
   * cwd never interleave a reload with another's.
   */
  private refreshResources(services: AgentSessionServices): Promise<void> {
    const prev = this.reloadChains.get(services) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        const before = services.resourceLoader.getSkills().skills.length;
        await services.resourceLoader.reload();
        const after = services.resourceLoader.getSkills().skills.length;
        if (after !== before) {
          this.opts.log.info(`resources refreshed for cwd=${services.cwd}: skills ${before} -> ${after}`);
        }
      } catch (err) {
        this.opts.log.warn(`resource reload failed for cwd=${services.cwd} (keeping previous resource set)`, err);
      }
    });
    this.reloadChains.set(services, next);
    return next;
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
        const out: BackendHistoryEntry[] = [];
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
            const content = msg.content as Array<{ type?: string; text?: string; id?: string; name?: string; arguments?: unknown; input?: unknown }> | undefined;
            const text = Array.isArray(content)
              ? content
                  .filter((c) => c?.type === "text" && typeof c.text === "string")
                  .map((c) => c.text as string)
                  .join("")
              : "";
            const toolCalls: BackendHistoryToolCall[] = Array.isArray(content)
              ? content
                  .filter((c) => (c?.type === "toolCall" || c?.type === "tool_call") && typeof c.id === "string" && typeof c.name === "string")
                  .map((c) => ({ toolCallId: c.id as string, toolName: c.name as string, input: c.arguments ?? c.input }))
              : [];
            if (text || toolCalls.length) out.push({ role: "assistant", ...(text ? { text } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
          } else if (role === "toolResult" || role === "tool") {
            const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : typeof msg.id === "string" ? msg.id : "";
            if (toolCallId) out.push({ role: "tool", toolCallId, toolName: typeof msg.toolName === "string" ? msg.toolName : undefined, content: msg.content, isError: msg.isError === true });
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
