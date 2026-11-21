/**
 * Sidebar sessions on external ACP agents (openspec sidebar-acp-agents):
 * the agent registry, the per-agent process, the session relay, settings,
 * the session index, idle stop, errors, the permission relay and the
 * pi-browser bridge tied to the session.
 *
 * Runs the real host pieces (AcpAgent, ExternalAgents, AgentConnection, the
 * MCP server and the stdio bridge) against test/fixtures/fake-acp-agent.mjs,
 * a scripted ACP agent over stdio.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PERMISSION_WITHDRAWN_METHOD,
  X_PI_BROWSER,
  type AgentsResult,
  type SessionNotification,
} from "@pi-browser/protocol";
import { createLogger } from "../src/logger.js";
import { createMemoryTransportPair, type Dispatcher } from "../src/native-host/transport.js";
import { AcpAgent } from "../src/acp/agent.js";
import { CapabilityToolProvider } from "../src/browser/provider.js";
import { PermissionStore } from "../src/permission-store.js";
import { ExternalAgents } from "../src/acp/agents/manager.js";
import { AgentRegistry } from "../src/acp/agents/registry.js";
import { AgentSessionIndex } from "../src/acp/agents/session-index.js";
import { startMcpBrowserServer, type McpBrowserServerHandle } from "../src/native-host/mcp-server.js";
import type { BridgeSessionContext, BrowserToolBridge } from "../src/tool-bridge.js";
import { MockBackend } from "./mock-backend.js";
import { waitFor } from "./helpers.js";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });
// dist-tests/test/ → package root → test/fixtures/
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "fake-acp-agent.mjs");
const INSTANCE = "test-broker-instance";

let root: string;
const savedBrokerDir = process.env.PI_BROWSER_BROKER_DIR;
const savedHostChild = process.env.PI_BROWSER_HOST_CHILD;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-ext-agents-"));
  process.env.PI_BROWSER_BROKER_DIR = path.join(root, "run");
  delete process.env.PI_BROWSER_HOST_CHILD;
});

after(() => {
  if (savedBrokerDir === undefined) delete process.env.PI_BROWSER_BROKER_DIR;
  else process.env.PI_BROWSER_BROKER_DIR = savedBrokerDir;
  if (savedHostChild !== undefined) process.env.PI_BROWSER_HOST_CHILD = savedHostChild;
  rmSync(root, { recursive: true, force: true });
});

interface FakeAgentConfig {
  env?: Record<string, string>;
  idleTimeoutMinutes?: number;
}

interface Harness {
  dir: string;
  agentsFile: string;
  logFile: string;
  index: AgentSessionIndex;
  ext: ExternalAgents;
  agent: AcpAgent;
  a: Dispatcher;
  updates: SessionNotification[];
  withdrawn: unknown[];
  permissions: Array<Record<string, unknown>>;
  /** How the fake add-on answers session/request_permission (default: never). */
  answer: (params: Record<string, unknown>) => Promise<unknown>;
  registered: Map<string, BridgeSessionContext>;
  clock: { now: number };
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  log(): Array<{ pid: number; method: string | null; sessionId: string | null; outcome?: { outcome: string; optionId?: string } }>;
  close(): Promise<void>;
}

let seq = 0;

function writeAgents(file: string, dir: string, logFile: string, cfg: FakeAgentConfig, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    file,
    JSON.stringify({
      agents: {
        fake: {
          name: "Fake Agent",
          command: process.execPath,
          args: [FAKE],
          env: { FAKE_ACP_STATE: path.join(dir, "state"), FAKE_ACP_LOG: logFile, ...(cfg.env ?? {}) },
          ...(cfg.idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes: cfg.idleTimeoutMinutes } : {}),
          loginHint: "run `fake login` in a terminal",
        },
        ...extra,
      },
    }),
  );
}

function setup(cfg: FakeAgentConfig = {}, opts: { permissionTimeoutMs?: number; dir?: string } = {}): Harness {
  const dir = opts.dir ?? path.join(root, `h${++seq}`);
  const agentsFile = path.join(dir, "agents.json");
  const logFile = path.join(dir, "agent.log");
  mkdirSync(dir, { recursive: true });
  writeAgents(agentsFile, dir, logFile, cfg);
  const clock = { now: Date.now() };
  const registry = new AgentRegistry({ file: agentsFile });
  const index = new AgentSessionIndex(path.join(dir, "agent-sessions.json"));
  const ext = new ExternalAgents({
    log: quiet,
    registry,
    index,
    instanceId: INSTANCE,
    idleCheckMs: 0,
    now: () => clock.now,
    stopGraceMs: 1_000,
    permissionTimeoutMs: () => opts.permissionTimeoutMs ?? 30_000,
  });
  const { a, b } = createMemoryTransportPair(quiet, quiet);
  const provider = new CapabilityToolProvider(b.transport, quiet, undefined, {
    permissionStore: new PermissionStore({ filePath: path.join(dir, "permissions.json") }),
  });
  const registered = new Map<string, BridgeSessionContext>();
  const bridge: BrowserToolBridge = {
    registerSession: (id, ctx) => registered.set(id, ctx),
    touchSession: () => undefined,
    closeSession: (id) => registered.delete(id),
    resolveParentSession: (token) => {
      const id = ext.resolveParentToken(token);
      return id && registered.has(id) ? id : undefined;
    },
    call: async (o) => ({ content: [{ type: "text", text: `ran ${o.tool} for ${o.sessionId ?? "?"}${o.caller ? ` as caller ${o.caller.name}` : ""}` }] }),
  };
  const agent = new AcpAgent({
    backend: new MockBackend(),
    provider,
    transport: b.transport,
    log: quiet,
    agentInfo: { name: "test", version: "0" },
    clientId: "client-1",
    bridge,
    externalAgents: ext,
    workspaceRoot: path.join(dir, "workspaces"),
  });
  const h: Harness = {
    dir,
    agentsFile,
    logFile,
    index,
    ext,
    agent,
    a,
    updates: [],
    withdrawn: [],
    permissions: [],
    answer: () => new Promise(() => undefined),
    registered,
    clock,
    request: (m, p, t) => a.transport.request(m, p, t ?? 20_000),
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
    close: async () => {
      agent.shutdown();
      await ext.shutdown();
    },
  };
  a.transport.onNotification = (method, params) => {
    if (method === CLIENT_METHODS.session_update) h.updates.push(params as SessionNotification);
    if (method === PERMISSION_WITHDRAWN_METHOD) h.withdrawn.push(params);
  };
  a.transport.onRequest = (method, params, id) => {
    if (method === CLIENT_METHODS.session_request_permission) {
      h.permissions.push(params as Record<string, unknown>);
      void h.answer(params as Record<string, unknown>).then((r) => a.transport.respond(id, r));
      return;
    }
    a.transport.respondError(id, { code: -32601, message: "no" });
  };
  return h;
}

async function newSession(h: Harness, agentId = "fake"): Promise<{ sessionId: string; configOptions: Array<{ id: string; currentValue: unknown }>; _meta?: unknown }> {
  return h.request(AGENT_METHODS.session_new, { cwd: h.dir, mcpServers: [], _meta: { piBrowser: { agent: agentId } } }, 30_000);
}

async function promptText(h: Harness, sessionId: string, text: string): Promise<{ stopReason: string }> {
  return h.request(AGENT_METHODS.session_prompt, { sessionId, prompt: [{ type: "text", text }] }, 30_000);
}

function agentText(h: Harness, sessionId: string): string {
  return h.updates
    .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => (u.update as { content: { text: string } }).content.text)
    .join("");
}

function initCount(h: Harness): number {
  return h.log().filter((l) => l.method === "initialize").length;
}

// ---------------------------------------------------------------------------
// Registry and process
// ---------------------------------------------------------------------------

test("x-pi-browser/agents lists pi first, available agents, and missing commands with a reason", async () => {
  const h = setup();
  try {
    writeAgents(h.agentsFile, h.dir, h.logFile, {}, { ghost: { name: "Ghost", command: "definitely-not-a-real-agent-cmd" } });
    const res = await h.request<AgentsResult>(X_PI_BROWSER.agents, {});
    assert.equal(res.defaultAgent, "pi");
    assert.equal(res.agents[0]!.id, "pi");
    assert.equal(res.agents.find((a) => a.id === "fake")?.available, true);
    const ghost = res.agents.find((a) => a.id === "ghost");
    assert.equal(ghost?.available, false);
    assert.match(ghost?.reason ?? "", /definitely-not-a-real-agent-cmd/);
    assert.ok(res.agents.some((a) => a.id === "claude") && res.agents.some((a) => a.id === "codex"), "built-ins listed");
  } finally {
    await h.close();
  }
});

test("an invalid agents.json keeps the built-in agents and reports the parse error", async () => {
  const h = setup();
  try {
    writeFileSync(h.agentsFile, "{ not json");
    const res = await h.request<AgentsResult>(X_PI_BROWSER.agents, {});
    assert.ok(res.agents.some((a) => a.id === "claude"));
    assert.ok(!res.agents.some((a) => a.id === "fake"));
    assert.match(res.configError ?? "", /agents\.json/);
  } finally {
    await h.close();
  }
});

test("a missing command fails session/new with a message naming it", async () => {
  const h = setup();
  try {
    writeAgents(h.agentsFile, h.dir, h.logFile, {}, { ghost: { name: "Ghost", command: "definitely-not-a-real-agent-cmd" } });
    await assert.rejects(newSession(h, "ghost"), (err: { message?: string }) => {
      assert.match(err.message ?? "", /Ghost is not available: not found \(definitely-not-a-real-agent-cmd\)/);
      return true;
    });
  } finally {
    await h.close();
  }
});

test("the agent starts on its first session; one process serves two sessions; pi sessions start none", async () => {
  const h = setup();
  try {
    const pi = await h.request<{ sessionId: string }>(AGENT_METHODS.session_new, { cwd: h.dir, mcpServers: [] });
    assert.ok(pi.sessionId);
    assert.equal(h.ext.isRunning("fake"), false, "a pi session starts no agent");
    const s1 = await newSession(h);
    const s2 = await newSession(h);
    assert.notEqual(s1.sessionId, s2.sessionId);
    assert.equal(initCount(h), 1, "initialized once");
    const pids = new Set(h.log().map((l) => l.pid));
    assert.equal(pids.size, 1, "one process");
    assert.deepEqual((s1._meta as { piBrowser: { agent: unknown } }).piBrowser.agent, { id: "fake", name: "Fake Agent" });
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

test("a streamed reply with a plan and a diff tool call reaches the client unchanged", async () => {
  const h = setup();
  try {
    const s = await newSession(h);
    const res = await promptText(h, s.sessionId, "diff please");
    assert.equal(res.stopReason, "end_turn");
    const mine = h.updates.filter((u) => u.sessionId === s.sessionId).map((u) => u.update as Record<string, unknown>);
    const call = mine.find((u) => u.sessionUpdate === "tool_call");
    assert.deepEqual(call, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit file.txt",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: path.join(h.dir, "file.txt") }],
      content: [{ type: "diff", path: path.join(h.dir, "file.txt"), oldText: "old line\n", newText: "new line\n" }],
    });
    assert.equal(mine.filter((u) => u.sessionUpdate === "plan").length, 2);
    assert.equal(agentText(h, s.sessionId), "Editing the file. Done.");
  } finally {
    await h.close();
  }
});

test("cancel ends a running turn with stopReason cancelled", async () => {
  const h = setup();
  try {
    const s = await newSession(h);
    const turn = promptText(h, s.sessionId, "slow");
    await waitFor(() => agentText(h, s.sessionId).includes("working"), 10_000);
    await h.request(AGENT_METHODS.session_cancel, { sessionId: s.sessionId });
    assert.equal((await turn).stopReason, "cancelled");
  } finally {
    await h.close();
  }
});

test("settings: config options pass through and a change is forwarded", async () => {
  const h = setup();
  try {
    const s = await newSession(h);
    assert.deepEqual(s.configOptions.map((o) => [o.id, o.currentValue]), [["model", "fast"], ["mode", "ask"]]);
    const res = await h.request<{ configOptions: Array<{ id: string; currentValue: unknown }> }>(AGENT_METHODS.session_set_config_option, {
      sessionId: s.sessionId,
      configId: "model",
      value: "smart",
    });
    assert.equal(res.configOptions.find((o) => o.id === "model")?.currentValue, "smart");
    assert.ok(h.log().some((l) => l.method === "session/set_config_option"));
  } finally {
    await h.close();
  }
});

test("settings: models and modes are presented as config options and set with set_model / set_mode", async () => {
  const h = setup({ env: { FAKE_ACP_MODES: "1" } });
  try {
    const s = await newSession(h);
    assert.deepEqual(s.configOptions.map((o) => [o.id, o.currentValue]), [["model", "fast"], ["mode", "ask"]]);
    const res = await h.request<{ configOptions: Array<{ id: string; currentValue: unknown }> }>(AGENT_METHODS.session_set_config_option, {
      sessionId: s.sessionId,
      configId: "mode",
      value: "auto",
    });
    assert.equal(res.configOptions.find((o) => o.id === "mode")?.currentValue, "auto");
    assert.ok(h.log().some((l) => l.method === "session/set_mode"));
  } finally {
    await h.close();
  }
});

test("sessions are listed with their agent and reopen through the agent after a host restart", async () => {
  const dir = path.join(root, `restart-${++seq}`);
  const h1 = setup({}, { dir });
  let sessionId: string;
  try {
    sessionId = (await newSession(h1)).sessionId;
    await promptText(h1, sessionId, "hello there");
    const list = await h1.request<{ sessions: Array<{ sessionId: string; title?: string | null; _meta?: { piBrowser?: { agent?: unknown } } }> }>(AGENT_METHODS.session_list, { cwd: null });
    const entry = list.sessions.find((x) => x.sessionId === sessionId);
    assert.deepEqual(entry?._meta?.piBrowser?.agent, { id: "fake", name: "Fake Agent" });
    assert.equal(entry?.title, "hello there");
  } finally {
    await h1.close();
  }
  // A new host (new manager, same files): load replays the history.
  const h2 = setup({}, { dir });
  try {
    const res = await h2.request<{ configOptions: unknown[] }>(AGENT_METHODS.session_load, { sessionId, cwd: dir, mcpServers: [] }, 30_000);
    assert.ok(Array.isArray(res.configOptions));
    const replay = h2.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate);
    assert.deepEqual(replay, ["user_message_chunk", "agent_message_chunk"]);
    assert.equal((await promptText(h2, sessionId, "again")).stopReason, "end_turn");
    assert.match(agentText(h2, sessionId), /echo: again/);
  } finally {
    await h2.close();
  }
});

test("an agent that can't load sessions: reopening fails with a clear message", async () => {
  const dir = path.join(root, `noload-${++seq}`);
  const h1 = setup({ env: { FAKE_ACP_LOAD: "0" } }, { dir });
  let sessionId: string;
  try {
    sessionId = (await newSession(h1)).sessionId;
  } finally {
    await h1.close();
  }
  const h2 = setup({ env: { FAKE_ACP_LOAD: "0" } }, { dir });
  try {
    await assert.rejects(h2.request(AGENT_METHODS.session_load, { sessionId, cwd: dir, mcpServers: [] }, 30_000), (err: { message?: string }) => {
      assert.match(err.message ?? "", /can't be reopened with Fake Agent/);
      return true;
    });
  } finally {
    await h2.close();
  }
});

test("authentication required: the message tells the user how to log in", async () => {
  const h = setup({ env: { FAKE_ACP_AUTH: "1" } });
  try {
    await assert.rejects(newSession(h), (err: { message?: string }) => {
      assert.equal(err.message, "Fake Agent needs you to log in: run `fake login` in a terminal, then try again");
      return true;
    });
  } finally {
    await h.close();
  }
});

test("a crash mid-turn ends the turn with an error; the next prompt restarts the agent and reloads the session", async () => {
  const h = setup();
  try {
    const s = await newSession(h);
    await promptText(h, s.sessionId, "first");
    await assert.rejects(promptText(h, s.sessionId, "crash"), (err: { message?: string }) => {
      assert.match(err.message ?? "", /Fake Agent stopped \(exit code 3\)/);
      return true;
    });
    await waitFor(() => !h.ext.isRunning("fake"), 5_000);
    const res = await promptText(h, s.sessionId, "after");
    assert.equal(res.stopReason, "end_turn");
    assert.equal(initCount(h), 2, "restarted");
    assert.ok(h.log().some((l) => l.method === "session/load" && l.sessionId === s.sessionId), "session reloaded");
    assert.match(agentText(h, s.sessionId), /echo: after/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Idle stop (D2a)
// ---------------------------------------------------------------------------

test("idle stop after the timeout; a prompt to the dormant session restarts, reloads without re-sending history, and runs", async () => {
  const h = setup({ idleTimeoutMinutes: 15 });
  try {
    const s = await newSession(h);
    await promptText(h, s.sessionId, "remember me");
    h.clock.now += 14 * 60_000;
    assert.deepEqual(h.ext.checkIdle(), [], "not yet idle");
    h.clock.now += 2 * 60_000;
    assert.deepEqual(h.ext.checkIdle(), ["fake"]);
    await waitFor(() => !h.ext.isRunning("fake"), 5_000);
    const before = h.updates.length;
    const res = await promptText(h, s.sessionId, "back");
    assert.equal(res.stopReason, "end_turn");
    const after = h.updates.slice(before).filter((u) => u.sessionId === s.sessionId).map((u) => u.update as Record<string, unknown>);
    assert.ok(!after.some((u) => u.sessionUpdate === "user_message_chunk"), "history not re-sent");
    assert.ok(after.some((u) => u.sessionUpdate === "tool_call" && u.title === "Starting Fake Agent…"), "start progress shown");
    assert.match(agentText(h, s.sessionId), /echo: back/);
    assert.equal(initCount(h), 2);
  } finally {
    await h.close();
  }
});

test("no idle stop during a long turn or a waiting permission request", async () => {
  const h = setup({ idleTimeoutMinutes: 15 });
  try {
    const s = await newSession(h);
    const turn = promptText(h, s.sessionId, "slow");
    await waitFor(() => agentText(h, s.sessionId).includes("working"), 10_000);
    h.clock.now += 60 * 60_000;
    assert.deepEqual(h.ext.checkIdle(), [], "turn running");
    await h.request(AGENT_METHODS.session_cancel, { sessionId: s.sessionId });
    await turn;

    let release!: (v: unknown) => void;
    h.answer = () => new Promise((r) => (release = r));
    const turn2 = promptText(h, s.sessionId, "perm");
    await waitFor(() => h.permissions.length === 1, 10_000);
    h.clock.now += 60 * 60_000;
    assert.deepEqual(h.ext.checkIdle(), [], "permission waiting");
    release({ outcome: { outcome: "selected", optionId: "allow" } });
    await turn2;
  } finally {
    await h.close();
  }
});

test("no idle stop when a session can't be reloaded, or when idleTimeoutMinutes is 0", async () => {
  const h = setup({ env: { FAKE_ACP_LOAD: "0" }, idleTimeoutMinutes: 15 });
  try {
    await newSession(h);
    h.clock.now += 60 * 60_000;
    assert.deepEqual(h.ext.checkIdle(), []);
    assert.equal(h.ext.isRunning("fake"), true);
  } finally {
    await h.close();
  }
  const h2 = setup({ idleTimeoutMinutes: 0 });
  try {
    await newSession(h2);
    h2.clock.now += 24 * 60 * 60_000;
    assert.deepEqual(h2.ext.checkIdle(), []);
  } finally {
    await h2.close();
  }
});

// ---------------------------------------------------------------------------
// Permission relay (D7)
// ---------------------------------------------------------------------------

test("permission relay: the agent's options pass through, labelled with the agent, and the chosen id returns", async () => {
  const h = setup();
  try {
    h.answer = async () => ({ outcome: { outcome: "selected", optionId: "always" } });
    const s = await newSession(h);
    await promptText(h, s.sessionId, "perm");
    const req = h.permissions[0]!;
    assert.equal(req.sessionId, s.sessionId);
    assert.deepEqual((req.options as Array<{ optionId: string; name: string }>).map((o) => [o.optionId, o.name]), [
      ["allow", "Allow"],
      ["always", "Allow always"],
      ["reject", "Reject"],
    ]);
    assert.equal((req.toolCall as { title: string }).title, "Run npm test");
    assert.deepEqual((req._meta as { piBrowser: { agent: unknown } }).piBrowser.agent, { id: "fake", name: "Fake Agent" });
    assert.match(agentText(h, s.sessionId), /permission: always/);
    // Nothing remembered: the next request is passed through again.
    await promptText(h, s.sessionId, "perm");
    assert.equal(h.permissions.length, 2);
  } finally {
    await h.close();
  }
});

test("permission relay: timeout answers cancelled and withdraws the prompt", async () => {
  const h = setup({}, { permissionTimeoutMs: 300 });
  try {
    const s = await newSession(h);
    await promptText(h, s.sessionId, "perm");
    assert.match(agentText(h, s.sessionId), /permission: cancelled/);
    assert.equal(h.withdrawn.length, 1);
    assert.equal((h.withdrawn[0] as { reason: string }).reason, "timeout");
  } finally {
    await h.close();
  }
});

test("permission relay: cancel withdraws the waiting prompt; a disconnect answers cancelled", async () => {
  const h = setup();
  try {
    const s = await newSession(h);
    const turn = promptText(h, s.sessionId, "perm");
    await waitFor(() => h.permissions.length === 1, 10_000);
    await h.request(AGENT_METHODS.session_cancel, { sessionId: s.sessionId });
    await turn;
    assert.deepEqual(h.withdrawn.map((w) => (w as { reason: string }).reason), ["cancelled"]);
    assert.match(agentText(h, s.sessionId), /permission: cancelled/);

    // Owner disconnects while a prompt waits: the agent gets cancelled.
    void promptText(h, s.sessionId, "perm").catch(() => undefined);
    await waitFor(() => h.permissions.length === 2, 10_000);
    h.agent.shutdown();
    await waitFor(() => h.log().filter((l) => l.outcome?.outcome === "cancelled").length === 2, 10_000);
  } finally {
    await h.ext.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Tools for agent sessions (D6)
// ---------------------------------------------------------------------------

test("the agent gets the pi-browser bridge with the host-child marker and a parent-session token per session", async () => {
  const h = setup();
  try {
    const s1 = await newSession(h);
    const s2 = await newSession(h);
    await promptText(h, s1.sessionId, "env");
    await promptText(h, s2.sessionId, "env");
    const env1 = JSON.parse(agentText(h, s1.sessionId).replace(/^env: /, "")) as Record<string, string>;
    const env2 = JSON.parse(agentText(h, s2.sessionId).replace(/^env: /, "")) as Record<string, string>;
    assert.equal(env1.PI_BROWSER_HOST_CHILD, INSTANCE);
    assert.notEqual(env1.PI_BROWSER_PARENT_SESSION, env2.PI_BROWSER_PARENT_SESSION);
    assert.equal(h.ext.resolveParentToken(env1.PI_BROWSER_PARENT_SESSION!), s1.sessionId);
    assert.equal(h.ext.resolveParentToken(env2.PI_BROWSER_PARENT_SESSION!), s2.sessionId);
    // The sessions' routing contexts are registered for the owner client.
    assert.deepEqual(h.registered.get(s1.sessionId), { ownerClientId: "client-1", ownerApplication: "firefox", mode: "legacy" });
  } finally {
    await h.close();
  }
});

test("bridge calls from an agent session run for that session; two sessions stay apart", async () => {
  const h = setup();
  let server: McpBrowserServerHandle | undefined;
  try {
    // The broker's MCP server with the same bridge the AcpAgent registers on.
    const bridgeForServer: BrowserToolBridge = {
      registerSession: () => undefined,
      touchSession: () => undefined,
      closeSession: () => undefined,
      resolveParentSession: (token) => {
        const id = h.ext.resolveParentToken(token);
        return id && h.registered.has(id) ? id : undefined;
      },
      call: async (o) => ({ content: [{ type: "text", text: `ran ${o.tool} for ${o.sessionId ?? "?"}${o.caller ? " as caller" : ""}` }] }),
    };
    server = await startMcpBrowserServer({ log: quiet, bridge: bridgeForServer, instanceId: INSTANCE, brokerPid: -1 });
    const s1 = await newSession(h);
    const s2 = await newSession(h);
    await promptText(h, s1.sessionId, "tool browser_get_page {}");
    await promptText(h, s2.sessionId, "tool browser_get_page {}");
    assert.match(agentText(h, s1.sessionId), new RegExp(`tool result: ran browser_get_page for ${s1.sessionId}$`));
    assert.match(agentText(h, s2.sessionId), new RegExp(`tool result: ran browser_get_page for ${s2.sessionId}$`));
  } finally {
    await h.close();
    await server?.close();
  }
});
