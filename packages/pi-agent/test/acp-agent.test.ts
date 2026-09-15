import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "../src/logger.js";
import { createMemoryTransportPair, type Dispatcher } from "../src/native-host/transport.js";
import { AcpAgent } from "../src/acp/agent.js";
import { CapabilityToolProvider } from "../src/browser/provider.js";
import { MockBackend, MockSession } from "./mock-backend.js";
import {
  AGENT_METHODS,
  BROWSER_TOOLS,
  REPL_TOOLS,
  CLIENT_METHODS,
  JSONRPC_ERROR,
  codeFromErrorObject,
  PROTOCOL_VERSION,
  X_PI_BROWSER,
  buildAgentHelloMeta,
  type JsonRpcErrorObject,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from "@pi-browser/protocol";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });

interface Harness {
  backend: MockBackend;
  agent: AcpAgent;
  provider: CapabilityToolProvider;
  a: Dispatcher; // fake Firefox
  b: Dispatcher; // host
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  updates: SessionNotification[];
  lastCreateTools: unknown[];
}

function setup(workspaceRoot?: string): Harness {
  const backend = new MockBackend();
  const { a, b } = createMemoryTransportPair(quiet, quiet);
  const provider = new CapabilityToolProvider(b.transport, quiet);
  const agent = new AcpAgent({
    backend,
    provider,
    transport: b.transport,
    log: quiet,
    agentInfo: { name: "test-agent", version: "0.0.0" },
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });
  const updates: SessionNotification[] = [];
  a.transport.onNotification = (method, params) => {
    if (method === CLIENT_METHODS.session_update) updates.push(params as SessionNotification);
  };
  const lastCreateTools: unknown[] = [];
  const originalCreate = backend.createSession.bind(backend);
  backend.createSession = async (opts) => {
    lastCreateTools.length = 0;
    lastCreateTools.push(...(opts.customTools ?? []));
    return originalCreate(opts);
  };
  return {
    backend,
    agent,
    provider,
    a,
    b,
    request: (m, p, t) => a.transport.request(m, p, t),
    updates,
    lastCreateTools,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("initialize: capabilities + piBrowser metadata", async () => {
  const h = setup();
  const res = (await h.request(AGENT_METHODS.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "firefox-test", version: "0.1" },
  })) as {
    protocolVersion: number;
    agentCapabilities: Record<string, unknown>;
    _meta: { piBrowser: { protocolVersion: number; browserToolVersion: number } };
    agentInfo: { name: string };
  };
  assert.equal(res.protocolVersion, PROTOCOL_VERSION);
  assert.equal((res.agentCapabilities as { loadSession: boolean }).loadSession, true);
  const caps = res.agentCapabilities as {
    sessionCapabilities: { list: unknown; resume: unknown; close: unknown };
    mcpCapabilities: { acp: boolean };
  };
  assert.ok(caps.sessionCapabilities.list);
  assert.ok(caps.sessionCapabilities.resume);
  assert.ok(caps.sessionCapabilities.close);
  assert.equal(caps.mcpCapabilities.acp, true);
  assert.equal(res._meta.piBrowser.protocolVersion, 2);
  assert.equal(res._meta.piBrowser.browserToolVersion, 6);
  assert.equal(res.agentInfo.name, "test-agent");
});

test("initialize: unsupported protocol version -> PROTOCOL_VERSION_MISMATCH", async () => {
  const h = setup();
  const err = (await h.request(AGENT_METHODS.initialize, { protocolVersion: 99 }).catch((e) => e)) as JsonRpcErrorObject;
  assert.equal(codeFromErrorObject(err), "PROTOCOL_VERSION_MISMATCH");
});

test("initialize: pi.agent.hello (thunderbird, mail + compose) -> no browser tools registered", async () => {
  const h = setup();
  const res = (await h.request(AGENT_METHODS.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "pi-thunderbird", version: "0.1.1" },
    _meta: buildAgentHelloMeta({
      client: { application: "thunderbird", extensionId: "pi-agent-thunderbird@matbee.com", version: "0.1.1" },
      capabilities: ["mail", "compose", "attachments"],
    }),
  })) as { _meta: { piAgent: { application: string; capabilities: string[] } } };
  assert.equal(res._meta.piAgent.application, "thunderbird");
  assert.deepEqual(res._meta.piAgent.capabilities, ["mail", "compose", "attachments"]);
  // A mail+compose client receives the read-only mail tools AND the draft-first
  // compose tools (11 + 6, incl. compose_add_attachment + mail_list_tags), and no browser tools.
  const s = (await h.request(AGENT_METHODS.session_new, { cwd: "/proj/m", mcpServers: [] })) as { sessionId: string };
  assert.equal(h.lastCreateTools.length, 17);
  assert.ok(
    h.lastCreateTools.every((t) => /^(mail_|compose_)/.test((t as { name: string }).name)),
    "mail+compose client gets only mail/compose tools",
  );
  assert.ok(
    h.lastCreateTools.some((t) => (t as { name: string }).name === "compose_prepare_reply"),
    "compose capability registers the compose tools",
  );
  assert.ok(h.lastCreateTools.every((t) => !(t as { name: string }).name.startsWith("browser_")), "mail client gets no browser tools");
  assert.ok(h.lastCreateTools.every((t) => (t as { name: string }).name !== "compose_send"), "no send tool is exposed");
  await h.request(AGENT_METHODS.session_close, { sessionId: s.sessionId });
});

test("initialize: thunderbird mailModify + contacts capabilities register mutation + contact tools", async () => {
  const h = setup();
  await h.request(AGENT_METHODS.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    _meta: buildAgentHelloMeta({
      client: { application: "thunderbird", extensionId: "pi-agent-thunderbird@matbee.com", version: "0.1.1" },
      capabilities: ["mail", "compose", "attachments", "mailModify", "contacts"],
    }),
  });
  const s = (await h.request(AGENT_METHODS.session_new, { cwd: "/proj/mc", mcpServers: [] })) as { sessionId: string };
  const names = h.lastCreateTools.map((t) => (t as { name: string }).name);
  // 11 mail + 6 compose + 4 mutation + 3 contacts = 24
  assert.equal(names.length, 24);
  assert.ok(names.includes("mail_archive"), "mutation tool registered");
  assert.ok(names.includes("mail_set_tags"), "tag tool registered");
  assert.ok(names.includes("contacts_search"), "contacts search tool registered");
  assert.ok(names.includes("contacts_list"), "contacts list tool registered");
  assert.ok(!names.some((n) => n === "mail_delete" || n.endsWith("delete")), "no delete tool is exposed");
  await h.request(AGENT_METHODS.session_close, { sessionId: s.sessionId });
});

test("initialize: legacy client (no hello) keeps browser tools; firefox hello declares browser", async () => {
  const hLegacy = setup();
  await hLegacy.request(AGENT_METHODS.initialize, { protocolVersion: PROTOCOL_VERSION });
  const sLegacy = (await hLegacy.request(AGENT_METHODS.session_new, { cwd: "/proj/l", mcpServers: [] })) as { sessionId: string };
  assert.ok(hLegacy.lastCreateTools.length > 0, "legacy client still gets browser tools");
  await hLegacy.request(AGENT_METHODS.session_close, { sessionId: sLegacy.sessionId });

  const hFx = setup();
  const res = (await hFx.request(AGENT_METHODS.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    _meta: buildAgentHelloMeta({
      client: { application: "firefox", extensionId: "pi-agent-firefox@matbee.com", version: "0.1.1" },
      capabilities: ["browser"],
    }),
  })) as { _meta: { piAgent: { application: string; capabilities: string[] } } };
  assert.equal(res._meta.piAgent.application, "firefox");
  assert.deepEqual(res._meta.piAgent.capabilities, ["browser"]);
  const sFx = (await hFx.request(AGENT_METHODS.session_new, { cwd: "/proj/f", mcpServers: [] })) as { sessionId: string };
  assert.ok(hFx.lastCreateTools.length > 0, "firefox hello gets browser tools");
  await hFx.request(AGENT_METHODS.session_close, { sessionId: sFx.sessionId });
});

test("session/new: three independent sessions over one connection", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/proj/a", mcpServers: [] })) as {
    sessionId: string;
    configOptions: SessionConfigOption[];
  };
  const s2 = (await h.request(AGENT_METHODS.session_new, { cwd: "/proj/b", mcpServers: [] })) as { sessionId: string };
  const s3 = (await h.request(AGENT_METHODS.session_new, { cwd: "/proj/c", mcpServers: [] })) as { sessionId: string };
  assert.ok(s1.sessionId && s2.sessionId && s3.sessionId);
  assert.notEqual(s1.sessionId, s2.sessionId);
  assert.notEqual(s2.sessionId, s3.sessionId);
  // Backend got one session per ACP session with isolated cwd.
  const sessions = [...h.backend.sessions.values()];
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions.map((s) => s.cwd)).size, 3);
  // Config options: model + thinking selectors.
  const ids = s1.configOptions.map((o) => o.id).sort();
  assert.deepEqual(ids, ["model", "thinking"]);
  const modelOpt = s1.configOptions.find((o) => o.id === "model") as Extract<SessionConfigOption, { type: "select" }>;
  assert.equal(modelOpt.type, "select");
  assert.equal(modelOpt.currentValue, "mock/model-a");
  assert.ok(modelOpt.options.some((o) => "value" in o && o.value === "mock/model-b"));
  // Browser tools (one per protocol tool) + the host-side javascript REPL tool.
  assert.equal(h.lastCreateTools.length, BROWSER_TOOLS.length + REPL_TOOLS.length);
  assert.ok(
    h.lastCreateTools.every(
      (t) => (t as { name: string }).name.startsWith("browser_") || (t as { name: string }).name === "javascript",
    ),
  );
});

test("session/prompt: streaming updates route to the right session", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/a", mcpServers: [] })) as { sessionId: string };
  const s2 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/b", mcpServers: [] })) as { sessionId: string };
  const sess1 = h.backend.sessions.get(s1.sessionId) as MockSession;
  const sess2 = h.backend.sessions.get(s2.sessionId) as MockSession;
  sess1.nextTurn = {
    events: [
      { type: "text_delta", delta: "A1 " },
      { type: "text_delta", delta: "A2" },
    ],
    delayMs: 5,
  };
  sess2.nextTurn = { events: [{ type: "thinking_delta", delta: "B-think" }], delayMs: 5 };

  const p1 = h.request(AGENT_METHODS.session_prompt, {
    sessionId: s1.sessionId,
    prompt: [{ type: "text", text: "hello A" }],
  });
  const p2 = h.request(AGENT_METHODS.session_prompt, {
    sessionId: s2.sessionId,
    prompt: [{ type: "text", text: "hello B" }],
  });
  const [r1, r2] = (await Promise.all([p1, p2])) as Array<{ stopReason: string }>;
  assert.equal(r1.stopReason, "end_turn");
  assert.equal(r2.stopReason, "end_turn");

  const forA = h.updates.filter((u) => u.sessionId === s1.sessionId);
  const forB = h.updates.filter((u) => u.sessionId === s2.sessionId);
  assert.equal(forA.length, 2);
  assert.equal(
    forA.map((u) => (u.update as { content?: { text?: string } }).content?.text).join(""),
    "A1 A2",
  );
  assert.equal(forB.length, 1);
  assert.equal((forB[0].update as { sessionUpdate: string }).sessionUpdate, "agent_thought_chunk");
  // No cross-talk.
  assert.ok(!h.updates.some((u) => u.sessionId === s1.sessionId && (u.update as { sessionUpdate: string }).sessionUpdate === "agent_thought_chunk"));
});

test("session/prompt: prompt content with images is forwarded", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/a", mcpServers: [] })) as { sessionId: string };
  const sess = h.backend.sessions.get(s1.sessionId) as MockSession;
  await h.request(AGENT_METHODS.session_prompt, {
    sessionId: s1.sessionId,
    prompt: [
      { type: "text", text: "look at this" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  });
  assert.deepEqual(sess.prompts[0], {
    text: "look at this",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  });
});

test("session/cancel: stopReason becomes cancelled", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/a", mcpServers: [] })) as { sessionId: string };
  const sess = h.backend.sessions.get(s1.sessionId) as MockSession;
  sess.nextTurn = { events: [{ type: "text_delta", delta: "partial" }], delayMs: 50 };
  const p = h.request(AGENT_METHODS.session_prompt, {
    sessionId: s1.sessionId,
    prompt: [{ type: "text", text: "long work" }],
  }) as Promise<{ stopReason: string }>;
  await wait(10); // let the turn start
  assert.ok(sess.isStreaming);
  await h.request(AGENT_METHODS.session_cancel, { sessionId: s1.sessionId });
  const res = await p;
  assert.equal(res.stopReason, "cancelled");
  assert.deepEqual(sess.abortedPromptIndexes, [0]);
});

test("session/prompt while streaming -> SESSION_BUSY", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/a", mcpServers: [] })) as { sessionId: string };
  const sess = h.backend.sessions.get(s1.sessionId) as MockSession;
  sess.nextTurn = { events: [], delayMs: 40 };
  const p1 = h.request(AGENT_METHODS.session_prompt, {
    sessionId: s1.sessionId,
    prompt: [{ type: "text", text: "first" }],
  }) as Promise<unknown>;
  await wait(5);
  const err = (await h.request(AGENT_METHODS.session_prompt, {
    sessionId: s1.sessionId,
    prompt: [{ type: "text", text: "second" }],
  }).catch((e) => e)) as JsonRpcErrorObject;
  assert.equal(codeFromErrorObject(err), "SESSION_BUSY");
  await p1;
});

test("session/list: reflects created sessions with cwd", async () => {
  const h = setup();
  await h.request(AGENT_METHODS.session_new, { cwd: "/proj/a", mcpServers: [] });
  await h.request(AGENT_METHODS.session_new, { cwd: "/proj/b", mcpServers: [] });
  const all = (await h.request(AGENT_METHODS.session_list, { cwd: null })) as {
    sessions: Array<{ sessionId: string; cwd: string }>;
  };
  assert.equal(all.sessions.length, 2);
  assert.ok(all.sessions.some((s) => s.cwd === "/proj/a"));
  const filtered = (await h.request(AGENT_METHODS.session_list, { cwd: "/proj/b" })) as {
    sessions: Array<{ cwd: string }>;
  };
  assert.equal(filtered.sessions.length, 1);
  assert.equal(filtered.sessions[0].cwd, "/proj/b");
});

test("session/resume: reconnects without replay; unknown id -> SESSION_NOT_FOUND", async () => {
  const h = setup();
  h.backend.precreate("existing-1", "/proj/x");
  h.updates.length = 0;
  const res = (await h.request(AGENT_METHODS.session_resume, {
    sessionId: "existing-1",
    cwd: "/proj/x",
    mcpServers: [],
  })) as { configOptions: SessionConfigOption[] };
  assert.ok(res.configOptions.length >= 2);
  assert.equal(h.updates.length, 0, "resume must not replay history");

  const err = (await h.request(AGENT_METHODS.session_resume, {
    sessionId: "nope",
    cwd: "/proj/x",
    mcpServers: [],
  }).catch((e) => e)) as JsonRpcErrorObject;
  assert.equal(codeFromErrorObject(err), "SESSION_NOT_FOUND");
});

test("session/load: replays history as session/update notifications", async () => {
  const h = setup();
  h.backend.precreate("existing-2", "/proj/y", [
    { role: "user", text: "fix the button" },
    { role: "assistant", text: "I will inspect it." },
  ]);
  h.updates.length = 0;
  await h.request(AGENT_METHODS.session_load, {
    sessionId: "existing-2",
    cwd: "/proj/y",
    mcpServers: [],
  });
  const kinds = h.updates.map((u) => (u.update as { sessionUpdate: string }).sessionUpdate);
  assert.deepEqual(kinds, ["user_message_chunk", "agent_message_chunk"]);
  assert.equal(
    (h.updates[0].update as { content: { text: string } }).content.text,
    "fix the button",
  );
});

test("session/close: subsequent prompts fail with SESSION_NOT_FOUND", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/a", mcpServers: [] })) as { sessionId: string };
  await h.request(AGENT_METHODS.session_close, { sessionId: s1.sessionId });
  const err = (await h.request(AGENT_METHODS.session_prompt, {
    sessionId: s1.sessionId,
    prompt: [{ type: "text", text: "after close" }],
  }).catch((e) => e)) as JsonRpcErrorObject;
  assert.equal(codeFromErrorObject(err), "SESSION_NOT_FOUND");
});

test("session/set_config_option: model and thinking changes round-trip", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/a", mcpServers: [] })) as { sessionId: string };
  const sess = h.backend.sessions.get(s1.sessionId) as MockSession;

  const r1 = (await h.request(AGENT_METHODS.session_set_config_option, {
    sessionId: s1.sessionId,
    configId: "model",
    value: "mock/model-b",
  })) as { configOptions: SessionConfigOption[] };
  assert.deepEqual(sess.modelChanges, ["mock/model-b"]);
  const modelOpt = r1.configOptions.find((o) => o.id === "model") as Extract<SessionConfigOption, { type: "select" }>;
  assert.equal(modelOpt.currentValue, "mock/model-b");

  const r2 = (await h.request(AGENT_METHODS.session_set_config_option, {
    sessionId: s1.sessionId,
    configId: "thinking",
    value: "high",
  })) as { configOptions: SessionConfigOption[] };
  assert.deepEqual(sess.thinkingChanges, ["high"]);
  const thinkingOpt = r2.configOptions.find((o) => o.id === "thinking") as Extract<SessionConfigOption, { type: "select" }>;
  assert.equal(thinkingOpt.currentValue, "high");

  const err = (await h.request(AGENT_METHODS.session_set_config_option, {
    sessionId: s1.sessionId,
    configId: "bogus",
    value: "x",
  }).catch((e) => e)) as JsonRpcErrorObject;
  assert.equal(codeFromErrorObject(err), "ACP_CAPABILITY_UNSUPPORTED");
});

test("tool events map to tool_call / tool_call_update updates", async () => {
  const h = setup();
  const s1 = (await h.request(AGENT_METHODS.session_new, { cwd: "/p/a", mcpServers: [] })) as { sessionId: string };
  const sess = h.backend.sessions.get(s1.sessionId) as MockSession;
  sess.nextTurn = {
    events: [
      { type: "tool_start", toolCallId: "tc1", toolName: "browser_get_page", args: {} },
      { type: "tool_end", toolCallId: "tc1", toolName: "browser_get_page", result: { content: [{ type: "text", text: "page data" }] }, isError: false },
    ],
    delayMs: 5,
  };
  await h.request(AGENT_METHODS.session_prompt, {
    sessionId: s1.sessionId,
    prompt: [{ type: "text", text: "check page" }],
  });
  const toolUpdates = h.updates
    .filter((u) => u.sessionId === s1.sessionId)
    .map((u) => u.update as SessionUpdate);
  const start = toolUpdates.find((u) => u.sessionUpdate === "tool_call") as Extract<SessionUpdate, { sessionUpdate: "tool_call" }> | undefined;
  const end = toolUpdates.find((u) => u.sessionUpdate === "tool_call_update") as
    | Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>
    | undefined;
  assert.ok(start && end);
  assert.equal(start.toolCallId, "tc1");
  assert.equal(start.title, "browser_get_page");
  assert.equal(start.kind, "fetch");
  assert.equal(end.status, "completed");
  assert.equal((end.content as Array<{ content: { text?: string } }>)[0].content.text, "page data");
});

test("unknown ACP method -> METHOD_NOT_FOUND", async () => {
  const h = setup();
  const err = (await h.request("session/frobnicate", {}).catch((e) => e)) as JsonRpcErrorObject;
  assert.equal(err.code, JSONRPC_ERROR.METHOD_NOT_FOUND);
});

test("x-pi-browser/ping responds with integration metadata", async () => {
  const h = setup();
  const res = (await h.request(X_PI_BROWSER.ping, {})) as { pong: boolean; meta: { protocolVersion: number } };
  assert.equal(res.pong, true);
  assert.equal(res.meta.protocolVersion, 2);
});

test("session/new: neutral cwd (\"/\") provisions a per-task workspace", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "pi-ws-"));
  const h = setup(workspaceRoot);
  const res = (await h.request(AGENT_METHODS.session_new, { cwd: "/", mcpServers: [] })) as {
    sessionId: string;
    _meta?: { piBrowser?: { workspace?: string } };
  };
  const workspace = res._meta?.piBrowser?.workspace;
  assert.ok(workspace, "_meta.piBrowser.workspace is reported");
  // The workspace lives under the configured root.
  assert.ok(workspace.startsWith(workspaceRoot + path.sep), `workspace ${workspace} under ${workspaceRoot}`);
  // The backend session's cwd is the provisioned workspace.
  const sess = h.backend.sessions.get(res.sessionId) as MockSession;
  assert.equal(sess.cwd, workspace);
  // A second neutral session gets its own, distinct workspace.
  const res2 = (await h.request(AGENT_METHODS.session_new, { cwd: "/", mcpServers: [] })) as {
    _meta?: { piBrowser?: { workspace?: string } };
  };
  assert.notEqual(res2._meta?.piBrowser?.workspace, workspace);
});

test("session/new: meaningful cwd is used as-is (no workspace provisioned)", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "pi-ws-"));
  const h = setup(workspaceRoot);
  const res = (await h.request(AGENT_METHODS.session_new, { cwd: "/proj/real", mcpServers: [] })) as {
    sessionId: string;
    _meta?: { piBrowser?: { workspace?: string } };
  };
  // The requested cwd is honored and reported back unchanged.
  assert.equal(res._meta?.piBrowser?.workspace, "/proj/real");
  const sess = h.backend.sessions.get(res.sessionId) as MockSession;
  assert.equal(sess.cwd, "/proj/real");
});
