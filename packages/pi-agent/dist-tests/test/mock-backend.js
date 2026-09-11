/**
 * Scripted in-memory Pi backend for ACP agent tests.
 */
import { randomUUID } from "node:crypto";
import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
export class MockSession {
    sessionId;
    cwd;
    isStreaming = false;
    modelValueId = "mock/model-a";
    thinkingLevel = "off";
    prompts = [];
    modelChanges = [];
    thinkingChanges = [];
    abortedPromptIndexes = [];
    listeners = new Set();
    pendingResolve;
    disposed = false;
    history = [];
    /** Per-prompt script; set from tests before prompting. */
    nextTurn = {};
    constructor(sessionId, cwd) {
        this.sessionId = sessionId;
        this.cwd = cwd;
    }
    emit(event) {
        for (const l of this.listeners)
            l(event);
    }
    prompt(text, images) {
        if (this.isStreaming)
            return Promise.reject(new Error("session busy"));
        if (this.disposed)
            return Promise.reject(new Error("session disposed"));
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
        return new Promise((resolve) => {
            this.pendingResolve = (aborted) => {
                this.isStreaming = false;
                this.pendingResolve = undefined;
                if (aborted)
                    this.abortedPromptIndexes.push(promptIndex);
                resolve({ aborted });
            };
            const step = () => {
                if (this.pendingResolve === undefined)
                    return;
                if (i < events.length) {
                    const ev = events[i++];
                    this.emit(ev);
                    setTimeout(step, 1);
                }
                else {
                    this.pendingResolve?.(false);
                }
            };
            setTimeout(step, turn.delayMs ?? 1);
        });
    }
    async abort() {
        if (this.isStreaming)
            this.pendingResolve?.(true);
    }
    async setModel(valueId) {
        if (valueId !== "mock/model-a" && valueId !== "mock/model-b") {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.ACP_CAPABILITY_UNSUPPORTED, `unknown model: ${valueId}`);
        }
        this.modelValueId = valueId;
        this.modelChanges.push(valueId);
    }
    setThinkingLevel(level) {
        this.thinkingLevel = level;
        this.thinkingChanges.push(level);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    dispose() {
        this.disposed = true;
        this.listeners.clear();
    }
    getHistory() {
        return Promise.resolve(this.history);
    }
}
export class MockBackend {
    ready = Promise.resolve();
    thinkingLevels = ["off", "low", "medium", "high"];
    sessions = new Map();
    async createSession(opts) {
        const session = new MockSession(randomUUID(), opts.cwd);
        if (opts.modelValueId)
            session.modelValueId = opts.modelValueId;
        if (opts.thinkingLevel)
            session.thinkingLevel = opts.thinkingLevel;
        this.sessions.set(session.sessionId, session);
        return session;
    }
    async openSession(opts) {
        const existing = this.sessions.get(opts.sessionId);
        if (existing)
            return existing;
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `Pi session not found: ${opts.sessionId}`);
    }
    /** Test helper: pre-existing persisted session (for resume/load). */
    precreate(sessionId, cwd, history = []) {
        const session = new MockSession(sessionId, cwd);
        session.history = history;
        this.sessions.set(sessionId, session);
        return session;
    }
    async listSessions(cwd) {
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
    async listModels() {
        return [
            { valueId: "mock/model-a", name: "Mock Model A" },
            { valueId: "mock/model-b", name: "Mock Model B" },
        ];
    }
    dispose() {
        for (const s of this.sessions.values())
            s.dispose();
        this.sessions.clear();
    }
}
//# sourceMappingURL=mock-backend.js.map