/**
 * JSON-RPC 2.0 transport over the Native Messaging link.
 *
 * The host side frames messages with Firefox's 4-byte length prefix
 * (framing.ts). The add-on side gets framing for free from
 * `browser.runtime.connectNative()` and implements the same interface
 * over the runtime port.
 *
 * stdout invariant: the host transport is the ONLY code allowed to write
 * to process.stdout; everything else logs to stderr.
 */
import type { Readable, Writable } from "node:stream";
import type { JsonRpcErrorObject } from "@pi-browser/protocol";
import type { Logger } from "../logger.js";
export declare class TransportTimeoutError extends Error {
    readonly method: string;
    readonly timeoutMs: number;
    constructor(method: string, timeoutMs: number);
}
export declare class TransportClosedError extends Error {
    constructor();
}
export interface AcpTransport {
    /** Send a request and wait for its response. */
    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
    /** Send a notification (no response expected). */
    notify(method: string, params?: unknown): void;
    /** Answer an incoming request with a result. */
    respond(id: number, result: unknown): void;
    /** Answer an incoming request with an error. */
    respondError(id: number, error: JsonRpcErrorObject): void;
    /** Close the link. Pending requests are rejected. */
    close(): void;
    readonly closed: boolean;
    /** Handle for incoming requests; must call respond/respondError exactly once. */
    onRequest: ((method: string, params: unknown, id: number) => void) | undefined;
    /** Handle for incoming notifications. */
    onNotification: ((method: string, params: unknown) => void) | undefined;
    /** Fired when the peer went away (stdin EOF / port disconnect). */
    onEof: (() => void) | undefined;
}
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export interface DispatcherOptions {
    log: Logger;
    onEof?: () => void;
}
export interface Dispatcher {
    transport: AcpTransport;
    /** Deliver an already-parsed JSON-RPC message (used by stdio framing and memory pairing). */
    deliverMessage(msg: unknown): void;
    dispose(): void;
}
/**
 * Core JSON-RPC dispatcher shared by the stdio and in-memory transports.
 * `write` is invoked with parsed JSON-RPC messages (the stdio adapter
 * wraps them into Firefox frames).
 */
export declare function createJsonRpcDispatcher(write: (msg: unknown) => void, opts: DispatcherOptions): Dispatcher;
/**
 * Host-side transport: Firefox framing on stdin/stdout.
 */
export declare function createStdioTransport(input: Readable, output: Writable, log: Logger): Dispatcher;
/**
 * In-memory transport pair for tests and for wiring two in-process
 * dispatchers (e.g. a fake Firefox driving the real host transport code).
 */
export declare function createMemoryTransportPair(aLog: Logger, bLog: Logger): {
    a: Dispatcher;
    b: Dispatcher;
};
//# sourceMappingURL=transport.d.ts.map