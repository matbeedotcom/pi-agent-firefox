export const PI_BROWSER_ERROR = {
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
    BROWSER_PERMISSION_DENIED: "BROWSER_PERMISSION_DENIED",
    BROWSER_ELEMENT_STALE: "BROWSER_ELEMENT_STALE",
    BROWSER_TOOL_TIMEOUT: "BROWSER_TOOL_TIMEOUT",
    MCP_UNAVAILABLE: "MCP_UNAVAILABLE",
    MCP_TOOL_NOT_FOUND: "MCP_TOOL_NOT_FOUND",
    PROTOCOL_VERSION_MISMATCH: "PROTOCOL_VERSION_MISMATCH",
    INTERNAL: "INTERNAL",
};
/** JSON-RPC reserved range for application errors. */
const APP_ERROR_BASE = -32099;
const ORDER = [
    PI_BROWSER_ERROR.NATIVE_HOST_NOT_INSTALLED,
    PI_BROWSER_ERROR.NATIVE_HOST_VERSION_MISMATCH,
    PI_BROWSER_ERROR.PI_NOT_FOUND,
    PI_BROWSER_ERROR.PI_START_FAILED,
    PI_BROWSER_ERROR.ACP_INITIALIZATION_FAILED,
    PI_BROWSER_ERROR.ACP_CAPABILITY_UNSUPPORTED,
    PI_BROWSER_ERROR.SESSION_NOT_FOUND,
    PI_BROWSER_ERROR.SESSION_BUSY,
    PI_BROWSER_ERROR.BROWSER_NOT_BOUND,
    PI_BROWSER_ERROR.BROWSER_TAB_CLOSED,
    PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
    PI_BROWSER_ERROR.BROWSER_ELEMENT_STALE,
    PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT,
    PI_BROWSER_ERROR.MCP_UNAVAILABLE,
    PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND,
    PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH,
    PI_BROWSER_ERROR.INTERNAL,
];
export const PI_BROWSER_ERROR_CODES = new Map(ORDER.map((code, i) => [code, APP_ERROR_BASE + 1 + i]));
const NUMERIC_TO_CODE = new Map([...PI_BROWSER_ERROR_CODES].map(([c, n]) => [n, c]));
export function isPiBrowserErrorCode(value) {
    return typeof value === "string" && PI_BROWSER_ERROR_CODES.has(value);
}
/** JSON-RPC numeric code for a Pi Browser error code. */
export function piBrowserErrorNumeric(code) {
    return PI_BROWSER_ERROR_CODES.get(code) ?? APP_ERROR_BASE;
}
/** Build a JSON-RPC error object carrying a structured Pi Browser code. */
export function toErrorObject(code, message, data) {
    return {
        code: piBrowserErrorNumeric(code),
        message,
        data: {
            piBrowserError: code,
            ...(typeof data === "object" && data !== null ? data : {}),
        },
    };
}
/**
 * Recover the structured code from a JSON-RPC error object. Prefers the
 * explicit `data.piBrowserError` string, falls back to the reserved numeric
 * range, returns undefined for plain JSON-RPC/protocol errors.
 */
export function codeFromErrorObject(err) {
    if (!err)
        return undefined;
    const data = err.data;
    if (data && isPiBrowserErrorCode(data.piBrowserError))
        return data.piBrowserError;
    const byNumeric = NUMERIC_TO_CODE.get(err.code);
    return byNumeric;
}
/** Error type used internally on both sides of the link. */
export class PiBrowserProtocolError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = "PiBrowserProtocolError";
    }
    toErrorObject() {
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
};
//# sourceMappingURL=errors.js.map