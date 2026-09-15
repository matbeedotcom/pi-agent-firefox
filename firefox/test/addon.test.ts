/**
 * Unit tests for the add-on's pure logic, with browser-API stubs.
 * (DOM/background lifecycle is covered by the live E2E in task-7.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { BROWSER_TOOLS, CONTROL_TOOLS, PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { AcpClient, SessionStore, bindingOwner, bindingRefId } from "@pi-browser/webext";
import { ToolDispatcher } from "../src/background/tool-dispatcher.js";
import { ReplTabs } from "../src/background/repl-tabs.js";
import { McpServer } from "../src/background/mcp-server.js";
import { networkLog } from "../src/background/network-log.js";

// ---------------------------------------------------------------------------
// browser API stub
// ---------------------------------------------------------------------------

interface StubTabs {
  get: (tabId: number) => Promise<any>;
  captureTab: (tabId: number, opts?: unknown) => Promise<string>;
  captureVisibleTab: (windowIdOrOpts: number | { format?: string }, maybeOpts?: unknown) => Promise<string>;
  reload: (tabId: number) => Promise<void>;
  update: (tabId: number, props: { active?: boolean; url?: string }) => Promise<any>;
  create: (props: { url?: string; active?: boolean }) => Promise<any>;
  remove: (tabId: number) => Promise<void>;
  query: (props: Record<string, unknown>) => Promise<any[]>;
  sendMessage: (tabId: number, message: { type: string }, options?: { frameId?: number }) => Promise<unknown>;
  onRemoved: ListenerHub;
}

/** Tiny addListener recorder for the event-page style browser.* stubs. */
interface ListenerHub {
  listeners: Array<(d: any) => void>;
  addListener: (fn: (d: any) => void) => void;
}

function listenerHub(): ListenerHub {
  const listeners: Array<(d: any) => void> = [];
  return { listeners, addListener: (fn) => listeners.push(fn) };
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
  webRequest: {
    onBeforeRequest: ListenerHub;
    onCompleted: ListenerHub;
    onErrorOccurred: ListenerHub;
  };
  webNavigation: { getAllFrames: (o: { tabId: number }) => Promise<Array<{ frameId: number; url: string }>> };
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
    async update(tabId: number, props: { active?: boolean; url?: string }) {
      (globalThis as { __tabUpdates?: unknown[] }).__tabUpdates = [
        ...((globalThis as { __tabUpdates?: unknown[] }).__tabUpdates ?? []),
        { tabId, props },
      ];
      return { id: tabId, ...props };
    },
    async create(props: { url?: string; active?: boolean }) {
      const id = ((globalThis as { __nextTabId?: number }).__nextTabId ??= 1000) + 1;
      (globalThis as { __nextTabId?: number }).__nextTabId = id;
      const created = { id, url: props.url, title: props.url, windowId: 1 };
      (globalThis as { __createdTabs?: unknown[] }).__createdTabs = [
        ...((globalThis as { __createdTabs?: unknown[] }).__createdTabs ?? []),
        created,
      ];
      return created;
    },
    async remove(tabId: number) {
      (globalThis as { __removedTabs?: number[] }).__removedTabs = [
        ...((globalThis as { __removedTabs?: number[] }).__removedTabs ?? []),
        tabId,
      ];
    },
    async query() {
      return (globalThis as { __tabsList?: any[] }).__tabsList ?? [];
    },
    async sendMessage(tabId: number, message: { type: string }, options?: { frameId?: number }) {
      (globalThis as { __lastContentMsg?: unknown }).__lastContentMsg = { tabId, message, options };
      // Mirrors real behavior: the content script always resolves with an
      // {ok, data|error} envelope; a missing content script rejects with the
      // "receiving end" error the dispatcher special-cases.
      const reply = (globalThis as { __contentReply?: unknown }).__contentReply;
      if (!reply) throw new Error("Could not establish connection. Receiving end does not exist.");
      return reply;
    },
    onRemoved: listenerHub(),
  },
  scripting: { async executeScript() {} },
  webRequest: {
    onBeforeRequest: listenerHub(),
    onCompleted: listenerHub(),
    onErrorOccurred: listenerHub(),
  },
  webNavigation: {
    async getAllFrames(_o: { tabId: number }) {
      return (
        (globalThis as { __frames?: Array<{ frameId: number; url: string }> }).__frames ?? []
      );
    },
  },
  runtime: {
    // Controllable native-messaging stub for AcpClient tests.
    connectNativeCalls: 0,
    mode: "fail" as "fail" | "ok",
    lastError: undefined as { message?: string } | undefined,
    lastPort: undefined as any,
    connectNative(_name: string) {
      (stub.runtime as any).connectNativeCalls++;
      if ((stub.runtime as any).mode === "fail") {
        // Some Firefox builds throw synchronously when the host is missing.
        throw new Error("Could not connect to any native messaging host");
      }
      const listeners: { message: Array<(m: unknown) => void>; disconnect: Array<() => void> } = { message: [], disconnect: [] };
      const port = {
        listeners,
        postMessage() {},
        onMessage: { addListener: (fn: (m: unknown) => void) => listeners.message.push(fn) },
        onDisconnect: { addListener: (fn: () => void) => listeners.disconnect.push(fn) },
        disconnect() {},
      };
      (stub.runtime as any).lastPort = port;
      if ((stub.runtime as any).mode === "dies-silent") {
        // Real Firefox 155 (missing manifest): returns a port that dies
        // immediately WITHOUT a lastError.
        setTimeout(() => {
          (stub.runtime as any).lastError = undefined;
          listeners.disconnect.forEach((fn: () => void) => fn());
        }, 0);
      }
      return port;
    },
    getManifest: () => ({ version: "0.1.1" }),
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
  assert.equal(store.sessionForRef(20), "s2");
  assert.equal(store.sessionForRef(99), undefined);
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

test("ToolDispatcher: browser_evaluate targets the bound tab via userScripts", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 5, windowId: 1 });
  stub.tabs.get = async () => tab(5);
  const extended = stub as typeof stub & { userScripts?: { execute: (o: any) => Promise<any> } };
  let injection: any;
  extended.userScripts = { execute: async (o) => {
    injection = o;
    return [{ frameId: 0, result: { value: 42, world: "page" } }];
  } };
  try {
    const result = await new ToolDispatcher(store).handleToolCall({
      sessionId: "s1", tool: "browser_evaluate",
      arguments: { expression: "document.querySelectorAll('.x').length", arg: null },
    }) as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(result.content[0].text), { value: 42, world: "page" });
    assert.deepEqual(injection.target, { tabId: 5, frameIds: [0] });
    assert.equal(injection.world, "MAIN");
    assert.match(injection.js[0].code, /document.querySelectorAll/);
  } finally {
    delete extended.userScripts;
  }
});

test("ToolDispatcher: browser_get_accessibility_tree passes maxNodes/maxDepth through", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 6, windowId: 1 });
  stub.tabs.get = async () => tab(6);
  (globalThis as { __contentReply?: unknown }).__contentReply = {
    ok: true,
    data: { tree: 'WebArea "T"\n  main\n    button "Go" [el-1]', nodeCount: 4, truncated: false },
  };
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_get_accessibility_tree",
    arguments: { maxNodes: 100, maxDepth: 8 },
  })) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text) as { tree: string; nodeCount: number };
  assert.ok(parsed.tree.includes('button "Go" [el-1]'));
  assert.equal(parsed.nodeCount, 4);
  const sent = (globalThis as { __lastContentMsg?: { message: Record<string, unknown> } }).__lastContentMsg;
  assert.equal(sent?.message.type, "pi:a11y");
  assert.equal(sent?.message.maxNodes, 100);
  assert.equal(sent?.message.maxDepth, 8);
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: browser_get_console passes level/limit/since/clear through", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 7, windowId: 1 });
  stub.tabs.get = async () => tab(7);
  (globalThis as { __contentReply?: unknown }).__contentReply = {
    ok: true,
    data: {
      messages: [{ t: 111, level: "error", source: "window-error", text: "TypeError: x is not defined" }],
      total: 1,
      dropped: 0,
      cleared: true,
    },
  };
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_get_console",
    arguments: { level: "error", limit: 10, since: 100, clear: true },
  })) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text) as { messages: Array<{ text: string }>; cleared: boolean };
  assert.equal(parsed.messages[0].text, "TypeError: x is not defined");
  assert.equal(parsed.cleared, true);
  const sent = (globalThis as { __lastContentMsg?: { message: Record<string, unknown> } }).__lastContentMsg;
  assert.equal(sent?.message.type, "pi:console");
  assert.equal(sent?.message.level, "error");
  assert.equal(sent?.message.clear, true);
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: browser_element_at passes coordinates through", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 8, windowId: 1 });
  stub.tabs.get = async () => tab(8);
  (globalThis as { __contentReply?: unknown }).__contentReply = {
    ok: true,
    data: { found: true, x: 10, y: 20, element: { ref: "el-7", tag: "button", role: "button", text: "Go" } },
  };
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_element_at",
    arguments: { x: 10, y: 20 },
  })) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text) as { found: boolean; element: { ref: string } };
  assert.equal(parsed.found, true);
  assert.equal(parsed.element.ref, "el-7");
  const sent = (globalThis as { __lastContentMsg?: { message: Record<string, unknown> } }).__lastContentMsg;
  assert.equal(sent?.message.type, "pi:elementAt");
  assert.equal(sent?.message.x, 10);
  assert.equal(sent?.message.y, 20);
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: frame parameter — a frameId number resolves and is passed to the content script", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  (globalThis as { __frames?: unknown[] }).__frames = [
    { frameId: 0, url: "http://localhost:5173/" },
    { frameId: 1, url: "http://localhost:5173/embed/app.html" },
  ];
  (globalThis as { __contentReply?: unknown }).__contentReply = { ok: true, data: { refCount: 1, elements: [] } };
  const d = new ToolDispatcher(store);
  await d.handleToolCall({ sessionId: "s1", tool: "browser_get_dom", arguments: { frame: 1 } });
  const sent = (globalThis as { __lastContentMsg?: { options?: { frameId?: number } } }).__lastContentMsg;
  assert.equal(sent?.options?.frameId, 1);
  delete (globalThis as { __frames?: unknown[] }).__frames;
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: frame parameter — a URL substring resolves to the matching frame", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  (globalThis as { __frames?: unknown[] }).__frames = [
    { frameId: 0, url: "http://localhost:5173/" },
    { frameId: 1, url: "https://embed.other-site.test/widget?x=1" },
  ];
  (globalThis as { __contentReply?: unknown }).__contentReply = { ok: true, data: { tree: "WebArea \"X\"" } };
  const d = new ToolDispatcher(store);
  await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_get_accessibility_tree",
    arguments: { frame: "other-site" },
  });
  const sent = (globalThis as { __lastContentMsg?: { options?: { frameId?: number } } }).__lastContentMsg;
  assert.equal(sent?.options?.frameId, 1);
  delete (globalThis as { __frames?: unknown[] }).__frames;
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: unknown frame rejects with BROWSER_FRAME_NOT_FOUND and the frame list", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  (globalThis as { __frames?: unknown[] }).__frames = [
    { frameId: 0, url: "http://localhost:5173/" },
    { frameId: 1, url: "http://localhost:5173/embed/app.html" },
  ];
  const d = new ToolDispatcher(store);
  await assert.rejects(
    d.handleToolCall({ sessionId: "s1", tool: "browser_click", arguments: { ref: "el-1", frame: "nope" } }),
    (err: unknown) => {
      assert.ok(err instanceof PiBrowserProtocolError);
      assert.equal(err.code, PI_BROWSER_ERROR.BROWSER_FRAME_NOT_FOUND);
      const frames = (err.data as { frames: Array<{ frameId: number; url: string }> }).frames;
      assert.equal(frames.length, 2);
      return true;
    },
  );
  delete (globalThis as { __frames?: unknown[] }).__frames;
});

test("ToolDispatcher: browser_get_network answers from the webRequest log (no content script)", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 42, windowId: 1 });
  stub.tabs.get = async () => tab(42);
  networkLog.start();
  const before = stub.webRequest.onBeforeRequest.listeners.at(-1) as (d: unknown) => void;
  const completed = stub.webRequest.onCompleted.listeners.at(-1) as (d: unknown) => void;
  before({ requestId: "n1", tabId: 42, url: "http://x.test/api/thing", method: "GET", type: "xmlhttprequest", timeStamp: 1000 });
  completed({ requestId: "n1", tabId: 42, url: "http://x.test/api/thing", method: "GET", type: "xmlhttprequest", timeStamp: 1042, statusCode: 200, statusLine: "HTTP/1.1 200 OK" });
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_get_network",
    arguments: { filter: "api" },
  })) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text) as { requests: Array<{ url: string; status: number; durationMs: number }>; total: number };
  assert.equal(parsed.total, 1);
  assert.equal(parsed.requests[0].url, "http://x.test/api/thing");
  assert.equal(parsed.requests[0].status, 200);
  assert.equal(parsed.requests[0].durationMs, 42);
});

test("ToolDispatcher: browser_navigate updates the bound tab with the URL", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  (globalThis as { __tabUpdates?: unknown[] }).__tabUpdates = [];
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_navigate",
    arguments: { url: "http://x.test/next" },
  })) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text) as { navigatingTo: string };
  assert.equal(parsed.navigatingTo, "http://x.test/next");
  const updates = (globalThis as { __tabUpdates?: unknown[] }).__tabUpdates as Array<{ tabId: number; props: { url?: string } }>;
  assert.equal(updates.length, 1);
  assert.equal(updates[0].tabId, 9);
  assert.equal(updates[0].props.url, "http://x.test/next");
  delete (globalThis as { __tabUpdates?: unknown[] }).__tabUpdates;
});

test("ToolDispatcher: browser_navigate rejects non-http(s)/file URLs", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 9, windowId: 1 });
  stub.tabs.get = async () => tab(9);
  (globalThis as { __tabUpdates?: unknown[] }).__tabUpdates = [];
  const d = new ToolDispatcher(store);
  for (const url of ["javascript:alert(1)", "/relative", "data:text/html,x", ""] as const) {
    await assert.rejects(
      d.handleToolCall({ sessionId: "s1", tool: "browser_navigate", arguments: { url } }),
      (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.INTERNAL,
      `url ${JSON.stringify(url)} must be rejected`,
    );
  }
  assert.equal((globalThis as { __tabUpdates?: unknown[] }).__tabUpdates?.length, 0, "no tab update on rejected URLs");
  delete (globalThis as { __tabUpdates?: unknown[] }).__tabUpdates;
});

test("ToolDispatcher: browser_get_accessibility_tree format=nodes routes to pi:a11yNodes", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 6, windowId: 1 });
  stub.tabs.get = async () => tab(6);
  (globalThis as { __contentReply?: unknown }).__contentReply = {
    ok: true,
    data: { nodes: [{ ref: "el-1", role: "button", name: "Go", rect: { x: 9, y: 9, width: 8, height: 2 } }], nodeCount: 1, truncated: false },
  };
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_get_accessibility_tree",
    arguments: { format: "nodes" },
  })) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text) as { nodes: Array<Record<string, unknown>> };
  assert.equal(parsed.nodes[0]?.role, "button");
  const sent = (globalThis as { __lastContentMsg?: { message: Record<string, unknown> } }).__lastContentMsg;
  assert.equal(sent?.message.type, "pi:a11yNodes");
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: interaction tools route to their content commands", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 6, windowId: 1 });
  stub.tabs.get = async () => tab(6);
  (globalThis as { __contentReply?: unknown }).__contentReply = { ok: true, data: { routed: true } };
  const d = new ToolDispatcher(store);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["browser_click_at", { x: 10, y: 20 }, "pi:clickAt"],
    ["browser_focus", { ref: "el-2" }, "pi:focus"],
    ["browser_scroll", { ref: "el-3" }, "pi:scroll"],
    ["browser_type_focused", { text: "hi" }, "pi:typeFocused"],
  ];
  for (const [tool, args, cmd] of cases) {
    (globalThis as { __lastContentMsg?: unknown }).__lastContentMsg = undefined;
    await d.handleToolCall({ sessionId: "s1", tool, arguments: args });
    const sent = (globalThis as { __lastContentMsg?: { message: Record<string, unknown> } }).__lastContentMsg;
    assert.equal(sent?.message.type, cmd, `${tool} -> ${cmd}`);
  }
  delete (globalThis as { __contentReply?: unknown }).__contentReply;
});

test("ToolDispatcher: browser_open_tab creates a REPL-owned tab and rebinds", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 11, windowId: 1, tabTitle: "User Tab" });
  stub.tabs.get = async () => tab(11);
  (globalThis as { __nextTabId?: number }).__nextTabId = 2000;
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({
    sessionId: "s1",
    tool: "browser_open_tab",
    arguments: { url: "https://aux.test/page" },
  })) as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text) as { tabId: number; url: string };
  assert.equal(parsed.tabId, 2001);
  assert.equal(parsed.url, "https://aux.test/page");
  // The session now binds the REPL tab (owner "repl"); the user tab is home.
  const binding = store.getBinding("s1");
  assert.equal(binding?.refId, 2001);
  assert.equal(bindingOwner(binding!), "repl");
  assert.equal((globalThis as { __createdTabs?: unknown[] }).__createdTabs?.length, 1);
});

test("ToolDispatcher: browser_close_tab closes a REPL tab and restores the home tab", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 11, windowId: 1, tabTitle: "User Tab" });
  stub.tabs.get = async () => tab(11);
  (globalThis as { __nextTabId?: number }).__nextTabId = 2000;
  (globalThis as { __removedTabs?: number[] }).__removedTabs = [];
  const d = new ToolDispatcher(store);
  await d.handleToolCall({ sessionId: "s1", tool: "browser_open_tab", arguments: { url: "https://aux.test" } });
  await d.handleToolCall({ sessionId: "s1", tool: "browser_close_tab", arguments: { tabId: 2001 } });
  assert.deepEqual((globalThis as { __removedTabs?: number[] }).__removedTabs, [2001]);
  // Binding restored to the user's tab (owner "bound"). The home binding is
  // the ORIGINAL binding object (legacy tabId field), so use bindingRefId.
  const binding = store.getBinding("s1");
  assert.equal(bindingRefId(binding!), 11);
  assert.equal(bindingOwner(binding!), "bound");
});

test("ToolDispatcher: browser_close_tab rejects non-REPL tabs (close-unbound-tab error)", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 11, windowId: 1, tabTitle: "User Tab" });
  stub.tabs.get = async () => tab(11);
  (globalThis as { __removedTabs?: number[] }).__removedTabs = [];
  const d = new ToolDispatcher(store);
  await assert.rejects(
    d.handleToolCall({ sessionId: "s1", tool: "browser_close_tab", arguments: { tabId: 11 } }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
  );
  assert.equal((globalThis as { __removedTabs?: number[] }).__removedTabs?.length, 0, "user tab never closed");
});

test("ToolDispatcher: browser_list_tabs marks the bound tab", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("s1", { tabId: 11, windowId: 1, tabTitle: "User Tab" });
  stub.tabs.get = async () => tab(11);
  (globalThis as { __tabsList?: any[] }).__tabsList = [
    tab(11, "http://a.test", "A"),
    tab(12, "http://b.test", "B"),
  ];
  const d = new ToolDispatcher(store);
  const result = (await d.handleToolCall({ sessionId: "s1", tool: "browser_list_tabs", arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  const parsed = JSON.parse(result.content[0].text) as { tabs: Array<{ id: number; bound: boolean }> };
  assert.deepEqual(
    parsed.tabs.map((t) => [t.id, t.bound]),
    [
      [11, true],
      [12, false],
    ],
  );
  delete (globalThis as { __tabsList?: any[] }).__tabsList;
});

test("ReplTabs: ownership registry (open/has/close/clear/ownerOf)", () => {
  const r = new ReplTabs();
  r.open("s1", 101);
  r.open("s1", 102);
  r.open("s2", 103);
  assert.ok(r.has("s1", 101));
  assert.ok(r.has("s1", 102));
  assert.ok(!r.has("s1", 103));
  assert.equal(r.ownerOf(103), "s2");
  assert.equal(r.ownerOf(999), undefined);
  r.close("s1", 101);
  assert.ok(!r.has("s1", 101));
  assert.deepEqual(r.clear("s1"), [102]);
  assert.deepEqual(r.all("s1"), []);
});

test("ReplTabs: home binding survives REPL rebinds and is taken once", () => {
  const r = new ReplTabs();
  r.rememberHome("s1", { tabId: 11, windowId: 1, owner: "bound" });
  r.rememberHome("s1", { tabId: 11, windowId: 1, owner: "bound" }); // idempotent restore point
  const first = r.takeHome("s1");
  assert.equal(first?.tabId, 11);
  assert.equal(r.takeHome("s1"), undefined, "home is consumed on restore");
});

test("NetworkLog: per-tab capture, filters, newest-first, closed-tab cleanup", () => {
  networkLog.start(); // idempotent (already started above in the dispatcher test)
  const before = stub.webRequest.onBeforeRequest.listeners.at(-1) as (d: unknown) => void;
  const completed = stub.webRequest.onCompleted.listeners.at(-1) as (d: unknown) => void;
  const failed = stub.webRequest.onErrorOccurred.listeners.at(-1) as (d: unknown) => void;
  const removed = stub.tabs.onRemoved.listeners.at(-1) as (d: number) => void;

  before({ requestId: "r1", tabId: 10, url: "http://x.test/api/users", method: "GET", type: "xmlhttprequest", timeStamp: 1000 });
  completed({ requestId: "r1", tabId: 10, url: "http://x.test/api/users", method: "GET", type: "xmlhttprequest", timeStamp: 1250, statusCode: 200, statusLine: "HTTP/1.1 200 OK" });
  before({ requestId: "r2", tabId: 10, url: "http://x.test/api/orders", method: "POST", type: "xmlhttprequest", timeStamp: 2000 });
  completed({ requestId: "r2", tabId: 10, url: "http://x.test/api/orders", method: "POST", type: "xmlhttprequest", timeStamp: 2300, statusCode: 500, statusLine: "HTTP/1.1 500 Internal Server Error" });
  before({ requestId: "r3", tabId: 20, url: "http://y.test/other.js", method: "GET", type: "script", timeStamp: 3000 });
  failed({ requestId: "r3", tabId: 20, url: "http://y.test/other.js", method: "GET", type: "script", timeStamp: 3100, error: "NS_ERROR_OFFLINE" });

  const all = networkLog.get(10);
  assert.equal(all.total, 2, "tab 10 has both requests");
  assert.equal(all.requests[0].url, "http://x.test/api/orders", "newest first");
  assert.equal(all.requests[0].durationMs, 300);
  assert.equal(all.requests[0].statusText, "Internal Server Error");

  const errors = networkLog.get(10, { errorsOnly: true });
  assert.equal(errors.returned, 1, "only the 500 is an error");
  assert.equal(errors.requests[0].status, 500);

  const filtered = networkLog.get(10, { filter: "USERS" });
  assert.equal(filtered.returned, 1, "filter is case-insensitive");
  assert.equal(filtered.requests[0].method, "GET");

  const byMethod = networkLog.get(10, { method: "post" });
  assert.equal(byMethod.returned, 1, "method is case-insensitive");

  const limited = networkLog.get(10, { limit: 1 });
  assert.equal(limited.returned, 1);
  assert.equal(limited.truncated, true);

  // A failed request on another tab is an error for that tab's log…
  const other = networkLog.get(20, { errorsOnly: true });
  assert.equal(other.returned, 1);
  assert.equal(other.requests[0].failed, true);
  assert.equal(other.requests[0].error, "NS_ERROR_OFFLINE");

  // …and closing the tab drops its log.
  removed(20);
  assert.equal(networkLog.get(20).total, 0);
  assert.equal(networkLog.get(10).total, 2, "other tabs unaffected");
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
  return new AcpClient(
    {
      clientName: "pi-browser-firefox",
      application: "firefox",
      capabilities: ["browser"],
      extensionId: "pi-agent-firefox@matbee.com",
    },
    {
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
  const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));
  const statuses: string[] = [];
  rt.connectNativeCalls = 0;
  rt.lastError = undefined;

  // 1) Add-on loads while the host is NOT installed (add-on-first order).
  //    Real Firefox 155 behavior: connectNative returns a port that dies
  //    immediately without a lastError (no throw).
  rt.mode = "dies-silent";
  const client = makeClient(statuses);
  client.start();
  assert.equal(rt.connectNativeCalls, 1, "one connect attempt");
  await tick(); // let the silent port die
  assert.equal(client.connected, false, "not connected while host missing");
  assert.ok(statuses.includes("not_installed"), `silent port death before any host message -> not_installed: ${statuses}`);

  // 2) Host still missing: ensureConnected() retries without hanging.
  client.ensureConnected();
  assert.equal(rt.connectNativeCalls, 2, "retry attempts the connect");
  await tick();
  assert.equal(client.connected, false);
  assert.ok(statuses[statuses.length - 1] === "not_installed", `still not_installed: ${statuses}`);

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

  // 5) A drop AFTER a successful exchange is "disconnected" (mid-session
  //    drop), not "not_installed" — the host exists, just crashed/closed.
  rt.lastPort.listeners.message.forEach((fn: (m: unknown) => void) => fn({ id: 1, result: { pong: true } }));
  (rt.lastError = { message: "native port disconnected" });
  rt.lastPort.listeners.disconnect.forEach((fn: () => void) => fn());
  assert.equal(client.connected, false, "port dropped");
  assert.ok(statuses[statuses.length - 1] === "disconnected", `post-exchange drop -> disconnected: ${statuses}`);

  // 6) The next ensureConnected() reconnects.
  client.ensureConnected();
  assert.equal(client.connected, true, "reconnected after drop");
  assert.equal(rt.connectNativeCalls, 4);

  client.stop(); // clear any pending reconnect timers
});

test("ToolDispatcher: activity lifecycle preserves results and is isolated from UI failure", async () => {
  const store = new SessionStore();
  await store.hydrate();
  store.bind("activity-session", { tabId: 7, windowId: 1 });
  stub.tabs.get = async () => ({ id: 7, windowId: 1, title: "Example", url: "https://example.com" });
  const events: import("../src/tool-activity.js").BrowserActivity[] = [];
  const dispatcher = new ToolDispatcher(store, new ReplTabs(), (sessionId, activity) => {
    assert.equal(sessionId, "activity-session");
    events.push(activity);
  });
  const result = await dispatcher.handleToolCall({ sessionId: "activity-session", tool: "browser_get_page", arguments: {} });
  assert.deepEqual(events.map((e) => e.status), ["in_progress", "completed"]);
  assert.equal(events[0].id, events[1].id);
  assert.equal(events[1].result, result);
  const brokenView = new ToolDispatcher(store, new ReplTabs(), () => { throw new Error("view closed"); });
  assert.deepEqual(await brokenView.handleToolCall({ sessionId: "activity-session", tool: "browser_get_page", arguments: {} }), result);
  events.length = 0;
  await assert.rejects(dispatcher.handleToolCall({ sessionId: "activity-session", tool: "missing", arguments: {} }));
  assert.deepEqual(events.map((e) => e.status), ["in_progress", "failed"]);
  assert.ok(events[1].result);
});
