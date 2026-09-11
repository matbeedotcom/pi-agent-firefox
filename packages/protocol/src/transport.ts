/**
 * Minimal transport contract shared by the host and the add-on.
 * Full transports (stdio-framed on the host, runtime-port on the add-on)
 * implement this interface; higher layers only depend on it.
 */
import type { JsonRpcErrorObject } from "./jsonrpc.js";

export interface AcpTransportLike {
  /** Send a request and wait for its response. Rejects with a JsonRpcErrorObject on peer errors. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void;
}

/** True when a rejected request value is a structured JSON-RPC error object. */
export function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  // The `jsonrpc` marker is present when a full response object is passed;
  // bare error objects ({ code, message, data }) are equally valid.
  return v.jsonrpc === "2.0" && typeof v.code === "number" && typeof v.message === "string";
}

/** True for any structured error object (with or without the jsonrpc marker). */
export function isStructuredErrorObject(value: unknown): value is JsonRpcErrorObject {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "number" && typeof v.message === "string";
}
