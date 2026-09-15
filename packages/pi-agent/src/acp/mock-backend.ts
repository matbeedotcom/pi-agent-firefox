/**
 * Deterministic scripted Pi backend (PRODUCT.md §6 seam).
 *
 * Selected with PI_BROWSER_BACKEND=mock. Used by the integration test
 * harness (tests/) and by users who want a token-free smoke of the full
 * ACP surface. Behaves like the real backend through the PiBackend seam:
 * sessions, streaming events, cancellation, history replay, and — when a
 * scripted turn requests it — execution of the session's custom tools
 * (the browser tools), which exercises the x-pi-browser/* and
 * MCP-over-ACP paths end to end.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PI_BROWSER_ERROR, PiBrowserProtocolError, codeFromErrorObject, isStructuredErrorObject } from "@pi-browser/protocol";
import type {
  BackendHistoryEntry,
  BackendEvent,
  BackendPromptResult,
  BackendSession,
  CreateSessionOptions,
  ImageAttachment,
  ListedSession,
  ModelOption,
  OpenSessionOptions,
  PiBackend,
  ToolSpec,
} from "./backend.js";

export interface ScriptedToolCall {
  toolName: string;
  args?: Record<string, unknown>;
}

export interface ScriptedTurn {
  /** Events emitted during the turn (after the prompt is accepted). */
  events?: BackendEvent[];
  /** Custom tools to execute mid-turn (after `events`, in order). */
  toolCalls?: ScriptedToolCall[];
  /** Reject the prompt outright instead of running. */
  fail?: string;
  /** Delay before the turn starts (ms). */
  delayMs?: number;
}

/** Entry in an external mock script file (PI_BROWSER_MOCK_SCRIPT). */
export interface MockScriptEntry extends ScriptedTurn {
  /** Substring that must appear in the prompt text to trigger this entry. */
  match?: string;
}

export class MockSession implements BackendSession {
  isStreaming = false;
  modelValueId = "mock/model-a";
  thinkingLevel = "off";
  readonly prompts: Array<{ text: string; images?: ImageAttachment[] }> = [];
  readonly modelChanges: string[] = [];
  readonly thinkingChanges: string[] = [];
  readonly abortedPromptIndexes: number[] = [];
  readonly executedTools: Array<{ toolCallId: string; toolName: string; isError: boolean; result: unknown }> = [];
  private listeners = new Set<(event: BackendEvent) => void>();
  private pendingResolve: ((aborted: boolean) => void) | undefined;
  /** Aborts the in-flight tool calls when the session is cancelled. */
  private abortController: AbortController | undefined;
  isDisposed = false;
  history: BackendHistoryEntry[] = [];
  /** Per-prompt script; set from the driver before prompting. */
  nextTurn: ScriptedTurn = {};

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    private readonly customTools: ToolSpec[] = [],
    private readonly script: MockScriptEntry[] = [],
  ) {}

  /** External script entry matching this prompt, if any. */
  private turnFor(text: string): ScriptedTurn {
    if (this.nextTurn.events?.length || this.nextTurn.toolCalls?.length || this.nextTurn.fail) {
      return this.nextTurn;
    }
    for (const entry of this.script) {
      if (entry.match && !text.includes(entry.match)) continue;
      return { events: entry.events, toolCalls: entry.toolCalls, fail: entry.fail, delayMs: entry.delayMs };
    }
    return this.nextTurn;
  }

  emit(event: BackendEvent): void {
    for (const l of this.listeners) l(event);
  }

  private async executeTool(toolCallId: string, spec: ScriptedToolCall): Promise<void> {
    const tool = this.customTools.find((t) => t.name === spec.toolName);
    this.emit({ type: "tool_start", toolCallId, toolName: spec.toolName, args: spec.args ?? {} });
    try {
      if (!tool) {
        const err = new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `mock: unknown tool ${spec.toolName}`);
        this.emit({ type: "tool_end", toolCallId, toolName: spec.toolName, result: { message: err.message }, isError: true });
        this.executedTools.push({ toolCallId, toolName: spec.toolName, isError: true, result: err.message });
        return;
      }
      const result = await tool.execute(toolCallId, spec.args ?? {}, this.abortController?.signal);
      this.emit({ type: "tool_end", toolCallId, toolName: spec.toolName, result, isError: false });
      this.executedTools.push({ toolCallId, toolName: spec.toolName, isError: false, result });
    } catch (err) {
      // Preserve the structured code in the agent-visible failure text so
      // consumers can tell a BROWSER_TAB_CLOSED from a generic MCP failure.
      let message = err instanceof Error ? err.message : String(err);
      if (err instanceof PiBrowserProtocolError) {
        message = `[${err.code}] ${message}`;
      } else if (isStructuredErrorObject(err)) {
        message = `[${codeFromErrorObject(err)}] ${err.message}`;
      }
      this.emit({ type: "tool_end", toolCallId, toolName: spec.toolName, result: { message }, isError: true });
      this.executedTools.push({ toolCallId, toolName: spec.toolName, isError: true, result: message });
    }
  }

  prompt(text: string, images?: ImageAttachment[]): Promise<BackendPromptResult> {
    if (this.isStreaming) return Promise.reject(new Error("session busy"));
    if (this.isDisposed) return Promise.reject(new Error("session disposed"));
    this.isStreaming = true;
    this.abortController = new AbortController();
    const promptIndex = this.prompts.length;
    this.prompts.push({ text, images });
    const turn = this.turnFor(text);
    if (turn.fail) {
      this.isStreaming = false;
      return Promise.reject(new Error(turn.fail));
    }
    const events = turn.events ?? [{ type: "text_delta", delta: `ok: ${text}` }];
    const toolCalls = turn.toolCalls ?? [];
    let i = 0;
    let assistantText = "";
    return new Promise<BackendPromptResult>((resolve) => {
      this.pendingResolve = (aborted: boolean) => {
        this.isStreaming = false;
        this.pendingResolve = undefined;
        if (aborted) {
          this.abortedPromptIndexes.push(promptIndex);
        } else {
          this.history.push({ role: "user", text });
          if (assistantText) this.history.push({ role: "assistant", text: assistantText });
        }
        resolve({ aborted });
      };
      const finish = () => this.pendingResolve?.(false);
      const stepTool = (j: number) => {
        if (this.pendingResolve === undefined) return;
        if (j >= toolCalls.length) {
          finish();
          return;
        }
        void this.executeTool(`toolu-${randomUUID()}`, toolCalls[j]).then(() =>
          setTimeout(() => stepTool(j + 1), 1),
        );
      };
      const step = () => {
        if (this.pendingResolve === undefined) return;
        if (i < events.length) {
          const ev = events[i++];
          if (ev.type === "text_delta") assistantText += ev.delta;
          this.emit(ev);
          setTimeout(step, 1);
        } else {
          stepTool(0);
        }
      };
      setTimeout(step, turn.delayMs ?? 1);
    });
  }

  async abort(): Promise<void> {
    if (!this.isStreaming) return;
    // Abort the in-flight tool call (e.g. the REPL cell) so the child is
    // killed, then settle the prompt as cancelled.
    this.abortController?.abort();
    this.pendingResolve?.(true);
  }

  async setModel(valueId: string): Promise<void> {
    if (valueId !== "mock/model-a" && valueId !== "mock/model-b") {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.ACP_CAPABILITY_UNSUPPORTED, `unknown model: ${valueId}`);
    }
    this.modelValueId = valueId;
    this.modelChanges.push(valueId);
  }

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
    this.thinkingChanges.push(level);
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.isDisposed = true;
    this.listeners.clear();
  }

  getHistory(): Promise<BackendHistoryEntry[]> {
    return Promise.resolve(this.history);
  }
}

export class MockBackend implements PiBackend {
  readonly ready: Promise<void> = Promise.resolve();
  readonly thinkingLevels = ["off", "low", "medium", "high"] as const;
  readonly sessions = new Map<string, MockSession>();
  /** Sessions that exist (or existed) — the mock's stand-in for persisted sessions. */
  private readonly known = new Map<string, { cwd: string; tools: ToolSpec[] }>();
  /** Optional external script (PI_BROWSER_MOCK_SCRIPT). */
  readonly script: MockScriptEntry[];

  constructor(scriptPath?: string) {
    if (scriptPath) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(scriptPath, "utf8"));
      } catch (err) {
        throw new Error(`mock script unreadable (${scriptPath}): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!Array.isArray(parsed)) throw new Error("mock script must be a JSON array of entries");
      this.script = parsed as MockScriptEntry[];
    } else {
      this.script = [];
    }
  }

  async createSession(opts: CreateSessionOptions): Promise<BackendSession> {
    const session = new MockSession(randomUUID(), opts.cwd, opts.customTools ?? [], this.script);
    if (opts.modelValueId) session.modelValueId = opts.modelValueId;
    if (opts.thinkingLevel) session.thinkingLevel = opts.thinkingLevel;
    this.sessions.set(session.sessionId, session);
    this.known.set(session.sessionId, { cwd: opts.cwd, tools: opts.customTools ?? [] });
    return session;
  }

  async openSession(opts: OpenSessionOptions): Promise<BackendSession> {
    const meta = this.known.get(opts.sessionId);
    if (!meta) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `mock session not found: ${opts.sessionId}`);
    }
    const prev = this.sessions.get(opts.sessionId);
    if (prev && !prev.isDisposed) {
      if (opts.customTools) {
        const replacement = new MockSession(prev.sessionId, prev.cwd, opts.customTools, this.script);
        replacement.history = prev.history;
        replacement.modelValueId = prev.modelValueId;
        replacement.thinkingLevel = prev.thinkingLevel;
        this.sessions.set(prev.sessionId, replacement);
        return replacement;
      }
      return prev;
    }
    // Reopen (resume/load after close): a fresh in-memory session with the
    // same identity and the history accumulated so far.
    const fresh = new MockSession(opts.sessionId, meta.cwd, opts.customTools ?? meta.tools, this.script);
    if (prev) {
      fresh.history = prev.history;
      fresh.modelValueId = prev.modelValueId;
      fresh.thinkingLevel = prev.thinkingLevel;
    }
    this.sessions.set(opts.sessionId, fresh);
    return fresh;
  }

  /** Test helper: pre-existing persisted session (for resume/load). */
  precreate(
    sessionId: string,
    cwd: string,
    history: BackendHistoryEntry[] = [],
    customTools: ToolSpec[] = [],
  ): MockSession {
    const session = new MockSession(sessionId, cwd, customTools, this.script);
    session.history = history;
    this.sessions.set(sessionId, session);
    this.known.set(sessionId, { cwd, tools: customTools });
    return session;
  }

  async listSessions(cwd?: string): Promise<ListedSession[]> {
    const now = new Date().toISOString();
    return [...this.sessions.values()]
      .filter((s) => (cwd ? s.cwd === cwd : true))
      .map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        updatedAt: now,
        title: "mock",
        messageCount: s.prompts.length,
      }));
  }

  async listModels(): Promise<ModelOption[]> {
    return [
      { valueId: "mock/model-a", name: "Mock Model A" },
      { valueId: "mock/model-b", name: "Mock Model B" },
    ];
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
}
