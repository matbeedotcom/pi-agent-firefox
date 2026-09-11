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
export class MockSession {
    sessionId;
    cwd;
    customTools;
    script;
    isStreaming = false;
    modelValueId = "mock/model-a";
    thinkingLevel = "off";
    prompts = [];
    modelChanges = [];
    thinkingChanges = [];
    abortedPromptIndexes = [];
    executedTools = [];
    listeners = new Set();
    pendingResolve;
    isDisposed = false;
    history = [];
    /** Per-prompt script; set from the driver before prompting. */
    nextTurn = {};
    constructor(sessionId, cwd, customTools = [], script = []) {
        this.sessionId = sessionId;
        this.cwd = cwd;
        this.customTools = customTools;
        this.script = script;
    }
    /** External script entry matching this prompt, if any. */
    turnFor(text) {
        if (this.nextTurn.events?.length || this.nextTurn.toolCalls?.length || this.nextTurn.fail) {
            return this.nextTurn;
        }
        for (const entry of this.script) {
            if (entry.match && !text.includes(entry.match))
                continue;
            return { events: entry.events, toolCalls: entry.toolCalls, fail: entry.fail, delayMs: entry.delayMs };
        }
        return this.nextTurn;
    }
    emit(event) {
        for (const l of this.listeners)
            l(event);
    }
    async executeTool(toolCallId, spec) {
        const tool = this.customTools.find((t) => t.name === spec.toolName);
        this.emit({ type: "tool_start", toolCallId, toolName: spec.toolName, args: spec.args ?? {} });
        try {
            if (!tool) {
                const err = new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `mock: unknown tool ${spec.toolName}`);
                this.emit({ type: "tool_end", toolCallId, toolName: spec.toolName, result: { message: err.message }, isError: true });
                this.executedTools.push({ toolCallId, toolName: spec.toolName, isError: true, result: err.message });
                return;
            }
            const result = await tool.execute(toolCallId, spec.args ?? {}, undefined);
            this.emit({ type: "tool_end", toolCallId, toolName: spec.toolName, result, isError: false });
            this.executedTools.push({ toolCallId, toolName: spec.toolName, isError: false, result });
        }
        catch (err) {
            // Preserve the structured code in the agent-visible failure text so
            // consumers can tell a BROWSER_TAB_CLOSED from a generic MCP failure.
            let message = err instanceof Error ? err.message : String(err);
            if (err instanceof PiBrowserProtocolError) {
                message = `[${err.code}] ${message}`;
            }
            else if (isStructuredErrorObject(err)) {
                message = `[${codeFromErrorObject(err)}] ${err.message}`;
            }
            this.emit({ type: "tool_end", toolCallId, toolName: spec.toolName, result: { message }, isError: true });
            this.executedTools.push({ toolCallId, toolName: spec.toolName, isError: true, result: message });
        }
    }
    prompt(text, images) {
        if (this.isStreaming)
            return Promise.reject(new Error("session busy"));
        if (this.isDisposed)
            return Promise.reject(new Error("session disposed"));
        this.isStreaming = true;
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
        return new Promise((resolve) => {
            this.pendingResolve = (aborted) => {
                this.isStreaming = false;
                this.pendingResolve = undefined;
                if (aborted) {
                    this.abortedPromptIndexes.push(promptIndex);
                }
                else {
                    this.history.push({ role: "user", text });
                    if (assistantText)
                        this.history.push({ role: "assistant", text: assistantText });
                }
                resolve({ aborted });
            };
            const finish = () => this.pendingResolve?.(false);
            const stepTool = (j) => {
                if (this.pendingResolve === undefined)
                    return;
                if (j >= toolCalls.length) {
                    finish();
                    return;
                }
                void this.executeTool(`toolu-${randomUUID()}`, toolCalls[j]).then(() => setTimeout(() => stepTool(j + 1), 1));
            };
            const step = () => {
                if (this.pendingResolve === undefined)
                    return;
                if (i < events.length) {
                    const ev = events[i++];
                    if (ev.type === "text_delta")
                        assistantText += ev.delta;
                    this.emit(ev);
                    setTimeout(step, 1);
                }
                else {
                    stepTool(0);
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
        this.isDisposed = true;
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
    /** Sessions that exist (or existed) — the mock's stand-in for persisted sessions. */
    known = new Map();
    /** Optional external script (PI_BROWSER_MOCK_SCRIPT). */
    script;
    constructor(scriptPath) {
        if (scriptPath) {
            let parsed;
            try {
                parsed = JSON.parse(readFileSync(scriptPath, "utf8"));
            }
            catch (err) {
                throw new Error(`mock script unreadable (${scriptPath}): ${err instanceof Error ? err.message : String(err)}`);
            }
            if (!Array.isArray(parsed))
                throw new Error("mock script must be a JSON array of entries");
            this.script = parsed;
        }
        else {
            this.script = [];
        }
    }
    async createSession(opts) {
        const session = new MockSession(randomUUID(), opts.cwd, opts.customTools ?? [], this.script);
        if (opts.modelValueId)
            session.modelValueId = opts.modelValueId;
        if (opts.thinkingLevel)
            session.thinkingLevel = opts.thinkingLevel;
        this.sessions.set(session.sessionId, session);
        this.known.set(session.sessionId, { cwd: opts.cwd, tools: opts.customTools ?? [] });
        return session;
    }
    async openSession(opts) {
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
    precreate(sessionId, cwd, history = [], customTools = []) {
        const session = new MockSession(sessionId, cwd, customTools, this.script);
        session.history = history;
        this.sessions.set(sessionId, session);
        this.known.set(sessionId, { cwd, tools: customTools });
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