/**
 * Caller sessions (openspec external-mcp-callers): external MCP clients
 * reach the tools through the broker with no add-on chat session, through
 * the caller gate (external access + per-app caller approval), with their
 * own grants, and attribution on every prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../src/logger.js";
import { createMemoryTransportPair } from "../src/native-host/transport.js";
import { CapabilityToolProvider } from "../src/browser/provider.js";
import { CapabilityRegistry } from "../src/capability-registry.js";
import { PermissionStore } from "../src/permission-store.js";
import {
  CLIENT_METHODS,
  PERMISSION_WITHDRAWN_METHOD,
  X_PI_BROWSER,
  type CallerInfo,
  type RequestPermissionRequest,
} from "@trusted-ua/protocol";
import { waitFor } from "./helpers.js";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });

function tempStore(): PermissionStore {
  return new PermissionStore({ filePath: join(mkdtempSync(join(tmpdir(), "pi-caller-")), "permissions.json") });
}

type Answer = string | "cancelled" | "hang";

/** A fake app: records prompts and tool calls, answers prompts from a script. */
interface FakeApp {
  prompts: RequestPermissionRequest[];
  tools: Array<{ sessionId: string; tool: string }>;
  withdrawn: Array<{ sessionId: string; toolCallId: string; reason: string }>;
  /** Next answers, in order; default answer when empty. */
  answers: Answer[];
  defaultAnswer: Answer;
}

interface Rig {
  provider: CapabilityToolProvider;
  store: PermissionStore;
  firefox: FakeApp;
  thunderbird: FakeApp;
}

function setup(opts: { permissionTimeoutMs?: number; store?: PermissionStore; withThunderbird?: boolean } = {}): Rig {
  const registry = new CapabilityRegistry(quiet);
  const store = opts.store ?? tempStore();
  const makeApp = (clientId: string, application: "firefox" | "thunderbird", capabilities: string[]): FakeApp => {
    const app: FakeApp = { prompts: [], tools: [], withdrawn: [], answers: [], defaultAnswer: "allow_once" };
    const { a, b } = createMemoryTransportPair(quiet, quiet);
    a.transport.onRequest = (method, params, id) => {
      if (method === CLIENT_METHODS.session_request_permission) {
        app.prompts.push(params as RequestPermissionRequest);
        const answer = app.answers.shift() ?? app.defaultAnswer;
        if (answer === "hang") return;
        a.transport.respond(
          id,
          answer === "cancelled"
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: answer } },
        );
        return;
      }
      if (method === X_PI_BROWSER.tool) {
        const p = params as { sessionId: string; tool: string };
        app.tools.push({ sessionId: p.sessionId, tool: p.tool });
        a.transport.respond(id, { content: [{ type: "text", text: `${application}:${p.tool}` }] });
        return;
      }
      a.transport.respondError(id, { code: -32601, message: `fake ${application}: unknown ${method}` });
    };
    a.transport.onNotification = (method, params) => {
      if (method === PERMISSION_WITHDRAWN_METHOD) app.withdrawn.push(params as FakeApp["withdrawn"][number]);
    };
    registry.register({ clientId, application, capabilities: capabilities as never, transport: b.transport });
    return app;
  };
  const firefox = makeApp("ff-1", "firefox", ["browser"]);
  const thunderbird =
    opts.withThunderbird === false
      ? ({ prompts: [], tools: [], withdrawn: [], answers: [], defaultAnswer: "allow_once" } as FakeApp)
      : makeApp("tb-1", "thunderbird", ["mail", "compose", "mailModify", "contacts"]);
  const provider = new CapabilityToolProvider(undefined, quiet, registry, {
    permissionStore: store,
    ...(opts.permissionTimeoutMs ? { permissionTimeoutMs: opts.permissionTimeoutMs } : {}),
  });
  return { provider, store, firefox, thunderbird };
}

const codex: CallerInfo = { name: "codex", version: "0.9" };

function callAs(rig: Rig, sessionId: string, caller: CallerInfo, tool: string) {
  return rig.provider.bridgeCall({
    tool,
    args: {},
    sessionId,
    ctx: { ownerApplication: "firefox", mode: "legacy", caller },
  });
}

const meta = (req: RequestPermissionRequest) =>
  ((req._meta as { piBrowser?: Record<string, unknown> } | undefined)?.piBrowser ?? {}) as {
    tool?: string;
    caller?: { name: string; version?: string };
    callerApproval?: boolean;
    application?: string;
  };

test("caller: first call asks to approve the caller in Firefox, then the tool, both attributed", async () => {
  const rig = setup();
  const res = await callAs(rig, "mcp:a", codex, "browser_get_page");
  assert.equal((res.content[0] as { text: string }).text, "firefox:browser_get_page", "runs with no add-on session");
  assert.equal(rig.firefox.prompts.length, 2, "caller approval + tool approval");
  const [callerPrompt, toolPrompt] = rig.firefox.prompts;
  assert.equal(meta(callerPrompt).callerApproval, true);
  assert.equal(meta(callerPrompt).application, "firefox");
  assert.deepEqual(meta(callerPrompt).caller, { name: "codex", version: "0.9" });
  assert.equal(callerPrompt.toolCall.title, "codex wants to use Firefox tools");
  assert.equal(meta(callerPrompt).tool, undefined, "older add-ons describe it from the title");
  assert.deepEqual(callerPrompt.options.map((o) => o.optionId), ["allow_once", "allow_always", "reject_once"]);
  assert.equal(meta(toolPrompt).tool, "browser_get_page");
  assert.deepEqual(meta(toolPrompt).caller, { name: "codex", version: "0.9" }, "tool prompts name the caller");
  assert.equal(rig.thunderbird.prompts.length, 0);

  // Allow once covers the rest of this caller session for Firefox.
  await callAs(rig, "mcp:a", codex, "browser_get_dom");
  assert.equal(rig.firefox.prompts.filter((p) => meta(p).callerApproval).length, 1);
  assert.equal(rig.store.getCallerState("firefox", "codex"), undefined, "Allow once is not remembered");
});

test("caller: a remembered allow skips the caller prompt, never the tool prompt", async () => {
  const rig = setup();
  rig.store.setCallerState("firefox", "codex", "allow");
  await callAs(rig, "mcp:b", codex, "browser_screenshot");
  assert.equal(rig.firefox.prompts.length, 1);
  assert.equal(meta(rig.firefox.prompts[0]).tool, "browser_screenshot", "per-tool approval still applies");
});

test("caller: Always allow in Firefox does not approve Thunderbird", async () => {
  const rig = setup();
  rig.firefox.answers = ["allow_always"];
  await callAs(rig, "mcp:c", codex, "browser_get_page");
  assert.equal(rig.store.getCallerState("firefox", "codex"), "allow");
  await callAs(rig, "mcp:c", codex, "mail_search");
  const tbCaller = rig.thunderbird.prompts.filter((p) => meta(p).callerApproval);
  assert.equal(tbCaller.length, 1, "Thunderbird asks separately, in Thunderbird");
  assert.equal(tbCaller[0].toolCall.title, "codex wants to use Thunderbird tools");
  assert.equal(rig.thunderbird.tools[0].tool, "mail_search");

  // A new codex session: Firefox remembered, no caller prompt there.
  const before = rig.firefox.prompts.length;
  await callAs(rig, "mcp:c2", codex, "browser_get_page");
  assert.equal(rig.firefox.prompts.slice(before).filter((p) => meta(p).callerApproval).length, 0);
});

test("caller: Deny is remembered per app and refuses later calls without asking", async () => {
  const rig = setup();
  rig.firefox.answers = ["reject_once"];
  await assert.rejects(callAs(rig, "mcp:d", codex, "browser_get_page"), /denied codex access to the Firefox tools/);
  assert.equal(rig.store.getCallerState("firefox", "codex"), "deny");
  assert.equal(rig.firefox.tools.length, 0);
  await assert.rejects(callAs(rig, "mcp:d", codex, "browser_get_page"), /denied codex/);
  await assert.rejects(callAs(rig, "mcp:d-new", codex, "browser_get_page"), /denied codex/);
  assert.equal(rig.firefox.prompts.length, 1, "no further prompts");
});

test("caller: a closed approval window denies once and is not remembered", async () => {
  const rig = setup();
  rig.firefox.answers = ["cancelled"];
  await assert.rejects(callAs(rig, "mcp:e", codex, "browser_get_page"), /denied the request/);
  assert.equal(rig.store.getCallerState("firefox", "codex"), undefined);
  await callAs(rig, "mcp:e", codex, "browser_get_page");
  assert.equal(rig.firefox.prompts.filter((p) => meta(p).callerApproval).length, 2, "the next call asks again");
});

test("caller: external access off refuses without a prompt; a fresh store defaults to on", async () => {
  const fresh = tempStore();
  assert.equal(fresh.getExternalAccess(), true);
  const rig = setup({ store: fresh });
  rig.provider.setExternalAccess(false);
  await assert.rejects(callAs(rig, "mcp:f", codex, "browser_get_page"), /External MCP access is disabled/);
  await assert.rejects(callAs(rig, "mcp:f", codex, "javascript"), /External MCP access is disabled/);
  assert.equal(rig.firefox.prompts.length, 0);
  // Persisted: a new store on the same file reads it back.
  assert.equal(new PermissionStore({ filePath: fresh.file }).getExternalAccess(), false);
  // Add-on sessions are not affected by the switch.
  const tools = rig.provider.createTools({ id: "s-addon" }, "legacy", undefined, ["browser"], "ff-1", "firefox");
  await tools.find((t) => t.name === "browser_get_page")!.execute("tc-1", {}, undefined);
});

test("caller: an unanswered prompt times out with a tool error and is withdrawn", async () => {
  const rig = setup({ permissionTimeoutMs: 60 });
  rig.firefox.answers = ["hang"];
  await assert.rejects(callAs(rig, "mcp:g", codex, "browser_get_page"), /did not respond/);
  await waitFor(() => rig.firefox.withdrawn.length === 1);
  assert.equal(rig.firefox.withdrawn[0].reason, "timeout");
  assert.equal(rig.firefox.withdrawn[0].toolCallId, rig.firefox.prompts[0].toolCall.toolCallId);
  assert.equal(rig.store.getCallerState("firefox", "codex"), undefined, "a timeout is not remembered");
});

test("caller: a persistent tool Deny refuses without a prompt", async () => {
  const rig = setup();
  rig.store.setCallerState("firefox", "codex", "allow");
  rig.store.setState("browser_screenshot", "deny");
  await assert.rejects(callAs(rig, "mcp:h", codex, "browser_screenshot"), /denied by the user/);
  assert.equal(rig.firefox.prompts.length, 0);
});

test("caller: sessions never share grants — with each other or with an add-on session", async () => {
  const rig = setup();
  rig.store.setCallerState("firefox", "codex", "allow");
  // The user's own sidebar session gets "Allow for this session".
  rig.firefox.answers = ["allow_session"];
  const tools = rig.provider.createTools({ id: "s-sidebar" }, "legacy", undefined, ["browser"], "ff-1", "firefox");
  await tools.find((t) => t.name === "browser_get_page")!.execute("tc-s", {}, undefined);
  // A caller still gets its own tool prompt.
  rig.firefox.answers = ["allow_session"];
  await callAs(rig, "mcp:i1", codex, "browser_get_page");
  assert.equal(rig.firefox.prompts.length, 2);
  // Its session grant now covers it...
  await callAs(rig, "mcp:i1", codex, "browser_get_page");
  assert.equal(rig.firefox.prompts.length, 2);
  // ...but not another connection of the same caller.
  await callAs(rig, "mcp:i2", codex, "browser_get_page");
  assert.equal(rig.firefox.prompts.length, 3);
});

test("caller: closing the session drops its grants and withdraws a waiting prompt", async () => {
  const rig = setup();
  rig.store.setCallerState("firefox", "codex", "allow");
  rig.firefox.answers = ["allow_session"];
  await callAs(rig, "mcp:j", codex, "browser_get_page");
  await rig.provider.disposeSession("mcp:j");
  await callAs(rig, "mcp:j", codex, "browser_get_page");
  assert.equal(rig.firefox.prompts.length, 2, "the session grant was dropped");

  rig.firefox.answers = ["hang"];
  const pending = callAs(rig, "mcp:k", codex, "browser_screenshot");
  pending.catch(() => undefined);
  await waitFor(() => rig.firefox.prompts.length === 3);
  await rig.provider.disposeSession("mcp:k");
  assert.equal(rig.firefox.withdrawn.at(-1)?.reason, "session_closed");
});

test("caller: concurrent first calls share one caller prompt", async () => {
  const rig = setup();
  await Promise.all([
    callAs(rig, "mcp:l", codex, "browser_get_page"),
    callAs(rig, "mcp:l", codex, "browser_get_dom"),
  ]);
  assert.equal(rig.firefox.prompts.filter((p) => meta(p).callerApproval).length, 1);
});

test("caller: revoking in settings asks again, only for that app and caller", async () => {
  const rig = setup();
  rig.store.setCallerState("firefox", "codex", "allow");
  rig.store.setCallerState("thunderbird", "codex", "allow");
  await callAs(rig, "mcp:m", codex, "browser_get_page");
  rig.provider.setCallerPermission({ application: "firefox", name: "codex" }, "ask");
  await callAs(rig, "mcp:m", codex, "browser_get_page");
  assert.equal(rig.firefox.prompts.filter((p) => meta(p).callerApproval).length, 1, "asked again after revoke");
  assert.equal(rig.store.getCallerState("thunderbird", "codex"), "allow", "Thunderbird decision unchanged");
  const config = rig.provider.permissionConfig();
  assert.equal(config.externalAccess, true);
  assert.deepEqual(config.callers, [{ application: "thunderbird", name: "codex", state: "allow" }]);
});

test("caller: a missing app is a tool error naming the app", async () => {
  const rig = setup({ withThunderbird: false });
  await assert.rejects(callAs(rig, "mcp:n", codex, "mail_search"), /mail_search needs Thunderbird with the Pi add-on running/);
});
