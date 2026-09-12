/**
 * Integration harness (PRODUCT.md §43, §44, §52).
 *
 * Spawns the REAL built native host (packages/pi-agent/dist/native-host/main.js)
 * with the deterministic mock backend and drives it over real Firefox
 * framing, speaking the client side of the protocol exactly like the
 * Firefox add-on does:
 *
 *   - ACP: initialize / session/* (new, list, resume, load, prompt, cancel,
 *     close, set_config_option), session/update notifications
 *   - x-pi-browser/* : ping / tool / notify  (host -> client direction)
 *   - mcp/* : the REAL Firefox-side McpServer class (firefox/dist-tests)
 *     fronts the MCP-over-ACP path, backed by a fake in-memory tab set.
 *
 * Agent turns that must call browser tools are driven through a script file
 * (PI_BROWSER_MOCK_SCRIPT) so the REAL provider + transports execute the
 * calls end to end. This exercises framing, JSON-RPC, structured errors,
 * streaming, cancellation, multi-session isolation, and both browser-tool
 * transports without a real browser or LLM. The live Firefox + real-Pi pass
 * is a separate step (task-7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_METHODS,
  PI_BROWSER,
  PI_BROWSER_META,
  PI_BROWSER_ERROR,
  X_PI_BROWSER,
  BROWSER_TOOLS,
  CONTROL_TOOLS,
  isStructuredErrorObject,
  codeFromErrorObject,
  toErrorObject,
} from "@pi-browser/protocol";
import { McpServer } from "@pi-browser/firefox/mcp-server";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST_ENTRY = path.join(REPO_ROOT, "packages", "pi-agent", "dist", "native-host", "main.js");

// ---------------------------------------------------------------------------
// Framed host client (Firefox framing: 4-byte LE length + JSON)
// ---------------------------------------------------------------------------

class HostClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.handlers = new Map();
    this.incomingRequests = []; // host -> client requests we chose not to handle
    this.buffer = Buffer.alloc(0);
    this.alive = true;

    child.stdout.on("data", (chunk) => this.onData(chunk));
    // stderr is diagnostics only; optionally mirror it to a file for debugging.
    child.stderr.on("data", (chunk) => {
      if (process.env.PI_BROWSER_E2E_STDERR) {
        import("node:fs").then((fs) => fs.appendFileSync(process.env.PI_BROWSER_E2E_STDERR, chunk));
      }
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.alive = false;
      for (const [, p] of this.pending) p.reject(new Error(`host exited (code=${code} signal=${signal})`));
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + len) return;
      const payload = this.buffer.subarray(4, 4 + len).toString("utf8");
      this.buffer = this.buffer.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(payload);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    // JSON-RPC: requests carry a method; responses never do. Host and
    // client id spaces are independent, so NEVER dispatch on id alone.
    if (typeof msg.method === "string" && typeof msg.id === "number") {
      // Request from the host: the fake Firefox answers.
      const handler = this.handlers.get(msg.method);
      if (!handler) {
        this.incomingRequests.push(msg);
        this.sendRaw({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no handler for ${msg.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params))
        .then((result) => this.sendRaw({ jsonrpc: "2.0", id: msg.id, result: result ?? null }))
        .catch((err) => {
          // Mirror the add-on's AcpClient error serialization exactly:
          // structured errors become reserved numeric codes + data.piBrowserError.
          const error = isStructuredErrorObject(err)
            ? { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) }
            : {
                code: -32603,
                message: err instanceof Error ? err.message : String(err),
                data: { piBrowserError: PI_BROWSER_ERROR.INTERNAL },
              };
          this.sendRaw({ jsonrpc: "2.0", id: msg.id, error });
        });
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      // Notification (method, no id): record, no response.
      this.notifications.push(msg);
      return;
    }
    if (msg.id !== undefined || msg.method !== undefined) this.notifications.push(msg);
  }

  sendRaw(obj) {
    // Safe against shutdown: a test's finally block may end the child's stdin
    // (or the child may exit) while an async response write from dispatch()
    // is still in the microtask queue. Writing a late frame to a closed stdin
    // would throw an uncaught ERR_STREAM_WRITE_AFTER_END and fail the test.
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) return;
    const json = Buffer.from(JSON.stringify(obj), "utf8");
    const frame = Buffer.alloc(4 + json.length);
    frame.writeUInt32LE(json.length, 0);
    json.copy(frame, 4);
    try {
      stdin.write(frame);
    } catch {
      /* stdin closed between the check and the write — harmless */
    }
  }

  request(method, params, timeoutMs = 15_000) {
    const id = this.nextId++;
    this.sendRaw({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  /** Collect session/update notifications for a session. */
  sessionUpdates(sessionId) {
    return this.notifications.filter(
      (m) => m.method === "session/update" && m.params?.sessionId === sessionId,
    );
  }
}

// ---------------------------------------------------------------------------
// Fake Firefox: in-memory tabs + the REAL add-on McpServer class
// ---------------------------------------------------------------------------

class FakeTabs {
  constructor() {
    this.tabs = new Map();
    this.bindings = new Map(); // sessionId -> tabId
    this.calls = [];
    this.notifyLog = [];
    this.activeTabId = undefined;
    this.focusLog = [];
  }

  addTab(url, title = "Fake Page") {
    const tabId = this.tabs.size + 1;
    this.tabs.set(tabId, {
      id: tabId,
      url,
      title,
      closed: false,
      dom: [
        { ref: "el-1", role: "heading", tag: "h1", text: title, visible: true },
        { ref: "el-2", role: "button", tag: "button", text: "Go", visible: true },
      ],
    });
    return tabId;
  }

  setActive(tabId) {
    this.activeTabId = tabId;
  }

  focusTab(tabId) {
    this.activeTabId = tabId;
    this.focusLog.push(tabId);
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (tab) tab.closed = true;
  }

  bind(sessionId, tabId) {
    this.bindings.set(sessionId, tabId);
  }

  unbind(sessionId) {
    this.bindings.delete(sessionId);
  }

  tabFor(sessionId) {
    const tabId = this.bindings.get(sessionId);
    if (tabId === undefined) return { state: "unbound" };
    const tab = this.tabs.get(tabId);
    return tab && !tab.closed ? { state: "ok", tab } : { state: "closed", tab };
  }

  /**
   * Execute a browser tool against the session's tab.
   * Throws structured error objects (code+message) for failures, mirroring
   * the Firefox add-on's ToolDispatcher behavior.
   */
  dispatch(params) {
    this.calls.push(params);
    const { sessionId, tool, arguments: args = {} } = params;
    const lookup = this.tabFor(sessionId);
    if (lookup.state === "unbound") {
      throw toErrorObject(PI_BROWSER_ERROR.BROWSER_NOT_BOUND, `session ${sessionId} has no bound tab`);
    }
    if (lookup.state === "closed") {
      throw toErrorObject(PI_BROWSER_ERROR.BROWSER_TAB_CLOSED, `bound tab no longer exists for session ${sessionId}`);
    }
    const tab = lookup.tab;
    const text = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    switch (tool) {
      case "browser_get_page":
        return text({ url: tab.url, title: tab.title, viewport: { width: 1280, height: 800 } });
      case "browser_get_dom":
        return text({ refCount: tab.dom.length, elements: tab.dom });
      case "browser_get_selection":
        return text({ text: "selected-text" });
      case "browser_screenshot":
        return { content: [{ type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }] };
      case "browser_reload":
        return text({ reloaded: tab.url });
      case "browser_click":
      case "browser_type": {
        const el = tab.dom.find((d) => d.ref === args.ref);
        if (!el) {
          throw toErrorObject(
            PI_BROWSER_ERROR.BROWSER_ELEMENT_STALE,
            `element reference ${args.ref} is stale (page changed or element removed)`,
          );
        }
        if (tool === "browser_click") return text({ clicked: el });
        return text({ typed: el, chars: String(args.text ?? "").length, submitted: Boolean(args.submit) });
      }
      case "browser_wait_for":
        return text({ found: true, waitedMs: 5, state: args.state ?? "visible" });
      default:
        throw toErrorObject(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown browser tool: ${tool}`);
    }
  }
}

/**
 * Fake add-on control handler: mirrors the real add-on's handleAction by
 * driving the host through its own ACP client (exactly what the background
 * event page does with its AcpClient). The mock script has no tool-result
 * dataflow, so the sentinel "$new" resolves to the most recently created
 * session — a test-double convenience for the scripted agent.
 */
function makeFakeControl(tabs, hostRef) {
  const state = { lastNew: undefined, log: [] };
  const ref = (id) => (id === "$new" ? state.lastNew : String(id ?? ""));
  const handler = async (tool, args) => {
    state.log.push({ tool, args });
    switch (tool) {
      case "pi_get_state": {
        const list = await hostRef.current.request(AGENT_METHODS.session_list, { cwd: null });
        return {
          status: { state: "connected" },
          sessions: (list.sessions ?? []).map((s) => ({
            sessionId: s.sessionId,
            cwd: s.cwd,
            ...(tabs.bindings.has(s.sessionId) ? { binding: { tabId: tabs.bindings.get(s.sessionId) } } : {}),
          })),
        };
      }
      case "pi_new_session": {
        const res = await hostRef.current.request(AGENT_METHODS.session_new, { cwd: String(args.cwd ?? "") });
        state.lastNew = res.sessionId;
        return { sessionId: res.sessionId };
      }
      case "pi_select_session": {
        await hostRef.current.request(AGENT_METHODS.session_resume, { sessionId: ref(args.sessionId), cwd: "/work/fake" });
        return {};
      }
      case "pi_prompt": {
        const sessionId = ref(args.sessionId);
        // Await the turn for determinism (the real add-on is fire-and-forget).
        await hostRef.current.request(
          AGENT_METHODS.session_prompt,
          { sessionId, prompt: [{ type: "text", text: String(args.text ?? "") }] },
          60_000,
        );
        return { accepted: true };
      }
      case "pi_cancel": {
        await hostRef.current.request(AGENT_METHODS.session_cancel, { sessionId: ref(args.sessionId) });
        return {};
      }
      case "pi_close_session": {
        await hostRef.current.request(AGENT_METHODS.session_close, { sessionId: ref(args.sessionId) });
        return {};
      }
      case "pi_set_config_option": {
        await hostRef.current.request(AGENT_METHODS.session_set_config_option, {
          sessionId: ref(args.sessionId),
          configId: String(args.configId ?? ""),
          value: args.value,
        });
        return {};
      }
      case "pi_bind_current_tab": {
        if (tabs.activeTabId === undefined) {
          throw toErrorObject(PI_BROWSER_ERROR.BROWSER_NOT_BOUND, "no active tab to bind");
        }
        tabs.bind(ref(args.sessionId), tabs.activeTabId);
        return { tabId: tabs.activeTabId };
      }
      case "pi_unbind_tab": {
        tabs.unbind(ref(args.sessionId)); // idempotent, like the real store
        return {};
      }
      case "pi_open_bound_tab": {
        const sessionId = ref(args.sessionId);
        const tabId = tabs.bindings.get(sessionId);
        if (!tabId) {
          throw toErrorObject(PI_BROWSER_ERROR.BROWSER_NOT_BOUND, `session ${sessionId} has no bound tab`);
        }
        tabs.focusTab(tabId);
        return { focused: tabId };
      }
      default:
        throw toErrorObject(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown control tool: ${tool}`);
    }
  };
  return { handler, state };
}

function makeFakeFirefox(tabs, control) {
  const mcpServer = new McpServer({ handleToolCall: (params) => Promise.resolve(tabs.dispatch(params)) }, control);
  const attach = (host) => {
    host.on(X_PI_BROWSER.tool, (params) => tabs.dispatch(params));
    host.on(X_PI_BROWSER.notify, (params) => {
      tabs.notifyLog.push(params);
    });
    host.on("mcp/connect", async (params) => await mcpServer.handleConnect(params));
    host.on("mcp/message", async (params) => await mcpServer.handleMessage(params));
    host.on("mcp/disconnect", async (params) => await mcpServer.handleDisconnect(params));
    // Sensitive tools (browser_screenshot) require user approval. The fake
    // "user" auto-approves unless a test overrides the behavior. Record each
    // request so tests can assert the permission flow fired.
    host.on("session/request_permission", (params) => {
      const behavior = tabs.permissionBehavior ?? "allow_once";
      tabs.permissionLog = tabs.permissionLog ?? [];
      tabs.permissionLog.push(params);
      if (behavior === "cancel") return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: behavior } };
    });
  };
  return { mcpServer, attach };
}

// ---------------------------------------------------------------------------
// Host lifecycle
// ---------------------------------------------------------------------------

let tmpRoot;
function spawnHost(extraEnv = {}) {
  if (!tmpRoot) tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"));
  const child = spawn(process.execPath, [HOST_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_BROWSER_BACKEND: "mock",
      PI_BROWSER_LOG_LEVEL: "silent",
      ...extraEnv,
    },
  });
  return new HostClient(child);
}

function writeScript(entries) {
  const file = path.join(tmpRoot ?? (tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"))), `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

async function shutdown(host) {
  host.child.stdin.end();
  await new Promise((resolve) => {
    if (!host.alive) return resolve();
    const timer = setTimeout(() => {
      host.child.kill("SIGKILL");
      resolve();
    }, 3000);
    host.child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function structuredCode(err) {
  if (isStructuredErrorObject(err)) return codeFromErrorObject(err);
  if (err?.code) return err.code;
  return undefined;
}

async function initialize(host) {
  // Mirror the real Firefox add-on: declare the pi.agent.hello so the host
  // registers browser tools via the capability handshake (plan §24).
  return host.request(AGENT_METHODS.initialize, {
    protocolVersion: 1,
    clientCapabilities: { loadSession: true },
    clientInfo: { name: "pi-browser-firefox", version: "0.1.0" },
    _meta: {
      piAgent: {
        type: "pi.agent.hello",
        client: { application: "firefox", extensionId: "pi-browser@pi.dev", version: "0.1.0" },
        capabilities: ["browser"],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("auto-detection: host writes the add-on heartbeat only for the add-on identity", async () => {
  if (!tmpRoot) tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"));
  const hbFile = path.join(tmpRoot, `hb-${Math.random().toString(36).slice(2)}.json`);
  const host = spawnHost({ PI_BROWSER_HEARTBEAT_FILE: hbFile });
  try {
    // A non-add-on client (this harness) must NOT create the heartbeat.
    await host.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "fake-firefox", version: "0.1.0" },
    });
    assert.equal(existsSync(hbFile), false, "no heartbeat for a non-add-on client");

    // The add-on's identity (what the real add-on sends) creates it — this is
    // the presence signal /pi-browser status|doctor uses for auto-detection.
    await host.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "pi-browser-firefox", version: "0.1.0" },
    });
    assert.ok(existsSync(hbFile), "heartbeat written for the add-on client");
    const hb = JSON.parse(readFileSync(hbFile, "utf8"));
    assert.equal(hb.client, "pi-browser-firefox");
    assert.equal(hb.version, "0.1.0");
    assert.ok(hb.ts <= Date.now());

    // The keepalive ping refreshes it.
    await sleep(25);
    await host.request(X_PI_BROWSER.ping, {}, 5_000);
    const hb2 = JSON.parse(readFileSync(hbFile, "utf8"));
    assert.ok(hb2.ts >= hb.ts, "ping refreshed the heartbeat ts");
  } finally {
    await shutdown(host);
  }
});

test("initialize: capabilities + piBrowser metadata; version mismatch is structured", async () => {
  const host = spawnHost();
  try {
    const res = await initialize(host);
    assert.equal(res.agentCapabilities?.loadSession, true);
    assert.equal(res.agentInfo?.name, "pi-coding-agent");
    const meta = res._meta?.piBrowser ?? res.piBrowser;
    assert.ok(meta, "piBrowser metadata present");
    assert.equal(meta.protocolVersion, PI_BROWSER_META.protocolVersion);
    assert.equal(meta.browserToolVersion, PI_BROWSER_META.browserToolVersion);

    // The host echoes the pi.agent.hello it accepted (plan §24): the fake
    // Firefox above declared application=firefox, capabilities=[browser].
    const agentMeta = res._meta?.piAgent;
    assert.ok(agentMeta, "piAgent metadata present");
    assert.equal(agentMeta.application, "firefox");
    assert.deepEqual(agentMeta.capabilities, ["browser"]);

    const bad = spawnHost();
    try {
      await assert.rejects(
        bad.request(AGENT_METHODS.initialize, {
          protocolVersion: 99,
          clientCapabilities: {},
          clientInfo: { name: "fake", version: "0" },
        }),
        (err) => structuredCode(err) === PI_BROWSER_ERROR.PROTOCOL_VERSION_MISMATCH,
      );
    } finally {
      await shutdown(bad);
    }
  } finally {
    await shutdown(host);
  }
});

test("sessions: three isolated sessions stream independently", async () => {
  const host = spawnHost();
  try {
    await initialize(host);

    const ids = [];
    for (let i = 0; i < 3; i++) {
      const res = await host.request(AGENT_METHODS.session_new, { cwd: `/work/proj-${i}` });
      ids.push(res.sessionId);
      assert.ok(res.sessionId);
    }
    assert.equal(new Set(ids).size, 3);

    // Overlapping turns: one on each session, started close together.
    const texts = ["slow", "one", "two"];
    const prompts = ids.map((id, i) =>
      host.request(
        AGENT_METHODS.session_prompt,
        { sessionId: id, prompt: [{ type: "text", text: texts[i] }] },
        60_000,
      ),
    );
    await Promise.all(prompts);

    for (let i = 0; i < 3; i++) {
      const updates = host.sessionUpdates(ids[i]);
      const chunks = updates.filter((u) => u.params.update?.sessionUpdate === "agent_message_chunk");
      assert.ok(chunks.length > 0, `session ${i} received streamed chunks`);
      const text = chunks.map((u) => u.params.update.content?.text ?? "").join("");
      assert.ok(text.includes(`ok: ${texts[i]}`), `session ${i} got its own reply`);
      // No cross-talk.
      for (let j = 0; j < 3; j++) {
        if (j !== i) assert.ok(!text.includes(`ok: ${texts[j]}`), `session ${i} did not leak session ${j}'s text`);
      }
    }
  } finally {
    await shutdown(host);
  }
});

test("session: list, resume, load replay, set_config_option, cancel, close", async () => {
  const script = writeScript([
    { match: "cancel me", events: [{ type: "text_delta", delta: "working…" }], delayMs: 3000 },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  try {
    await initialize(host);

    const created = await host.request(AGENT_METHODS.session_new, { cwd: "/work/app" });
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "hello" }] },
      60_000,
    );

    const list = await host.request(AGENT_METHODS.session_list, { cwd: null });
    assert.ok(list.sessions.some((s) => s.sessionId === created.sessionId), "created session listed");

    // An already-open session cannot be resumed (SESSION_BUSY).
    await assert.rejects(
      host.request(AGENT_METHODS.session_resume, { sessionId: created.sessionId, cwd: "/work/app" }),
      (err) => structuredCode(err) === PI_BROWSER_ERROR.SESSION_BUSY || /already open/i.test(JSON.stringify(err)),
    );

    // Close, then resume: reopens the same session from the backend.
    await host.request(AGENT_METHODS.session_close, { sessionId: created.sessionId });
    await host.request(AGENT_METHODS.session_resume, { sessionId: created.sessionId, cwd: "/work/app" });

    // Load replays the transcript as session/update chunks.
    await host.request(AGENT_METHODS.session_close, { sessionId: created.sessionId });
    const mark = host.notifications.length;
    await host.request(AGENT_METHODS.session_load, { sessionId: created.sessionId, cwd: "/work/app" });
    const replay = host.notifications.slice(mark).filter((m) => m.method === "session/update" && m.params?.sessionId === created.sessionId);
    assert.ok(replay.some((u) => u.params.update?.sessionUpdate === "user_message_chunk"), "replay included the user message");
    assert.ok(replay.some((u) => u.params.update?.sessionUpdate === "agent_message_chunk"), "replay included the assistant message");

    // Config options come from the backend (ACP session/set_config_option).
    const setModel = await host.request(AGENT_METHODS.session_set_config_option, {
      sessionId: created.sessionId,
      configId: "model",
      value: "mock/model-b",
    });
    const modelOpt = (setModel.configOptions ?? []).find((o) => o.id === "model");
    assert.ok(modelOpt, "model config option present");
    assert.equal(modelOpt.currentValue, "mock/model-b");

    const setThinking = await host.request(AGENT_METHODS.session_set_config_option, {
      sessionId: created.sessionId,
      configId: "thinking",
      value: "high",
    });
    const thinkOpt = (setThinking.configOptions ?? []).find((o) => o.id === "thinking");
    assert.equal(thinkOpt?.currentValue, "high");

    // Cancel an in-flight turn.
    const promptP = host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "cancel me" }] },
      60_000,
    );
    await sleep(50);
    await host.request(AGENT_METHODS.session_cancel, { sessionId: created.sessionId });
    await promptP; // resolves after abort

    // Close the session; further prompts are rejected.
    await host.request(AGENT_METHODS.session_close, { sessionId: created.sessionId });
    await assert.rejects(
      host.request(AGENT_METHODS.session_prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "post-close" }],
      }, 60_000),
      (err) => /not found|closed|disposed|unknown/i.test(JSON.stringify(err)),
    );
  } finally {
    await shutdown(host);
  }
});

test("browser tools (legacy transport): agent-driven calls, A/B isolation, stale ref, closed tab", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);

  const script = writeScript([
    { match: "page", toolCalls: [{ toolName: "browser_get_page", args: {} }] },
    { match: "dom", toolCalls: [{ toolName: "browser_get_dom", args: { maxElements: 50 } }] },
    { match: "shot", toolCalls: [{ toolName: "browser_screenshot", args: { format: "png" } }] },
    { match: "click-stale", toolCalls: [{ toolName: "browser_click", args: { ref: "el-99" } }] },
    { match: "click-ok", toolCalls: [{ toolName: "browser_click", args: { ref: "el-2" } }] },
    { match: "type-it", toolCalls: [{ toolName: "browser_type", args: { ref: "el-2", text: "hello world", submit: false } }] },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  fakeFirefox.attach(host);
  try {
    await initialize(host);

    const tabA = tabs.addTab("http://a.test/page", "Page A");
    const tabB = tabs.addTab("http://b.test/page", "Page B");
    const a = await host.request(AGENT_METHODS.session_new, { cwd: "/work/a" });
    const b = await host.request(AGENT_METHODS.session_new, { cwd: "/work/b" });
    tabs.bind(a.sessionId, tabA);
    tabs.bind(b.sessionId, tabB);

    // Session A asks for the page: the host MUST dispatch to tab A only.
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: a.sessionId, prompt: [{ type: "text", text: "what page am I on" }] },
      60_000,
    );
    const updatesA = host.sessionUpdates(a.sessionId);
    const toolStarts = updatesA.filter((u) => u.params.update?.sessionUpdate === "tool_call");
    const toolEnds = updatesA.filter((u) => u.params.update?.sessionUpdate === "tool_call_update");
    assert.ok(toolStarts.some((u) => u.params.update?.title?.includes("browser_get_page")), "tool_call streamed");
    assert.ok(toolEnds.length >= 1, "tool_call_update streamed");
    const endTexts = toolEnds.map((u) => JSON.stringify(u.params.update)).join("\n");
    assert.ok(endTexts.includes("http://a.test/page"), "tool result carried tab A's URL");
    assert.ok(!endTexts.includes("http://b.test/page"), "A never saw B's tab");

    // Session B sees only its own tab.
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: b.sessionId, prompt: [{ type: "text", text: "what page am I on" }] },
      60_000,
    );
    const updatesB = host.sessionUpdates(b.sessionId);
    const endTextsB = updatesB
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update))
      .join("\n");
    assert.ok(endTextsB.includes("http://b.test/page"), "B saw its own tab");
    assert.ok(!endTextsB.includes("http://a.test/page"), "B never saw A's tab");

    // DOM dump + screenshot through the agent.
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: a.sessionId, prompt: [{ type: "text", text: "dump the dom" }] },
      60_000,
    );
    const domEnd = host
      .sessionUpdates(a.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update))
      .join("\n");
    assert.ok(domEnd.includes("el-1"), "dom refs streamed back");

    // Stale element: the error stays structured (no free-form parsing).
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: b.sessionId, prompt: [{ type: "text", text: "click-stale please" }] },
      60_000,
    );
    const staleEnd = host
      .sessionUpdates(b.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.ok(staleEnd, "stale click produced a tool_call_update");
    assert.ok(staleEnd.params.update.status === "failed", `stale click failed: ${JSON.stringify(staleEnd.params.update)}`);
    assert.ok(JSON.stringify(staleEnd.params.update).includes("stale"), "failure message mentions staleness");

    // Close tab A: the next tool call fails with the structured tab-closed
    // code, while B keeps working.
    tabs.closeTab(tabA);
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: a.sessionId, prompt: [{ type: "text", text: "what page am I on now" }] },
      60_000,
    );
    const closedEnd = host
      .sessionUpdates(a.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.ok(closedEnd.params.update.status === "failed", "closed-tab tool failed");
    assert.ok(JSON.stringify(closedEnd.params.update).includes("no longer exists"), "structured tab-closed message");

    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: b.sessionId, prompt: [{ type: "text", text: "click-ok now" }] },
      60_000,
    );
    const okEnd = host
      .sessionUpdates(b.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.equal(okEnd.params.update.status, "completed", "B still works after A's tab closed");

    // Typing into a referenced element (DoD: Pi can type into a referenced element).
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: b.sessionId, prompt: [{ type: "text", text: "type-it please" }] },
      60_000,
    );
    const typeEnd = host
      .sessionUpdates(b.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.equal(typeEnd.params.update.status, "completed", "browser_type completed");
    // The typed text + target ref reached the dispatcher (the content script
    // result shape is {typed, chars, submitted}, so check the call args).
    const typeCall = [...tabs.calls].reverse().find((c) => c.tool === "browser_type");
    assert.equal(typeCall.sessionId, b.sessionId, "type targeted session B's tab");
    assert.equal(typeCall.arguments.ref, "el-2", "type targeted the referenced element");
    assert.equal(typeCall.arguments.text, "hello world", "typed text delivered");
  } finally {
    await shutdown(host);
  }
});

test("browser_screenshot requires user permission (approve runs, deny blocks)", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);

  const script = writeScript([
    { match: "shot", toolCalls: [{ toolName: "browser_screenshot", args: { format: "png" } }] },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    const tab = tabs.addTab("http://perm.test/page", "Perm Page");
    const res = await host.request(AGENT_METHODS.session_new, { cwd: "/work/perm" });
    const sessionId = res.sessionId;
    tabs.bind(sessionId, tab);

    // 1) User APPROVES: the screenshot runs and returns an image, and a
    //    session/request_permission was emitted for browser_screenshot.
    tabs.permissionBehavior = "allow_once";
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId, prompt: [{ type: "text", text: "shot please" }] },
      60_000,
    );
    assert.ok(tabs.permissionLog.length >= 1, "a permission request was emitted");
    const permReq = tabs.permissionLog[tabs.permissionLog.length - 1];
    assert.equal(permReq.sessionId, sessionId, "permission carried the session id");
    assert.ok(
      JSON.stringify(permReq._meta ?? {}).includes("browser_screenshot"),
      "permission identified the sensitive tool",
    );
    assert.ok(
      Array.isArray(permReq.options) && permReq.options.some((o) => o.kind === "allow_once"),
      "permission offered an allow option",
    );
    const endOk = host
      .sessionUpdates(sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.equal(endOk.params.update.status, "completed", "approved screenshot completed");

    // 2) User DENIES: the tool is blocked with a structured permission error
    //    and never reaches the dispatcher.
    const callsBefore = tabs.calls.filter((c) => c.tool === "browser_screenshot").length;
    tabs.permissionBehavior = "cancel";
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId, prompt: [{ type: "text", text: "shot again please" }] },
      60_000,
    );
    const endDenied = host
      .sessionUpdates(sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.equal(endDenied.params.update.status, "failed", "denied screenshot failed");
    assert.ok(
      JSON.stringify(endDenied.params.update).toLowerCase().includes("permission"),
      "failure surfaced the permission denial",
    );
    const callsAfter = tabs.calls.filter((c) => c.tool === "browser_screenshot").length;
    assert.equal(callsAfter, callsBefore, "denied screenshot never reached the dispatcher");
  } finally {
    await shutdown(host);
  }
});

test("browser tools (MCP-over-ACP): agent-driven calls through the real add-on McpServer", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);

  const script = writeScript([
    { match: "dom", toolCalls: [{ toolName: "browser_get_dom", args: { maxElements: 50 } }] },
    { match: "sel", toolCalls: [{ toolName: "browser_get_selection", args: {} }] },
    { match: "click-stale", toolCalls: [{ toolName: "browser_click", args: { ref: "el-404" } }] },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  fakeFirefox.attach(host);
  try {
    await initialize(host);

    const tabA = tabs.addTab("http://mcp.test/page", "MCP Page");

    // Mimic the add-on flow: declare the ACP-transport MCP server BEFORE
    // session/new (no sessionId yet), resolve on the response.
    const decl = fakeFirefox.mcpServer.declarePending();
    const res = await host.request(AGENT_METHODS.session_new, {
      cwd: "/work/mcp",
      mcpServers: [{ name: "firefox-browser", type: "acp", serverId: decl.serverId }],
    });
    const sessionId = res.sessionId;
    decl.resolve(sessionId);
    tabs.bind(sessionId, tabA);

    // First tool use triggers mcp/connect + the MCP handshake inside the
    // ACP channel, then tools/call.
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId, prompt: [{ type: "text", text: "dump the dom" }] },
      60_000,
    );
    const updates = host.sessionUpdates(sessionId);
    const endTexts = updates
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update))
      .join("\n");
    assert.ok(endTexts.includes("el-1"), "MCP tools/call round-trip carried the DOM");

    // A second tool reuses the connection (the handshake runs once).
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId, prompt: [{ type: "text", text: "what is selected" }] },
      60_000,
    );
    const selEnd = host
      .sessionUpdates(sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.ok(JSON.stringify(selEnd.params.update).includes("selected-text"), "selection via MCP");

    // Structured errors survive the MCP round trip.
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId, prompt: [{ type: "text", text: "click-stale now" }] },
      60_000,
    );
    const staleEnd = host
      .sessionUpdates(sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .at(-1);
    assert.equal(staleEnd.params.update.status, "failed", "MCP stale click failed");
    assert.ok(JSON.stringify(staleEnd.params.update).includes("stale"), "stale message preserved");

    // session/close tears the MCP connection down.
    let disconnects = 0;
    const orig = host.handlers.get("mcp/disconnect");
    host.handlers.set("mcp/disconnect", async (params) => {
      disconnects++;
      return orig(params);
    });
    await host.request(AGENT_METHODS.session_close, { sessionId });
    assert.ok(disconnects >= 1, "mcp/disconnect sent on close");
  } finally {
    await shutdown(host);
  }
});

test("x-pi-browser/notify is accepted and does not break the channel", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);
  const host = spawnHost();
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    host.sendRaw({
      jsonrpc: "2.0",
      method: X_PI_BROWSER.notify,
      params: { sessionId: "s1", event: "tab_closed", data: { tabId: 1 } },
    });
    host.sendRaw({
      jsonrpc: "2.0",
      method: X_PI_BROWSER.notify,
      params: { sessionId: "s1", event: "tab_navigated", data: { tabId: 1 } },
    });
    await sleep(100);
    assert.ok(host.alive, "host alive after notifications");
    const ping = await host.request(X_PI_BROWSER.ping, {});
    assert.equal(ping.pong, true);
    assert.equal(ping.meta.protocolVersion, PI_BROWSER_META.protocolVersion);
    assert.equal(ping.meta.browserToolVersion, PI_BROWSER_META.browserToolVersion);
    assert.equal(ping.backendReady, true);
  } finally {
    await shutdown(host);
  }
});

test("tool surface: the add-on MCP server serves browser + control tools", async () => {
  const tabs = new FakeTabs();
  const hostRef = { current: null };
  const control = makeFakeControl(tabs, hostRef);
  const fake = makeFakeFirefox(tabs, control.handler);
  const mcp = fake.mcpServer;
  const serverId = mcp.declareFor("sess-x");
  const conn = await mcp.handleConnect({ serverId });
  await mcp.handleMessage({
    connectionId: conn.connectionId,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  await mcp.handleMessage({ connectionId: conn.connectionId, method: "notifications/initialized", params: undefined });
  const res = await mcp.handleMessage({ connectionId: conn.connectionId, method: "tools/list", params: undefined });
  assert.equal(res.tools.length, BROWSER_TOOLS.length + CONTROL_TOOLS.length);
  assert.deepEqual(
    res.tools.map((t) => t.name).sort(),
    [...BROWSER_TOOLS.map((t) => t.name), ...CONTROL_TOOLS.map((t) => t.name)].sort(),
  );
  for (const tool of res.tools) {
    assert.ok(tool.inputSchema?.type === "object", `${tool.name} has an object input schema`);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} described`);
  }
});

test("control tools (MCP-over-ACP): agent-driven session orchestration end to end", async () => {
  const tabs = new FakeTabs();
  const hostRef = { current: null };
  const control = makeFakeControl(tabs, hostRef);
  const fakeFirefox = makeFakeFirefox(tabs, control.handler);

  // The driver agent's turn: read state, create a session, bind the active
  // tab to it, prompt it, and read state again — all via control tools.
  // The created session's own turn calls a browser tool on its bound tab.
  const script = writeScript([
    {
      match: "orchestrate",
      toolCalls: [
        { toolName: "pi_get_state", args: {} },
        { toolName: "pi_new_session", args: { cwd: "/work/demo-ctrl" } },
        { toolName: "pi_bind_current_tab", args: { sessionId: "$new" } },
        { toolName: "pi_prompt", args: { sessionId: "$new", text: "work now" } },
        { toolName: "pi_get_state", args: {} },
      ],
    },
    { match: "work now", toolCalls: [{ toolName: "browser_get_page", args: {} }] },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  hostRef.current = host;
  fakeFirefox.attach(host);
  try {
    await initialize(host);

    const tab = tabs.addTab("http://demo.test/", "Demo Page");
    tabs.setActive(tab);

    const decl = fakeFirefox.mcpServer.declarePending();
    const driverRes = await host.request(AGENT_METHODS.session_new, {
      cwd: "/work/driver",
      mcpServers: [{ name: "firefox-browser", type: "acp", serverId: decl.serverId }],
    });
    const driverId = driverRes.sessionId;
    decl.resolve(driverId);

    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: driverId, prompt: [{ type: "text", text: "orchestrate the demo" }] },
      120_000,
    );

    // Every control call went through the MCP-over-ACP path, in order.
    assert.deepEqual(
      control.state.log.map((c) => c.tool),
      ["pi_get_state", "pi_new_session", "pi_bind_current_tab", "pi_prompt", "pi_get_state"],
    );
    const newSessionId = control.state.lastNew;
    assert.ok(newSessionId, "a new session id was created via pi_new_session");

    // The driver's stream carries the control tool results (incl. the id).
    const driverEnds = host
      .sessionUpdates(driverId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update))
      .join("\n");
    assert.ok(driverEnds.includes(newSessionId), "pi_new_session result carried the new session id");
    // Tool result text is JSON-escaped inside the update, so match loosely.
    assert.ok(driverEnds.includes("accepted"), "pi_prompt reported acceptance");
    assert.ok(driverEnds.includes(String(tab)), "pi_bind result carried the bound tab id");

    // The created session ran its turn: the prompt text reached it (the mock
    // echoes it in its reply) and its browser tool hit the bound tab (via the
    // legacy callback path, since it was created without an MCP server).
    const newUpdates = host.sessionUpdates(newSessionId);
    assert.ok(
      newUpdates.some(
        (u) => u.params.update?.sessionUpdate === "agent_message_chunk" && (u.params.update.content?.text ?? "").includes("work now"),
      ),
      "new session received the orchestrated prompt",
    );
    const newEnds = newUpdates
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update))
      .join("\n");
    assert.ok(newEnds.includes("http://demo.test/"), "new session's browser tool saw the bound tab");
    const lastEnd = newUpdates.filter((u) => u.params.update?.sessionUpdate === "tool_call_update").at(-1);
    assert.equal(lastEnd.params.update.status, "completed");

    // State after the turn: the new session is listed (via the host's ACP).
    const list = await host.request(AGENT_METHODS.session_list, { cwd: null });
    assert.ok(list.sessions.some((s) => s.sessionId === newSessionId), "new session listed by the host");
  } finally {
    await shutdown(host);
  }
});

test("control tools (MCP-over-ACP): structured errors round-trip with their codes", async () => {
  const tabs = new FakeTabs();
  const hostRef = { current: null };
  const control = makeFakeControl(tabs, hostRef);
  const fakeFirefox = makeFakeFirefox(tabs, control.handler);

  const script = writeScript([
    { match: "error tools", toolCalls: [
      // session/close is idempotent; set_config_option on an unknown session
      // is the structured SESSION_NOT_FOUND path.
      { toolName: "pi_set_config_option", args: { sessionId: "nope-404", configId: "model", value: "mock/model-b" } },
      { toolName: "pi_open_bound_tab", args: { sessionId: "never-bound" } },
    ] },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  hostRef.current = host;
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    const decl = fakeFirefox.mcpServer.declarePending();
    const res = await host.request(AGENT_METHODS.session_new, {
      cwd: "/work/d",
      mcpServers: [{ name: "firefox-browser", type: "acp", serverId: decl.serverId }],
    });
    decl.resolve(res.sessionId);

    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: res.sessionId, prompt: [{ type: "text", text: "trigger the error tools" }] },
      60_000,
    );
    const ends = host
      .sessionUpdates(res.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update))
      .join("\n");
    // Both failed, with their structured codes preserved through the wire.
    const failed = host
      .sessionUpdates(res.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update" && u.params.update.status === "failed");
    assert.equal(failed.length, 2, `expected 2 failed control calls, got: ${ends}`);
    assert.ok(ends.includes("SESSION_NOT_FOUND"), "SESSION_NOT_FOUND code preserved");
    assert.ok(ends.includes("BROWSER_NOT_BOUND"), "BROWSER_NOT_BOUND code preserved");
  } finally {
    await shutdown(host);
  }
});

test("json-rpc: pipelined requests keep their ids (no cross-talk)", async () => {
  const host = spawnHost();
  try {
    await initialize(host);
    // Fire several session/new without awaiting — responses must come back
    // paired with the right ids even when frames interleave.
    const reqs = ["/work/p0", "/work/p1", "/work/p2", "/work/p3", "/work/p4"].map((cwd) =>
      host.request(AGENT_METHODS.session_new, { cwd }),
    );
    const results = await Promise.all(reqs);
    const ids = results.map((r) => r.sessionId);
    assert.equal(new Set(ids).size, 5, "five distinct sessions");
    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});
