/**
 * A sidebar session running on an external ACP agent (openspec
 * sidebar-acp-agents D3, D4, D7).
 *
 * The relay forwards ACP both ways and leaves the content alone:
 * - prompts, cancel and close go to the agent;
 * - the agent's `session/update` notifications go to the client that owns
 *   the session, as they are (the session id is the agent's own, D5);
 * - the agent's `session/request_permission` goes to the owner's prompt UI,
 *   labelled with the agent, with the add-on's prompt timeout; cancel and
 *   disconnect answer it `cancelled`.
 *
 * When the agent process stopped (idle stop, D2a, or a crash, D8) the
 * session is *dormant*: it stays open for the add-on, and the next prompt or
 * setting change starts the agent again and reloads the session with its
 * replay suppressed (the sidebar already shows the history).
 */
import {
  CLIENT_METHODS,
  PERMISSION_WITHDRAWN_METHOD,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  type AcpTransportLike,
  type ContentBlock,
  type PermissionWithdrawnParams,
  type SessionConfigOption,
  type SessionUpdate,
} from "@pi-browser/protocol";
import { TransportTimeoutError } from "../../native-host/transport.js";
import type { Logger } from "../../logger.js";
import { AgentRpcError, AgentStoppedError, type AgentConnection } from "./connection.js";

/** Who owns the session in the add-on: its transport and broker client id. */
export interface RelayOwner {
  transport: AcpTransportLike;
  clientId?: string;
}

/** What the relay needs from the manager. */
export interface RelayHost {
  readonly log: Logger;
  /** The agent's live connection, started (and initialized) if needed. */
  connection(agentId: string): Promise<AgentConnection>;
  /** The live connection, if the agent is running. */
  liveConnection(agentId: string): AgentConnection | undefined;
  /** The `mcpServers` to pass the agent for this session (the pi-browser bridge). */
  mcpServers(session: AcpRelaySession): unknown[];
  /** Prompt timeout of the add-on's permission UI. */
  permissionTimeoutMs(): number;
  /**
   * Refresh the index entry: after a turn, on a title from the agent, or
   * with the first prompt (used as the title until the agent names it).
   */
  touchIndex(session: AcpRelaySession, title?: string, firstPrompt?: string): void;
  /** Map an agent error to a readable protocol error. */
  describeError(agentId: string, err: unknown, action: string): PiBrowserProtocolError;
  /** The session went away (closed or owner disconnected). */
  forget(session: AcpRelaySession): void;
}

interface WaitingPermission {
  toolCallId: string;
  settle: (result: unknown) => void;
}

/** Updates kept for re-sending history when the add-on loads an open session. */
const MAX_TRANSCRIPT = 5_000;

type SelectOption = { value: string; name: string; description?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Settings the agent reported, as the config options the add-on renders:
 * `configOptions` when present, otherwise its models and modes (D4).
 */
export function settingsFromSessionResult(result: unknown): {
  configOptions: SessionConfigOption[];
  native: boolean;
} {
  const r = isRecord(result) ? result : {};
  if (Array.isArray(r.configOptions)) {
    return { configOptions: r.configOptions as SessionConfigOption[], native: true };
  }
  const options: SessionConfigOption[] = [];
  const models = isRecord(r.models) ? r.models : undefined;
  if (models && Array.isArray(models.availableModels) && models.availableModels.length) {
    const opts: SelectOption[] = [];
    for (const m of models.availableModels) {
      if (isRecord(m) && typeof m.modelId === "string") {
        opts.push({ value: m.modelId, name: typeof m.name === "string" ? m.name : m.modelId });
      }
    }
    options.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: typeof models.currentModelId === "string" ? models.currentModelId : (opts[0]?.value ?? ""),
      options: opts,
    } as SessionConfigOption);
  }
  const modes = isRecord(r.modes) ? r.modes : undefined;
  if (modes && Array.isArray(modes.availableModes) && modes.availableModes.length) {
    const opts: SelectOption[] = [];
    for (const m of modes.availableModes) {
      if (isRecord(m) && typeof m.id === "string") {
        opts.push({ value: m.id, name: typeof m.name === "string" ? m.name : m.id });
      }
    }
    options.push({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: typeof modes.currentModeId === "string" ? modes.currentModeId : (opts[0]?.value ?? ""),
      options: opts,
    } as SessionConfigOption);
  }
  return { configOptions: options, native: false };
}

export class AcpRelaySession {
  configOptions: SessionConfigOption[] = [];
  /** The agent reports `configOptions` (else models/modes are mapped). */
  nativeConfig = false;
  /** The agent process stopped; the next request restarts and reloads. */
  dormant = false;
  streaming = false;
  /** Token the bridge reports as its parent session (PI_BROWSER_PARENT_SESSION). */
  readonly parentToken: string;
  private suppressReplay = false;
  private readonly transcript: SessionUpdate[] = [];
  private readonly waiting = new Set<WaitingPermission>();
  private releaseTurn: (() => void) | undefined;
  private startSeq = 0;
  private closed = false;

  constructor(
    private readonly host: RelayHost,
    readonly id: string,
    readonly agentId: string,
    readonly agentName: string,
    readonly cwd: string,
    public owner: RelayOwner,
    parentToken: string,
  ) {
    this.parentToken = parentToken;
  }

  /** Apply a session/new|load|resume result (settings). */
  applySessionResult(result: unknown): void {
    const s = settingsFromSessionResult(result);
    this.configOptions = s.configOptions;
    this.nativeConfig = s.native;
  }

  // ------------------------------------------------------------------
  // Agent → add-on
  // ------------------------------------------------------------------

  handleUpdate(update: SessionUpdate): void {
    if (this.suppressReplay) return;
    const u = update as SessionUpdate & Record<string, unknown>;
    // Keep the settings in step with what the agent reports.
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
      this.configOptions = u.configOptions as SessionConfigOption[];
      this.nativeConfig = true;
    } else if (u.sessionUpdate === "current_mode_update" && typeof u.currentModeId === "string") {
      this.setLocalValue("mode", u.currentModeId);
    } else if (u.sessionUpdate === "session_info_update" && typeof u.title === "string" && u.title.trim()) {
      this.host.touchIndex(this, u.title.trim());
    }
    this.record(update);
    this.send(update);
  }

  private record(update: SessionUpdate): void {
    const kind = (update as { sessionUpdate?: string }).sessionUpdate;
    // Only what rebuilds the transcript; settings/usage/commands are live state.
    if (kind === "available_commands_update" || kind === "usage_update" || kind === "session_info_update") return;
    this.transcript.push(update);
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
  }

  private send(update: SessionUpdate): void {
    try {
      this.owner.transport.notify(CLIENT_METHODS.session_update, { sessionId: this.id, update });
    } catch (err) {
      this.host.log.debug(`relay ${this.id}: update not delivered: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Re-send the transcript (the add-on loaded a session that is already open). */
  replayTranscript(): void {
    for (const update of this.transcript) this.send(update);
  }

  /** The agent asks permission: show it in the session's UI, return the choice. */
  async handlePermission(params: unknown): Promise<unknown> {
    const p = isRecord(params) ? params : {};
    const toolCall = isRecord(p.toolCall) ? p.toolCall : {};
    const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : `agent-perm-${Date.now()}`;
    const meta = isRecord(p._meta) ? p._meta : {};
    const piBrowser = isRecord(meta.piBrowser) ? meta.piBrowser : {};
    const request = {
      ...p,
      sessionId: this.id,
      _meta: { ...meta, piBrowser: { ...piBrowser, agent: { id: this.agentId, name: this.agentName } } },
    };
    const release = this.host.liveConnection(this.agentId)?.hold();
    let settle!: (result: unknown) => void;
    const local = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const entry: WaitingPermission = { toolCallId, settle };
    this.waiting.add(entry);
    const timeoutMs = this.host.permissionTimeoutMs();
    this.host.log.info(`relay ${this.id}: ${this.agentName} asks permission (${String(toolCall.title ?? toolCallId)})`);
    const remote = this.owner.transport
      .request(CLIENT_METHODS.session_request_permission, request, timeoutMs)
      .then(
        (res) => res,
        (err: unknown) => {
          if (err instanceof TransportTimeoutError) {
            this.host.log.info(`relay ${this.id}: permission prompt timed out after ${Math.round(timeoutMs / 1000)} s`);
            this.withdraw(toolCallId, "timeout");
          } else {
            this.host.log.debug(`relay ${this.id}: permission prompt failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
          }
          return { outcome: { outcome: "cancelled" } };
        },
      );
    try {
      return await Promise.race([remote, local]);
    } finally {
      this.waiting.delete(entry);
      release?.();
    }
  }

  private withdraw(toolCallId: string, reason: PermissionWithdrawnParams["reason"]): void {
    try {
      const params: PermissionWithdrawnParams = { sessionId: this.id, toolCallId, reason };
      this.owner.transport.notify(PERMISSION_WITHDRAWN_METHOD, params);
    } catch {
      /* owner gone */
    }
  }

  /** Answer every waiting permission request `cancelled` and drop it from the UI. */
  private cancelWaiting(reason: PermissionWithdrawnParams["reason"]): void {
    for (const w of [...this.waiting]) {
      this.waiting.delete(w);
      this.withdraw(w.toolCallId, reason);
      w.settle({ outcome: { outcome: "cancelled" } });
    }
  }

  // ------------------------------------------------------------------
  // Add-on → agent
  // ------------------------------------------------------------------

  /** The live connection, restarting the agent and reloading the session if it stopped. */
  private async live(): Promise<AgentConnection> {
    const existing = this.host.liveConnection(this.agentId);
    if (existing && !this.dormant) return existing;
    const cardId = `pi-browser-agent-start-${++this.startSeq}`;
    this.send({ sessionUpdate: "tool_call", toolCallId: cardId, title: `Starting ${this.agentName}…`, kind: "other", status: "in_progress" } as SessionUpdate);
    try {
      const conn = await this.host.connection(this.agentId);
      if (!conn.init?.loadSession) {
        throw new PiBrowserProtocolError(
          PI_BROWSER_ERROR.SESSION_NOT_FOUND,
          `${this.agentName} stopped and can't reopen this session. Start a new session.`,
        );
      }
      this.suppressReplay = true;
      let result: unknown;
      try {
        result = await conn.request("session/load", { sessionId: this.id, cwd: this.cwd, mcpServers: this.host.mcpServers(this) });
      } finally {
        this.suppressReplay = false;
      }
      // Keep the user's choices if the reload reports none.
      const s = settingsFromSessionResult(result);
      if (s.configOptions.length) {
        this.configOptions = s.configOptions;
        this.nativeConfig = s.native;
      }
      this.dormant = false;
      this.send({ sessionUpdate: "tool_call_update", toolCallId: cardId, status: "completed", title: `Started ${this.agentName}` } as SessionUpdate);
      return conn;
    } catch (err) {
      this.send({ sessionUpdate: "tool_call_update", toolCallId: cardId, status: "failed", title: `${this.agentName} did not start` } as SessionUpdate);
      if (err instanceof PiBrowserProtocolError) throw err;
      throw this.host.describeError(this.agentId, err, "reopen the session");
    }
  }

  async prompt(prompt: ContentBlock[]): Promise<{ stopReason: string }> {
    if (this.streaming) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, `session ${this.id} is busy`);
    }
    this.streaming = true;
    try {
      const conn = await this.live();
      this.releaseTurn = conn.hold();
      // The sidebar shows the user's own message; keep it for a reload replay.
      for (const block of prompt) {
        if (block.type === "text" && block.text) {
          this.record({ sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } } as SessionUpdate);
        }
      }
      const firstText = prompt.find((b) => b.type === "text") as { text?: string } | undefined;
      if (firstText?.text) this.host.touchIndex(this, undefined, firstText.text);
      const result = await conn.request<{ stopReason?: string }>("session/prompt", { sessionId: this.id, prompt });
      this.host.touchIndex(this);
      return { stopReason: typeof result?.stopReason === "string" ? result.stopReason : "end_turn" };
    } catch (err) {
      if (err instanceof PiBrowserProtocolError) throw err;
      if (err instanceof AgentStoppedError) {
        this.dormant = true;
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${err.message}. Send your message again to restart it.`);
      }
      throw this.host.describeError(this.agentId, err, "answer");
    } finally {
      this.streaming = false;
      this.releaseTurn?.();
      this.releaseTurn = undefined;
    }
  }

  cancel(): void {
    this.cancelWaiting("cancelled");
    const conn = this.host.liveConnection(this.agentId);
    if (conn && !this.dormant) conn.notify("session/cancel", { sessionId: this.id });
  }

  async setConfigOption(configId: string, value: unknown): Promise<SessionConfigOption[]> {
    const conn = await this.live();
    const release = conn.hold();
    try {
      if (this.nativeConfig) {
        const res = await conn.request<{ configOptions?: SessionConfigOption[] }>("session/set_config_option", {
          sessionId: this.id,
          configId,
          value,
        });
        if (Array.isArray(res?.configOptions)) this.configOptions = res.configOptions;
        else this.setLocalValue(configId, value);
      } else if (configId === "model") {
        await conn.request("session/set_model", { sessionId: this.id, modelId: value });
        this.setLocalValue(configId, value);
      } else if (configId === "mode") {
        await conn.request("session/set_mode", { sessionId: this.id, modeId: value });
        this.setLocalValue(configId, value);
      } else {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.ACP_CAPABILITY_UNSUPPORTED, `unknown config option: ${configId}`);
      }
      return this.configOptions;
    } catch (err) {
      if (err instanceof PiBrowserProtocolError) throw err;
      throw this.host.describeError(this.agentId, err, "change the setting");
    } finally {
      release();
    }
  }

  private setLocalValue(configId: string, value: unknown): void {
    this.configOptions = this.configOptions.map((o) =>
      (o as { id?: string }).id === configId ? ({ ...o, currentValue: value } as SessionConfigOption) : o,
    );
  }

  /** The agent process went away: the session stays open, dormant. */
  markStopped(notice?: string): void {
    this.dormant = true;
    this.cancelWaiting("session_closed");
    if (notice) {
      this.send({
        sessionUpdate: "tool_call",
        toolCallId: `pi-browser-agent-stopped-${Date.now()}`,
        title: notice,
        kind: "other",
        status: "failed",
      } as SessionUpdate);
    }
  }

  /** Close the session (add-on close, or the owner disconnected). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelWaiting("session_closed");
    const conn = this.host.liveConnection(this.agentId);
    if (conn && !this.dormant) {
      if (this.streaming) conn.notify("session/cancel", { sessionId: this.id });
      if (conn.init?.closeSession) {
        try {
          await conn.request("session/close", { sessionId: this.id }, 10_000);
        } catch (err) {
          this.host.log.debug(`relay ${this.id}: session/close failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    this.host.forget(this);
  }

  /** For errors from the agent that the relay passes on as they are. */
  static isAgentError(err: unknown): err is AgentRpcError {
    return err instanceof AgentRpcError;
  }
}
