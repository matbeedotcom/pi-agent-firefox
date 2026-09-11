/**
 * Unit tests for the add-on's pure logic, with browser-API stubs.
 * (DOM/background lifecycle is covered by the live E2E in task-7.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { BROWSER_TOOLS, PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { SessionStore } from "../src/background/session-store.js";
import { ToolDispatcher } from "../src/background/tool-dispatcher.js";
import { McpServer } from "../src/background/mcp-server.js";

// ---------------------------------------------------------------------------
// browser API stub
// ---------------------------------------------------------------------------

interface StubTabs {
  get: (tabId: number) => Promise<any>;
  captureVisibleTab: (windowId: number, opts?: unknown) => Promise<string>;
  reload: (tabId: number) => Promise<void>;
  sendMessage: (tabId: number, message: { type: string }) => Promise<unknown>;
}

const stub: {
  storage: { local: { get: (k: string) => Promise<Record<string, unknown>>; set: (o: Record<string, unknown>) => Promise<void> } };
  tabs: StubTabs;
  scripting: { executeScript: (o: unknown) => Promise<void> };
  runtime: unknown;
} = {
  storage: {
    local: {
      async get() {
        return {};
      },
      async set() {},
    },
  },
  tabs: {
    async get(tabId: number) {
      throw new Error(`no tab ${tabId}`);
    },
    async captureVisibleTab() {
      return "data:image/png;base64,QUJD";
    },
    async reload() {},
    async sendMessage(_tabId: number, _message: { type: string }) {
      // Mirrors real behavior: the content script always resolves with an
      // {ok, data|error} envelope; a missing content script rejects with the
      // "receiving end" error the dispatcher special-cases.
      const reply = (globalThis as { __contentReply?: unknown }).__contentReply;
      if (!reply) throw new Error("Could not establish connection. Receiving end does not exist.");
      return reply;
    },
  },
  scripting: { async executeScript() {} },
  runtime: {},
};

before(() => {
  (globalThis as { browser?: unknown }).browser = stub;
});

after(() => {
  delete (globalThis as { browser?: unknown }).browser;
});

function tab(id: number, url = "http://localhost:5173/", title = "Test Page"): any {
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
  const backing = new Map<string, unknown>();
  const realGet = stub.storage.local.get;
  const realSet = stub.storage.local.set;
  stub.storage.local.get = async (key: string) => (backing.has(key) ? { [key]: backing.get(key) } : {});
  stub.storage.local.set = async (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) backing.set(k, v);
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
  } finally {
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
  await assert.rejects(
    d.handleToolCall({ sessionId: "nope", tool: "browser_get_page", arguments: {} }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_NOT_BOUND,
  );
});

test("ToolDispatcher: closed tab -> BROWSER_TAB_CLOSED (never another tab)", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 42, windowId: 1 });
  stub.tabs.get = async () => {
    throw new Error("No such tab");
  };
  const d = new ToolDispatcher(store);
  await assert.rejects(
    d.handleToolCall({ sessionId: "s1", tool: "browser_click", arguments: { ref: "el-1" } }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_TAB_CLOSED,
  );
});

test("ToolDispatcher: unknown tool -> MCP_TOOL_NOT_FOUND", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 1, windowId: 1 });
  stub.tabs.get = async () => tab(1);
  const d = new ToolDispatcher(store);
  await assert.rejects(
    d.handleToolCall({ sessionId: "s1", tool: "browser_explode", arguments: {} }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND,
  );
});

test("ToolDispatcher: browser_get_page returns url/title/viewport via content script", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 7, windowId: 1 });
  stub.tabs.get = async () => tab(7, "http://localhost:5173/login", "Login");
  // Content script reply for pi:viewport (via the stubbed sendMessage path).
  (globalThis as { __contentReply?: unknown }).__contentReply = { ok: true, data: { width: 1280, height: 800 } };
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({ sessionId: "s1", tool: "browser_get_page", arguments: {} })) as {
    content: Array<{ type: string; text: string }>;
  };
  const parsed = JSON.parse(result.content[0].text) as { url: string; title: string; viewport: { width: number } };
  assert.equal(parsed.url, "http://localhost:5173/login");
  assert.equal(parsed.title, "Login");
  assert.equal(parsed.viewport.width, 1280);
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: stale element ref surfaces BROWSER_ELEMENT_STALE", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 3, windowId: 1 });
  stub.tabs.get = async () => tab(3);
  (globalThis as { __contentReply?: unknown }).__contentReply = {
    ok: false,
    error: { code: "BROWSER_ELEMENT_STALE", message: "element reference el-9 is stale (page changed or element removed)" },
  };
  const d = new ToolDispatcher(store);
  await assert.rejects(
    d.handleToolCall({ sessionId: "s1", tool: "browser_click", arguments: { ref: "el-9" } }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_ELEMENT_STALE,
  );
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

// ---------------------------------------------------------------------------
// McpServer (Firefox side of MCP-over-ACP)
// ---------------------------------------------------------------------------

test("McpServer: connect with unknown serverId fails; declared server connects", async () => {
  const fakeDispatcher = {
    handleToolCall: async (p: { sessionId: string; tool: string }) => ({
      content: [{ type: "text", text: `ok:${p.sessionId}:${p.tool}` }],
    }),
  } as never;
  const server = new McpServer(fakeDispatcher);

  await assert.rejects(
    server.handleConnect({ serverId: "nope" }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE,
  );

  const serverId = server.declareFor("session-1");
  const conn = await server.handleConnect({ serverId });
  assert.ok(conn.connectionId);

  // initialize handshake
  const init = (await server.handleMessage({ connectionId: conn.connectionId, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as {
    protocolVersion: string;
    serverInfo: { name: string };
  };
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(init.serverInfo.name, "pi-browser-firefox");

  await server.handleMessage({ connectionId: conn.connectionId, method: "notifications/initialized" });

  // tools/list serves all 8 MCP-compatible browser tools
  const list = (await server.handleMessage({ connectionId: conn.connectionId, method: "tools/list" })) as {
    tools: Array<{ name: string }>;
  };
  assert.equal(list.tools.length, BROWSER_TOOLS.length);
  assert.deepEqual(list.tools.map((t) => t.name).sort(), [...BROWSER_TOOLS.map((t) => t.name)].sort());

  // tools/call routes to the dispatcher with the right session
  const call = (await server.handleMessage({
    connectionId: conn.connectionId,
    method: "tools/call",
    params: { name: "browser_get_page", arguments: {} },
  })) as { content: Array<{ text: string }> };
  assert.equal(call.content[0].text, "ok:session-1:browser_get_page");

  await server.handleDisconnect({ connectionId: conn.connectionId });
  await assert.rejects(
    server.handleMessage({ connectionId: conn.connectionId, method: "tools/list" }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE,
  );
});
