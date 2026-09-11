import type { BackendEvent, BackendPromptResult, BackendSession, CreateSessionOptions, ImageAttachment, ListedSession, ModelOption, OpenSessionOptions, PiBackend } from "../src/acp/backend.js";
export interface ScriptedTurn {
    /** Events emitted during the turn (after the prompt is accepted). */
    events?: BackendEvent[];
    /** Reject the prompt outright instead of running. */
    fail?: string;
    /** Delay before the turn completes (ms). */
    delayMs?: number;
}
export declare class MockSession implements BackendSession {
    readonly sessionId: string;
    readonly cwd: string;
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
    private listeners;
    private pendingResolve;
    private disposed;
    history: Array<{
        role: "user" | "assistant";
        text: string;
    }>;
    /** Per-prompt script; set from tests before prompting. */
    nextTurn: ScriptedTurn;
    constructor(sessionId: string, cwd: string);
    emit(event: BackendEvent): void;
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
    createSession(opts: CreateSessionOptions): Promise<BackendSession>;
    openSession(opts: OpenSessionOptions): Promise<BackendSession>;
    /** Test helper: pre-existing persisted session (for resume/load). */
    precreate(sessionId: string, cwd: string, history?: Array<{
        role: "user" | "assistant";
        text: string;
    }>): MockSession;
    listSessions(cwd?: string): Promise<ListedSession[]>;
    listModels(): Promise<ModelOption[]>;
    dispose(): void;
}
//# sourceMappingURL=mock-backend.d.ts.map