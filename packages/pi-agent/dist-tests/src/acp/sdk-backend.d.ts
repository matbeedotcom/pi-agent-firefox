/**
 * Production Pi backend: Pi SDK `createAgentSession()` in-process
 * (PRODUCT.md §6 "Preferred long-term implementation").
 *
 * Each ACP session maps to one independent Pi `AgentSession` with its own
 * SessionManager (persistence, cwd, model state). The ACP boundary never
 * exposes the SDK directly.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
/** The concrete Model type as returned by ModelRuntime.getModel. */
export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
import type { BackendEvent, BackendSession, CreateSessionOptions, ListedSession, ModelOption, OpenSessionOptions, PiBackend } from "./backend.js";
import type { Logger } from "../logger.js";
interface PiBackendOptions {
    log: Logger;
    /** Override Pi's agent dir (tests); defaults to getAgentDir() semantics. */
    agentDir?: string;
    /** Override model runtime paths (tests). */
    authPath?: string;
    modelsPath?: string;
}
export declare class PiSdkBackend implements PiBackend {
    private readonly opts;
    private modelRuntime;
    private runtimePromise;
    private sessions;
    readonly thinkingLevels: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    constructor(opts: PiBackendOptions);
    get ready(): Promise<void>;
    private initRuntime;
    private runtime;
    private settingsManager;
    createSession(opts: CreateSessionOptions): Promise<BackendSession>;
    openSession(opts: OpenSessionOptions): Promise<BackendSession>;
    private spawnSession;
    private resolveModel;
    private toPiTool;
    private wrapSession;
    listSessions(cwd?: string): Promise<ListedSession[]>;
    listModels(): Promise<ModelOption[]>;
    dispose(): void;
}
/**
 * Map Pi `AgentSessionEvent`s to normalized `BackendEvent`s.
 * Returns an empty array for events with no ACP counterpart.
 */
export declare function mapBackendEvent(event: unknown): BackendEvent[];
export {};
//# sourceMappingURL=sdk-backend.d.ts.map