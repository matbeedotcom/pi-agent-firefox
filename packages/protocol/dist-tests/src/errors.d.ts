/**
 * Structured integration errors (PRODUCT.md §44).
 *
 * Neither side of the link may rely on parsing human-readable error
 * strings. Every protocol-level failure carries a stable code, mapped to a
 * dedicated JSON-RPC application error code (-320xx) and echoed in
 * `error.data.code` for readability.
 */
import type { JsonRpcErrorObject } from "./jsonrpc.js";
export declare const PI_BROWSER_ERROR: {
    readonly NATIVE_HOST_NOT_INSTALLED: "NATIVE_HOST_NOT_INSTALLED";
    readonly NATIVE_HOST_VERSION_MISMATCH: "NATIVE_HOST_VERSION_MISMATCH";
    readonly PI_NOT_FOUND: "PI_NOT_FOUND";
    readonly PI_START_FAILED: "PI_START_FAILED";
    readonly ACP_INITIALIZATION_FAILED: "ACP_INITIALIZATION_FAILED";
    readonly ACP_CAPABILITY_UNSUPPORTED: "ACP_CAPABILITY_UNSUPPORTED";
    readonly SESSION_NOT_FOUND: "SESSION_NOT_FOUND";
    readonly SESSION_BUSY: "SESSION_BUSY";
    readonly BROWSER_NOT_BOUND: "BROWSER_NOT_BOUND";
    readonly BROWSER_TAB_CLOSED: "BROWSER_TAB_CLOSED";
    readonly BROWSER_PERMISSION_DENIED: "BROWSER_PERMISSION_DENIED";
    readonly BROWSER_ELEMENT_STALE: "BROWSER_ELEMENT_STALE";
    readonly BROWSER_TOOL_TIMEOUT: "BROWSER_TOOL_TIMEOUT";
    readonly MCP_UNAVAILABLE: "MCP_UNAVAILABLE";
    readonly MCP_TOOL_NOT_FOUND: "MCP_TOOL_NOT_FOUND";
    readonly PROTOCOL_VERSION_MISMATCH: "PROTOCOL_VERSION_MISMATCH";
    readonly INTERNAL: "INTERNAL";
};
export type PiBrowserErrorCode = (typeof PI_BROWSER_ERROR)[keyof typeof PI_BROWSER_ERROR];
export declare const PI_BROWSER_ERROR_CODES: ReadonlyMap<PiBrowserErrorCode, number>;
export declare function isPiBrowserErrorCode(value: unknown): value is PiBrowserErrorCode;
/** JSON-RPC numeric code for a Pi Browser error code. */
export declare function piBrowserErrorNumeric(code: PiBrowserErrorCode): number;
/** Build a JSON-RPC error object carrying a structured Pi Browser code. */
export declare function toErrorObject(code: PiBrowserErrorCode, message: string, data?: unknown): JsonRpcErrorObject;
/**
 * Recover the structured code from a JSON-RPC error object. Prefers the
 * explicit `data.piBrowserError` string, falls back to the reserved numeric
 * range, returns undefined for plain JSON-RPC/protocol errors.
 */
export declare function codeFromErrorObject(err: JsonRpcErrorObject | undefined | null): PiBrowserErrorCode | undefined;
/** Error type used internally on both sides of the link. */
export declare class PiBrowserProtocolError extends Error {
    readonly code: PiBrowserErrorCode;
    readonly data?: unknown | undefined;
    constructor(code: PiBrowserErrorCode, message: string, data?: unknown | undefined);
    toErrorObject(): JsonRpcErrorObject;
}
/** Standard JSON-RPC error codes for protocol-level (non-Pi-Browser) failures. */
export declare const JSONRPC_ERROR: {
    readonly PARSE: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL: -32603;
};
//# sourceMappingURL=errors.d.ts.map