/** True when a rejected request value is a structured JSON-RPC error object. */
export function isJsonRpcErrorObject(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const v = value;
    // The `jsonrpc` marker is present when a full response object is passed;
    // bare error objects ({ code, message, data }) are equally valid.
    return v.jsonrpc === "2.0" && typeof v.code === "number" && typeof v.message === "string";
}
/** True for any structured error object (with or without the jsonrpc marker). */
export function isStructuredErrorObject(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const v = value;
    return typeof v.code === "number" && typeof v.message === "string";
}
//# sourceMappingURL=transport.js.map