/**
 * Cross-app broker integration tests (THUNDERBIRD-PLAN.md §26–30).
 *
 * Spawns the REAL built host (packages/pi-agent/dist/native-host/main.js)
 * TWICE against a shared broker dir:
 *
 *   host A (mock backend): the FIRST process — becomes the broker, owns the
 *     ACP agent + Pi sessions, and listens on the private Unix socket.
 *   host B: the SECOND process — detects the broker and runs as a thin
 *     RELAY (app stdin → socket → broker, broker → socket → app stdout).
 *
 * A fake Firefox add-on speaks ACP to host A over stdio; a fake
 * Thunderbird add-on speaks ACP to host B over stdio (through the relay).
 * A single Pi session — owned by EITHER app — gets the union of both
 * apps' tools, and every tool call is routed to the app that provides it:
 *
 *   Firefox session  → mail_* / compose_*   → Thunderbird (cross-app)
 *   Firefox session  → browser_*            → Firefox (owner)
 *   Thunderbird session → browser_*         → Firefox  (cross-app)
 *   Thunderbird session → mail_*            → Thunderbird (owner)
 *
 * This exercises framing, the broker handshake/token, relay byte pipe,
 * the capability registry, and cross-app tool routing end to end —
 * without a real browser or LLM (the live check is a separate step).
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
  PI_BROWSER_ERROR,
  X_PI_BROWSER,
  toErrorObject,
} from "@pi-browser/protocol";
import { McpServer } from "@pi-browser/firefox/mcp-server";
import { HostClient } from "./host-client.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST_ENTRY = path.join(REPO_ROOT, "packages", "pi-agent", "dist", "native-host", "main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmpRoot;
function freshBrokerDir() {
  if (!tmpRoot) tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-broker-e2e-"));
  return path.join(tmpRoot, `broker-${Math.random().toString(36).slice(2)}`);
}

function writeScript(entries) {
  const file = path.join(
    tmpRoot ?? (tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-broker-e2e-"))),
    `script-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

/** Spawn a real host process (mock backend) with the given broker dir. */
function spawnHost(brokerDirPath, extraEnv = {}) {
  const child = spawn(process.execPath, [HOST_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_BROWSER_BACKEND: "mock",
      PI_BROWSER_LOG_LEVEL: "silent",
      PI_BROWSER_BROKER_DIR: brokerDirPath,
      ...extraEnv,
    },
  });
  return new HostClient(child);
}

/** Wait until the broker state file (pid + token) appears. */
async function waitForBroker(brokerDirPath, timeoutMs = 8000) {
  const stateFile = path.join(brokerDirPath, "agent-broker.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      if (typeof state.pid === "number" && typeof state.token === "string") return state;
    }
    await sleep(50);
  }
  throw new Error("broker did not start (state file missing)");
}

async function shutdown(host) {
  if (!host.alive) return;
  host.child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      host.child.kill("SIGKILL");
      resolve();
    }, 4000);
    host.child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Fake apps
// ---------------------------------------------------------------------------

/** Client-side fake Firefox: serves browser tools (legacy + MCP-over-ACP). */
class FakeBrowser {
  constructor() {
    this.calls = [];
    this.promptedElsewhere = [];
    this.mcpServer = new McpServer({
      handleToolCall: (params) => Promise.resolve(this.dispatch(params)),
    });
  }
  attach(host) {
    host.on(X_PI_BROWSER.tool, (params) => this.dispatch(params));
    host.on("mcp/connect", (params) => this.mcpServer.handleConnect(params));
    host.on("mcp/message", (params) => this.mcpServer.handleMessage(params));
    host.on("mcp/disconnect", (params) => this.mcpServer.handleDisconnect(params));
    host.on("session/request_permission", () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }));
    // Cross-app heads-up: this client's session has a tool waiting for
    // approval in ANOTHER app (display-only; ack it).
    host.on(X_PI_BROWSER.permission_prompted, (params) => {
      this.promptedElsewhere.push(params);
      return { ok: true };
    });
  }
  dispatch(params) {
    this.calls.push(params.tool);
    switch (params.tool) {
      case "browser_get_page":
        return { content: [{ type: "text", text: "PAGE: staging login form" }] };
      case "browser_get_dom":
        return { content: [{ type: "text", text: "DOM: #login-form input[type=password]" }] };
      case "browser_get_selection":
        return { content: [{ type: "text", text: "SELECTION: 'password field'" }] };
      default:
        throw toErrorObject(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown browser tool: ${params.tool}`);
    }
  }
}

/** Client-side fake Thunderbird: serves the full mail toolset. */
class FakeMail {
  constructor() {
    this.calls = [];
    this.permRequests = [];
    this.promptedElsewhere = [];
    // Overridable per test (e.g. to answer allow_session instead of allow_always).
    this.answerPermission = () => ({ outcome: { outcome: "selected", optionId: "allow_always" } });
  }
  attach(host) {
    host.on(X_PI_BROWSER.tool, (params) => this.dispatch(params));
    // Mail tools are approval-gated: the fake user answers via answerPermission.
    host.on("session/request_permission", (params) => {
      this.permRequests.push(params);
      return this.answerPermission(params);
    });
    // Cross-app heads-up (display-only; ack it).
    host.on(X_PI_BROWSER.permission_prompted, (params) => {
      this.promptedElsewhere.push(params);
      return { ok: true };
    });
  }
  dispatch(params) {
    this.calls.push(params.tool);
    switch (params.tool) {
      case "mail_get_selected_messages":
      case "mail_get_context":
        return {
          content: [{ type: "text", text: JSON.stringify({ subject: "Login broken on staging", author: "Alice <alice@x>" }) }],
        };
      case "mail_get_message":
        return { content: [{ type: "text", text: JSON.stringify({ subject: "Login broken on staging", messageId: 1001 }) }] };
      case "mail_get_message_body":
        return { content: [{ type: "text", text: JSON.stringify({ bodyText: "The staging login 500s after typing the password." }) }] };
      case "compose_prepare_reply":
        return { content: [{ type: "text", text: JSON.stringify({ composeWindowId: 7, subject: "Re: Login broken on staging" }) }] };
      case "contacts_search":
        return { content: [{ type: "text", text: JSON.stringify({ count: 1, contacts: [{ id: "c1", name: "Alice" }] }) }] };
      default:
        throw toErrorObject(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown mail tool: ${params.tool}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario setup: broker (host A) + relay (host B) + both fake apps
// ---------------------------------------------------------------------------

async function startScenario(script) {
  const brokerDirPath = freshBrokerDir();
  const browser = new FakeBrowser();
  const mail = new FakeMail();

  const hostA = spawnHost(brokerDirPath, { PI_BROWSER_MOCK_SCRIPT: script });
  const ff = hostA; // fake Firefox talks to the broker over stdio
  browser.attach(ff);

  // host A must become the broker (state file with pid + token).
  const brokerState = await waitForBroker(brokerDirPath);

  // host B starts later and must attach as a relay.
  const hostB = spawnHost(brokerDirPath);
  const tb = hostB; // fake Thunderbird talks through the relay
  mail.attach(tb);

  // Initialize both clients exactly like the real add-ons.
  const ffInit = await ff.request(AGENT_METHODS.initialize, {
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
  assert.equal(ffInit._meta?.piAgent?.application, "firefox");

  // Give the relay a moment to be wired before TB initializes (it must
  // round-trip through host B → socket → broker).
  const tbInit = await tb.request(AGENT_METHODS.initialize, {
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
  }, 20_000);
  assert.equal(tbInit._meta?.piAgent?.application, "thunderbird", "TB hello routed through the relay");
  assert.deepEqual(
    tbInit._meta?.piAgent?.capabilities,
    ["mail", "attachments", "compose", "mailModify", "contacts"],
  );

  return { brokerDirPath, brokerState, hostA, hostB, ff, tb, browser, mail };
}

function toolUpdates(host, sessionId) {
  return host
    .notifications.filter((m) => m.method === "session/update" && m.params?.sessionId === sessionId)
    .map((m) => m.params.update)
    .filter((u) => u?.sessionUpdate === "tool_call_update" || u?.sessionUpdate === "tool_call");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("cross-app: Firefox-owned session calls browser AND mail tools (one session, both apps)", async () => {
  const script = writeScript([
    {
      match: "investigate",
      events: [{ type: "text_delta", delta: "Reading the report…" }],
      toolCalls: [
        { toolName: "mail_get_selected_messages" },
        { toolName: "browser_get_page" },
        { toolName: "compose_prepare_reply" },
      ],
    },
  ]);
  const sc = await startScenario(script);
  try {
    const created = await sc.ff.request(AGENT_METHODS.session_new, { cwd: "/work/staging" });
    assert.ok(created.sessionId);

    const mark = sc.ff.notifications.length;
    await sc.ff.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "investigate" }] },
      60_000,
    );

    // Browser tool executed by the Firefox app; mail/compose by Thunderbird —
    // from the SAME session, through the relay.
    assert.ok(sc.browser.calls.includes("browser_get_page"), "Firefox got the browser call");
    assert.ok(sc.mail.calls.includes("mail_get_selected_messages"), "Thunderbird got the mail call (cross-app)");
    assert.ok(sc.mail.calls.includes("compose_prepare_reply"), "Thunderbird got the compose call (cross-app)");

    // The approval prompts for the cross-app mail tools were routed through
    // the relay to the EXECUTING client (Thunderbird), not Firefox.
    const prompted = sc.mail.permRequests.map((p) => p?._meta?.piBrowser?.tool);
    assert.ok(prompted.includes("mail_get_selected_messages"), "mail prompt reached Thunderbird");
    assert.ok(prompted.includes("compose_prepare_reply"), "compose prompt reached Thunderbird");

    // The Firefox session owner was told the prompts show in Thunderbird, so
    // its sidebar can point the user at the mail client.
    const headsUps = sc.browser.promptedElsewhere.map((p) => p?.tool);
    assert.ok(headsUps.includes("mail_get_selected_messages"), "FF notified: mail prompt is in Thunderbird");
    assert.equal(sc.mail.promptedElsewhere.length, 0, "TB is the executing client: no heads-up to itself");

    // All three tool calls completed (none failed) in the FF session.
    const updates = toolUpdates(sc.ff, created.sessionId);
    const ends = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status);
    assert.equal(ends.length, 3, `three tool results, got: ${JSON.stringify(ends.map((e) => e.status))}`);
    for (const e of ends) assert.equal(e.status, "completed");
    const all = JSON.stringify(updates);
    assert.ok(all.includes("staging login form"), "browser result surfaced in the session");
    assert.ok(all.includes("Login broken on staging"), "mail result surfaced in the session");
    assert.ok(all.includes("composeWindowId"), "compose result surfaced in the session");
  } finally {
    await shutdown(sc.hostB);
    await shutdown(sc.hostA);
  }
});

test("cross-app: 'allow for this session' sticks for the session (via the relay)", async () => {
  const script = writeScript([
    {
      match: "twice",
      events: [{ type: "text_delta", delta: "Twice." }],
      toolCalls: [
        { toolName: "mail_get_selected_messages" },
        { toolName: "mail_get_selected_messages" },
      ],
    },
    {
      match: "again",
      events: [{ type: "text_delta", delta: "Again." }],
      toolCalls: [{ toolName: "mail_get_selected_messages" }],
    },
  ]);
  const sc = await startScenario(script);
  // The Thunderbird user picks "Allow for this session" — not always.
  sc.mail.answerPermission = () => ({ outcome: { outcome: "selected", optionId: "allow_session" } });
  try {
    const created = await sc.ff.request(AGENT_METHODS.session_new, { cwd: "/work/twice" });
    assert.ok(created.sessionId);

    await sc.ff.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "twice" }] },
      60_000,
    );

    // Both calls executed...
    const mailCalls = sc.mail.calls.filter((c) => c === "mail_get_selected_messages");
    assert.equal(mailCalls.length, 2, "both mail calls executed");
    // ...but the session-scoped approval covered the second one: exactly one
    // prompt despite two calls of the SAME tool in the SAME session.
    assert.equal(sc.mail.permRequests.length, 1, "second call was not re-prompted (allow_session)");

    // A further call in a NEW session must ask again (session-scoped).
    const created2 = await sc.ff.request(AGENT_METHODS.session_new, { cwd: "/work/twice2" });
    await sc.ff.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created2.sessionId, prompt: [{ type: "text", text: "again" }] },
      60_000,
    );
    assert.equal(sc.mail.permRequests.length, 2, "new session prompts again");
  } finally {
    await shutdown(sc.hostB);
    await shutdown(sc.hostA);
  }
});

test("cross-app (reverse): Thunderbird-owned session calls mail AND browser tools", async () => {
  const script = writeScript([
    {
      match: "fix it",
      events: [{ type: "text_delta", delta: "Looking at the page…" }],
      toolCalls: [
        { toolName: "mail_get_message_body" },
        { toolName: "browser_get_dom" },
        { toolName: "browser_get_selection" },
      ],
    },
  ]);
  const sc = await startScenario(script);
  try {
    // The Thunderbird client (through the relay) owns the session.
    const created = await sc.tb.request(AGENT_METHODS.session_new, { cwd: "/work/staging" }, 20_000);
    assert.ok(created.sessionId, "TB session created via relay");

    const mark = sc.tb.notifications.length;
    await sc.tb.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "fix it" }] },
      60_000,
    );

    // Mail by the owner (Thunderbird); browser tools cross-app to Firefox.
    assert.ok(sc.mail.calls.includes("mail_get_message_body"), "Thunderbird got the mail call (owner)");
    assert.ok(sc.browser.calls.includes("browser_get_dom"), "Firefox got the DOM call (cross-app)");
    assert.ok(sc.browser.calls.includes("browser_get_selection"), "Firefox got the selection call (cross-app)");

    // Results stream back to Thunderbird through the relay.
    const updates = toolUpdates(sc.tb, created.sessionId);
    const ends = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status);
    assert.equal(ends.length, 3);
    for (const e of ends) assert.equal(e.status, "completed");
    const all = JSON.stringify(updates);
    assert.ok(all.includes("500s after typing the password"), "mail body surfaced in the TB session");
    assert.ok(all.includes("#login-form"), "DOM surfaced in the TB session");
    void mark;
  } finally {
    await shutdown(sc.hostB);
    await shutdown(sc.hostA);
  }
});

test("cross-app (mcp-acp owner): FF session keeps its MCP path for own tools, legacy for cross-app", async () => {
  const script = writeScript([
    {
      match: "mcp mixed",
      events: [{ type: "text_delta", delta: "Mixed transports." }],
      toolCalls: [{ toolName: "browser_get_page" }, { toolName: "mail_get_message" }],
    },
  ]);
  const sc = await startScenario(script);
  try {
    // Real Firefox add-on flow: declare the ACP-transport MCP server BEFORE
    // session/new (no sessionId yet), resolve on the response.
    const decl = sc.browser.mcpServer.declarePending();
    const created = await sc.ff.request(AGENT_METHODS.session_new, {
      cwd: "/work/staging",
      mcpServers: [{ name: "firefox-browser", type: "acp", serverId: decl.serverId }],
    });
    assert.ok(created.sessionId);
    decl.resolve(created.sessionId);

    await sc.ff.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "mcp mixed" }] },
      60_000,
    );

    assert.ok(sc.browser.calls.includes("browser_get_page"), "owner browser tool executed");
    assert.ok(sc.mail.calls.includes("mail_get_message"), "cross-app mail tool executed");
    const updates = toolUpdates(sc.ff, created.sessionId);
    const ends = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status);
    assert.equal(ends.length, 2);
    for (const e of ends) assert.equal(e.status, "completed");
  } finally {
    await shutdown(sc.hostB);
    await shutdown(sc.hostA);
  }
});

test("lifecycle: broker survives relay disconnect; peer re-attaches later", async () => {
  const script = writeScript([
    { match: "solo", toolCalls: [{ toolName: "browser_get_page" }] },
    { match: "back", toolCalls: [{ toolName: "mail_get_selected_messages" }] },
  ]);
  const sc = await startScenario(script);
  try {
    const created = await sc.ff.request(AGENT_METHODS.session_new, { cwd: "/work/solo" });
    assert.ok(created.sessionId);

    // Thunderbird goes away (app quit): relay process exits with its pipe.
    await shutdown(sc.hostB);
    await sleep(300);

    // The broker (host A) must still serve the Firefox session.
    await sc.ff.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "solo" }] },
      60_000,
    );
    assert.ok(sc.browser.calls.includes("browser_get_page"), "FF session works after TB disconnect");

    // A NEW Thunderbird process re-attaches to the same broker and mail
    // tools work again in the same FF session (registry re-populated).
    // (Sessions are owned by the creating client; cross-app means the FF
    // session's mail calls are routed to whichever TB is connected.)
    const hostB2 = spawnHost(sc.brokerDirPath);
    const mail2 = new FakeMail();
    mail2.attach(hostB2);
    await hostB2.request(AGENT_METHODS.initialize, {
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
    }, 20_000);
    await sc.ff.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "back" }] },
      60_000,
    );
    assert.ok(mail2.calls.includes("mail_get_selected_messages"), "re-attached TB serves mail again");

    // The broker exits only when its last client leaves.
    await shutdown(hostB2);
    await shutdown(sc.hostA);
  } finally {
    if (sc.hostB.alive) await shutdown(sc.hostB);
    if (sc.hostA.alive) await shutdown(sc.hostA);
  }
});

test("stdout invariant: relay host stdout carries only framed protocol data", async () => {
  const script = writeScript([{ match: "probe", toolCalls: [{ toolName: "browser_get_page" }] }]);
  const sc = await startScenario(script);
  try {
    // Every byte the fake Thunderbird received from host B parsed as a
    // valid frame + JSON-RPC message (HostClient would have dropped/garbled
    // anything else). Prove traffic actually flowed through the relay.
    const created = await sc.tb.request(AGENT_METHODS.session_new, { cwd: "/work/relay-check" }, 20_000);
    assert.ok(created.sessionId);
    await sc.tb.request(
      AGENT_METHODS.session_prompt,
      { sessionId: created.sessionId, prompt: [{ type: "text", text: "probe" }] },
      60_000,
    );
    assert.ok(sc.browser.calls.includes("browser_get_page"), "browser call reached Firefox via the broker");
    assert.ok(sc.tb.notifications.length > 0, "session updates flowed back through the relay");
  } finally {
    await shutdown(sc.hostB);
    await shutdown(sc.hostA);
  }
});
