import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_TOOLS, BROWSER_TOOL_NAMES, getBrowserTool, isBrowserTool, isMutatingBrowserTool, } from "../src/browser-tools.js";
import { codeFromErrorObject, isPiBrowserErrorCode, PI_BROWSER_ERROR, PI_BROWSER_ERROR_CODES, PiBrowserProtocolError, toErrorObject, } from "../src/errors.js";
import { PI_BROWSER, PI_BROWSER_META, X_PI_BROWSER } from "../src/integration.js";
import { isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from "../src/jsonrpc.js";
test("browser tool registry: names are unique and well-formed", () => {
    const names = BROWSER_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
        assert.match(name, /^browser_[a-z_]+$/);
    }
    assert.deepEqual([...BROWSER_TOOL_NAMES], names);
    assert.ok(isBrowserTool("browser_get_page"));
    assert.ok(!isBrowserTool("browser_nope"));
    assert.equal(getBrowserTool("browser_click")?.readOnly, false);
    assert.equal(isMutatingBrowserTool("browser_click"), true);
    assert.equal(isMutatingBrowserTool("browser_get_dom"), false);
});
test("browser tool input schemas are JSON Schema objects", () => {
    for (const tool of BROWSER_TOOLS) {
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.ok(typeof tool.description === "string" && tool.description.length > 10);
    }
});
test("error codes map to unique reserved JSON-RPC codes", () => {
    const numeric = [...PI_BROWSER_ERROR_CODES.values()];
    assert.equal(new Set(numeric).size, numeric.length);
    for (const n of numeric) {
        assert.ok(n >= -32099 && n <= -32001, `code out of range: ${n}`);
    }
    const err = toErrorObject(PI_BROWSER_ERROR.BROWSER_TAB_CLOSED, "tab gone", { tabId: 3 });
    assert.equal(err.data?.piBrowserError, "BROWSER_TAB_CLOSED");
    assert.equal(codeFromErrorObject(err), "BROWSER_TAB_CLOSED");
    assert.equal(codeFromErrorObject({ code: -32601, message: "nope" }), undefined);
    assert.ok(isPiBrowserErrorCode(PI_BROWSER_ERROR.SESSION_NOT_FOUND));
    assert.ok(!isPiBrowserErrorCode("NOPE"));
    const p = new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, "busy");
    assert.equal(p.toErrorObject().data?.piBrowserError, "SESSION_BUSY");
});
test("integration metadata is stable and complete", () => {
    assert.equal(PI_BROWSER.nativeHost, "dev.pi.browser");
    assert.equal(PI_BROWSER.extensionId, "pi-browser@pi.dev");
    assert.equal(PI_BROWSER_META.protocolVersion, 1);
    assert.equal(PI_BROWSER_META.browserToolVersion, 1);
    assert.equal(X_PI_BROWSER.tool, "x-pi-browser/tool");
});
test("jsonrpc guards discriminate messages", () => {
    assert.ok(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} }));
    assert.ok(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} }));
    assert.ok(isJsonRpcResponse({ jsonrpc: "2.0", id: 2, error: { code: -1, message: "x" } }));
    assert.ok(isJsonRpcNotification({ jsonrpc: "2.0", method: "session/update", params: {} }));
    assert.ok(!isJsonRpcRequest({ jsonrpc: "2.0", id: 1, result: {} }));
    assert.ok(!isJsonRpcResponse({ jsonrpc: "2.0", id: 1, method: "x" }));
});
//# sourceMappingURL=protocol.test.js.map