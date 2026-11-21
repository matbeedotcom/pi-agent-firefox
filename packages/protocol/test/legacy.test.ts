/**
 * The v0.4.0 (pi-browser) dialect (openspec rename-trusted-user-agent D2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initializeIsLegacy,
  initializeResultIsLegacy,
  normalizeIncoming,
  toLegacy,
  withLegacyAliases,
} from "../src/legacy.js";
import { codeFromErrorObject, toErrorObject } from "../src/errors.js";
import { buildAgentHelloMeta, parseAgentHello } from "../src/integration.js";

test("incoming old names are normalized: methods, _meta keys at any depth, hello type", () => {
  const { message, legacy } = normalizeIncoming({
    jsonrpc: "2.0",
    id: 1,
    method: "x-pi-browser/permission_set",
    params: {
      tool: "browser_screenshot",
      _meta: { piBrowser: { x: 1 }, piAgent: { type: "pi.agent.hello", client: { application: "firefox" } }, other: true },
      sessions: [{ sessionId: "s", _meta: { piBrowser: { agent: { id: "codex", name: "Codex" } } } }],
    },
  });
  assert.equal(legacy, true);
  assert.equal(message.method, "x-trusted-ua/permission_set");
  const p = message.params as Record<string, any>;
  assert.deepEqual(p._meta, { trustedUa: { x: 1 }, trustedUaAgent: { type: "trusted-ua.hello", client: { application: "firefox" } }, other: true });
  assert.deepEqual(p.sessions[0]._meta, { trustedUa: { agent: { id: "codex", name: "Codex" } } });
});

test("new names pass through untouched (same object), and the new key wins over the old one", () => {
  const msg = { jsonrpc: "2.0", method: "x-trusted-ua/ping", params: { _meta: { trustedUa: { a: 1 } } } };
  const r = normalizeIncoming(msg);
  assert.equal(r.message, msg);
  assert.equal(r.legacy, false);
  const both = normalizeIncoming({ jsonrpc: "2.0", id: 2, result: { _meta: { trustedUa: { v: "new" }, piBrowser: { v: "old" } } } });
  assert.deepEqual((both.message as any).result._meta, { trustedUa: { v: "new" } });
});

test("outgoing messages to an old peer use the old names; the input is not mutated", () => {
  const msg = {
    jsonrpc: "2.0",
    id: 3,
    result: { protocolVersion: 1, _meta: { trustedUa: { protocolVersion: 3 }, trustedUaAgent: { capabilities: ["browser"] } } },
  };
  const before = JSON.stringify(msg);
  const out = toLegacy(msg) as any;
  assert.deepEqual(out.result._meta, { piBrowser: { protocolVersion: 3 }, piAgent: { capabilities: ["browser"] } });
  assert.equal(JSON.stringify(msg), before);
  assert.equal((toLegacy({ jsonrpc: "2.0", id: 4, method: "x-trusted-ua/tool", params: {} }) as any).method, "x-pi-browser/tool");
  assert.equal((toLegacy({ jsonrpc: "2.0", method: "session/update", params: {} }) as any).method, "session/update");
});

test("dialect detection from initialize", () => {
  assert.equal(initializeIsLegacy({ _meta: { piAgent: {} } }), true);
  assert.equal(initializeIsLegacy({ _meta: { piAgent: {}, trustedUaAgent: {} } }), false, "a new add-on sends both");
  assert.equal(initializeIsLegacy({}), false);
  assert.equal(initializeResultIsLegacy({ _meta: { piBrowser: {} } }), true);
  assert.equal(initializeResultIsLegacy({ _meta: { trustedUa: {} } }), false);
});

test("the add-on's hello carries both names; each host reads its own", () => {
  const meta = withLegacyAliases(buildAgentHelloMeta({ client: { application: "thunderbird", extensionId: "x", version: "1" }, capabilities: ["mail"] }));
  assert.equal((meta.piAgent as any).type, "pi.agent.hello");
  assert.equal((meta.trustedUaAgent as any).type, "trusted-ua.hello");
  // New host: normalizes (new key wins) and parses.
  const normalized = normalizeIncoming({ jsonrpc: "2.0", id: 1, method: "initialize", params: { _meta: meta } }).message as any;
  assert.equal(parseAgentHello(normalized.params)?.client.application, "thunderbird");
});

test("error codes travel under both data keys and are read from either", () => {
  const err = toErrorObject("BROWSER_TAB_CLOSED", "gone");
  assert.equal((err.data as any).trustedUaError, "BROWSER_TAB_CLOSED");
  assert.equal((err.data as any).piBrowserError, "BROWSER_TAB_CLOSED");
  assert.equal(codeFromErrorObject({ code: -1, message: "x", data: { piBrowserError: "SESSION_BUSY" } }), "SESSION_BUSY");
});
