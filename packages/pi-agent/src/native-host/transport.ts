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
import { encodeFrame, FrameDecoder, FramingError } from "./framing.js";
import type { JsonRpcErrorObject } from "@pi-browser/protocol";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JSONRPC_ERROR,
} from "@pi-browser/protocol";
import type { Logger } from "../logger.js";

export class TransportTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`request timed out after ${timeoutMs}ms: ${method}`);
    this.name = "TransportTimeoutError";
  }
}

export class TransportClosedError extends Error {
  constructor() {
    super("transport closed");
    this.name = "TransportClosedError";
  }
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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
export function createJsonRpcDispatcher(write: (msg: unknown) => void, opts: DispatcherOptions): Dispatcher {
  const { log } = opts;
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;
  let eofEmitted = false;

  const transport: AcpTransport = {
    get closed() {
      return closed;
    },
    onRequest: undefined,
    onNotification: undefined,
    onEof: undefined,

    request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
      if (closed) return Promise.reject(new TransportClosedError());
      const id = nextId++;
      const msg = { jsonrpc: "2.0" as const, id, method, ...(params !== undefined ? { params } : {}) };
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new TransportTimeoutError(method, timeoutMs));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
      });
      try {
        write(msg);
      } catch (err) {
        const p = pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(id);
        }
        log.error(`failed to send request ${method}`, err);
        return Promise.reject(err);
      }
      return promise as Promise<T>;
    },

    notify(method: string, params?: unknown): void {
      if (closed) return;
      try {
        write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
      } catch (err) {
        log.error(`failed to send notification ${method}`, err);
      }
    },

    respond(id: number, result: unknown): void {
      if (closed) return;
      try {
        write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
      } catch (err) {
        log.error("failed to send response", err);
      }
    },

    respondError(id: number, error: JsonRpcErrorObject): void {
      if (closed) return;
      try {
        write({ jsonrpc: "2.0", id, error });
      } catch (err) {
        log.error("failed to send error response", err);
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new TransportClosedError());
      }
      pending.clear();
    },
  };

  function deliverMessage(msg: unknown): void {
    if (closed) return;
    if (isJsonRpcResponse(msg)) {
      const p = pending.get(msg.id);
      if (!p) {
        log.debug(`response for unknown id ${msg.id}`);
        return;
      }
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject({ jsonrpc: "2.0" as const, ...msg.error });
      else p.resolve(msg.result);
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
      } catch (err) {
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
      } catch (err) {
        log.error(`notification handler threw: ${msg.method}`, err);
      }
      return;
    }
    log.warn(`dropping malformed message: ${String(msg).slice(0, 200)}`);
  }

  function emitEof(): void {
    if (eofEmitted || closed) return;
    eofEmitted = true;
    try {
      transport.onEof?.();
    } catch (err) {
      log.error("onEof handler threw", err);
    }
  }

  return {
    transport,
    deliverMessage,
    dispose(): void {
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
export function createStdioTransport(input: Readable, output: Writable, log: Logger): Dispatcher {
  const decoder = new FrameDecoder();

  const dispatcher = createJsonRpcDispatcher((msg) => {
    const frame = encodeFrame(msg);
    if (!output.write(frame)) {
      // Backpressure: drain before the next write is safe. Native Messaging
      // messages are small except screenshots; buffer briefly.
      log.debug("stdout backpressure; waiting for drain");
    }
  }, { log });

  input.on("data", (chunk: Buffer) => {
    try {
      decoder.push(chunk);
      for (const frame of decoder.readAll()) {
        let msg: unknown;
        try {
          msg = JSON.parse(frame.toString("utf8"));
        } catch {
          log.warn("malformed JSON frame dropped");
          continue;
        }
        dispatcher.deliverMessage(msg);
      }
    } catch (err) {
      if (err instanceof FramingError) {
        log.error(`framing violation (${err.reason}); terminating connection`, err);
        dispatcher.dispose();
        output.end();
      } else {
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
export function createMemoryTransportPair(aLog: Logger, bLog: Logger): { a: Dispatcher; b: Dispatcher } {
  let a: Dispatcher;
  let b: Dispatcher;
  a = createJsonRpcDispatcher((msg) => b.deliverMessage(msg), { log: aLog });
  b = createJsonRpcDispatcher((msg) => a.deliverMessage(msg), { log: bLog });
  return { a, b };
}
