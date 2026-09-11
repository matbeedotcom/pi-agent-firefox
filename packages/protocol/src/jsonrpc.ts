/**
 * Minimal JSON-RPC 2.0 envelope types shared by both sides of the
 * Native Messaging link. The native host frames these objects with
 * Firefox's 4-byte little-endian length prefix; the browser runtime
 * handles framing on the add-on side.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.jsonrpc === "2.0" &&
    typeof m.id === "number" &&
    typeof m.method === "string" &&
    m.result === undefined &&
    m.error === undefined
  );
}

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.jsonrpc === "2.0" &&
    typeof m.id === "number" &&
    (m.result !== undefined || m.error !== undefined)
  );
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && m.id === undefined && typeof m.method === "string";
}
