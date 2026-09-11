/**
 * Unit tests for the add-on's pure logic, with browser-API stubs.
 * (DOM/background lifecycle is covered by the live E2E in task-7.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { BROWSER_TOOLS, CONTROL_TOOLS, PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { AcpClient } from "../src/background/acp-client.js";
import { SessionStore } from "../src/background/session-store.js";
import { ToolDispatcher } from "../src/background/tool-dispatcher.js";
import { McpServer } from "../src/background/mcp-server.js";

// ---------------------------------------------------------------------------
// browser API stub
// ---------------------------------------------------------------------------

interface StubTabs {
  get: (tabId: number) => Promise<any>;
  captureTab: (tabId: number, opts?: unknown) => Promise<string>;
  captureVisibleTab: (windowIdOrOpts: number | { format?: string }, maybeOpts?: unknown) => Promise<string>;
  reload: (tabId: number) => Promise<void>;
  update: (tabId: number, props: { active?: boolean }) => Promise<any>;
  sendMessage: (tabId: number, message: { type: string }) => Promise<unknown>;
}

// Shared capture stub. Both capture APIs share the fail counter so tests can
// model: 0 -> captureTab succeeds (direct); 1 -> captureTab fails, fallback
// succeeds; N>1 -> enough failures to exhaust captureTab + the focus-settle
// retry loop (everything fails).
async function captureStub(): Promise<string> {
  const fail = (globalThis as { __captureFail?: number }).__captureFail;
  if (fail && fail > 0) {
    (globalThis as { __captureFail?: number }).__captureFail = fail - 1;
    throw new Error(`Cannot capture a tab that is not visible in its window`);
  }
  return "data:image/png;base64,QUJD";
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
    async captureTab(_tabId: number, _opts?: unknown) {
      return captureStub();
    },
    async captureVisibleTab(_windowIdOrOpts: number | { format?: string }, _maybeOpts?: unknown) {
      return captureStub();
    },
    async reload() {},
    async update() {
      return {};
    },
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
  runtime: {
    // Controllable native-messaging stub for AcpClient tests.
    connectNativeCalls: 0,
    mode: "fail" as "fail" | "ok",
    lastError: undefined as { message?: string } | undefined,
    lastPort: undefined as any,
    connectNative(_name: string) {
      (stub.runtime as any).connectNativeCalls++;
      if ((stub.runtime as any).mode === "fail") {
        throw new Error("Could not connect to any native messaging host");
      }
      const listeners: { message: Array<(m: unknown) => void>; disconnect: Array<() => void> } = { message: [], disconnect: [] };
      (stub.runtime as any).lastPort = {
        listeners,
        postMessage() {},
        onMessage: { addListener: (fn: (m: unknown) => void) => listeners.message.push(fn) },
        onDisconnect: { addListener: (fn: () => void) => listeners.disconnect.push(fn) },
        disconnect() {},
      };
      return (stub.runtime as any).lastPort;
    },
    getManifest: () => ({ version: "0.1.0" }),
  },
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

test("ToolDispatcher: screenshot via captureTab (direct) records the method", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  // No failures: captureTab (the specific-tab path) succeeds immediately.
  (globalThis as { __captureFail?: number }).__captureFail = 0;
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_screenshot",
    arguments: {},
  })) as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };
  assert.equal(result.content[0].type, "image", "first block is the image");
  assert.equal(result.content[0].mimeType, "image/png");
  // imageResult strips the data: prefix; data is raw base64.
  assert.equal(result.content[0].data, "QUJD");
  // A short note records which capture API produced the image.
  const note = result.content.find((c) => c.type === "text")?.text ?? "";
  assert.ok(note.includes("captureTab"), `note names the method: ${note}`);
  delete (globalThis as { __captureFail?: number }).__captureFail;
});

test("ToolDispatcher: screenshot falls back to captureVisibleTab when captureTab fails", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  // captureTab fails once (fail=1); the captureVisibleTab path then succeeds
  // on its first attempt after activation.
  (globalThis as { __captureFail?: number }).__captureFail = 1;
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_screenshot",
    arguments: {},
  })) as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };
  assert.equal(result.content[0].type, "image", "image returned via the fallback path");
  assert.equal(result.content[0].data, "QUJD");
  const note = result.content.find((c) => c.type === "text")?.text ?? "";
  assert.ok(note.includes("captureVisibleTab"), `note names the fallback method: ${note}`);
  delete (globalThis as { __captureFail?: number }).__captureFail;
});

test("ToolDispatcher: screenshot that stays invisible raises structured BROWSER_PERMISSION_DENIED", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  // Every capture attempt fails across the whole retry loop: the tab
  // genuinely cannot be made visible (e.g. occluded window). The agent gets
  // a structured code. 999 exceeds the max number of attempts in the loop.
  (globalThis as { __captureFail?: number }).__captureFail = 999;
  const d = new ToolDispatcher(store);
  await assert.rejects(
    d.handleToolCall({ sessionId: "s1", tool: "browser_screenshot", arguments: {} }),
    (err: unknown) =>
      err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
  );
  delete (globalThis as { __captureFail?: number }).__captureFail;
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
  const controlCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const control = async (tool: string, args: Record<string, unknown>) => {
    controlCalls.push({ tool, args });
    if (tool === "pi_get_state") return { status: { state: "connected" }, sessions: [{ sessionId: "session-1" }] };
    if (tool === "pi_cancel") {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, "unknown session: s404");
    }
    return { ok: true };
  };
  const server = new McpServer(fakeDispatcher, control);

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

  // tools/list serves the browser tools + the control tools
  const list = (await server.handleMessage({ connectionId: conn.connectionId, method: "tools/list" })) as {
    tools: Array<{ name: string }>;
  };
  assert.equal(list.tools.length, BROWSER_TOOLS.length + CONTROL_TOOLS.length);
  assert.deepEqual(
    list.tools.map((t) => t.name).sort(),
    [...BROWSER_TOOLS.map((t) => t.name), ...CONTROL_TOOLS.map((t) => t.name)].sort(),
  );

  // tools/call routes browser tools to the dispatcher with the right session
  const call = (await server.handleMessage({
    connectionId: conn.connectionId,
    method: "tools/call",
    params: { name: "browser_get_page", arguments: {} },
  })) as { content: Array<{ text: string }> };
  assert.equal(call.content[0].text, "ok:session-1:browser_get_page");

  // tools/call routes control tools to the control handler (args passed through)
  const state = (await server.handleMessage({
    connectionId: conn.connectionId,
    method: "tools/call",
    params: { name: "pi_get_state", arguments: {} },
  })) as { content: Array<{ type: string; text: string }> };
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
  await assert.rejects(
    server.handleMessage({
      connectionId: conn.connectionId,
      method: "tools/call",
      params: { name: "pi_cancel", arguments: { sessionId: "s404" } },
    }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.SESSION_NOT_FOUND,
  );

  await server.handleDisconnect({ connectionId: conn.connectionId });
  await assert.rejects(
    server.handleMessage({ connectionId: conn.connectionId, method: "tools/list" }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE,
  );
});

test("McpServer: control tools are rejected without a control handler", async () => {
  const fakeDispatcher = {
    handleToolCall: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as never;
  const server = new McpServer(fakeDispatcher);
  const serverId = server.declareFor("session-2");
  const conn = await server.handleConnect({ serverId });
  await server.handleMessage({ connectionId: conn.connectionId, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await server.handleMessage({ connectionId: conn.connectionId, method: "notifications/initialized" });
  await assert.rejects(
    server.handleMessage({
      connectionId: conn.connectionId,
      method: "tools/call",
      params: { name: "pi_get_state", arguments: {} },
    }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND,
  );
});

// ---------------------------------------------------------------------------
// AcpClient: auto-detection (add-on-first onboarding)
// ---------------------------------------------------------------------------

function makeClient(statuses: string[]): AcpClient {
  return new AcpClient({
    onSessionUpdate() {},
    onToolCall: async () => ({}),
    onMcpConnect: async () => ({ connectionId: "c" }) as never,
    onMcpMessage: async () => ({} as never),
    onMcpDisconnect: async () => {},
    onStatus: (s) => statuses.push(s.state),
    onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }) as never,
  });
}

test("AcpClient: auto-detects a host installed after the add-on loaded", async () => {
  const rt = stub.runtime as any;
  const statuses: string[] = [];
  rt.connectNativeCalls = 0;
  rt.lastError = undefined;

  // 1) Add-on loads while the host is NOT installed (add-on-first order).
  rt.mode = "fail";
  const client = makeClient(statuses);
  client.start();
  assert.equal(client.connected, false, "not connected while host missing");
  assert.equal(rt.connectNativeCalls, 1, "one connect attempt");
  assert.ok(statuses.includes("not_installed"), `status reflects not_installed: ${statuses}`);

  // 2) Host still missing: ensureConnected() is safe (no double connect in
  //    flight) and does not hang the page.
  client.ensureConnected();
  assert.equal(rt.connectNativeCalls, 2, "retry attempts the connect");
  assert.equal(client.connected, false);

  // 3) The host gets installed (plugin-first completes later). The next
  //    keepalive ensureConnected() detects it — this is the auto-detection
  //    that makes add-on-first onboarding work without a reload.
  rt.mode = "ok";
  client.ensureConnected();
  assert.equal(client.connected, true, "auto-detected the newly installed host");
  assert.equal(rt.connectNativeCalls, 3);

  // 4) Idempotent: repeated ensureConnected() while connected opens no new port.
  client.ensureConnected();
  client.ensureConnected();
  assert.equal(rt.connectNativeCalls, 3, "no duplicate ports while connected");

  // 5) After a disconnect, the next ensureConnected() reconnects.
  (rt.lastError = { message: "native port disconnected" });
  rt.lastPort.listeners.disconnect.forEach((fn: () => void) => fn());
  assert.equal(client.connected, false, "port dropped");
  client.ensureConnected();
  assert.equal(client.connected, true, "reconnected after drop");
  assert.equal(rt.connectNativeCalls, 4);

  client.stop(); // clear any pending reconnect timers
});
