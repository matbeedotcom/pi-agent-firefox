import type { BackendEvent, BackendPromptResult, BackendSession, CreateSessionOptions, ImageAttachment, ListedSession, ModelOption, OpenSessionOptions, PiBackend, ToolSpec } from "./backend.js";
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
export declare class MockSession implements BackendSession {
    readonly sessionId: string;
    readonly cwd: string;
    private readonly customTools;
    private readonly script;
    isStreaming: boolean;
    modelValueId: string;
    thinkingLevel: string;
    readonly prompts: Array<{
        text: string;
        images?: ImageAttachment[];
    }>;
    readonly modelChanges: string[];
    readonly thinkingChanges: string[];
    readonly abortedPromptIndexes: number[];
    readonly executedTools: Array<{
        toolCallId: string;
        toolName: string;
        isError: boolean;
        result: unknown;
    }>;
    private listeners;
    private pendingResolve;
    isDisposed: boolean;
    history: Array<{
        role: "user" | "assistant";
        text: string;
    }>;
    /** Per-prompt script; set from the driver before prompting. */
    nextTurn: ScriptedTurn;
    constructor(sessionId: string, cwd: string, customTools?: ToolSpec[], script?: MockScriptEntry[]);
    /** External script entry matching this prompt, if any. */
    private turnFor;
    emit(event: BackendEvent): void;
    private executeTool;
    prompt(text: string, images?: ImageAttachment[]): Promise<BackendPromptResult>;
    abort(): Promise<void>;
    setModel(valueId: string): Promise<void>;
    setThinkingLevel(level: string): void;
    subscribe(listener: (event: BackendEvent) => void): () => void;
    dispose(): void;
    getHistory(): Promise<Array<{
        role: "user" | "assistant";
        text: string;
    }>>;
}
export declare class MockBackend implements PiBackend {
    readonly ready: Promise<void>;
    readonly thinkingLevels: readonly ["off", "low", "medium", "high"];
    readonly sessions: Map<string, MockSession>;
    /** Sessions that exist (or existed) — the mock's stand-in for persisted sessions. */
    private readonly known;
    /** Optional external script (PI_BROWSER_MOCK_SCRIPT). */
    readonly script: MockScriptEntry[];
    constructor(scriptPath?: string);
    createSession(opts: CreateSessionOptions): Promise<BackendSession>;
    openSession(opts: OpenSessionOptions): Promise<BackendSession>;
    /** Test helper: pre-existing persisted session (for resume/load). */
    precreate(sessionId: string, cwd: string, history?: Array<{
        role: "user" | "assistant";
        text: string;
    }>, customTools?: ToolSpec[]): MockSession;
    listSessions(cwd?: string): Promise<ListedSession[]>;
    listModels(): Promise<ModelOption[]>;
    dispose(): void;
}
//# sourceMappingURL=mock-backend.d.ts.map