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

import { HostClient } from "./host-client.mjs";

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
    this.replOwned = new Set(); // tabIds opened via browser_open_tab (mirrors ReplTabs)
    this.dispatchDelayMs = 0; // tests can widen the in-flight window
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
  async dispatch(params) {
    this.calls.push(params);
    if (this.dispatchDelayMs > 0) await new Promise((r) => setTimeout(r, this.dispatchDelayMs));
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
        return text({
          refCount: tab.dom.length,
          elements: tab.dom,
          stats: { scanned: tab.dom.length, matched: tab.dom.length, shadowRoots: 0, iframes: 1 },
          frames: [{ index: 0, src: "http://a.test/embed/app", sameOrigin: true }],
          frameEcho: args.frame ?? 0,
        });
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
      case "browser_evaluate":
        return text({ value: "fake-eval-result", world: "page" });
      case "browser_get_console":
        return text({
          messages: [{ t: Date.now(), level: "error", source: "window-error", text: "TypeError: fake is not defined" }],
          total: 1,
          dropped: 0,
          cleared: Boolean(args.clear),
        });
      case "browser_get_network":
        return text({
          requests: [
            { id: 1, time: Date.now(), url: "http://a.test/api/x", method: "GET", type: "xmlhttprequest", status: 500, durationMs: 12 },
          ],
          total: 1,
          returned: 1,
          truncated: false,
        });
      case "browser_element_at":
        return text({
          found: true,
          x: args.x,
          y: args.y,
          element: { ref: "el-2", role: "button", tag: "button", text: "Go", rect: { x: 90, y: 90, width: 20, height: 20 } },
        });
      case "browser_navigate": {
        if (typeof args.url !== "string" || !/^(https?|file):\/\//i.test(args.url)) {
          throw toErrorObject(PI_BROWSER_ERROR.INTERNAL, "browser_navigate requires an absolute http(s) or file URL");
        }
        tab.url = args.url;
        return text({ navigatingTo: tab.url });
      }
      case "browser_get_accessibility_tree": {
        // The REPL snapshot() asks for the structured nodes format.
        if (args.format === "nodes") {
          return text({
            nodes: tab.dom.map((d) => ({ ref: d.ref, role: d.role, name: d.text, ...(d.role === "heading" ? { level: 1 } : {}), rect: { x: 90, y: 90, width: 20, height: 20 } })),
            nodeCount: tab.dom.length,
            truncated: false,
          });
        }
        return text({
          tree: 'WebArea "Fake Page"\n  main\n    heading "Fake Page" (level 1)\n    button "Go" [el-2]',
          nodeCount: 4,
          truncated: false,
        });
      }
      case "browser_click_at":
        return text({ found: true, x: args.x, y: args.y, clicked: { ref: "el-2", role: "button", tag: "button", text: "Go" } });
      case "browser_focus":
        return text({ focused: { tag: "button", role: "button" } });
      case "browser_scroll":
        return text({ scrolled: { tag: "button", role: "button" } });
      case "browser_type_focused":
        return text({ typed: { tag: "input", role: "textbox" }, chars: String(args.text ?? "").length });
      case "browser_open_tab": {
        const url = typeof args.url === "string" ? args.url : "about:blank";
        const tabId = this.addTab(url, "REPL Tab");
        this.replOwned.add(tabId);
        // The real add-on rebinds the session to the REPL tab (owner "repl");
        // the previous binding is remembered as the home tab.
        this.bind(sessionId, tabId);
        return text({ tabId, url });
      }
      case "browser_close_tab": {
        const tabId = Number(args.tabId);
        if (!this.replOwned.has(tabId)) {
          throw toErrorObject(PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED, `tab ${tabId} is not owned by this session's REPL`);
        }
        this.replOwned.delete(tabId);
        this.closeTab(tabId);
        // Restore the home tab when the session was bound to the closed tab.
        if (this.bindings.get(sessionId) === tabId) {
          const home = [...this.tabs.values()].find((t) => !t.closed);
          if (home) this.bind(sessionId, home.id);
        }
        return text({ closed: tabId });
      }
      case "browser_list_tabs":
        return text({
          tabs: [...this.tabs.values()].filter((t) => !t.closed).map((t) => ({ id: t.id, url: t.url, title: t.title, bound: t.id === this.bindings.get(sessionId) })),
        });
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
      // Isolated broker dir per host: e2e hosts must not attach to the
      // developer's real broker (or to each other) unless a test opts in.
      PI_BROWSER_BROKER_DIR: path.join(
        tmpRoot,
        `broker-${Math.random().toString(36).slice(2)}`,
      ),
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
    clientInfo: { name: "pi-browser-firefox", version: "0.1.1" },
    _meta: {
      piAgent: {
        type: "pi.agent.hello",
        client: { application: "firefox", extensionId: "pi-agent-firefox@matbee.com", version: "0.1.1" },
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
      clientInfo: { name: "fake-firefox", version: "0.1.1" },
    });
    assert.equal(existsSync(hbFile), false, "no heartbeat for a non-add-on client");

    // The add-on's identity (what the real add-on sends) creates it — this is
    // the presence signal /pi-browser status|doctor uses for auto-detection.
    await host.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "pi-browser-firefox", version: "0.1.1" },
    });
    assert.ok(existsSync(hbFile), "heartbeat written for the add-on client");
    const hb = JSON.parse(readFileSync(hbFile, "utf8"));
    assert.equal(hb.client, "pi-browser-firefox");
    assert.equal(hb.version, "0.1.1");
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
    { match: "diagnose", toolCalls: [
      { toolName: "browser_get_accessibility_tree", args: { maxNodes: 50 } },
      { toolName: "browser_get_console", args: { level: "error", limit: 5 } },
      { toolName: "browser_get_network", args: { errorsOnly: true } },
      { toolName: "browser_evaluate", args: { expression: "(t) => t.toUpperCase()", arg: "hello" } },
      { toolName: "browser_element_at", args: { x: 100, y: 100 } },
      { toolName: "browser_get_dom", args: { frame: "embed", maxElements: 5 } },
    ] },
    { match: "goto-next", toolCalls: [{ toolName: "browser_navigate", args: { url: "http://b.test/next" } }] },
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

    // Diagnostic tools (PRODUCT.md §25 "Next" / Phase 6): a11y tree, console,
    // network, evaluate, element_at — all round-trip through the real
    // provider + legacy transport to the bound tab.
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: b.sessionId, prompt: [{ type: "text", text: "diagnose the tab" }] },
      60_000,
    );
    const diagEnds = host
      .sessionUpdates(b.sessionId)
      .filter((u) => u.params.update?.sessionUpdate === "tool_call_update" && u.params.update.status === "completed")
      .map((u) => JSON.stringify(u.params.update))
      .join("\n");
    assert.ok(diagEnds.includes("fake-eval-result"), "browser_evaluate result streamed");
    // (quotes in the tree are JSON-escaped inside the update, match without them)
    assert.ok(diagEnds.includes("WebArea") && diagEnds.includes("[el-2]"), "accessibility tree streamed");
    assert.ok(diagEnds.includes("TypeError: fake is not defined"), "console error streamed");
    assert.ok(diagEnds.includes("/api/x"), "network request streamed");
    assert.ok(diagEnds.includes("rect"), "element_at returned the hit element");
    assert.ok(diagEnds.includes("embed"), "frame parameter round-tripped through get_dom");
    const evalCall = [...tabs.calls].reverse().find((c) => c.tool === "browser_evaluate");
    assert.equal(evalCall.arguments.arg, "hello", "evaluate arg delivered");
    const elemCall = [...tabs.calls].reverse().find((c) => c.tool === "browser_element_at");
    assert.deepEqual({ x: elemCall.arguments.x, y: elemCall.arguments.y }, { x: 100, y: 100 }, "coordinates delivered");
    const frameCall = [...tabs.calls].reverse().find((c) => c.tool === "browser_get_dom" && c.arguments.frame !== undefined);
    assert.equal(frameCall.arguments.frame, "embed", "frame arg delivered to the tab");

    // browser_navigate moves the bound tab (the fake tab state follows).
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: b.sessionId, prompt: [{ type: "text", text: "goto-next" }] },
      60_000,
    );
    const navCall = [...tabs.calls].reverse().find((c) => c.tool === "browser_navigate");
    assert.equal(navCall.sessionId, b.sessionId, "navigate targeted session B's tab");
    assert.equal(tabs.tabs.get(tabB).url, "http://b.test/next", "tab B navigated");
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

// ---------------------------------------------------------------------------
// Thunderbird client (THUNDERBIRD-PLAN.md §36, Phase T1)
//
// The real Thunderbird add-on declares application=thunderbird and, in T1,
// NO capabilities (pure chat — mail/compose tools land in T2/T3). It also
// declares no MCP server (no tools to serve). This drives the REAL built host
// exactly like that add-on does and proves the host contract for a
// Thunderbird client: the hello is accepted and echoed, a session runs as a
// complete chat interface (prompt → streaming, cancel), and NO browser tools
// are registered for it.
// ---------------------------------------------------------------------------

async function initializeThunderbird(host) {
  return host.request(AGENT_METHODS.initialize, {
    protocolVersion: 1,
    clientCapabilities: { loadSession: true },
    clientInfo: { name: "pi-thunderbird", version: "0.1.1" },
    _meta: {
      piAgent: {
        type: "pi.agent.hello",
        client: { application: "thunderbird", extensionId: "pi-agent-thunderbird@matbee.com", version: "0.1.1" },
        // T1: pure chat interface — no tools (plan §28: mail/compose arrive later).
        capabilities: [],
      },
    },
  });
}

test("thunderbird client: hello accepted, no tools registered, chat streams + cancel", async () => {
  const script = writeScript([
    // Chat turn: streams text, then the script attempts a browser tool. For a
    // capabilities:[] Thunderbird client the host registered no browser tools,
    // so the mock backend must report it as an unknown tool.
    {
      match: "summarize",
      events: [{ type: "text_delta", delta: "Here is the summary." }],
      toolCalls: [{ toolName: "browser_get_page" }],
    },
    { match: "slow", events: [{ type: "text_delta", delta: "working…" }], delayMs: 3000 },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  try {
    const res = await initializeThunderbird(host);

    // The host echoes the Thunderbird hello it accepted (plan §24).
    const agentMeta = res._meta?.piAgent;
    assert.ok(agentMeta, "piAgent metadata present");
    assert.equal(agentMeta.application, "thunderbird");
    assert.deepEqual(agentMeta.capabilities, []);

    // Session with NO mcpServers (T1 declares no MCP server / no tools).
    const created = await host.request(AGENT_METHODS.session_new, { cwd: "/home/user" });
    assert.ok(created.sessionId, "session created");

    // A prompt streams assistant text back over session/update.
    const mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "summarize" }] },
      60_000,
    );
    const updates = host.notifications
      .slice(mark)
      .filter((m) => m.method === "session/update" && m.params?.sessionId === created.sessionId);
    const text = updates
      .map((u) => (u.params.update?.sessionUpdate === "agent_message_chunk" ? u.params.update.content?.text : ""))
      .join("");
    assert.ok(text.includes("Here is the summary."), "assistant text streamed to the client");

    // The scripted browser tool call must report FAILED as an unknown tool:
    // proof that no browser tools were registered for this Thunderbird client.
    const toolUpdates = updates.filter((u) => u.params.update?.sessionUpdate === "tool_call_update");
    const failed = toolUpdates.find((u) => u.params.update?.status === "failed");
    assert.ok(failed, "browser tool call reported failed for a capabilities:[] client");
    const failedOut = JSON.stringify(failed.params.update?.rawOutput ?? failed.params.update?.content ?? "");
    assert.ok(/unknown tool browser_get_page/i.test(failedOut), "browser tool was not registered for thunderbird");

    // Cancel an in-flight turn (full chat interface: new/prompt/stream/cancel).
    const promptP = host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "slow" }] },
      60_000,
    );
    await sleep(50);
    await host.request(AGENT_METHODS.session_cancel, { sessionId: created.sessionId });
    await promptP; // resolves after abort

    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});

// ---------------------------------------------------------------------------
// T2: Thunderbird mail capability provider
//
// The real Thunderbird add-on now declares capabilities ["mail","attachments"]
// and serves the ten read-only mail tools over the legacy x-pi-browser/tool
// transport. This drives the REAL built host exactly like that add-on does:
// the hello is accepted and echoed, the host registers the mail tools (not the
// browser tools), and a scripted agent mail-tool call round-trips over the
// legacy transport to the client-side mail dispatcher.
// ---------------------------------------------------------------------------

/** Client-side stand-in for the add-on's mail-dispatcher (fake mailbox). */
class FakeMail {
  constructor() {
    this.calls = [];
    this.context = {
      tab: { tabId: 1, type: "inbox" },
      selectedFolders: [{ id: "f1", name: "Inbox" }],
      selectedMessages: [
        {
          messageId: 1001,
          headerMessageId: "<t2@x>",
          subject: "T2 works",
          author: "Tester <t@x>",
          date: "2024-05-05T00:00:00Z",
          read: false,
          folder: "Inbox",
          folderId: "f1",
        },
      ],
      displayedMessages: [{ messageId: 1001, subject: "T2 works" }],
    };
  }
  dispatch(params) {
    this.calls.push(params.tool);
    const { tool } = params;
    let result;
    switch (tool) {
      case "mail_get_context":
        result = { context: this.context };
        break;
      case "mail_get_message":
        result = this.context.selectedMessages[0];
        break;
      case "mail_get_message_body":
        result = { bodyText: "Body of T2 works.", truncated: false };
        break;
      case "mail_search":
        result = { messages: this.context.selectedMessages, nextCursor: null };
        break;
      case "mail_list_attachments":
        result = { attachments: [{ partName: "1", name: "t2.txt", contentType: "text/plain", size: 9 }] };
        break;
      case "mail_list_accounts":
        result = { accounts: [{ id: "acc1", name: "Test", identities: [{ identityId: "id1", email: "t@x", isDefault: true }] }] };
        break;
      case "mail_list_folders":
        result = { folders: this.context.selectedFolders };
        break;
      default:
        throw toErrorObject(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown mail tool: ${tool}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
}

test("thunderbird mail client: hello accepted, mail tools registered, mail tool round-trips", async () => {
  const mail = new FakeMail();
  const script = writeScript([
    {
      match: "summarize this email",
      events: [{ type: "text_delta", delta: "Done." }],
      toolCalls: [{ toolName: "mail_get_context" }],
    },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  try {
    // Client-side mail dispatcher, as the add-on's onToolCall installs one.
    host.on(X_PI_BROWSER.tool, (params) => mail.dispatch(params));
    // Mail tools are approval-gated: the fake user approves, and each prompt
    // is recorded so the test can assert the permission flow fired.
    const permLog = [];
    host.on("session/request_permission", (params) => {
      permLog.push(params);
      return { outcome: { outcome: "selected", optionId: "allow_always" } };
    });

    const res = await host.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: { loadSession: true },
      clientInfo: { name: "pi-thunderbird", version: "0.1.1" },
      _meta: {
        piAgent: {
          type: "pi.agent.hello",
          client: { application: "thunderbird", extensionId: "pi-agent-thunderbird@matbee.com", version: "0.1.1" },
          capabilities: ["mail", "attachments"],
        },
      },
    });
    // The host echoes the mail capabilities it accepted.
    assert.deepEqual(res._meta?.piAgent?.capabilities, ["mail", "attachments"]);

    // Session with no mcpServers (the add-on uses the legacy transport).
    const created = await host.request(AGENT_METHODS.session_new, { cwd: "/home/user" });
    assert.ok(created.sessionId, "session created");

    const mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "summarize this email" }] },
      60_000,
    );
    const updates = host.notifications
      .slice(mark)
      .filter((m) => m.method === "session/update" && m.params?.sessionId === created.sessionId);
    const text = updates
      .map((u) => (u.params.update?.sessionUpdate === "agent_message_chunk" ? u.params.update.content?.text : ""))
      .join("");
    assert.ok(text.includes("Done."), "assistant text streamed");

    // The scripted mail tool completed (not failed) and returned the mailbox.
    const toolEnds = updates.filter((u) => u.params.update?.sessionUpdate === "tool_call_update");
    const completed = toolEnds.find((u) => u.params.update?.status === "completed");
    assert.ok(completed, "mail_get_context completed");
    const out = JSON.stringify(completed.params.update?.rawOutput ?? "");
    assert.ok(out.includes("T2 works"), "mail tool returned the fake mail context");
    assert.ok(mail.calls.includes("mail_get_context"), "client-side mail dispatcher was invoked");
    // The approval gate fired for the mail tool before it executed.
    assert.equal(permLog.length, 1, "one permission prompt for the mail tool");
    assert.equal(
      permLog[0]?._meta?.piBrowser?.tool,
      "mail_get_context",
      "prompt named the mail tool",
    );

    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});

// T4 + T6: Thunderbird mail-organization + contacts capability provider
//
// The real add-on now declares capabilities
// ["mail","attachments","compose","mailModify","contacts"]. This drives the REAL
// built host with that full hello: the host must register the mutation (mailModify)
// and contacts tools and route a scripted call for each over the legacy transport.
// ---------------------------------------------------------------------------

/** Client-side stand-in for the add-on's mutation + contacts dispatchers. */
class FakeT4T6 {
  constructor() {
    this.calls = [];
  }
  dispatch(params) {
    this.calls.push(params.tool);
    const { tool, arguments: args = {} } = params;
    switch (tool) {
      case "contacts_search":
        return {
          content: [{ type: "text", text: JSON.stringify({ count: 1, contacts: [{ id: "c1", name: "Sarah Doe", emails: ["sarah@acme.com"], organization: "Acme" }] }) }],
        };
      case "contacts_get":
        return { content: [{ type: "text", text: JSON.stringify({ id: args.contactId, name: "Sarah Doe", emails: ["sarah@acme.com"] }) }] };
      case "mail_mark_read":
        return { content: [{ type: "text", text: JSON.stringify({ count: args.messageIds?.length ?? 0, read: args.read ?? true }) }] };
      case "mail_set_tags":
        return { content: [{ type: "text", text: JSON.stringify({ count: args.messageIds?.length ?? 0, tags: args.tags }) }] };
      case "mail_archive":
        return { content: [{ type: "text", text: JSON.stringify({ count: args.messageIds?.length ?? 0, note: "archived" }) }] };
      case "mail_move":
        return { content: [{ type: "text", text: JSON.stringify({ count: args.messageIds?.length ?? 0, folderId: args.folderId }) }] };
      default:
        throw toErrorObject(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown tool: ${tool}`);
    }
  }
}

test("thunderbird T4/T6 client: mailModify + contacts tools registered and round-trip", async () => {
  const t46 = new FakeT4T6();
  const script = writeScript([
    {
      match: "sarah",
      events: [{ type: "text_delta", delta: "Found her." }],
      toolCalls: [
        { toolName: "contacts_search", args: { query: "Sarah Acme" } },
        { toolName: "mail_archive", args: { messageIds: [1001] } },
      ],
    },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script });
  try {
    host.on(X_PI_BROWSER.tool, (params) => t46.dispatch(params));
    // Approval-gated tools: the fake user approves; record each prompt.
    const permLog = [];
    host.on("session/request_permission", (params) => {
      permLog.push(params);
      return { outcome: { outcome: "selected", optionId: "allow_always" } };
    });

    const res = await host.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: { loadSession: true },
      clientInfo: { name: "pi-thunderbird", version: "0.1.1" },
      _meta: {
        piAgent: {
          type: "pi.agent.hello",
          client: { application: "thunderbird", extensionId: "pi-agent-thunderbird@matbee.com", version: "0.1.1" },
          capabilities: ["mail", "attachments", "compose", "mailModify", "contacts"],
        },
      },
    });
    const caps = res._meta?.piAgent?.capabilities ?? [];
    assert.ok(caps.includes("mailModify"), "mailModify capability echoed");
    assert.ok(caps.includes("contacts"), "contacts capability echoed");

    const created = await host.request(AGENT_METHODS.session_new, { cwd: "/home/user" });
    const mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "draft a message to sarah and archive the invoice" }] },
      60_000,
    );
    const updates = host.notifications
      .slice(mark)
      .filter((m) => m.method === "session/update" && m.params?.sessionId === created.sessionId);
    const toolEnds = updates.filter((u) => u.params.update?.sessionUpdate === "tool_call_update");
    const completed = toolEnds.filter((u) => u.params.update?.status === "completed");
    const outs = completed.map((u) => JSON.stringify(u.params.update?.rawOutput ?? "")).join("\n");

    // A successful round-trip proves the host REGISTERED each tool (an
    // unregistered tool would fail the schema gate / route to an error).
    assert.ok(t46.calls.includes("contacts_search"), "contacts_search routed to the client dispatcher");
    assert.ok(t46.calls.includes("mail_archive"), "mail_archive routed to the client dispatcher");
    assert.ok(outs.includes("Sarah Doe"), "contacts_search returned the fake contact");
    assert.ok(outs.includes("archived"), "mail_archive returned a result");
    // Both tools were approval-gated before execution.
    const promptedTools = permLog.map((p) => p?._meta?.piBrowser?.tool);
    assert.ok(promptedTools.includes("contacts_search"), "contacts_search prompted for approval");
    assert.ok(promptedTools.includes("mail_archive"), "mail_archive prompted for approval");

    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});

// ---------------------------------------------------------------------------
// javascript REPL (legacy transport) — BROWSER-USE-REPL-PLAN.md Phase 1
// ---------------------------------------------------------------------------

test("javascript REPL (legacy transport): persistent cells, image content, timeout kill, reap on close", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);
  const replDir = path.join(tmpRoot ?? (tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"))), "repl");
  const script = writeScript([
    { match: "repl-init", toolCalls: [{ toolName: "javascript", args: { code: "x = 41; x + 1" } }] },
    { match: "repl-persist", toolCalls: [{ toolName: "javascript", args: { code: "x" } }] },
    { match: "repl-shot", toolCalls: [{ toolName: "javascript", args: { code: "await screenshot()" } }] },
    { match: "repl-hang", toolCalls: [{ toolName: "javascript", args: { code: "for (;;) {}", timeoutMs: 1500 } }] },
  ]);
  // Neutral cwd ("/"): the host provisions a per-task workspace under
  // PI_BROWSER_WORKSPACE_DIR (the REPL binds to it); a real /work/... path
  // would need mkdir /work (EACCES) in CI.
  const wsDir = path.join(tmpRoot, "ws-repl");
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script, PI_BROWSER_REPL_DIR: replDir, PI_BROWSER_WORKSPACE_DIR: wsDir });
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    const tab = tabs.addTab("http://a.test/repl", "REPL Page");
    const s = await host.request(AGENT_METHODS.session_new, { cwd: "/" });
    tabs.bind(s.sessionId, tab);

    const cellUpdates = (mark) =>
      host.notifications
        .slice(mark)
        .filter((m) => m.method === "session/update" && m.params?.sessionId === s.sessionId);
    const cellEnds = (mark) =>
      cellUpdates(mark).filter((u) => u.params.update?.sessionUpdate === "tool_call_update");

    // Cell 1: x = 41; x + 1 -> 42
    let mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-init" }] },
      60_000,
    );
    const starts1 = cellUpdates(mark).filter((u) => u.params.update?.sessionUpdate === "tool_call");
    assert.ok(starts1.some((u) => u.params.update?.title?.includes("javascript")), "javascript tool call streamed");
    let outs = cellEnds(mark).map((u) => JSON.stringify(u.params.update?.rawOutput ?? "")).join("\n");
    assert.ok(outs.includes("42"), "cell printed 42");
    assert.equal(tabs.calls.filter((c) => c.sessionId === s.sessionId).length, 0, "plain cells never touch the add-on");

    // Cell 2: x persists (41) — same runtime, same realm.
    mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-persist" }] },
      60_000,
    );
    outs = cellEnds(mark).map((u) => JSON.stringify(u.params.update?.rawOutput ?? "")).join("\n");
    assert.ok(outs.includes("41"), "x persisted across cells");

    // Cell 3: screenshot() — the cell's tool call goes through the SAME
    // permission gate as a direct browser_screenshot call.
    mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-shot" }] },
      60_000,
    );
    const shotEnds = cellEnds(mark);
    const shotRaw = shotEnds.map((u) => JSON.stringify(u.params.update?.rawOutput ?? "")).join("\n");
    assert.ok(shotRaw.includes('"type":"image"') || shotRaw.includes('"type": "image"'), "image content attached to the cell result");
    assert.ok(shotRaw.includes("image/png"), "fake tab screenshot mime type carried");
    assert.ok(
      (tabs.permissionLog ?? []).some((p) => JSON.stringify(p._meta ?? {}).includes("browser_screenshot")),
      "screenshot from inside a cell was approval-gated",
    );
    assert.ok(tabs.calls.some((c) => c.sessionId === s.sessionId && c.tool === "browser_screenshot"), "screenshot routed to the bound tab");

    // Cell 4: sync infinite loop — killed at 1.5s, state reset, host alive.
    mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-hang" }] },
      60_000,
    );
    const hangEnds = cellEnds(mark);
    const hangRaw = hangEnds.map((u) => JSON.stringify(u.params.update ?? "")).join("\n");
    assert.ok(hangRaw.includes("cell aborted"), "timeout surfaced as a reset notice");
    assert.ok(hangRaw.includes("exceeded 1500 ms"), "cell timeout message carries the budget");
    assert.ok(host.alive, "host survived the killed cell");

    // Close the session: the worker child is reaped (no orphan processes).
    await host.request(AGENT_METHODS.session_close, { sessionId: s.sessionId });
    const { execSync } = await import("node:child_process");
    let orphans = "";
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      orphans = execSync(`pgrep -P ${host.child.pid} -f "repl/worker.js" || true`, { encoding: "utf8" }).trim();
      if (!orphans) break;
    }
    assert.equal(orphans, "", `session close reaps the REPL worker (orphans: ${orphans})`);

    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});

test("javascript REPL (primitives): snapshot/goto/interact/tabs/checkpoint through the real worker", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);
  const replDir = path.join(tmpRoot ?? (tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"))), "repl-primitives");
  const wsDir = path.join(tmpRoot, "ws-repl-p");
  const script = writeScript([
    { match: "repl-snap", toolCalls: [{ toolName: "javascript", args: { code: "const s = await page.snapshot(); JSON.stringify(s.nodes.map((n) => n.role))" } }] },
    { match: "repl-goto", toolCalls: [{ toolName: "javascript", args: { code: "const p = await page.goto('http://a.test/next'); p.url" } }] },
    { match: "repl-act", toolCalls: [{ toolName: "javascript", args: { code: "const r = await page.clickAt(95, 95); [r.clicked.text, (await page.typeFocused('hi')).chars, (await page.focus('el-2')).focused.tag, (await page.scroll('el-2')).scrolled.tag].join('/')" } }] },
    { match: "repl-tabs", toolCalls: [{ toolName: "javascript", args: { code: "const t = await tabs.open('http://aux.test/r'); const l = await tabs.list(); await page.close(); l.length" } }] },
    { match: "repl-checkpoint", toolCalls: [{ toolName: "javascript", args: { code: "await checkpoint('state-1', { n: 1 }); 'saved'" } }] },
  ]);
  // Neutral cwd: the session gets a provisioned task workspace; the REPL
  // binds to it, so checkpoints land there (reported in _meta.piBrowser.workspace).
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script, PI_BROWSER_REPL_DIR: replDir, PI_BROWSER_WORKSPACE_DIR: wsDir });
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    const tab = tabs.addTab("http://a.test/repl", "REPL Page");
    const s = await host.request(AGENT_METHODS.session_new, { cwd: "/" });
    tabs.bind(s.sessionId, tab);

    const runCell = async (name) => {
      const mark = host.notifications.length;
      await host.request(
        AGENT_METHODS.session_prompt,
        { sessionId: s.sessionId, prompt: [{ type: "text", text: name }] },
        60_000,
      );
      return host.notifications
        .slice(mark)
        .filter((m) => m.method === "session/update" && m.params?.sessionId === s.sessionId && m.params.update?.sessionUpdate === "tool_call_update")
        .map((u) => JSON.stringify(u.params.update?.rawOutput ?? ""))
        .join("\n");
    };

    // P2.5: structured snapshot (nodes + refs + rects). (The last expression
    // is a string, so the REPL prints it quoted — assert on the roles.)
    let outs = await runCell("repl-snap");
    assert.ok(outs.includes("heading") && outs.includes("button"), `snapshot roles: ${outs}`);
    assert.ok(
      tabs.calls.some((c) => c.tool === "browser_get_accessibility_tree" && c.sessionId === s.sessionId && c.arguments?.format === "nodes"),
      "snapshot used the structured nodes format",
    );

    // P2.5: goto = navigate + readyState poll + info.
    outs = await runCell("repl-goto");
    assert.ok(outs.includes("http://a.test/next"), `goto resolved: ${outs}`);
    assert.ok(tabs.calls.some((c) => c.tool === "browser_navigate" && c.sessionId === s.sessionId), "navigate routed through the bound tab");

    // P2.5: clickAt / typeFocused / focus / scroll.
    outs = await runCell("repl-act");
    assert.ok(outs.includes("Go/2/button/button"), `interaction primitives: ${outs}`);
    for (const tool of ["browser_click_at", "browser_type_focused", "browser_focus", "browser_scroll"]) {
      assert.ok(tabs.calls.some((c) => c.tool === tool && c.sessionId === s.sessionId), `${tool} called`);
    }

    // P2.6: tabs.open -> list -> close lifecycle; binding restored.
    outs = await runCell("repl-tabs");
    assert.ok(outs.includes("2"), `two tabs listed before close: ${outs}`);
    assert.equal(tabs.bindings.get(s.sessionId), tab, "binding restored to the bound tab after page.close()");
    assert.equal(tabs.replOwned.size, 0, "REPL-owned tab cleaned up on close");

    // P2.7: checkpoint lands in the session workspace (0600).
    outs = await runCell("repl-checkpoint");
    assert.ok(outs.includes("saved"), `checkpoint cell: ${outs}`);
    const ws = s._meta?.piBrowser?.workspace;
    assert.ok(ws, "session_new reports the provisioned task workspace");
    const cp = path.join(ws, "state-1");
    const fs = await import("node:fs");
    assert.equal(fs.statSync(cp).mode & 0o777, 0o600, "checkpoint file is 0600");
    assert.equal(fs.readFileSync(cp, "utf8"), JSON.stringify({ n: 1 }), "checkpoint content round-trips");

    await host.request(AGENT_METHODS.session_close, { sessionId: s.sessionId });
    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});

test("javascript REPL (fs): workspace-scoped filesystem, escapes rejected", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);
  const replDir = path.join(tmpRoot ?? (tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"))), "repl-fs");
  const wsDir = path.join(tmpRoot, "ws-repl-fs");
  const script = writeScript([
    { match: "repl-fs-write", toolCalls: [{ toolName: "javascript", args: { code: "await fs.write('notes/a.txt', 'from-cell'); await fs.append('notes/a.txt', '+more'); await fs.mkdir('docs'); (await fs.list()).length" } }] },
    { match: "repl-fs-read", toolCalls: [{ toolName: "javascript", args: { code: "await fs.read('notes/a.txt')" } }] },
    { match: "repl-fs-escape", toolCalls: [{ toolName: "javascript", args: { code: "try { await fs.read('../escape.txt'); 'no-throw' } catch (e) { String(e).includes('escapes') ? 'blocked' : 'wrong-error: ' + e }" } }] },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script, PI_BROWSER_REPL_DIR: replDir, PI_BROWSER_WORKSPACE_DIR: wsDir });
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    const tab = tabs.addTab("http://a.test/fs", "REPL FS Page");
    const s = await host.request(AGENT_METHODS.session_new, { cwd: "/" });
    tabs.bind(s.sessionId, tab);
    const ws = s._meta?.piBrowser?.workspace;
    assert.ok(ws && ws.startsWith(wsDir), `session workspace under PI_BROWSER_WORKSPACE_DIR: ${ws}`);

    const runCell = async (name) => {
      const mark = host.notifications.length;
      await host.request(
        AGENT_METHODS.session_prompt,
        { sessionId: s.sessionId, prompt: [{ type: "text", text: name }] },
        60_000,
      );
      return host.notifications
        .slice(mark)
        .filter((m) => m.method === "session/update" && m.params?.sessionId === s.sessionId && m.params.update?.sessionUpdate === "tool_call_update")
        .map((u) => JSON.stringify(u.params.update?.rawOutput ?? ""))
        .join("\n");
    };

    // fs.write/append/mkdir land in the session's task workspace.
    let outs = await runCell("repl-fs-write");
    assert.ok(outs.includes("2"), `two top-level entries after write+mkdir: ${outs}`);
    const nodeFs = await import("node:fs");
    assert.equal(
      nodeFs.readFileSync(path.join(ws, "notes/a.txt"), "utf8"),
      "from-cell+more",
      "fs.write/append landed in the session workspace",
    );

    // Round-trip read through the realm.
    outs = await runCell("repl-fs-read");
    assert.ok(outs.includes("from-cell+more"), `fs.read round-trips: ${outs}`);

    // Escape attempts are rejected by the sandbox (the cell reports 'blocked').
    outs = await runCell("repl-fs-escape");
    assert.ok(outs.includes("blocked"), `escape rejected with the sandbox error: ${outs}`);

    await host.request(AGENT_METHODS.session_close, { sessionId: s.sessionId });
    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});

test("javascript REPL (hardening): rebind mid-cell, ACP cancel, two-session isolation", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);
  const replDir = path.join(tmpRoot ?? (tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"))), "repl-hard");
  const wsDir = path.join(tmpRoot, "ws-repl-h");
  const script = writeScript([
    { match: "repl-mid", toolCalls: [{ toolName: "javascript", args: { code: "await page.info()" } }] },
    { match: "repl-next", toolCalls: [{ toolName: "javascript", args: { code: "1 + 1" } }] },
    { match: "repl-cancel", toolCalls: [{ toolName: "javascript", args: { code: "for (;;) {}" } }] },
    { match: "repl-a1", toolCalls: [{ toolName: "javascript", args: { code: "secret = 'A'; 1" } }] },
    { match: "repl-b1", toolCalls: [{ toolName: "javascript", args: { code: "typeof secret" } }] },
  ]);
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script, PI_BROWSER_REPL_DIR: replDir, PI_BROWSER_WORKSPACE_DIR: wsDir });
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    const tabA = tabs.addTab("http://a.test/1", "Tab A");
    const s = await host.request(AGENT_METHODS.session_new, { cwd: "/" });
    tabs.bind(s.sessionId, tabA);

    // P3.1: rebind mid-cell — the in-flight tool call hits the closed tab
    // (structured error) and the NEXT cell starts with the invalidation note.
    tabs.dispatchDelayMs = 300;
    let p = host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-mid" }] },
      60_000,
    );
    await sleep(80); // the browser_get_page call is now in flight
    tabs.closeTab(tabA);
    host.sendRaw({
      jsonrpc: "2.0",
      method: X_PI_BROWSER.notify,
      params: { sessionId: s.sessionId, event: "tab_closed", data: { tabId: tabA } },
    });
    await p;
    const midOut = host.notifications
      .filter((m) => m.method === "session/update" && m.params?.sessionId === s.sessionId && m.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update?.rawOutput ?? ""))
      .join("\n");
    assert.ok(midOut.includes("BROWSER_TAB_CLOSED"), `in-flight call failed with the structured code: ${midOut}`);

    // Next cell: the tab_closed note is prepended (state survived; the note
    // warns the model before it acts on a dead binding).
    const tabA2 = tabs.addTab("http://a.test/2", "Tab A2");
    tabs.bind(s.sessionId, tabA2);
    tabs.dispatchDelayMs = 0;
    const mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-next" }] },
      60_000,
    );
    const nextOut = host.notifications
      .slice(mark)
      .filter((m) => m.method === "session/update" && m.params?.sessionId === s.sessionId && m.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update?.rawOutput ?? ""))
      .join("\n");
    assert.ok(nextOut.includes("bound tab was closed"), `invalidation note on next cell: ${nextOut}`);
    assert.ok(nextOut.includes("2"), "state persisted across the dead cell (1 + 1 = 2)");

    // P3.2: ACP cancel aborts a running cell (child killed, host alive).
    p = host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-cancel" }] },
      60_000,
    );
    await sleep(2000); // the cell is spinning; cancel mid-loop
    const cancelRes = await host.request(AGENT_METHODS.session_cancel, { sessionId: s.sessionId });
    assert.deepEqual(cancelRes, {}, "session/cancel acked");
    const res = await p;
    assert.equal(res.stopReason, "cancelled", "cancel surfaced as the ACP stopReason");
    // The killed child settles the cell AFTER the prompt resolved; poll for
    // the abort notification.
    let cancelOut = "";
    for (let i = 0; i < 50 && !(cancelOut.includes("cell aborted") && cancelOut.includes("cancelled")); i++) {
      await sleep(100);
      cancelOut = host.notifications
        .filter((m) => m.method === "session/update" && m.params?.sessionId === s.sessionId && m.params.update?.sessionUpdate === "tool_call_update")
        .map((u) => JSON.stringify(u.params.update?.rawOutput ?? ""))
        .join("\n");
    }
    assert.ok(cancelOut.includes("cell aborted"), `cancel aborted the cell: ${cancelOut}`);
    assert.ok(host.alive, "host survived the cancel");

    // P3.3: two sessions, two tabs — REPL state and tool traffic never cross.
    // A defines `secret` in its own realm; B must not see it.
    const s2 = await host.request(AGENT_METHODS.session_new, { cwd: "/" });
    const tabB = tabs.addTab("http://b.test/1", "Tab B");
    tabs.bind(s2.sessionId, tabB);
    await host.request(AGENT_METHODS.session_prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "repl-a1" }] }, 60_000);
    const markB = host.notifications.length;
    await host.request(AGENT_METHODS.session_prompt, { sessionId: s2.sessionId, prompt: [{ type: "text", text: "repl-b1" }] }, 60_000);
    const bOut = host.notifications
      .slice(markB)
      .filter((m) => m.method === "session/update" && m.params?.sessionId === s2.sessionId && m.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update?.rawOutput ?? ""))
      .join("\n");
    assert.ok(bOut.includes("undefined"), `B's realm does not see A's state: ${bOut}`);

    // Tool traffic is partitioned per session.
    const forA = tabs.calls.filter((c) => c.sessionId === s.sessionId);
    const forB = tabs.calls.filter((c) => c.sessionId === s2.sessionId);
    assert.ok(forA.every((c) => c.sessionId === s.sessionId));
    assert.ok(forB.every((c) => c.sessionId === s2.sessionId));

    await host.request(AGENT_METHODS.session_close, { sessionId: s.sessionId });
    await host.request(AGENT_METHODS.session_close, { sessionId: s2.sessionId });
    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});

// WS2/T2.3 (BROWSER-USE-SUPPORT-PLAN.md): rebinding the session to a different
// tab (binding_changed, tab stays open) invalidates the REPL realm — the next
// cell starts with the "binding changed" note. P1.3 deliverable, scripted e2e.
test("javascript REPL: rebind (binding_changed) -> next cell starts with the note", async () => {
  const tabs = new FakeTabs();
  const fakeFirefox = makeFakeFirefox(tabs);
  const replDir = path.join(tmpRoot ?? (tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-browser-e2e-"))), "repl-rebind");
  const script = writeScript([
    { match: "rebind-a", toolCalls: [{ toolName: "javascript", args: { code: "origin = 'A'; 1" } }] },
    { match: "rebind-b", toolCalls: [{ toolName: "javascript", args: { code: "2 + 2" } }] },
  ]);
  const wsDir = path.join(tmpRoot, "ws-repl-rebind");
  const host = spawnHost({ PI_BROWSER_MOCK_SCRIPT: script, PI_BROWSER_REPL_DIR: replDir, PI_BROWSER_WORKSPACE_DIR: wsDir });
  fakeFirefox.attach(host);
  try {
    await initialize(host);
    const s = await host.request(AGENT_METHODS.session_new, { cwd: "/" });
    const tabA = tabs.addTab("http://a.test/1", "Tab A");
    tabs.bind(s.sessionId, tabA);

    // Cell on tab A establishes realm state.
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "rebind-a" }] },
      60_000,
    );

    // Rebind: the add-on points the session at a different (open) tab.
    const tabB = tabs.addTab("http://b.test/1", "Tab B");
    tabs.bind(s.sessionId, tabB);
    host.sendRaw({
      jsonrpc: "2.0",
      method: X_PI_BROWSER.notify,
      params: { sessionId: s.sessionId, event: "binding_changed", data: { tabId: tabB } },
    });

    // The next cell starts with the invalidation note (state may have
    // survived, but the model is warned the page it is looking at is new).
    const mark = host.notifications.length;
    await host.request(
      AGENT_METHODS.session_prompt,
      { sessionId: s.sessionId, prompt: [{ type: "text", text: "rebind-b" }] },
      60_000,
    );
    const out = host.notifications
      .slice(mark)
      .filter((m) => m.method === "session/update" && m.params?.sessionId === s.sessionId && m.params.update?.sessionUpdate === "tool_call_update")
      .map((u) => JSON.stringify(u.params.update?.rawOutput ?? ""))
      .join("\n");
    assert.ok(out.includes("tab binding changed"), `binding_changed note on next cell: ${out}`);

    await host.request(AGENT_METHODS.session_close, { sessionId: s.sessionId });
    assert.ok(host.alive);
  } finally {
    await shutdown(host);
  }
});
