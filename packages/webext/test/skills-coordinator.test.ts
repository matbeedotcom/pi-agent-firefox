/**
 * Addon skills coordinator tests (skills-runtime-design.md §2, §7, §13).
 *
 * Verifies the coordinator's identity rules: source identity is stamped by
 * the coordinator (never a page payload), snapshots are bounded per
 * document, contextRef resolution is privacy-by-request, redelivery is
 * deduplicated, and a new connection epoch invalidates everything stale.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  X_PI_BROWSER,
  type SkillEventSource,
  type SkillsContextRequestParams,
  type SkillsContextResult,
  type SkillsEventResult,
  type SkillsPlanResult,
  type SkillsResultParams,
} from "@pi-browser/protocol";
import { SkillsCoordinator, type DocumentIdentity } from "../src/skills/coordinator.js";

const doc: DocumentIdentity = {
  application: "firefox",
  tabId: 7,
  frameId: 0,
  documentGeneration: "doc-1",
  url: "https://example.com/thread",
};

interface Recorded {
  method: string;
  params: unknown;
}

function setup(options: { onResult?: (params: SkillsResultParams) => void } = {}) {
  const recorded: Recorded[] = [];
  const fakeRequest = (method: string, params?: unknown): Promise<unknown> => {
    recorded.push({ method, params });
    if (method === X_PI_BROWSER.skills_plan) {
      return Promise.resolve({
        status: "ok",
        plan: {
          planId: "plan-1", planVersion: 1, documentGeneration: "doc-1", expiresAt: Date.now() + 60_000,
          rules: [{ skillKey: "p/s", skillRevision: "v1", packageId: "p", world: "isolated", targets: {},
            events: { "before-submit": { kind: "gate" as const, chainId: "c1", alternatives: [[{ dom: "click" as const, target: "submit" }]] } },
            subscriptions: [{ event: "before-submit" }], mode: "advisory", capabilities: ["context.read"] }],
          unavailable: [],
        },
      } satisfies SkillsPlanResult);
    }
    return Promise.resolve({ status: "accepted", jobs: [{ jobId: "job:1", skillKey: "p/s", key: "p/s:composer:0" }] } satisfies SkillsEventResult);
  };
  const coordinator = new SkillsCoordinator({
    application: "firefox",
    request: fakeRequest as <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>,
    ...(options.onResult ? { onResult: options.onResult } : {}),
  });
  return { coordinator, recorded };
}

test("plan requests carry coordinator-stamped identity, never page claims", async () => {
  const { coordinator, recorded } = setup();
  const epoch = coordinator.connectionEpoch;
  const result = await coordinator.plan(doc);
  assert.equal(result.status, "ok");
  assert.equal(result.plan?.planVersion, 1);

  const request = recorded[0]!.params as { source: SkillEventSource; url: string };
  assert.equal(request.source.application, "firefox");
  assert.equal(request.source.connectionEpoch, epoch);
  assert.equal(request.source.tabId, 7);
  assert.equal(request.source.frameId, 0);
  assert.equal(request.source.documentGeneration, "doc-1");
  assert.equal(request.url, doc.url);
});

test("events are stamped, snapshots are stored, contextRef resolution is privacy-by-request", async () => {
  const { coordinator, recorded } = setup();
  await coordinator.plan(doc);
  const ack = await coordinator.submitEvent({
    document: doc,
    event: "p:before-submit",
    interactionId: "composer-7",
    planVersion: 1,
    contextRevision: 3,
    draftRevision: 0,
    origin: "user",
    snapshot: { draft: "Nice post!", replyTarget: "post-1", secretPageState: "must-not-leave" },
  });
  assert.equal(ack.status, "accepted");

  const eventRequest = recorded[1]!.params as { event: { contextRef: string; source: SkillEventSource; planVersion: number } };
  assert.ok(eventRequest.event.contextRef.startsWith("snap:"));
  assert.equal(eventRequest.event.source.connectionEpoch, coordinator.connectionEpoch);
  assert.equal(eventRequest.event.planVersion, 1);

  // Host asks for a subset of fields: only those may leave the addon.
  const hostRequest: SkillsContextRequestParams = {
    contextRef: eventRequest.event.contextRef,
    interactionId: "composer-7",
    planVersion: 1,
    fields: ["draft"],
    maxBytes: 32_768,
  };
  const resolved = coordinator.handleHostRequest(X_PI_BROWSER.skills_context, hostRequest) as SkillsContextResult;
  const context = resolved.context as Record<string, unknown>;
  assert.equal(context.draft, "Nice post!");
  assert.equal(Object.keys(context).length, 1);
  assert.equal(context.replyTarget, undefined);
  assert.equal(context.secretPageState, undefined);

  // Unknown refs are rejected (stale snapshots after navigation/reconnect).
  assert.throws(
    () => coordinator.handleHostRequest(X_PI_BROWSER.skills_context, { ...hostRequest, contextRef: "snap:gone" }),
    /unknown contextRef/,
  );
});

test("redelivered events dedupe without resubmitting", async () => {
  const { coordinator, recorded } = setup();
  const input = {
    document: doc,
    event: "p:before-submit" as const,
    interactionId: "composer-7",
    planVersion: 1,
    contextRevision: 3,
    origin: "user" as const,
    snapshot: { draft: "x" },
  };
  const first = await coordinator.submitEvent(input);
  assert.equal(first.status, "accepted");
  const second = await coordinator.submitEvent(input);
  assert.equal(second.status, "duplicate");
  assert.equal(recorded.filter((r) => r.method === X_PI_BROWSER.skills_event).length, 1);
  // A new draft revision is a new identity, not a duplicate.
  const third = await coordinator.submitEvent({ ...input, draftRevision: 1, contextRevision: 4 });
  assert.equal(third.status, "accepted");
});

test("snapshot store is bounded per document (4 snapshots / 256 KiB)", async () => {
  const { coordinator } = setup();
  const base = {
    document: doc,
    event: "p:before-submit" as const,
    planVersion: 1,
    contextRevision: 0,
    origin: "user" as const,
    snapshot: { draft: "d" },
  };
  for (let i = 0; i < 4; i++) {
    const ack = await coordinator.submitEvent({ ...base, interactionId: `composer-${i}` });
    assert.equal(ack.status, "accepted");
  }
  const fifth = await coordinator.submitEvent({ ...base, interactionId: "composer-4" });
  assert.equal(fifth.status, "unavailable");
  assert.match(fifth.reason ?? "", /snapshot store full/);

  // A different document has its own budget.
  const other = await coordinator.submitEvent({ ...base, document: { ...doc, tabId: 8 }, interactionId: "composer-0" });
  assert.equal(other.status, "accepted");
});

test("job outcomes route to onResult and ack delivery", () => {
  const seen: SkillsResultParams[] = [];
  const { coordinator } = setup({ onResult: (p) => seen.push(p) });
  const params: SkillsResultParams = {
    jobId: "job:1", eventId: "evt:1", skillKey: "p/s", skillRevision: "v1",
    status: "done", decision: "suggest", replacementText: "A kinder reply",
  };
  const ack = coordinator.handleHostRequest(X_PI_BROWSER.skills_result, params) as { delivered: boolean };
  assert.deepEqual(ack, { delivered: true });
  assert.deepEqual(seen, [params]);

  // Semantic results only: an unavailable outcome carries no decision.
  assert.throws(
    () => coordinator.handleHostRequest(X_PI_BROWSER.skills_result, { ...params, status: "unavailable", decision: "clear", reason: "boom" }),
    /no decision/,
  );
  // Unknown methods answer METHOD_NOT_FOUND (the client sends -32601).
  assert.equal(coordinator.handleHostRequest("x-pi-browser/other", {}), undefined);
});

test("a new connection epoch invalidates snapshots, plans, and dedup state", async () => {
  const { coordinator, recorded } = setup();
  await coordinator.plan(doc);
  const ack = await coordinator.submitEvent({
    document: doc, event: "p:before-submit", interactionId: "composer-7",
    planVersion: 1, contextRevision: 3, origin: "user", snapshot: { draft: "x" },
  });
  assert.equal(ack.status, "accepted");
  const oldRef = (recorded[1]!.params as { event: { contextRef: string } }).event.contextRef;

  coordinator.noteConnection();
  const newRef = (await coordinator.submitEvent({
    document: doc, event: "p:before-submit", interactionId: "composer-7",
    planVersion: 1, contextRevision: 3, origin: "user", snapshot: { draft: "x" },
  }));
  // Same logical event, fresh epoch: NOT a duplicate.
  assert.equal(newRef.status, "accepted");
  assert.throws(
    () =>
      coordinator.handleHostRequest(X_PI_BROWSER.skills_context, {
        contextRef: oldRef, interactionId: "composer-7", planVersion: 1, fields: ["draft"], maxBytes: 32_768,
      }),
    /unknown contextRef/,
  );
});

test("mail documents use account identity; forgetDocument drops a document's state", async () => {
  const { coordinator, recorded } = setup();
  const mail: DocumentIdentity = { application: "thunderbird", accountId: "acc-1", url: "https://mail.example.com/inbox" };
  await coordinator.plan(mail);
  const source = (recorded[0]!.params as { source: SkillEventSource }).source;
  assert.equal(source.application, "thunderbird");
  assert.equal(source.accountId, "acc-1");
  assert.equal(source.tabId, undefined);
  assert.equal(source.documentGeneration, undefined);

  await coordinator.submitEvent({
    document: doc, event: "p:before-submit", interactionId: "composer-7",
    planVersion: 1, contextRevision: 1, origin: "user", snapshot: { draft: "x" },
  });
  coordinator.forgetDocument(doc);
  assert.throws(
    () =>
      coordinator.handleHostRequest(X_PI_BROWSER.skills_context, {
        contextRef: (recorded[1]!.params as { event: { contextRef: string } }).event.contextRef,
        interactionId: "composer-7", planVersion: 1, fields: ["draft"], maxBytes: 32_768,
      }),
    /unknown contextRef/,
  );
});
