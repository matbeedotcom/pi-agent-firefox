/**
 * pi-integration tests: isolated job runner, host wiring, bridge, extension.
 * All sessions are faked — no model calls, no filesystem, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  type RegisteredSkill,
} from "@trusted-ua/protocol";
import {
  IsolatedSkillRunner,
  type CreateIsolatedSessionOptions,
  type IsolatedSessionFactory,
  type SkillJobSpec,
} from "../src/skills/isolated-runner.js";
import { createSkillsHost } from "../src/skills/pi-integration.js";
import { getSkillsBridge, setSkillsBridge, type SkillsBridge, type SkillsSessionBinding } from "../src/skills/pi-bridge.js";
import { createSkillsExtensionFactory, SKILL_AUDIT_TYPE, SKILL_JOB_RESULT_CHANNEL } from "../src/skills/extension.js";
import { createLogger, type Logger } from "../src/logger.js";
import type { BrowserToolBridge } from "../src/tool-bridge.js";
import type { SkillsRegistry } from "../src/skills/registry.js";
import type { SkillJobOutcome } from "../src/skills/skills-service.js";
import { deferred, waitFor } from "./helpers.js";

const QUIET: Logger = createLogger({ level: "error", stderr: { write: () => true } });

const skill: RegisteredSkill = {
  key: "pkg/friendliness",
  revision: "rev-1",
  packageId: "pkg",
  instructions: "Review the draft for friendliness.",
  definition: {
    id: "friendliness",
    type: "triggered",
    instructions: "skills/friendliness/SKILL.md",
    subscriptions: [{ event: "before-submit" }],
    context: { required: ["draft"], optional: [] },
    capabilities: ["context.read", "suggestion.present"],
    execution: { handler: "agent", timeoutMs: 5000 },
  },
  manifest: {
    schemaVersion: 2,
    packageId: "pkg",
    application: "firefox",
    hosts: ["facebook.com"],
    targets: { composer: { selector: "composer-x", kind: "css" } },
    events: { "before-submit": { kind: "gate", chainId: "pkg-submit",
      alternatives: [[{ dom: "click", target: "composer" }]],
      payload: { draft: { from: "composer", field: "value" } } } },
    skills: [],
  },
};

function spec(overrides: Partial<SkillJobSpec> = {}): SkillJobSpec {
  return {
    skill,
    context: JSON.stringify({ draft: "hi there" }),
    eventId: "e1",
    jobId: "j1",
    grantedTools: [],
    ...overrides,
  };
}

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "j1",
    eventId: "e1",
    skillKey: "pkg/friendliness",
    skillRevision: "rev-1",
    decision: "clear",
    explanation: "the draft is fine",
    ...overrides,
  };
}

interface FakeSession {
  prompts: string[];
  reportPayloads: unknown[];
  disposed: boolean;
  aborted: boolean;
  msgs: unknown[];
  readonly messages: unknown[];
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  callReport(payload: unknown): Promise<unknown>;
}

type SessionHandler = (session: FakeSession, opts: CreateIsolatedSessionOptions) => void | Promise<void>;

function makeSessionFactory(handler?: SessionHandler) {
  const calls: CreateIsolatedSessionOptions[] = [];
  const factory: IsolatedSessionFactory = async (opts) => {
    calls.push(opts);
    const fake: FakeSession = {
      prompts: [],
      reportPayloads: [],
      disposed: false,
      aborted: false,
      msgs: [],
      get messages() {
        return this.msgs;
      },
      async prompt(text: string) {
        this.prompts.push(text);
        if (handler) await handler(this, opts);
      },
      async abort() {
        this.aborted = true;
      },
      dispose() {
        this.disposed = true;
      },
      async callReport(payload: unknown) {
        const tool = opts.customTools.find((t) => t.name === "skill_report");
        if (!tool) throw new Error("skill_report tool missing");
        this.reportPayloads.push(payload);
        return tool.execute("tc-1", payload as never, undefined, undefined, undefined as never);
      },
    };
    return fake;
  };
  return { factory, calls };
}

// --- isolated runner -------------------------------------------------------

test("isolated session: explicit skill only, no ambient resources, minimal tools", async () => {
  const { factory, calls } = makeSessionFactory(async (session) => {
    session.msgs = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
    await session.callReport(validReport());
  });
  const runner = new IsolatedSkillRunner({ log: QUIET, cwd: "/tmp/skills-job", agentDir: "/tmp/skills-agent", sessionFactory: factory });
  const result = await runner.run(spec(), new AbortController().signal);
  assert.equal(result.ok, true);

  const opts = calls[0]!;
  assert.equal(opts.noExtensions, true, "no ambient extension discovery in workers");
  assert.equal(opts.noSkills, true, "no ambient skill discovery in workers");
  assert.equal(opts.inMemorySession, true, "job traffic never persists to a session file");
  assert.deepEqual(opts.tools, ["skill_report"], "a plain review gets ONLY the report tool");
  assert.equal(opts.skill.key, skill.key, "the single selected skill is explicit");
  assert.ok(opts.systemPromptAppend.join("\n").includes(skill.instructions), "skill instructions injected into the system prompt");
  assert.ok(opts.systemPromptAppend.join("\n").includes(`jobId: ${"j1"}`), "job identity in the contract");
  assert.ok(opts.taskPrompt.includes(opts === calls[0] ? JSON.stringify({ draft: "hi there" }) : ""), "context payload in the task prompt");
  assert.ok(opts.taskPrompt.includes("event e1"));
});

test("verified report completes the job with transcript", async () => {
  const { factory } = makeSessionFactory(async (session) => {
    session.msgs = [
      { role: "user", content: "review" },
      { role: "assistant", content: [{ type: "text", text: "final verdict text" }] },
    ];
    await session.callReport(validReport({ decision: "suggest", replacementText: "hi there!" }));
  });
  const runner = new IsolatedSkillRunner({ log: QUIET, sessionFactory: factory });
  const result = await runner.run(spec(), new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.report?.decision, "suggest");
  assert.equal(result.report?.replacementText, "hi there!");
  assert.equal(result.transcript, "final verdict text");
});

test("report identity is bound from the job spec — forged identity fields are overwritten", async () => {
  // The runner ALWAYS binds jobId/eventId/skillKey/skillRevision from the
  // spec (isolated-runner.ts skill_report tool), so a model-echoed foreign
  // identity can never name another job: it is replaced, not trusted.
  const { factory } = makeSessionFactory(async (session) => {
    await session.callReport(validReport({ jobId: "other-job", skillKey: "evil/skill", skillRevision: "rev-999" }));
  });
  const runner = new IsolatedSkillRunner({ log: QUIET, sessionFactory: factory });
  const s = spec();
  const result = await runner.run(s, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.report?.jobId, s.jobId);
  assert.equal(result.report?.skillKey, s.skill.key);
  assert.equal(result.report?.skillRevision, s.skill.revision);
});

test("malformed report fails validation", async () => {
  const { factory } = makeSessionFactory(async (session) => {
    await session.callReport(validReport({ decision: "reject" }));
  });
  const runner = new IsolatedSkillRunner({ log: QUIET, sessionFactory: factory });
  const result = await runner.run(spec(), new AbortController().signal);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid report/);
});

test("job without a report fails", async () => {
  const { factory } = makeSessionFactory(async () => {
    // session settles without calling skill_report
  });
  const runner = new IsolatedSkillRunner({ log: QUIET, sessionFactory: factory });
  const result = await runner.run(spec(), new AbortController().signal);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /without a verified report/);
});

test("pre-aborted signal aborts before spawning a session", async () => {
  const { factory, calls } = makeSessionFactory();
  const runner = new IsolatedSkillRunner({ log: QUIET, sessionFactory: factory });
  const controller = new AbortController();
  controller.abort();
  const result = await runner.run(spec(), controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.error, "aborted");
  assert.equal(calls.length, 0, "no session spawned");
});

test("granted browser tools route through the host bridge; unknown names are skipped", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const browserBridge = {
    call: async (opts: { tool: string; args: Record<string, unknown> }) => {
      calls.push({ tool: opts.tool, args: opts.args });
      return { content: [{ type: "text" as const, text: `called:${opts.tool}` }] };
    },
  } as unknown as BrowserToolBridge;
  const { factory, calls: factoryCalls } = makeSessionFactory();
  const runner = new IsolatedSkillRunner({ log: QUIET, browserBridge, sessionFactory: factory });
  const result = await runner.run(spec({ grantedTools: ["browser_unbind_tab", "nope/unknown"] }), new AbortController().signal);
  assert.equal(result.ok, false); // no report in this test — the assertion is on tool wiring
  const opts = factoryCalls[0]!;
  assert.deepEqual(opts.tools, ["skill_report", "browser_unbind_tab"], "allowlist = report + granted only");
  const granted = opts.customTools.find((t) => t.name === "browser_unbind_tab");
  assert.ok(granted, "granted tool present");
  const out = (await granted!.execute("tc-9", {}, undefined, undefined, undefined as never)) as { content: Array<{ type?: string; text?: string }> };
  assert.equal(out.content[0]?.text, "called:browser_unbind_tab");
  assert.equal(calls.length, 1);
});

// --- host wiring -----------------------------------------------------------

test("host: submit resolves done with the verified report; close clears the bridge", async () => {
  const { factory } = makeSessionFactory(async (session) => {
    session.msgs = [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];
    await session.callReport(validReport());
  });
  const host = createSkillsHost({ log: QUIET, cwd: "/tmp/skills-job", agentDir: "/tmp/skills-agent", sessionFactory: factory });
  assert.equal(getSkillsBridge(), host.bridge, "bridge installed process-wide");

  const outcome = await host.submit(spec());
  assert.equal(outcome.status, "done");
  assert.equal((outcome.value as { decision: string })?.decision, "clear");
  assert.equal(host.service.stats.outcomes.done, 1);

  await host.close();
  assert.equal(getSkillsBridge(), undefined, "bridge cleared on close");
  const late = await host.submit(spec({ jobId: "j2", eventId: "e2" }));
  assert.equal(late.status, "unavailable");
});

test("host: supersede coalesces per key; cancel aborts", async () => {
  const hold = deferred<void>();
  let n = 0;
  const { factory } = makeSessionFactory(async (session) => {
    n += 1;
    if (n === 1) {
      await hold.promise; // first job runs until superseded
      return;
    }
    session.msgs = [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];
    await session.callReport(validReport({ jobId: "j1" }));
  });
  const host = createSkillsHost({ log: QUIET, cwd: "/tmp/skills-job", agentDir: "/tmp/skills-agent", sessionFactory: factory });

  const o1 = host.submit(spec());
  await waitFor(() => host.service.stats.running === 1);
  const o2 = host.submit(spec()); // same key pkg/friendliness:e1 — supersedes
  hold.resolve();
  const [r1, r2] = await Promise.all([o1, o2]);
  assert.equal(r1.status, "superseded");
  assert.equal(r2.status, "done");

  // cancel path: a fresh key, cancelled while running
  const hold2 = deferred<void>();
  let cancelled = 0;
  const { factory: f2 } = makeSessionFactory(async () => {
    await hold2.promise;
  });
  const host2 = createSkillsHost({ log: QUIET, cwd: "/tmp/skills-job", agentDir: "/tmp/skills-agent", sessionFactory: f2 });
  void host2.submit(spec({ eventId: "e9", jobId: "j9" }));
  await waitFor(() => host2.service.stats.running === 1);
  cancelled = host2.cancel("pkg/friendliness:e9");
  hold2.resolve();
  assert.equal(cancelled, 1);
  assert.equal(host2.service.stats.outcomes.aborted, 1);
  await host2.close();
});

test("host: runActive resolves from the registry; unknown keys are unavailable", async () => {
  const { factory } = makeSessionFactory(async (session) => {
    session.msgs = [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];
    await session.callReport({ jobId: "active:pkg/friendliness", eventId: "active", skillKey: "pkg/friendliness", skillRevision: "rev-1", decision: "clear" });
  });
  const registry = { get: (key: string) => (key === "pkg/friendliness" ? skill : undefined) } as unknown as SkillsRegistry;
  const host = createSkillsHost({ log: QUIET, cwd: "/tmp/skills-job", agentDir: "/tmp/skills-agent", registry, sessionFactory: factory });

  const unknown = await host.bridge.runActive("no/such-skill");
  assert.equal(unknown.status, "unavailable");
  assert.match(unknown.reason ?? "", /unknown skill/);

  const active = await host.bridge.runActive("pkg/friendliness", "make it warmer");
  assert.equal(active.status, "done");
  assert.equal((active.value as { decision: string })?.decision, "clear");
  await host.close();
});

// --- extension factory -----------------------------------------------------

function fakeExtensionApi() {
  const handlers: Record<string, Array<(event: unknown) => unknown>> = {};
  const commands: Array<{ name: string; handler: (args: string, ctx: never) => Promise<void> }> = [];
  const entries: Array<{ type: string; data?: unknown }> = [];
  const emitCalls: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    on: (event: string, handler: (event: unknown) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: never) => Promise<void> }) => {
      commands.push({ name, handler: options.handler });
    },
    appendEntry: (type: string, data?: unknown) => {
      entries.push({ type, data });
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emitCalls.push({ channel, data });
      },
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, entries, emitCalls };
}

function fakeBridge() {
  const listeners: Array<(r: { key: string; outcome: SkillJobOutcome }) => void> = [];
  let binding: SkillsSessionBinding | undefined;
  let attached = 0;
  let detached = 0;
  const bridge: SkillsBridge = {
    runActive: async (key) => ({ status: "done", value: { decision: "clear", explanation: "from bridge" } }),
    cancel: () => 1,
    stats: { running: 0, queued: 0, replacements: 0, closed: false, outcomes: { done: 0, superseded: 0, aborted: 0, "timed-out": 0, failed: 0, unavailable: 0 } },
    bindSession: (b) => { binding = b; },
    unbindSession: () => { binding = undefined; },
    currentBinding: () => binding,
    sessionAttached: () => { attached += 1; },
    sessionDetached: () => { detached += 1; },
    onJobResult: (cb) => { listeners.push(cb); return () => {}; },
  };
  return {
    bridge,
    fireJobResult: (r: { key: string; outcome: SkillJobOutcome }) => listeners.forEach((l) => l(r)),
    get attached() { return attached; },
    get detached() { return detached; },
  };
}

test("extension: registers nothing in a plain pi session (no bridge)", () => {
  setSkillsBridge(undefined);
  const { pi, handlers, commands } = fakeExtensionApi();
  createSkillsExtensionFactory()(pi);
  assert.equal(commands.length, 0);
  assert.equal(Object.keys(handlers).length, 0);
});

test("extension: full behavior with a host bridge", () => {
  const fb = fakeBridge();
  const { bridge, fireJobResult } = fb;
  setSkillsBridge(bridge);
  const { pi, handlers, commands, entries, emitCalls } = fakeExtensionApi();
  createSkillsExtensionFactory()(pi);
  setSkillsBridge(undefined);

  assert.deepEqual(commands.map((c) => c.name), ["trusted-ua-skills", "pi-skills"]);

  // Idempotent attach/detach — repeated starts/shutdowns never throw.
  void handlers.session_start![0]({});
  void handlers.session_start![0]({});
  void handlers.session_shutdown![0]({});
  void handlers.session_shutdown![0]({});
  void handlers.session_shutdown![0]({});
  assert.equal(fb.attached, 2);
  assert.equal(fb.detached, 3);

  // resources_discover: explicitly selected paths only.
  bridge.bindSession({ skillPaths: ["/pkg/friendliness"] });
  assert.deepEqual(handlers.resources_discover![0]({}), { skillPaths: ["/pkg/friendliness"] });
  bridge.unbindSession();
  assert.deepEqual(handlers.resources_discover![0]({}), {}, "no selection — nothing contributed");

  // before_agent_start: selected task instructions as a custom message.
  bridge.bindSession({ skillPaths: [], instructions: { skillKey: "pkg/friendliness", instructions: "Review for warmth." } });
  const injection = handlers.before_agent_start![0]({}) as { message?: { customType: string; content: string; details?: { skillKey: string } } };
  assert.equal(injection.message?.customType, "pi-browser:skill-instructions");
  assert.equal(injection.message?.content, "Review for warmth.");
  assert.equal(injection.message?.details?.skillKey, "pkg/friendliness");
  bridge.bindSession({ skillPaths: [] });
  assert.equal(handlers.before_agent_start![0]({}), undefined, "no instructions — no injection");

  // tool_call gating: allowed tools pass, everything else is blocked.
  bridge.bindSession({ skillPaths: [], allowedTools: ["read"] });
  const event = (toolName: string) => ({ type: "tool_call", toolCallId: "t1", toolName, input: {} }) as ToolCallEvent;
  assert.equal(handlers.tool_call![0](event("read")), undefined);
  const blocked = handlers.tool_call![0](event("bash")) as { block?: boolean; reason?: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", /not permitted/);
  bridge.unbindSession();
  assert.equal(handlers.tool_call![0](event("bash")), undefined, "no scope — no gating");

  // job results: session-local audit entry + local integration event.
  fireJobResult({ key: "pkg/friendliness:e1", outcome: { status: "done" } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.type, SKILL_AUDIT_TYPE);
  assert.equal((entries[0]!.data as { key?: string })?.key, "pkg/friendliness:e1");
  assert.equal(emitCalls.length, 1);
  assert.equal(emitCalls[0]!.channel, SKILL_JOB_RESULT_CHANNEL);
});

test("extension: /pi-skills command — status, run, cancel", async () => {
  const fb = fakeBridge();
  const { bridge } = fb;
  setSkillsBridge(bridge);
  const { pi, commands } = fakeExtensionApi();
  createSkillsExtensionFactory()(pi);

  const notices: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => { notices.push({ message, level }); } } };
  const handler = commands[0]!.handler;

  await handler("status", ctx as never);
  assert.match(notices.at(-1)!.message, /running=0 queued=0/);

  await handler("run pkg/friendliness warmer tone", ctx as never);
  assert.equal(notices.length, 3); // starting + result
  assert.match(notices.at(-1)!.message, /pkg\/friendliness: clear — from bridge/);

  await handler("cancel some-key", ctx as never);
  assert.match(notices.at(-1)!.message, /cancelled 1 job/);

  await handler("bogus", ctx as never);
  assert.match(notices.at(-1)!.message, /usage/);
  assert.equal(fb.attached, 0);
  setSkillsBridge(undefined);
});
