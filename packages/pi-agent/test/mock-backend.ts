/**
 * Scripted in-memory Pi backend for ACP agent tests.
 */
import { randomUUID } from "node:crypto";
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import type {
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
} from "../src/acp/backend.js";

export interface ScriptedTurn {
  /** Events emitted during the turn (after the prompt is accepted). */
  events?: BackendEvent[];
  /** Reject the prompt outright instead of running. */
  fail?: string;
  /** Delay before the turn completes (ms). */
  delayMs?: number;
}

export class MockSession implements BackendSession {
  isStreaming = false;
  modelValueId = "mock/model-a";
  thinkingLevel = "off";
  readonly prompts: Array<{ text: string; images?: ImageAttachment[] }> = [];
  readonly modelChanges: string[] = [];
  readonly thinkingChanges: string[] = [];
  readonly abortedPromptIndexes: number[] = [];
  private listeners = new Set<(event: BackendEvent) => void>();
  private pendingResolve: ((aborted: boolean) => void) | undefined;
  private disposed = false;
  history: Array<{ role: "user" | "assistant"; text: string }> = [];
  /** Per-prompt script; set from tests before prompting. */
  nextTurn: ScriptedTurn = {};

  constructor(readonly sessionId: string, readonly cwd: string) {}

  emit(event: BackendEvent): void {
    for (const l of this.listeners) l(event);
  }

  prompt(text: string, images?: ImageAttachment[]): Promise<BackendPromptResult> {
    if (this.isStreaming) return Promise.reject(new Error("session busy"));
    if (this.disposed) return Promise.reject(new Error("session disposed"));
    this.isStreaming = true;
    const promptIndex = this.prompts.length;
    this.prompts.push({ text, images });
    const turn = this.nextTurn;
    if (turn.fail) {
      this.isStreaming = false;
      return Promise.reject(new Error(turn.fail));
    }
    const events = turn.events ?? [{ type: "text_delta", delta: `ok: ${text}` }];
    let i = 0;
    return new Promise<BackendPromptResult>((resolve) => {
      this.pendingResolve = (aborted: boolean) => {
        this.isStreaming = false;
        this.pendingResolve = undefined;
        if (aborted) this.abortedPromptIndexes.push(promptIndex);
        resolve({ aborted });
      };
      const step = () => {
        if (this.pendingResolve === undefined) return;
        if (i < events.length) {
          const ev = events[i++];
          this.emit(ev);
          setTimeout(step, 1);
        } else {
          this.pendingResolve?.(false);
        }
      };
      setTimeout(step, turn.delayMs ?? 1);
    });
  }

  async abort(): Promise<void> {
    if (this.isStreaming) this.pendingResolve?.(true);
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
    this.disposed = true;
    this.listeners.clear();
  }

  getHistory(): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
    return Promise.resolve(this.history);
  }
}

export class MockBackend implements PiBackend {
  readonly ready: Promise<void> = Promise.resolve();
  readonly thinkingLevels = ["off", "low", "medium", "high"] as const;
  readonly sessions = new Map<string, MockSession>();

  async createSession(opts: CreateSessionOptions): Promise<BackendSession> {
    const session = new MockSession(randomUUID(), opts.cwd);
    if (opts.modelValueId) session.modelValueId = opts.modelValueId;
    if (opts.thinkingLevel) session.thinkingLevel = opts.thinkingLevel;
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async openSession(opts: OpenSessionOptions): Promise<BackendSession> {
    const existing = this.sessions.get(opts.sessionId);
    if (existing) return existing;
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `Pi session not found: ${opts.sessionId}`);
  }

  /** Test helper: pre-existing persisted session (for resume/load). */
  precreate(
    sessionId: string,
    cwd: string,
    history: Array<{ role: "user" | "assistant"; text: string }> = [],
  ): MockSession {
    const session = new MockSession(sessionId, cwd);
    session.history = history;
    this.sessions.set(sessionId, session);
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
