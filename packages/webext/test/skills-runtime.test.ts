/**
 * Skills runtime tests (skills-runtime-design.md §2, §7, §8, §13).
 *
 * Verifies the glue between the coordinator transport and the per-document
 * submission gates: the gate's opaque eventId travels to the host as the
 * transport eventId; host jobIds are mapped back by skillKey so
 * skills_result deliveries reach the right ticket; rejected events degrade
 * to a usable local bypass; reconnects and tab removals reset state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  X_PI_BROWSER,
  type PagePlan,
  type SkillEvent,
  type SkillsEventResult,
  type SkillsPlanResult,
  type SkillsResultParams,
} from "@trusted-ua/protocol";
import { SkillsRuntime, type DocumentIdentity } from "../src/skills/skills-runtime.js";
import type { GateIdentity } from "../src/skills/submission-gate.js";

type ArmIdentity = Omit<GateIdentity, "planVersion">;

const doc: DocumentIdentity = {
  application: "firefox",
  tabId: 7,
  frameId: 0,
  documentGeneration: "doc-1",
  url: "https://example.com/thread",
};

const plan: PagePlan = {
  planId: "plan-1",
  planVersion: 1,
  documentGeneration: "doc-1",
  expiresAt: Date.now() + 60_000,
  rules: [
    { skillKey: "p/friendliness", skillRevision: "v1", packageId: "p", world: "isolated", targets: {},
      events: { "before-submit": { kind: "gate" as const, chainId: "c1", alternatives: [[{ dom: "click" as const, target: "submit" }]] } },
      subscriptions: [{ event: "before-submit" }], mode: "review-before-submit", capabilities: ["context.read"] },
    { skillKey: "p/tone", skillRevision: "v2", packageId: "p", world: "isolated", targets: {},
      events: { "before-submit": { kind: "gate" as const, chainId: "c1", alternatives: [[{ dom: "click" as const, target: "submit" }]] } },
      subscriptions: [{ event: "before-submit" }], mode: "review-before-submit", capabilities: ["context.read"] },
  ],
  unavailable: [],
};

const identity = (draft = "Nice post!"): ArmIdentity => ({
  documentGeneration: "doc-1",
  frameId: 0,
  interactionId: "composer-7",
  replyTarget: "post-1",
  draft,
  contextRevision: 1,
  reviewers: [
    { key: "p/friendliness", revision: "v1", memoryRevision: 1 },
    { key: "p/tone", revision: "v2", memoryRevision: 0 },
  ],
});

const fullIdentity = (draft = "Nice post!", planVersion = 1): GateIdentity => ({ ...identity(draft), planVersion });

interface FakeHostOptions {
  eventAck?: SkillsEventResult;
}

function setup(options: FakeHostOptions = {}) {
  const events: SkillEvent[] = [];
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (method === X_PI_BROWSER.skills_plan) {
      return Promise.resolve({ status: "ok", plan } satisfies SkillsPlanResult);
    }
    if (method === X_PI_BROWSER.skills_event) {
      const event = (params as { event: SkillEvent }).event;
      events.push(event);
      const ack = options.eventAck ?? {
        status: "accepted",
        jobs: plan.rules
          .filter((r) => r.subscriptions.some((s) => `${r.packageId}:${s.event}` === event.event))
          .map((r) => ({ jobId: `job:${event.eventId}:${r.skillKey}`, skillKey: r.skillKey, key: `${r.skillKey}:composer-7:0` })),
      } satisfies SkillsEventResult;
      return Promise.resolve(ack);
    }
    return Promise.reject(new Error(`unexpected host request: ${method}`));
  };
  const runtime = new SkillsRuntime({ application: "firefox", request: request as never });
  /** Host→client delivery (skills_result / skills_context). */
  const hostDelivers = (method: string, params: unknown): unknown => runtime.handleHostRequest(method, params);
  return { runtime, events, hostDelivers };
}

/** Deliver one host job outcome using the HOST's jobId format. */
function deliver(hostDelivers: (m: string, p: unknown) => unknown, jobId: string, event: { eventId: string; skillKey: string; skillRevision: string }, params: Partial<SkillsResultParams>): unknown {
  return hostDelivers(X_PI_BROWSER.skills_result, {
    jobId,
    eventId: event.eventId,
    skillKey: event.skillKey,
    skillRevision: event.skillRevision,
    status: "done",
    ...params,
  });
}

test("arm sends ONE transport event carrying the gate eventId; host jobs map to tickets; two clears release the gesture", async () => {
  const { runtime, events, hostDelivers } = setup();
  const { tickets, jobs } = await runtime.arm({ document: doc, event: "p:before-submit", identity: identity(), plan, snapshot: { draft: "Nice post!" } });
  assert.equal(tickets.length, 2);
  assert.equal(jobs.length, 2);
  assert.equal(events.length, 1);

  // The transport event carries the GATE's opaque eventId (echo contract).
  assert.equal(events[0]!.eventId, tickets[0]!.eventId);
  assert.equal(events[0]!.planVersion, 1);
  assert.ok(events[0]!.contextRef.startsWith("snap:"));

  // Host jobIds differ from gate ticket jobIds; delivery maps by skillKey.
  assert.notEqual(jobs[0]!.jobId, tickets[0]!.jobId);
  deliver(hostDelivers, jobs[0]!.jobId, tickets[0]!, { decision: "clear" });
  assert.equal(runtime.view(doc)?.state, "reviewing");
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "click" }), "hold");
  deliver(hostDelivers, jobs[1]!.jobId, tickets[1]!, { decision: "clear" });
  assert.equal(runtime.view(doc)?.state, "clear");
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "click" }), "allow");
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "submit" }), "allow");

  // Redelivered results drop (mapping consumed) and never re-enter the gate.
  deliver(hostDelivers, jobs[0]!.jobId, tickets[0]!, { decision: "clear" });
  assert.equal(runtime.view(doc)?.state, "dirty");
});

test("suggestion holds and syncs the card; unavailable delivery leaves a usable bypass", async () => {
  const states: { state?: string }[] = [];
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (method === X_PI_BROWSER.skills_plan) return Promise.resolve({ status: "ok", plan });
    if (method === X_PI_BROWSER.skills_event) {
      const event = (params as { event: SkillEvent }).event;
      return Promise.resolve({ status: "accepted", jobs: [{ jobId: `job:${event.eventId}:p/friendliness`, skillKey: "p/friendliness", key: "k" }] });
    }
    return Promise.reject(new Error(method));
  };
  const runtime = new SkillsRuntime({ application: "firefox", request: request as never, onCardState: (_d, _v, _e) => states.push(_v) });
  const deliverHere = (m: string, p: unknown): unknown => runtime.handleHostRequest(m, p);

  const first = await runtime.arm({ document: doc, event: "p:before-submit", identity: identity(), plan });
  deliver(deliverHere, first.jobs[0]!.jobId, first.tickets[0]!, { decision: "suggest", explanation: "too formal", replacementText: "hey!" });
  const view = runtime.view(doc)!;
  assert.equal(view.state, "suggestion");
  assert.equal(view.suggestions.length, 1);
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "click" }), "hold");
  assert.ok(states.some((s) => s.state === "suggestion"));

  // Runtime failure on a fresh arm (host job crashed): local bypass stays usable.
  // New contextRevision: the same interaction at the old revision is a redelivery (deduped).
  const second = await runtime.arm({ document: doc, event: "p:before-submit", identity: { ...identity("edited"), contextRevision: 2 }, plan });
  const ack = runtime.handleHostRequest(X_PI_BROWSER.skills_result, {
    jobId: second.jobs[0]!.jobId, eventId: second.tickets[0]!.eventId, skillKey: "p/friendliness", skillRevision: "v1",
    status: "unavailable", reason: "host down",
  });
  assert.deepEqual(ack, { delivered: true });
  assert.equal(runtime.view(doc)?.state, "unavailable");
  assert.ok(runtime.authorize(doc));
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "click" }), "allow");
  assert.equal(runtime.history.summarize().byOutcome.unavailable, 1);
});

test("rejected event degrades the gate to a usable bypass (no false protection)", async () => {
  const { runtime } = setup({ eventAck: { status: "no-match" } });
  await runtime.arm({ document: doc, event: "p:before-submit", identity: identity(), plan });
  assert.equal(runtime.view(doc)?.state, "unavailable");
  assert.ok(runtime.authorize(doc));
  assert.equal(runtime.view(doc)?.state, "authorized");
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "click" }), "allow");
  assert.equal(runtime.history.summarize().byOutcome.unavailable, 0); // no "unavailable" RESULT was delivered; the gate degraded locally
});

test("editing during review drops stale results (acceptance check)", async () => {
  const { runtime, hostDelivers } = setup();
  const { tickets, jobs } = await runtime.arm({ document: doc, event: "p:before-submit", identity: identity("original"), plan });
  runtime.draftChanged(doc, "p:before-submit", fullIdentity("edited"));
  assert.equal(runtime.view(doc)?.state, "dirty");
  deliver(hostDelivers, jobs[0]!.jobId, tickets[0]!, { decision: "clear" });
  // The gate rejects the stale ticket; nothing is recorded.
  assert.equal(runtime.view(doc)?.state, "dirty");
  assert.equal(runtime.history.size, 0);
});

test("new connection epoch resets sessions and job mappings", async () => {
  const { runtime, hostDelivers } = setup();
  const { tickets, jobs } = await runtime.arm({ document: doc, event: "p:before-submit", identity: identity(), plan });
  runtime.noteConnection();
  assert.equal(runtime.view(doc), undefined);
  deliver(hostDelivers, jobs[0]!.jobId, tickets[0]!, { decision: "clear" });
  // Dropped: no session to route to.
});

test("closeDocument drops the gate and its snapshots; closeTab covers unknown generations", async () => {
  const { runtime, events, hostDelivers } = setup();
  const { tickets, jobs } = await runtime.arm({ document: doc, event: "p:before-submit", identity: identity(), plan, snapshot: { draft: "x" } });
  const ref = events[0]!.contextRef;
  runtime.closeDocument(doc);
  assert.equal(runtime.view(doc), undefined);
  assert.throws(
    () => hostDelivers(X_PI_BROWSER.skills_context, { contextRef: ref, interactionId: "composer-7", planVersion: 1, fields: ["draft"], maxBytes: 32_768 }),
    /unknown contextRef/,
  );
  deliver(hostDelivers, jobs[0]!.jobId, tickets[0]!, { decision: "clear" });

  // Tab removal with a generation the background does not track.
  const other = { ...doc, documentGeneration: "doc-2" };
  await runtime.arm({ document: other, event: "p:before-submit", identity: { ...identity(), documentGeneration: "doc-2" }, plan });
  assert.notEqual(runtime.view(other), undefined);
  runtime.closeTab(7);
  assert.equal(runtime.view(other), undefined);
});

test("speculative arm lands in the rule's GATE session (card shows review before first submit)", async () => {
  const specPlan: PagePlan = {
    planId: "plan-spec",
    planVersion: 1,
    documentGeneration: "doc-1",
    expiresAt: Date.now() + 60_000,
    rules: [
      { skillKey: "p/friendliness", skillRevision: "v1", packageId: "p", world: "isolated", targets: {},
        events: {
          "draft.paused": { kind: "debounced" as const, debounceMs: 800 },
          "before-submit": { kind: "gate" as const, chainId: "c1", alternatives: [[{ dom: "click" as const, target: "submit" }]] },
        },
        subscriptions: [{ event: "draft.paused" }, { event: "before-submit" }],
        mode: "review-before-submit", capabilities: ["context.read"] },
    ],
    unavailable: [],
  };
  const events: SkillEvent[] = [];
  const card: { event?: string; state?: string }[] = [];
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (method === X_PI_BROWSER.skills_plan) return Promise.resolve({ status: "ok", plan: specPlan });
    if (method === X_PI_BROWSER.skills_event) {
      const event = (params as { event: SkillEvent }).event;
      events.push(event);
      return Promise.resolve({ status: "accepted", jobs: [{ jobId: `job:${event.eventId}:p/friendliness`, skillKey: "p/friendliness", key: "k" }] });
    }
    return Promise.reject(new Error(method));
  };
  const runtime = new SkillsRuntime({
    application: "firefox",
    request: request as never,
    onCardState: (_d, v, e) => card.push({ event: e, state: v.state }),
  });
  const deliverHere = (m: string, p: unknown): unknown => runtime.handleHostRequest(m, p);
  // Single reviewer — the plan carries one rule (the module-level
  // identity() names the two-rule plan's reviewers and would leave a
  // second ticket unfulfilled).
  const id = (draft: string, contextRevision: number): ArmIdentity => ({
    documentGeneration: "doc-1", frameId: 0, interactionId: "composer-7", replyTarget: "post-1",
    draft, contextRevision, reviewers: [{ key: "p/friendliness", revision: "v1", memoryRevision: 1 }],
  });

  // Speculative arm (draft paused): the transport keeps the armed event
  // (host schedules the speculative job)...
  const { tickets, jobs } = await runtime.arm({ document: doc, event: "p:draft.paused", identity: id("Nice post!", 1), plan: specPlan, snapshot: { draft: "Nice post!" } });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "p:draft.paused");
  // ...while the card syncs the GATE event — the session submit consults.
  assert.ok(card.length > 0);
  assert.ok(card.every((c) => c.event === "p:before-submit"));

  deliver(deliverHere, jobs[0]!.jobId, tickets[0]!, { decision: "suggest", explanation: "tone", replacementText: "hey!" });
  assert.equal(runtime.view(doc)?.state, "suggestion");
  // The gate event consults the SAME session the speculative review filled.
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "click" }), "hold");
  assert.ok(runtime.authorize(doc, "p:before-submit"));
  assert.equal(runtime.gesture(doc, "p:before-submit", { chainId: "c1", phase: "click" }), "allow");

  // A later gate arm reuses the session (card keeps the gate event).
  const second = await runtime.arm({ document: doc, event: "p:before-submit", identity: id("edited", 2), plan: specPlan });
  assert.ok(card.every((c) => c.event === "p:before-submit"));
  deliver(deliverHere, second.jobs[0]!.jobId, second.tickets[0]!, { decision: "clear" });
  assert.equal(runtime.view(doc)?.state, "clear");
});

test("context resolution stays privacy-by-request through the runtime", async () => {
  const { runtime, events, hostDelivers } = setup();
  await runtime.arm({ document: doc, event: "p:before-submit", identity: identity(), plan, snapshot: { draft: "d", secret: "no" } });
  const resolved = hostDelivers(X_PI_BROWSER.skills_context, {
    contextRef: events[0]!.contextRef, interactionId: "composer-7", planVersion: 1, fields: ["draft"], maxBytes: 32_768,
  }) as { context: Record<string, unknown> };
  assert.equal(resolved.context.draft, "d");
  assert.equal(Object.keys(resolved.context).length, 1);
});
