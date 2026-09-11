/**
 * Minimal JSON-RPC 2.0 envelope types shared by both sides of the
 * Native Messaging link. The native host frames these objects with
 * Firefox's 4-byte little-endian length prefix; the browser runtime
 * handles framing on the add-on side.
 */
export function isJsonRpcRequest(msg) {
    if (typeof msg !== "object" || msg === null)
        return false;
    const m = msg;
    return (m.jsonrpc === "2.0" &&
        typeof m.id === "number" &&
        typeof m.method === "string" &&
        m.result === undefined &&
        m.error === undefined);
}
export function isJsonRpcResponse(msg) {
    if (typeof msg !== "object" || msg === null)
        return false;
    const m = msg;
    return (m.jsonrpc === "2.0" &&
        typeof m.id === "number" &&
        (m.result !== undefined || m.error !== undefined));
}
export function isJsonRpcNotification(msg) {
    if (typeof msg !== "object" || msg === null)
        return false;
    const m = msg;
    return m.jsonrpc === "2.0" && m.id === undefined && typeof m.method === "string";
}
//# sourceMappingURL=jsonrpc.js.map