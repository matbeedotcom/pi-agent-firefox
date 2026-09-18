/**
 * Skills protocol surface tests (skills-runtime-design.md §7, §13).
 *
 * Drives the real host protocol over an in-memory transport pair: the test
 * plays the addon coordinator (client side) and asserts identity binding,
 * plan validation, context resolution, result delivery, and teardown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  X_PI_BROWSER,
  parseSkillPackage,
  type ReviewResult,
  type RegisteredSkill,
  type SkillEvent,
  type SkillsCancelResult,
  type SkillsContextRequestParams,
  type SkillsContextResult,
  type SkillsEventResult,
  type SkillsPlanResult,
  type SkillsResultParams,
  type SkillsStatusResult,
} from "@pi-browser/protocol";
import { createMemoryTransportPair } from "../src/native-host/transport.js";
import { createSkillsProtocol, type SkillsLifecycleEvent } from "../src/skills/skills-protocol.js";
import { SkillsPlanner, type SkillGrant } from "../src/skills/planner.js";
import type { SkillsRegistry } from "../src/skills/registry.js";
import type { SkillsHost, } from "../src/skills/pi-integration.js";
import { createLogger } from "../src/logger.js";
import type { SkillJobSpec } from "../src/skills/isolated-runner.js";

const log = createLogger({ level: "error", stderr: { write: () => true } });

function manifest(packageId = "test-package", host = "example.com") {
  return {
    schemaVersion: 2, packageId, application: "firefox", hosts: [host],
    targets: { composer: "composer-x", submit: "submit-x" },
    events: {
      "before-submit": {
        kind: "gate", chainId: "t-submit",
        alternatives: [[{ dom: "click", target: "submit" }]],
        payload: { draft: { from: "composer", field: "value" }, replyTarget: { from: "composer", field: "text" } },
      },
      "draft.paused": {
        kind: "debounced", debounceMs: 100,
        sequence: [{ dom: "input", target: "composer" }],
        payload: { draft: { from: "composer", field: "value" } },
      },
    },
    skills: [
      { id: "friendliness", type: "triggered", instructions: "skills/friendliness/SKILL.md",
        subscriptions: [{ event: "before-submit" }],
        context: { required: ["draft", "replyTarget"], optional: [] },
        capabilities: ["context.read", "suggestion.present"], execution: { handler: "agent", timeoutMs: 10000 } },
      { id: "constructive-reply", type: "triggered", instructions: "skills/constructive-reply/SKILL.md",
        subscriptions: [{ event: "before-submit" }],
        context: { required: ["draft"], optional: [] },
        capabilities: ["context.read"], execution: { handler: "agent", timeoutMs: 10000 } },
    ],
  };
}

function skills(): RegisteredSkill[] {
  const parsed = parseSkillPackage(manifest());
  return parsed.skills.map((definition, i) => ({
    key: `test-package/${definition.id}`,
    revision: `rev-${i}`,
    packageId: "test-package",
    definition,
    instructions: "Be kind.",
    manifest: parsed,
  }));
}

function makeFakeHost() {
  const submissions: SkillJobSpec[] = [];
  const cancellations: string[] = [];
  const host = {
    service: { stats: { running: 0, queued: 0, replacements: 0, closed: false, outcomes: {} } },
    submit: (spec: SkillJobSpec) => {
      submissions.push(spec);
      const report: ReviewResult = {
        jobId: spec.jobId,
        eventId: spec.eventId,
        skillKey: spec.skill.key,
        skillRevision: spec.skill.revision,
        decision: "clear",
      };
      return Promise.resolve({ status: "done" as const, value: report });
    },
    cancel: (key: string) => {
      cancellations.push(key);
      return 1;
    },
  } as unknown as SkillsHost;
  return { host, submissions, cancellations };
}

function setup(options: { grants?: Map<string, SkillGrant>; contextOk?: boolean; lifecycle?: (e: SkillsLifecycleEvent) => void } = {}) {
  const skillList = skills();
  const planner = new SkillsPlanner(skillList);
  const grants = options.grants ?? new Map(skillList.map((s) => [s.key, {
    enabled: true, revision: s.revision, capabilities: ["context.read", "suggestion.present"],
  } satisfies SkillGrant]));
  const registry = {
    get: (key: string) => skillList.find((s) => s.key === key) ?? undefined,
    snapshot: () => skillList,
    version: 1,
  } as unknown as SkillsRegistry;
  const fake = makeFakeHost();
  const { a, b } = createMemoryTransportPair(log, log);

  const contextRequests: unknown[] = [];
  const results: SkillsResultParams[] = [];
  b.transport.onRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.skills_context) {
      contextRequests.push(params);
      if (options.contextOk === false) {
        b.transport.respondError(id, { code: -32000, message: "snapshot gone" });
        return;
      }
      const request = params as SkillsContextRequestParams;
      const context: Record<string, unknown> = { draft: "Hello there, friend!", replyTarget: "post-1" };
      const body: Record<string, unknown> = {};
      for (const field of request.fields) if (context[field] !== undefined) body[field] = context[field];
      const out: SkillsContextResult = { contextRef: request.contextRef, context: body, bytes: JSON.stringify(body).length };
      b.transport.respond(id, out);
      return;
    }
    if (method === X_PI_BROWSER.skills_result) {
      results.push(params as SkillsResultParams);
      b.transport.respond(id, { delivered: true });
      return;
    }
    b.transport.respondError(id, { code: -32601, message: `unknown method: ${method}` });
  };

  const protocol = createSkillsProtocol({
    log,
    host: fake.host,
    registry,
    planner,
    grants: () => grants,
    endpoint: a.transport,
    ...(options.lifecycle ? { onLifecycle: options.lifecycle } : {}),
  });

  const call = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const handled = protocol.handle(
        method,
        params,
        (result) => resolve(result),
        (code, message) => reject(new Error(`${code}: ${message}`)),
      );
      if (!handled) reject(new Error("METHOD_NOT_FOUND"));
    });

  return { protocol, a, b, call, fake, contextRequests, results, skillList, grants };
}

test("lifecycle sink records plan, event ack and job result lines (agent observation log)", async () => {
  const lifecycle: SkillsLifecycleEvent[] = [];
  const { call, skillList } = setup({ lifecycle: (e) => lifecycle.push(e) });
  const plan = (await call(X_PI_BROWSER.skills_plan, planParams)) as SkillsPlanResult;
  assert.equal(plan.status, "ok");
  const ack = (await call(X_PI_BROWSER.skills_event, { event: event(1) })) as SkillsEventResult;
  assert.equal(ack.status, "accepted");
  await new Promise((r) => setTimeout(r, 50)); // job settlement is async
  const types = lifecycle.map((e) => e.type);
  assert.ok(types.includes("plan"), `plan line recorded: ${JSON.stringify(lifecycle)}`);
  assert.ok(types.includes("event"), "event ack line recorded");
  assert.ok(types.includes("result"), "job result line recorded");
  const planLine = lifecycle.find((e) => e.type === "plan");
  assert.ok(planLine && planLine.type === "plan" && planLine.rules === skillList.length, `plan line: ${JSON.stringify(planLine)}`);
  const resultLine = lifecycle.find((e) => e.type === "result");
  assert.ok(resultLine && resultLine.type === "result" && resultLine.status === "done" && resultLine.decision === "clear", `result line: ${JSON.stringify(resultLine)}`);
  assert.ok(skillList.some((s) => s.key === resultLine.skillKey));
});

function event(planVersion: number, overrides: Partial<SkillEvent> = {}): SkillEvent {
  return {
    version: 1,
    eventId: "evt:1",
    event: "test-package:before-submit",
    source: { application: "firefox", connectionEpoch: "epoch-1", documentGeneration: "doc-1", tabId: 7, frameId: 0 },
    interactionId: "composer-7",
    draftRevision: 0,
    contextRevision: 3,
    planVersion,
    origin: "user",
    contextRef: "snap:1",
    ...overrides,
  };
}

const planParams = {
  source: { application: "firefox" as const, connectionEpoch: "epoch-1", documentGeneration: "doc-1", tabId: 7, frameId: 0 },
  url: "https://example.com/thread",
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("plans compile with versioning; grants and adapters gate rules", async () => {
  const { call } = setup();
  const first = (await call(X_PI_BROWSER.skills_plan, planParams)) as SkillsPlanResult;
  assert.equal(first.status, "ok");
  assert.equal(first.plan?.planVersion, 1);
  assert.equal(first.plan?.rules.length, 2);
  assert.equal(first.plan?.unavailable.length, 0);

  const second = (await call(X_PI_BROWSER.skills_plan, planParams)) as SkillsPlanResult;
  assert.equal(second.plan?.planVersion, 2);

  // No grants: nothing arms (installed ≠ enabled, design §12).
  const ungranted = setup({ grants: new Map() });
  const empty = (await ungranted.call(X_PI_BROWSER.skills_plan, planParams)) as SkillsPlanResult;
  assert.equal(empty.status, "ok");
  assert.equal(empty.plan?.rules.length, 0);
});

test("plan rejects malformed requests as protocol errors, not silent plans", async () => {
  const { call } = setup();
  // A coordinator only sends verified http(s) URLs with complete frame
  // identity; anything else is a client bug → JSON-RPC error, not a plan.
  await assert.rejects(call(X_PI_BROWSER.skills_plan, { ...planParams, url: "ftp://example.com/x" }), /skills: Unsupported document URL/);
  await assert.rejects(call(X_PI_BROWSER.skills_plan, { ...planParams, source: { ...planParams.source, frameId: undefined } }), /skills: Browser events require document, tab and frame identity/);
});

test("events naming a stale or unknown plan are rejected, never guessed", async () => {
  const { call } = setup();
  const noPlan = (await call(X_PI_BROWSER.skills_event, { event: event(1) })) as SkillsEventResult;
  assert.deepEqual(noPlan, { status: "stale-plan", reason: noPlan.reason });
  assert.match(noPlan.reason ?? "", /re-plan/);

  await call(X_PI_BROWSER.skills_plan, planParams); // version 1
  const stale = (await call(X_PI_BROWSER.skills_event, { event: event(99) })) as SkillsEventResult;
  assert.equal(stale.status, "stale-plan");
});

test("non-matching events ack no-match without model work", async () => {
  const { call, fake } = setup();
  await call(X_PI_BROWSER.skills_plan, planParams);
  const result = (await call(X_PI_BROWSER.skills_event, { event: event(1, { event: "test-package:draft.paused" }) })) as SkillsEventResult;
  assert.equal(result.status, "no-match");
  assert.equal(fake.submissions.length, 0);
});

test("matching event resolves context by request, submits jobs, and delivers an acked result", async () => {
  const { call, fake, contextRequests, results, skillList } = setup();
  await call(X_PI_BROWSER.skills_plan, planParams);
  const ack = (await call(X_PI_BROWSER.skills_event, { event: event(1) })) as SkillsEventResult;
  assert.equal(ack.status, "accepted");
  assert.equal(ack.jobs?.length, 2);

  // Context resolved through the coordinator: only requested fields, bounded.
  const contextRequest = contextRequests[0] as SkillsContextRequestParams;
  assert.equal(contextRequest.contextRef, "snap:1");
  assert.equal(contextRequest.interactionId, "composer-7");
  assert.equal(contextRequest.planVersion, 1);
  assert.ok(contextRequest.fields.includes("draft"));
  assert.ok(contextRequest.fields.includes("replyTarget"));
  assert.equal(contextRequest.maxBytes, 32_768);

  // Both jobs submitted with the resolved snapshot, correct kind and key.
  assert.equal(fake.submissions.length, 2);
  const [first, second] = fake.submissions;
  assert.equal(first.kind, "gate"); // before-submit gate event → held submission
  assert.equal(first.key, "test-package/friendliness:composer-7:0");
  assert.equal(first.jobId, "job:evt:1:test-package/friendliness");
  assert.equal(second.key, "test-package/constructive-reply:composer-7:0");
  const context = JSON.parse(first.context) as Record<string, string>;
  assert.equal(context.draft, "Hello there, friend!");
  assert.equal(context.replyTarget, "post-1");
  assert.equal(first.grantedTools.length, 0);
  assert.equal(first.skill.key, skillList[0]!.key);

  // Result delivered back on the same connection and acked.
  await tick();
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    jobId: "job:evt:1:test-package/friendliness",
    eventId: "evt:1",
    skillKey: "test-package/friendliness",
    skillRevision: "rev-0",
    status: "done",
    decision: "clear",
  });
});

test("a runtime failure reports unavailable, never clear", async () => {
  const { a, b, fake, results, skillList } = setup();
  const protocol = createSkillsProtocol({
    log,
    host: { ...fake.host, submit: () => Promise.resolve({ status: "timed-out", reason: "deadline exceeded" }) } as unknown as SkillsHost,
    registry: { get: () => skillList[0] } as unknown as SkillsRegistry,
    planner: new SkillsPlanner([skillList[0]!]),
    grants: () => new Map([[skillList[0]!.key, { enabled: true, revision: skillList[0]!.revision, capabilities: ["context.read"] }]]),
    endpoint: a.transport,
  });
  b.transport.onRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.skills_result) results.push(params as SkillsResultParams);
    b.transport.respond(id, method === X_PI_BROWSER.skills_context ? { contextRef: "r", context: { draft: "x" }, bytes: 3 } : { ok: true });
  };
  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      protocol.handle(method, params, resolve, (code, message) => reject(new Error(`${code}: ${message}`)));
    });
  await call(X_PI_BROWSER.skills_plan, planParams);
  const ack = (await call(X_PI_BROWSER.skills_event, { event: event(1) })) as SkillsEventResult;
  assert.equal(ack.status, "accepted");
  await tick();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, "unavailable");
  assert.equal(results[0]!.reason, "deadline exceeded");
  assert.equal(results[0]!.decision, undefined);
});

test("context resolution failure acks unavailable; no job is launched", async () => {
  const { call, fake } = setup({ contextOk: false });
  await call(X_PI_BROWSER.skills_plan, planParams);
  const ack = (await call(X_PI_BROWSER.skills_event, { event: event(1) })) as SkillsEventResult;
  assert.equal(ack.status, "unavailable");
  assert.match(ack.reason ?? "", /context unavailable/);
  assert.equal(fake.submissions.length, 0);
});

test("cancel targets one interaction's jobs; status and dispose are bounded", async () => {
  const { call, protocol, fake } = setup();
  await call(X_PI_BROWSER.skills_plan, planParams);
  const ack = (await call(X_PI_BROWSER.skills_event, { event: event(1) })) as SkillsEventResult;
  assert.equal(ack.jobs?.length, 2);

  const other = (await call(X_PI_BROWSER.skills_cancel, { interactionId: "nobody" })) as SkillsCancelResult;
  assert.equal(other.cancelled, 0);

  const cancelled = (await call(X_PI_BROWSER.skills_cancel, { interactionId: "composer-7" })) as SkillsCancelResult;
  assert.equal(cancelled.cancelled, 2);
  assert.deepEqual(fake.cancellations.sort(), [
    "test-package/constructive-reply:composer-7:0",
    "test-package/friendliness:composer-7:0",
  ]);

  const status = (await call(X_PI_BROWSER.skills_status)) as SkillsStatusResult;
  assert.equal(status.available, true);
  assert.equal(status.plans, 1);
  assert.equal(status.armedRules, 2);

  // A second event after cancel re-arms and is cancellable again.
  const rearm = (await call(X_PI_BROWSER.skills_event, { event: event(1) })) as SkillsEventResult;
  assert.equal(rearm.status, "accepted");
  protocol.dispose();
  assert.equal(protocol.plans().count, 0);
  assert.ok(fake.cancellations.length >= 4, "dispose cancels the client's in-flight jobs");
});

test("unknown methods are not claimed; malformed params fail with a protocol error", async () => {
  const { call } = setup();
  await assert.rejects(call("x-pi-browser/other", {}), /METHOD_NOT_FOUND/);
  await assert.rejects(call(X_PI_BROWSER.skills_event, { event: { version: 2 } }), /skills:/);
});
