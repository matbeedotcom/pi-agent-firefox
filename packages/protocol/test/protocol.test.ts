import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_TOOLS,
  BROWSER_TOOL_NAMES,
  getBrowserTool,
  isBrowserTool,
  isMutatingBrowserTool,
} from "../src/browser-tools.js";
import {
  CONTROL_TOOLS,
  CONTROL_TOOL_NAMES,
  getControlTool,
  isControlTool,
  isMutatingControlTool,
} from "../src/control-tools.js";
import {
  codeFromErrorObject,
  isPiBrowserErrorCode,
  PI_BROWSER_ERROR,
  PI_BROWSER_ERROR_CODES,
  PiBrowserProtocolError,
  toErrorObject,
} from "../src/errors.js";
import {
  MAIL_TOOLS,
  MAIL_TOOL_NAMES,
  getMailTool,
  isMailTool,
} from "../src/mail-tools.js";
import {
  AGENT_CAPABILITIES,
  PI_AGENT,
  PI_AGENT_META,
  PI_BROWSER,
  PI_BROWSER_META,
  X_PI_BROWSER,
  buildAgentHelloMeta,
  normalizeCapabilities,
  parseAgentHello,
  type AgentCapability,
} from "../src/integration.js";
import { isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from "../src/jsonrpc.js";
import {
  buildPermissionRequest,
  PERMISSION_ALLOW_ALWAYS,
  PERMISSION_ALLOW_ONCE,
  PERMISSION_REJECT,
  permissionAllowed,
  REQUEST_PERMISSION_METHOD,
} from "../src/permission.js";

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

test("mail tool registry: 10 read-only tools, unique names, disjoint from browser tools", () => {
  const names = MAIL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^mail_[a-z_]+$/);
  }
  assert.deepEqual(
    [...MAIL_TOOL_NAMES],
    [
      "mail_get_context",
      "mail_get_selected_messages",
      "mail_get_displayed_messages",
      "mail_get_message",
      "mail_get_message_body",
      "mail_search",
      "mail_list_attachments",
      "mail_get_attachment",
      "mail_list_accounts",
      "mail_list_folders",
    ],
  );
  // Every T2 mail tool is read-only; none may mutate state or send.
  for (const t of MAIL_TOOLS) {
    assert.equal(t.readOnly, true, `${t.name} must be read-only in T2`);
  }
  // No send/delete/move/compose tool may leak into the read-only surface.
  for (const name of names) {
    assert.ok(!isBrowserTool(name), `${name} collides with a browser tool`);
    assert.doesNotMatch(name, /send|delete|move|compose/);
  }
  assert.ok(isMailTool("mail_get_context"));
  assert.ok(!isMailTool("mail_nope"));
  assert.equal(getMailTool("mail_get_message")?.readOnly, true);
});

test("mail tool input schemas are JSON Schema objects", () => {
  for (const tool of MAIL_TOOLS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(typeof tool.description === "string" && tool.description.length > 10);
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    const required = (tool.inputSchema.required ?? []) as string[];
    for (const r of required) assert.ok(props[r], `${tool.name}: required ${r} missing from properties`);
  }
  // The tools that operate on a single message all require its id.
  for (const name of ["mail_get_message", "mail_get_message_body", "mail_list_attachments"]) {
    assert.ok((getMailTool(name)!.inputSchema.required as string[]).includes("messageId"), `${name} requires messageId`);
  }
  // mail_get_attachment requires both the message and the part.
  assert.deepEqual(
    [...(getMailTool("mail_get_attachment")!.inputSchema.required as string[])].sort(),
    ["messageId", "partName"],
  );
})

test("control tool registry: names are unique, well-formed, and disjoint from browser tools", () => {
  const names = CONTROL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^pi_[a-z_]+$/);
  }
  assert.deepEqual([...CONTROL_TOOL_NAMES], names);
  // Disjoint from the browser tool surface.
  for (const name of names) {
    assert.ok(!isBrowserTool(name), `${name} collides with a browser tool`);
  }
  assert.ok(isControlTool("pi_new_session"));
  assert.ok(!isControlTool("pi_nope"));
  assert.equal(getControlTool("pi_get_state")?.readOnly, true);
  assert.equal(isMutatingControlTool("pi_prompt"), true);
  assert.equal(isMutatingControlTool("pi_get_state"), false);
});

test("control tool input schemas are JSON Schema objects", () => {
  for (const tool of CONTROL_TOOLS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(typeof tool.description === "string" && tool.description.length > 10);
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    const required = (tool.inputSchema.required ?? []) as string[];
    for (const r of required) assert.ok(props[r], `${tool.name}: required ${r} missing from properties`);
  }
  // Every mutating session tool takes an explicit sessionId (no implicit targets).
  for (const name of ["pi_prompt", "pi_cancel", "pi_close_session", "pi_select_session", "pi_bind_current_tab", "pi_unbind_tab", "pi_open_bound_tab"]) {
    const def = getControlTool(name);
    assert.ok(def, name);
    assert.ok((def!.inputSchema.required as string[]).includes("sessionId"), `${name} requires an explicit sessionId`);
  }
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
  assert.equal((err.data as { piBrowserError?: string })?.piBrowserError, "BROWSER_TAB_CLOSED");
  assert.equal(codeFromErrorObject(err), "BROWSER_TAB_CLOSED");
  assert.equal(codeFromErrorObject({ code: -32601, message: "nope" }), undefined);
  assert.ok(isPiBrowserErrorCode(PI_BROWSER_ERROR.SESSION_NOT_FOUND));
  assert.ok(!isPiBrowserErrorCode("NOPE"));
  const p = new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, "busy");
  assert.equal((p.toErrorObject().data as { piBrowserError?: string })?.piBrowserError, "SESSION_BUSY");
});

test("integration metadata is stable and complete", () => {
  assert.equal(PI_BROWSER.nativeHost, "dev.pi.browser");
  assert.equal(PI_BROWSER.extensionId, "pi-agent-firefox@matbee.com");
  assert.equal(PI_BROWSER_META.protocolVersion, 2);
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

test("permission helpers: request shape + outcome classification", () => {
  assert.equal(REQUEST_PERMISSION_METHOD, "session/request_permission");
  const req = buildPermissionRequest({
    sessionId: "sess-1",
    toolCallId: "tc-1",
    toolName: "browser_screenshot",
  });
  assert.equal(req.sessionId, "sess-1");
  assert.equal(req.toolCall.toolCallId, "tc-1");
  assert.equal(req.toolCall.status, "pending");
  // All three canonical options are offered.
  const kinds = req.options.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ["allow_always", "allow_once", "reject_once"]);
  const ids = req.options.map((o) => o.optionId).sort();
  assert.deepEqual(ids.sort(), [PERMISSION_ALLOW_ALWAYS, PERMISSION_ALLOW_ONCE, PERMISSION_REJECT].sort());
  // The tool name is carried in _meta for the client UI.
  assert.equal((req._meta as { piBrowser?: { tool?: string } }).piBrowser?.tool, "browser_screenshot");

  // Outcome classification.
  assert.equal(permissionAllowed({ outcome: { outcome: "selected", optionId: PERMISSION_ALLOW_ONCE } }), true);
  assert.equal(permissionAllowed({ outcome: { outcome: "selected", optionId: PERMISSION_ALLOW_ALWAYS } }), true);
  assert.equal(permissionAllowed({ outcome: { outcome: "selected", optionId: PERMISSION_REJECT } }), false);
  assert.equal(permissionAllowed({ outcome: { outcome: "cancelled" } }), false);
  assert.equal(permissionAllowed(undefined), false);
});

test("agent identity: host name + authorized extensions", () => {
  assert.equal(PI_AGENT.nativeHost, "com.matbee.agent");
  assert.equal(PI_AGENT.legacyNativeHost, "dev.pi.browser");
  assert.deepEqual(PI_AGENT.authorizedExtensions, [
    "pi-agent-firefox@matbee.com",
    "pi-firefox@matbee.com",
    "pi-agent-thunderbird@matbee.com",
  ]);
  assert.equal(PI_AGENT.protocolVersion, 2);
  assert.equal(PI_AGENT_META.protocolVersion, PI_AGENT.protocolVersion);
  assert.deepEqual(PI_AGENT_META.capabilities, []);
  assert.deepEqual(AGENT_CAPABILITIES, ["browser", "mail", "compose", "attachments", "contacts", "mailModify"]);
});

test("agent hello: parseAgentHello accepts firefox and thunderbird clients", () => {
  const firefoxParams = {
    protocolVersion: 1,
    clientInfo: { name: "pi-browser-firefox", version: "0.1.1" },
    _meta: buildAgentHelloMeta({
      client: { application: "firefox", extensionId: "pi-agent-firefox@matbee.com", version: "0.1.1" },
      capabilities: ["browser"],
    }),
  };
  const fx = parseAgentHello(firefoxParams);
  assert.ok(fx);
  assert.equal(fx.client.application, "firefox");
  assert.equal(fx.client.extensionId, "pi-agent-firefox@matbee.com");
  assert.deepEqual(fx.capabilities, ["browser"]);

  const tbParams = {
    protocolVersion: 1,
    _meta: buildAgentHelloMeta({
      client: { application: "thunderbird", extensionId: "pi-agent-thunderbird@matbee.com", version: "0.1.1" },
      capabilities: ["mail", "compose", "attachments", "bogus", "mail"] as unknown as AgentCapability[],
    }),
  };
  const tb = parseAgentHello(tbParams);
  assert.ok(tb);
  assert.equal(tb.client.application, "thunderbird");
  // Unknown capabilities are dropped, duplicates removed, order preserved.
  assert.deepEqual(tb.capabilities, ["mail", "compose", "attachments"]);
});

test("agent hello: absent or malformed hello parses to undefined (legacy fallback)", () => {
  assert.equal(parseAgentHello({ protocolVersion: 1 }), undefined);
  assert.equal(parseAgentHello(undefined), undefined);
  assert.equal(parseAgentHello({ _meta: {} }), undefined);
  assert.equal(parseAgentHello({ _meta: { piAgent: { client: { application: "opera" } } } }), undefined);
  assert.equal(parseAgentHello({ _meta: { piAgent: { client: "nope" } } }), undefined);
  assert.equal(parseAgentHello({ _meta: { piAgent: { capabilities: ["browser"] } } }), undefined);
});

test("normalizeCapabilities: non-array and unknown values are ignored", () => {
  assert.deepEqual(normalizeCapabilities(undefined), []);
  assert.deepEqual(normalizeCapabilities("browser"), []);
  assert.deepEqual(normalizeCapabilities(["browser", 3, null, "browser", "mail"]), ["browser", "mail"]);
});
