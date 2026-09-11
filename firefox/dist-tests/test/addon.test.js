/**
 * Unit tests for the add-on's pure logic, with browser-API stubs.
 * (DOM/background lifecycle is covered by the live E2E in task-7.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_TOOLS, CONTROL_TOOLS, PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { SessionStore } from "../src/background/session-store.js";
import { ToolDispatcher } from "../src/background/tool-dispatcher.js";
import { McpServer } from "../src/background/mcp-server.js";
const stub = {
    storage: {
        local: {
            async get() {
                return {};
            },
            async set() { },
        },
    },
    tabs: {
        async get(tabId) {
            throw new Error(`no tab ${tabId}`);
        },
        // captureTab(tabId, opts) — the dispatcher's PREFERRED path (no OS focus
        // needed). Shares the same fail counter as captureVisibleTab so tests can
        // model "direct capture fails, focused capture works" or "everything fails".
        async captureTab(_tabId, _opts) {
            const fail = globalThis.__captureFail;
            if (fail && fail > 0) {
                globalThis.__captureFail = fail - 1;
                throw new Error(`Cannot capture a tab that is not visible in its window`);
            }
            return "data:image/png;base64,QUJD";
        },
        // Two call forms: captureVisibleTab(windowId, opts) and
        // captureVisibleTab(opts). Used as the fallback when captureTab fails.
        async captureVisibleTab(_windowIdOrOpts, _maybeOpts) {
            const fail = globalThis.__captureFail;
            if (fail && fail > 0) {
                globalThis.__captureFail = fail - 1;
                throw new Error(`Cannot capture a tab that is not visible in its window`);
            }
            return "data:image/png;base64,QUJD";
        },
        async reload() { },
        async update() {
            return {};
        },
        async sendMessage(_tabId, _message) {
            // Mirrors real behavior: the content script always resolves with an
            // {ok, data|error} envelope; a missing content script rejects with the
            // "receiving end" error the dispatcher special-cases.
            const reply = globalThis.__contentReply;
            if (!reply)
                throw new Error("Could not establish connection. Receiving end does not exist.");
            return reply;
        },
    },
    scripting: { async executeScript() { } },
    runtime: {},
};
before(() => {
    globalThis.browser = stub;
});
after(() => {
    delete globalThis.browser;
});
function tab(id, url = "http://localhost:5173/", title = "Test Page") {
    return { id, url, title, windowId: 1 };
}
// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------
test("SessionStore: bindings persist and round-trip", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.bind("s1", { tabId: 10, windowId: 1, tabTitle: "A" });
    store.bind("s2", { tabId: 20, windowId: 2 });
    assert.equal(store.getBinding("s1")?.tabId, 10);
    assert.equal(store.sessionForTab(20), "s2");
    assert.equal(store.sessionForTab(99), undefined);
    store.unbind("s1");
    assert.equal(store.getBinding("s1"), undefined);
});
test("SessionStore: hydration from persisted state restores bindings", async () => {
    const backing = new Map();
    const realGet = stub.storage.local.get;
    const realSet = stub.storage.local.set;
    stub.storage.local.get = async (key) => (backing.has(key) ? { [key]: backing.get(key) } : {});
    stub.storage.local.set = async (obj) => {
        for (const [k, v] of Object.entries(obj))
            backing.set(k, v);
    };
    try {
        const store = new SessionStore();
        await store.hydrate();
        store.bind("s9", { tabId: 77, windowId: 1 });
        store.setLastSession("s9");
        // Simulate a browser restart. Bindings + last session survive; session
        // VIEWS are deliberately not persisted (ACP/Pi is authoritative and
        // they are rebuilt from session/list).
        const store2 = new SessionStore();
        await store2.hydrate();
        assert.equal(store2.getBinding("s9")?.tabId, 77);
        assert.equal(store2.lastSession, "s9");
        assert.equal(store2.get("s9"), undefined);
    }
    finally {
        stub.storage.local.get = realGet;
        stub.storage.local.set = realSet;
    }
});
test("SessionStore: snapshot carries views, bindings, and last session", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.upsertFromList([
        { sessionId: "a", cwd: "/x", updatedAt: "2027-01-01T00:00:00Z", title: "A" },
        { sessionId: "b", cwd: "/y", updatedAt: "2027-01-02T00:00:00Z" },
    ]);
    store.upsertCreated("c", "/z");
    store.bind("b", { tabId: 5, windowId: 1 });
    store.setStreaming("a", true);
    store.setLastSession("b");
    const snap = store.snapshot();
    assert.equal(snap.sessions.length, 3);
    assert.equal(snap.lastSessionId, "b");
    const a = snap.sessions.find((s) => s.sessionId === "a");
    assert.equal(a?.streaming, true);
    const b = snap.sessions.find((s) => s.sessionId === "b");
    assert.equal(b?.binding?.tabId, 5);
    // sorted by updatedAt desc
    assert.deepEqual(snap.sessions.map((s) => s.sessionId)[0], "b");
});
// ---------------------------------------------------------------------------
// ToolDispatcher: error precedence & tool routing
// ---------------------------------------------------------------------------
test("ToolDispatcher: unbound session -> BROWSER_NOT_BOUND", async () => {
    const store = new SessionStore();
    await store.hydrate();
    const d = new ToolDispatcher(store);
    await assert.rejects(d.handleToolCall({ sessionId: "nope", tool: "browser_get_page", arguments: {} }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_NOT_BOUND);
});
test("ToolDispatcher: closed tab -> BROWSER_TAB_CLOSED (never another tab)", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.bind("s1", { tabId: 42, windowId: 1 });
    stub.tabs.get = async () => {
        throw new Error("No such tab");
    };
    const d = new ToolDispatcher(store);
    await assert.rejects(d.handleToolCall({ sessionId: "s1", tool: "browser_click", arguments: { ref: "el-1" } }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_TAB_CLOSED);
});
test("ToolDispatcher: unknown tool -> MCP_TOOL_NOT_FOUND", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.bind("s1", { tabId: 1, windowId: 1 });
    stub.tabs.get = async () => tab(1);
    const d = new ToolDispatcher(store);
    await assert.rejects(d.handleToolCall({ sessionId: "s1", tool: "browser_explode", arguments: {} }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND);
});
test("ToolDispatcher: browser_get_page returns url/title/viewport via content script", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.bind("s1", { tabId: 7, windowId: 1 });
    stub.tabs.get = async () => tab(7, "http://localhost:5173/login", "Login");
    // Content script reply for pi:viewport (via the stubbed sendMessage path).
    globalThis.__contentReply = { ok: true, data: { width: 1280, height: 800 } };
    const d = new ToolDispatcher(store);
    const result = (await d.handleToolCall({ sessionId: "s1", tool: "browser_get_page", arguments: {} }));
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.url, "http://localhost:5173/login");
    assert.equal(parsed.title, "Login");
    assert.equal(parsed.viewport.width, 1280);
    delete globalThis.__contentReply;
});
test("ToolDispatcher: stale element ref surfaces BROWSER_ELEMENT_STALE", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.bind("s1", { tabId: 3, windowId: 1 });
    stub.tabs.get = async () => tab(3);
    globalThis.__contentReply = {
        ok: false,
        error: { code: "BROWSER_ELEMENT_STALE", message: "element reference el-9 is stale (page changed or element removed)" },
    };
    const d = new ToolDispatcher(store);
    await assert.rejects(d.handleToolCall({ sessionId: "s1", tool: "browser_click", arguments: { ref: "el-9" } }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_ELEMENT_STALE);
    delete globalThis.__contentReply;
});
test("ToolDispatcher: screenshot of a background tab activates it, retries, and succeeds", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.bind("s1", { tabId: 9, windowId: 1 });
    stub.tabs.get = async () => tab(9);
    // First capture attempt fails with the real-world visibility error; the
    // retry after activation succeeds. This mirrors the snap/GNOME setup where
    // the bound tab is a background tab until the addon activates it.
    // A few capture attempts fail with the real-world visibility error, then
    // succeed once the (simulated) window-manager focus settles. This mirrors
    // the snap/GNOME setup where focus is delivered asynchronously.
    globalThis.__captureFail = 2;
    const d = new ToolDispatcher(store);
    const result = (await d.handleToolCall({
        sessionId: "s1",
        tool: "browser_screenshot",
        arguments: {},
    }));
    assert.equal(result.content[0].type, "image", "succeeded after the focus-settle retry loop");
    assert.equal(result.content[0].mimeType, "image/png");
    // imageResult strips the data: prefix; data is raw base64.
    assert.equal(result.content[0].data, "QUJD");
    delete globalThis.__captureFail;
});
test("ToolDispatcher: screenshot that stays invisible raises structured BROWSER_PERMISSION_DENIED", async () => {
    const store = new SessionStore();
    await store.hydrate();
    store.bind("s1", { tabId: 9, windowId: 1 });
    stub.tabs.get = async () => tab(9);
    // Every capture attempt fails across the whole retry loop: the tab
    // genuinely cannot be made visible (e.g. occluded window). The agent gets
    // a structured code. 999 exceeds the max number of attempts in the loop.
    globalThis.__captureFail = 999;
    const d = new ToolDispatcher(store);
    await assert.rejects(d.handleToolCall({ sessionId: "s1", tool: "browser_screenshot", arguments: {} }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED);
    delete globalThis.__captureFail;
});
// ---------------------------------------------------------------------------
// McpServer (Firefox side of MCP-over-ACP)
// ---------------------------------------------------------------------------
test("McpServer: connect with unknown serverId fails; declared server connects", async () => {
    const fakeDispatcher = {
        handleToolCall: async (p) => ({
            content: [{ type: "text", text: `ok:${p.sessionId}:${p.tool}` }],
        }),
    };
    const controlCalls = [];
    const control = async (tool, args) => {
        controlCalls.push({ tool, args });
        if (tool === "pi_get_state")
            return { status: { state: "connected" }, sessions: [{ sessionId: "session-1" }] };
        if (tool === "pi_cancel") {
            throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, "unknown session: s404");
        }
        return { ok: true };
    };
    const server = new McpServer(fakeDispatcher, control);
    await assert.rejects(server.handleConnect({ serverId: "nope" }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE);
    const serverId = server.declareFor("session-1");
    const conn = await server.handleConnect({ serverId });
    assert.ok(conn.connectionId);
    // initialize handshake
    const init = (await server.handleMessage({ connectionId: conn.connectionId, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.equal(init.serverInfo.name, "pi-browser-firefox");
    await server.handleMessage({ connectionId: conn.connectionId, method: "notifications/initialized" });
    // tools/list serves the browser tools + the control tools
    const list = (await server.handleMessage({ connectionId: conn.connectionId, method: "tools/list" }));
    assert.equal(list.tools.length, BROWSER_TOOLS.length + CONTROL_TOOLS.length);
    assert.deepEqual(list.tools.map((t) => t.name).sort(), [...BROWSER_TOOLS.map((t) => t.name), ...CONTROL_TOOLS.map((t) => t.name)].sort());
    // tools/call routes browser tools to the dispatcher with the right session
    const call = (await server.handleMessage({
        connectionId: conn.connectionId,
        method: "tools/call",
        params: { name: "browser_get_page", arguments: {} },
    }));
    assert.equal(call.content[0].text, "ok:session-1:browser_get_page");
    // tools/call routes control tools to the control handler (args passed through)
    const state = (await server.handleMessage({
        connectionId: conn.connectionId,
        method: "tools/call",
        params: { name: "pi_get_state", arguments: {} },
    }));
    assert.equal(state.content[0].type, "text");
    assert.ok(state.content[0].text.includes("\"status\""), "control result JSON-serialized");
    assert.deepEqual(controlCalls, [{ tool: "pi_get_state", args: {} }]);
    await server.handleMessage({
        connectionId: conn.connectionId,
        method: "tools/call",
        params: { name: "pi_new_session", arguments: { cwd: "/work/x" } },
    });
    assert.deepEqual(controlCalls[1], { tool: "pi_new_session", args: { cwd: "/work/x" } });
    // Structured errors from the control handler propagate unchanged
    await assert.rejects(server.handleMessage({
        connectionId: conn.connectionId,
        method: "tools/call",
        params: { name: "pi_cancel", arguments: { sessionId: "s404" } },
    }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.SESSION_NOT_FOUND);
    await server.handleDisconnect({ connectionId: conn.connectionId });
    await assert.rejects(server.handleMessage({ connectionId: conn.connectionId, method: "tools/list" }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE);
});
test("McpServer: control tools are rejected without a control handler", async () => {
    const fakeDispatcher = {
        handleToolCall: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const server = new McpServer(fakeDispatcher);
    const serverId = server.declareFor("session-2");
    const conn = await server.handleConnect({ serverId });
    await server.handleMessage({ connectionId: conn.connectionId, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await server.handleMessage({ connectionId: conn.connectionId, method: "notifications/initialized" });
    await assert.rejects(server.handleMessage({
        connectionId: conn.connectionId,
        method: "tools/call",
        params: { name: "pi_get_state", arguments: {} },
    }), (err) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND);
});
