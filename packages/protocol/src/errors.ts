/**
 * Structured integration errors (PRODUCT.md §44).
 *
 * Neither side of the link may rely on parsing human-readable error
 * strings. Every protocol-level failure carries a stable code, mapped to a
 * dedicated JSON-RPC application error code (-320xx) and echoed in
 * `error.data.code` for readability.
 */
import type { JsonRpcErrorObject } from "./jsonrpc.js";

export const TRUSTED_UA_ERROR = {
  NATIVE_HOST_NOT_INSTALLED: "NATIVE_HOST_NOT_INSTALLED",
  NATIVE_HOST_VERSION_MISMATCH: "NATIVE_HOST_VERSION_MISMATCH",
  PI_NOT_FOUND: "PI_NOT_FOUND",
  PI_START_FAILED: "PI_START_FAILED",
  ACP_INITIALIZATION_FAILED: "ACP_INITIALIZATION_FAILED",
  ACP_CAPABILITY_UNSUPPORTED: "ACP_CAPABILITY_UNSUPPORTED",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_BUSY: "SESSION_BUSY",
  BROWSER_NOT_BOUND: "BROWSER_NOT_BOUND",
  BROWSER_TAB_CLOSED: "BROWSER_TAB_CLOSED",
  BROWSER_FRAME_NOT_FOUND: "BROWSER_FRAME_NOT_FOUND",
  BROWSER_PERMISSION_DENIED: "BROWSER_PERMISSION_DENIED",
  BROWSER_ELEMENT_STALE: "BROWSER_ELEMENT_STALE",
  BROWSER_TOOL_TIMEOUT: "BROWSER_TOOL_TIMEOUT",
  BROWSER_DOWNLOAD_TOO_LARGE: "BROWSER_DOWNLOAD_TOO_LARGE",
  MCP_UNAVAILABLE: "MCP_UNAVAILABLE",
  MCP_TOOL_NOT_FOUND: "MCP_TOOL_NOT_FOUND",
  PROTOCOL_VERSION_MISMATCH: "PROTOCOL_VERSION_MISMATCH",
  INTERNAL: "INTERNAL",
  MAIL_NO_CONTEXT: "MAIL_NO_CONTEXT",
  MAIL_MESSAGE_NOT_FOUND: "MAIL_MESSAGE_NOT_FOUND",
  MAIL_ATTACHMENT_NOT_FOUND: "MAIL_ATTACHMENT_NOT_FOUND",
  MAIL_CURSOR_EXPIRED: "MAIL_CURSOR_EXPIRED",
} as const;

export type TrustedUaErrorCode = (typeof TRUSTED_UA_ERROR)[keyof typeof TRUSTED_UA_ERROR];

/** JSON-RPC reserved range for application errors. */
const APP_ERROR_BASE = -32099;

const ORDER: TrustedUaErrorCode[] = [
  TRUSTED_UA_ERROR.NATIVE_HOST_NOT_INSTALLED,
  TRUSTED_UA_ERROR.NATIVE_HOST_VERSION_MISMATCH,
  TRUSTED_UA_ERROR.PI_NOT_FOUND,
  TRUSTED_UA_ERROR.PI_START_FAILED,
  TRUSTED_UA_ERROR.ACP_INITIALIZATION_FAILED,
  TRUSTED_UA_ERROR.ACP_CAPABILITY_UNSUPPORTED,
  TRUSTED_UA_ERROR.SESSION_NOT_FOUND,
  TRUSTED_UA_ERROR.SESSION_BUSY,
  TRUSTED_UA_ERROR.BROWSER_NOT_BOUND,
  TRUSTED_UA_ERROR.BROWSER_TAB_CLOSED,
  TRUSTED_UA_ERROR.BROWSER_FRAME_NOT_FOUND,
  TRUSTED_UA_ERROR.BROWSER_PERMISSION_DENIED,
  TRUSTED_UA_ERROR.BROWSER_ELEMENT_STALE,
  TRUSTED_UA_ERROR.BROWSER_TOOL_TIMEOUT,
  TRUSTED_UA_ERROR.BROWSER_DOWNLOAD_TOO_LARGE,
  TRUSTED_UA_ERROR.MCP_UNAVAILABLE,
  TRUSTED_UA_ERROR.MCP_TOOL_NOT_FOUND,
  TRUSTED_UA_ERROR.PROTOCOL_VERSION_MISMATCH,
  TRUSTED_UA_ERROR.INTERNAL,
  TRUSTED_UA_ERROR.MAIL_NO_CONTEXT,
  TRUSTED_UA_ERROR.MAIL_MESSAGE_NOT_FOUND,
  TRUSTED_UA_ERROR.MAIL_ATTACHMENT_NOT_FOUND,
  TRUSTED_UA_ERROR.MAIL_CURSOR_EXPIRED,
];

export const TRUSTED_UA_ERROR_CODES: ReadonlyMap<TrustedUaErrorCode, number> = new Map(
  ORDER.map((code, i) => [code, APP_ERROR_BASE + 1 + i]),
);

const NUMERIC_TO_CODE = new Map<number, TrustedUaErrorCode>([...TRUSTED_UA_ERROR_CODES].map(([c, n]) => [n, c]));

export function isTrustedUaErrorCode(value: unknown): value is TrustedUaErrorCode {
  return typeof value === "string" && TRUSTED_UA_ERROR_CODES.has(value as TrustedUaErrorCode);
}

/** JSON-RPC numeric code for a Pi Browser error code. */
export function trustedUaErrorNumeric(code: TrustedUaErrorCode): number {
  return TRUSTED_UA_ERROR_CODES.get(code) ?? APP_ERROR_BASE;
}

/**
 * Build a JSON-RPC error object carrying a structured code. The code rides
 * `data.trustedUaError`, and also `data.piBrowserError`, the name v0.4.0 and
 * older peers read (openspec rename-trusted-user-agent).
 */
export function toErrorObject(code: TrustedUaErrorCode, message: string, data?: unknown): JsonRpcErrorObject {
  return {
    code: trustedUaErrorNumeric(code),
    message,
    data: {
      trustedUaError: code,
      piBrowserError: code,
      ...(typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}),
    },
  };
}

/**
 * Recover the structured code from a JSON-RPC error object. Prefers the
 * explicit `data.trustedUaError` string, falls back to the reserved numeric
 * range, returns undefined for plain JSON-RPC/protocol errors.
 */
export function codeFromErrorObject(err: JsonRpcErrorObject | undefined | null): TrustedUaErrorCode | undefined {
  if (!err) return undefined;
  const data = err.data as { trustedUaError?: unknown; piBrowserError?: unknown } | undefined;
  if (data && isTrustedUaErrorCode(data.trustedUaError)) return data.trustedUaError;
  // v0.4.0 and older peers.
  if (data && isTrustedUaErrorCode(data.piBrowserError)) return data.piBrowserError;
  const byNumeric = NUMERIC_TO_CODE.get(err.code);
  return byNumeric;
}

/** Error type used internally on both sides of the link. */
export class TrustedUaProtocolError extends Error {
  constructor(
    public readonly code: TrustedUaErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "TrustedUaProtocolError";
  }

  toErrorObject(): JsonRpcErrorObject {
    return toErrorObject(this.code, this.message, this.data);
  }
}

/** Standard JSON-RPC error codes for protocol-level (non-Pi-Browser) failures. */
export const JSONRPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;
