import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../src/logger.js";
import { createMemoryTransportPair, type Dispatcher } from "../src/native-host/transport.js";
import { CapabilityRegistry } from "../src/capability-registry.js";
import { CapabilityToolProvider } from "../src/browser/provider.js";
import { PermissionStore } from "../src/permission-store.js";
import {
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  X_PI_BROWSER,
  toErrorObject,
  type AgentCapability,
  type JsonRpcErrorObject,
  type PermissionPromptedParams,
} from "@pi-browser/protocol";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });

function client(
  clientId: string,
  application: "firefox" | "thunderbird",
  capabilities: AgentCapability[],
  transport: Dispatcher["transport"],
) {
  return { clientId, application, capabilities, transport };
}

test("registry: register/list/remove", () => {
  const reg = new CapabilityRegistry(quiet);
  assert.equal(reg.size, 0);
  const ff = new (class { request() { throw new Error("n/a"); } notify() {} })();
  const tb = new (class { request() { throw new Error("n/a"); } notify() {} })();
  reg.register(client("stdio", "firefox", ["browser"], ff as never));
  reg.register(client("relay-1", "thunderbird", ["mail", "compose"], tb as never));
  assert.equal(reg.size, 2);
  assert.deepEqual(reg.list().map((c) => c.clientId), ["stdio", "relay-1"]);
  assert.ok(reg.get("relay-1"));
  const removed = reg.remove("relay-1");
  assert.ok(removed);
  assert.equal(reg.size, 1);
  assert.equal(reg.remove("nope"), undefined);
});

test("registry: onChange fires with the new union on register/remove, not on no-ops", () => {
  const reg = new CapabilityRegistry(quiet);
  const ff = new (class { request() { throw new Error("n/a"); } notify() {} })();
  const tb = new (class { request() { throw new Error("n/a"); } notify() {} })();
  const changes: AgentCapability[][] = [];
  reg.onChange = (caps) => changes.push(caps);
  reg.register(client("a", "thunderbird", ["mail", "compose"], tb as never));
  reg.register(client("b", "firefox", ["browser"], ff as never));
  reg.remove("b");
  reg.remove("ghost"); // unknown id: the client set is unchanged → no event
  assert.deepEqual(changes, [
    ["mail", "compose"],
    ["browser", "mail", "compose"],
    ["mail", "compose"],
  ]);
});

test("registry: a throwing onChange never breaks register/remove", () => {
  const reg = new CapabilityRegistry(quiet);
  const ff = new (class { request() { throw new Error("n/a"); } notify() {} })();
  reg.onChange = () => {
    throw new Error("boom");
  };
  reg.register(client("a", "firefox", ["browser"], ff as never));
  assert.doesNotThrow(() => reg.remove("a"));
  assert.equal(reg.size, 0);
});

test("registry: allCapabilities is the union in canonical order", () => {
  const reg = new CapabilityRegistry(quiet);
  const ff = new (class { request() { throw new Error("n/a"); } notify() {} })();
  const tb = new (class { request() { throw new Error("n/a"); } notify() {} })();
  reg.register(client("a", "thunderbird", ["contacts", "mail", "compose"], tb as never));
  reg.register(client("b", "firefox", ["browser"], ff as never));
  assert.deepEqual(reg.allCapabilities(), ["browser", "mail", "compose", "contacts"]);
});

test("registry: resolveTarget prefers the owner, falls back to a peer", () => {
  const reg = new CapabilityRegistry(quiet);
  const ff = new (class { request() { throw new Error("n/a"); } notify() {} })();
  const tb = new (class { request() { throw new Error("n/a"); } notify() {} })();
  reg.register(client("tb", "thunderbird", ["mail", "compose", "contacts"], tb as never));
  reg.register(client("ff", "firefox", ["browser"], ff as never));

  // Owner provides → owner.
  assert.equal(reg.resolveTarget("ff", "browser_get_page").clientId, "ff");
  assert.equal(reg.resolveTarget("tb", "mail_get_message").clientId, "tb");
  // Owner doesn't provide → cross-app peer.
  assert.equal(reg.resolveTarget("ff", "mail_get_message").clientId, "tb");
  assert.equal(reg.resolveTarget("tb", "browser_get_page").clientId, "ff");
  // Attachments satisfied by "mail" capability.
  assert.equal(reg.resolveTarget("ff", "mail_get_attachment").clientId, "tb");
  // Unknown owner: first provider wins.
  assert.equal(reg.resolveTarget(undefined, "compose_prepare_reply").clientId, "tb");
  // No provider (neither client has "mailModify") → structured error.
  assert.throws(
    () => reg.resolveTarget("ff", "mail_mark_read"),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE,
  );
});

// ---------------------------------------------------------------------------
// Cross-app routing through the provider (plan §29)
// ---------------------------------------------------------------------------

interface TwoClients {
  reg: CapabilityRegistry;
  provider: CapabilityToolProvider;
  ff: Dispatcher;
  tb: Dispatcher;
  ffToolCalls: Array<{ tool: string; args: unknown }>;
  tbToolCalls: Array<{ tool: string; args: unknown }>;
  ffPermissionRequests: { n: number };
  tbPermissionRequests: { n: number };
  ffPromptedElsewhere: PermissionPromptedParams[];
  tbPromptedElsewhere: PermissionPromptedParams[];
}

function setupTwoClients(): TwoClients {
  const ffPair = createMemoryTransportPair(quiet, quiet); // a = app, b = host side
  const tbPair = createMemoryTransportPair(quiet, quiet);
  const reg = new CapabilityRegistry(quiet);
  const ffToolCalls: TwoClients["ffToolCalls"] = [];
  const tbToolCalls: TwoClients["tbToolCalls"] = [];
  const ffPermissionRequests = { n: 0 };
  const tbPermissionRequests = { n: 0 };
  const ffPromptedElsewhere: PermissionPromptedParams[] = [];
  const tbPromptedElsewhere: PermissionPromptedParams[] = [];
  const answerPermission = (counter: { n: number }, respond: (id: number, r: unknown) => void, id: number) => {
    counter.n++;
    // The fake users approve every prompt ("Always allow").
    respond(id, { outcome: { outcome: "selected", optionId: "allow_always" } });
  };
  const recordPromptedElsewhere =
    (rec: PermissionPromptedParams[], respond: (id: number, r: unknown) => void) =>
    (params: unknown, id: number) => {
      rec.push(params as PermissionPromptedParams);
      respond(id, { ok: true });
    };
  ffPair.a.transport.onRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.tool) {
      const p = params as { tool: string; arguments: unknown };
      ffToolCalls.push({ tool: p.tool, args: p.arguments });
      ffPair.a.transport.respond(id, { content: [{ type: "text", text: "from-firefox" }] });
    } else if (method === "session/request_permission") {
      answerPermission(ffPermissionRequests, (i, r) => ffPair.a.transport.respond(i, r), id);
    } else if (method === X_PI_BROWSER.permission_prompted) {
      recordPromptedElsewhere(ffPromptedElsewhere, (i, r) => ffPair.a.transport.respond(i, r))(params, id);
    }
  };
  tbPair.a.transport.onRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.tool) {
      const p = params as { tool: string; arguments: unknown };
      tbToolCalls.push({ tool: p.tool, args: p.arguments });
      tbPair.a.transport.respond(id, { content: [{ type: "text", text: "from-thunderbird" }] });
    } else if (method === "session/request_permission") {
      answerPermission(tbPermissionRequests, (i, r) => tbPair.a.transport.respond(i, r), id);
    } else if (method === X_PI_BROWSER.permission_prompted) {
      recordPromptedElsewhere(tbPromptedElsewhere, (i, r) => tbPair.a.transport.respond(i, r))(params, id);
    }
  };
  reg.register(client("ff", "firefox", ["browser"], ffPair.b.transport));
  reg.register(client("tb", "thunderbird", ["mail", "compose", "contacts", "mailModify"], tbPair.b.transport));
  // Isolated temp store: the fake users answer "allow_always", which is now
  // persistent — sharing the real file would leak grants between tests.
  const store = new PermissionStore({ filePath: join(mkdtempSync(join(tmpdir(), "pi-permreg-")), "permissions.json") });
  const provider = new CapabilityToolProvider(undefined, quiet, reg, { permissionStore: store });
  return {
    reg,
    provider,
    ff: ffPair.a,
    tb: tbPair.a,
    ffToolCalls,
    tbToolCalls,
    ffPermissionRequests,
    tbPermissionRequests,
    ffPromptedElsewhere,
    tbPromptedElsewhere,
  };
}

test("provider (broker mode): tool surface is the union of connected clients", () => {
  const { provider } = setupTwoClients();
  const tools = provider.createTools({ id: "s1" }, "legacy", undefined, ["browser"], "ff");
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("browser_get_page"), "browser tool visible");
  assert.ok(names.includes("mail_get_message"), "mail tool visible cross-app");
  assert.ok(names.includes("compose_prepare_reply"), "compose tool visible cross-app");
  // Control tools only in mcp-acp mode.
  assert.ok(!names.includes("pi_get_state"));
});

test("provider (broker mode): owner tools route to owner, cross-app tools route to peer", async () => {
  const { provider, ffToolCalls, tbToolCalls, tbPermissionRequests, ffPermissionRequests } = setupTwoClients();
  // Session owned by Firefox.
  const tools = provider.createTools({ id: "s1" }, "legacy", undefined, ["browser"], "ff");
  const byName = new Map(tools.map((t) => [t.name, t]));

  const browserResult = await byName.get("browser_get_page")!.execute("tc1", {}, undefined as never);
  const mailResult = await byName.get("mail_get_message")!.execute("tc2", {}, undefined as never);
  const composeResult = await byName.get("compose_prepare_reply")!.execute("tc3", {}, undefined as never);

  assert.deepEqual(ffToolCalls, [{ tool: "browser_get_page", args: {} }]);
  assert.deepEqual(tbToolCalls, [
    { tool: "mail_get_message", args: {} },
    { tool: "compose_prepare_reply", args: {} },
  ]);
  assert.match((browserResult.content[0] as { text: string }).text, /from-firefox/);
  assert.match((mailResult.content[0] as { text: string }).text, /from-thunderbird/);
  assert.match((composeResult.content[0] as { text: string }).text, /from-thunderbird/);
  // Approval prompts for the cross-app mail tools went to the EXECUTING
  // client (Thunderbird), not the Firefox session owner. (The owner's own
  // browser_get_page prompted on Firefox too — every tool is gated.)
  assert.equal(tbPermissionRequests.n, 2, "mail + compose prompts sent to Thunderbird");
  assert.equal(ffPermissionRequests.n, 1, "owner's browser tool prompted on Firefox");
});

test("provider (broker mode): Thunderbird-owned session routes browser tools to Firefox", async () => {
  const { provider, ffToolCalls, tbToolCalls } = setupTwoClients();
  // Session owned by Thunderbird.
  const tools = provider.createTools({ id: "s2" }, "legacy", undefined, ["mail", "compose"], "tb");
  const byName = new Map(tools.map((t) => [t.name, t]));

  await byName.get("mail_get_selected_messages")!.execute("tc1", {}, undefined as never);
  await byName.get("browser_get_page")!.execute("tc2", {}, undefined as never);
  await byName.get("browser_click")!.execute("tc3", {}, undefined as never);

  assert.deepEqual(tbToolCalls, [{ tool: "mail_get_selected_messages", args: {} }]);
  assert.deepEqual(ffToolCalls, [
    { tool: "browser_get_page", args: {} },
    { tool: "browser_click", args: {} },
  ]);
});

test("provider (broker mode): error when no connected client provides the tool", async () => {
  const { provider, reg } = setupTwoClients();
  // Tool surface is created while both clients are connected...
  const tools = provider.createTools({ id: "s3" }, "legacy", undefined, ["browser"], "ff");
  const mail = tools.find((t) => t.name === "mail_get_message");
  assert.ok(mail, "tool was registered while TB was connected");
  // ...then Thunderbird disconnects: the call must fail with a structured error.
  reg.remove("tb");
  await assert.rejects(mail!.execute("tc1", {}, undefined as never), (err: unknown) => {
    return (
      err instanceof PiBrowserProtocolError &&
      err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE &&
      /no connected client provides/.test(err.message)
    );
  });
});

test("provider (broker mode): session owner is told when the prompt shows in another app", async () => {
  const { provider, ffPromptedElsewhere, tbPromptedElsewhere } = setupTwoClients();

  // Firefox-owned session, mail tool executes on Thunderbird → the Firefox
  // session owner gets the display-only heads-up pointing at Thunderbird.
  const ffTools = provider.createTools({ id: "s-a" }, "legacy", undefined, ["browser"], "ff");
  const mail = ffTools.find((t) => t.name === "mail_get_message");
  assert.ok(mail);
  await mail.execute("tc1", {}, undefined as never);
  assert.equal(ffPromptedElsewhere.length, 1, "FF session owner notified");
  assert.equal(ffPromptedElsewhere[0].tool, "mail_get_message");
  assert.equal(ffPromptedElsewhere[0].application, "thunderbird");
  assert.equal(ffPromptedElsewhere[0].sessionId, "s-a");
  assert.equal(tbPromptedElsewhere.length, 0, "executing client is not told about its own prompt");

  // Thunderbird-owned session, mail tool executes on Thunderbird (owner ==
  // executor) → nobody gets a remote heads-up.
  const tbTools = provider.createTools({ id: "s-b" }, "legacy", undefined, ["mail"], "tb");
  const ownMail = tbTools.find((t) => t.name === "mail_search");
  assert.ok(ownMail);
  await ownMail.execute("tc2", {}, undefined as never);
  assert.equal(ffPromptedElsewhere.length, 1, "no new notification");
  assert.equal(tbPromptedElsewhere.length, 0, "owner == executor: no remote prompt banner");

  // Reverse direction: Thunderbird-owned session, browser_screenshot
  // executes on Firefox → the TB session owner gets a heads-up pointing at
  // the browser.
  const shot = tbTools.find((t) => t.name === "browser_screenshot");
  assert.ok(shot);
  await shot.execute("tc3", {}, undefined as never);
  assert.equal(tbPromptedElsewhere.length, 1, "TB session owner notified");
  assert.equal(tbPromptedElsewhere[0].tool, "browser_screenshot");
  assert.equal(tbPromptedElsewhere[0].application, "firefox");
  assert.equal(ffPromptedElsewhere.length, 1, "FF (executor) is not told about its own prompt");
});

test("provider (broker mode): sensitive tool permission prompt goes to the executing client", async () => {
  const setup = setupTwoClients();
  const { provider, tb } = setup;
  // browser_screenshot executes on Firefox → the prompt must go to Firefox,
  // not to the Thunderbird session owner.
  let ffPermissionRequests = 0;
  let tbPermissionRequests = 0;
  const setupFfPair = setup.ff;
  setupFfPair.transport.onRequest = (method, _params, id) => {
    if (method === X_PI_BROWSER.tool) {
      setupFfPair.transport.respond(id, { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] });
    } else if (method === "session/request_permission") {
      ffPermissionRequests++;
      setupFfPair.transport.respond(id, { outcome: { outcome: "selected", optionId: "allow_once" } });
    } else {
      setupFfPair.transport.respondError(id, toErrorObject(PI_BROWSER_ERROR.INTERNAL, "unexpected"));
    }
  };
  tb.transport.onRequest = (method, _params, id) => {
    if (method === "session/request_permission") tbPermissionRequests++;
    tb.transport.respondError(id, toErrorObject(PI_BROWSER_ERROR.INTERNAL, "prompt leaked to TB"));
  };

  const tools = provider.createTools({ id: "s4" }, "legacy", undefined, ["mail"], "tb");
  const screenshot = tools.find((t) => t.name === "browser_screenshot");
  assert.ok(screenshot);
  await screenshot!.execute("tc1", {}, undefined as never);
  assert.equal(ffPermissionRequests, 1, "prompt sent to Firefox (executing client)");
  assert.equal(tbPermissionRequests, 0, "no prompt leaked to the session owner");
});
