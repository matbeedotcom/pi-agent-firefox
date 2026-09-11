import { encodeFrame, FrameDecoder, FramingError } from "./framing.js";
import { isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, JSONRPC_ERROR, } from "@pi-browser/protocol";
export class TransportTimeoutError extends Error {
    method;
    timeoutMs;
    constructor(method, timeoutMs) {
        super(`request timed out after ${timeoutMs}ms: ${method}`);
        this.method = method;
        this.timeoutMs = timeoutMs;
        this.name = "TransportTimeoutError";
    }
}
export class TransportClosedError extends Error {
    constructor() {
        super("transport closed");
        this.name = "TransportClosedError";
    }
}
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Core JSON-RPC dispatcher shared by the stdio and in-memory transports.
 * `write` is invoked with parsed JSON-RPC messages (the stdio adapter
 * wraps them into Firefox frames).
 */
export function createJsonRpcDispatcher(write, opts) {
    const { log } = opts;
    const pending = new Map();
    let nextId = 1;
    let closed = false;
    let eofEmitted = false;
    const transport = {
        get closed() {
            return closed;
        },
        onRequest: undefined,
        onNotification: undefined,
        onEof: undefined,
        request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
            if (closed)
                return Promise.reject(new TransportClosedError());
            const id = nextId++;
            const msg = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
            const promise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new TransportTimeoutError(method, timeoutMs));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer, method });
            });
            try {
                write(msg);
            }
            catch (err) {
                const p = pending.get(id);
                if (p) {
                    clearTimeout(p.timer);
                    pending.delete(id);
                }
                log.error(`failed to send request ${method}`, err);
                return Promise.reject(err);
            }
            return promise;
        },
        notify(method, params) {
            if (closed)
                return;
            try {
                write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
            }
            catch (err) {
                log.error(`failed to send notification ${method}`, err);
            }
        },
        respond(id, result) {
            if (closed)
                return;
            try {
                write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
            }
            catch (err) {
                log.error("failed to send response", err);
            }
        },
        respondError(id, error) {
            if (closed)
                return;
            try {
                write({ jsonrpc: "2.0", id, error });
            }
            catch (err) {
                log.error("failed to send error response", err);
            }
        },
        close() {
            if (closed)
                return;
            closed = true;
            for (const p of pending.values()) {
                clearTimeout(p.timer);
                p.reject(new TransportClosedError());
            }
            pending.clear();
        },
    };
    function deliverMessage(msg) {
        if (closed)
            return;
        if (isJsonRpcResponse(msg)) {
            const p = pending.get(msg.id);
            if (!p) {
                log.debug(`response for unknown id ${msg.id}`);
                return;
            }
            clearTimeout(p.timer);
            pending.delete(msg.id);
            if (msg.error)
                p.reject({ jsonrpc: "2.0", ...msg.error });
            else
                p.resolve(msg.result);
            return;
        }
        if (isJsonRpcRequest(msg)) {
            const handler = transport.onRequest;
            if (!handler) {
                transport.respondError(msg.id, {
                    code: JSONRPC_ERROR.METHOD_NOT_FOUND,
                    message: `no request handler for ${msg.method}`,
                });
                return;
            }
            try {
                handler(msg.method, msg.params, msg.id);
            }
            catch (err) {
                log.error(`request handler threw: ${msg.method}`, err);
                transport.respondError(msg.id, {
                    code: JSONRPC_ERROR.INTERNAL,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
            return;
        }
        if (isJsonRpcNotification(msg)) {
            try {
                transport.onNotification?.(msg.method, msg.params);
            }
            catch (err) {
                log.error(`notification handler threw: ${msg.method}`, err);
            }
            return;
        }
        log.warn(`dropping malformed message: ${String(msg).slice(0, 200)}`);
    }
    function emitEof() {
        if (eofEmitted || closed)
            return;
        eofEmitted = true;
        try {
            transport.onEof?.();
        }
        catch (err) {
            log.error("onEof handler threw", err);
        }
    }
    return {
        transport,
        deliverMessage,
        dispose() {
            closed = true;
            for (const p of pending.values()) {
                clearTimeout(p.timer);
                p.reject(new TransportClosedError());
            }
            pending.clear();
            emitEof();
        },
    };
}
/**
 * Host-side transport: Firefox framing on stdin/stdout.
 */
export function createStdioTransport(input, output, log) {
    const decoder = new FrameDecoder();
    const dispatcher = createJsonRpcDispatcher((msg) => {
        const frame = encodeFrame(msg);
        if (!output.write(frame)) {
            // Backpressure: drain before the next write is safe. Native Messaging
            // messages are small except screenshots; buffer briefly.
            log.debug("stdout backpressure; waiting for drain");
        }
    }, { log });
    input.on("data", (chunk) => {
        try {
            decoder.push(chunk);
            for (const frame of decoder.readAll()) {
                let msg;
                try {
                    msg = JSON.parse(frame.toString("utf8"));
                }
                catch {
                    log.warn("malformed JSON frame dropped");
                    continue;
                }
                dispatcher.deliverMessage(msg);
            }
        }
        catch (err) {
            if (err instanceof FramingError) {
                log.error(`framing violation (${err.reason}); terminating connection`, err);
                dispatcher.dispose();
                output.end();
            }
            else {
                log.error("framing error", err);
                dispatcher.dispose();
                output.end();
            }
        }
    });
    input.on("end", () => dispatcher.dispose());
    input.on("close", () => dispatcher.dispose());
    input.on("error", (err) => {
        log.error("stdin error", err);
        dispatcher.dispose();
    });
    output.on("error", (err) => {
        log.error("stdout error", err);
        dispatcher.dispose();
    });
    return dispatcher;
}
/**
 * In-memory transport pair for tests and for wiring two in-process
 * dispatchers (e.g. a fake Firefox driving the real host transport code).
 */
export function createMemoryTransportPair(aLog, bLog) {
    let a;
    let b;
    a = createJsonRpcDispatcher((msg) => b.deliverMessage(msg), { log: aLog });
    b = createJsonRpcDispatcher((msg) => a.deliverMessage(msg), { log: bLog });
    return { a, b };
}
//# sourceMappingURL=transport.js.map