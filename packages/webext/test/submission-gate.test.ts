import test from "node:test";
import assert from "node:assert/strict";
import { SubmissionGate, type GateIdentity, type ReviewTicket } from "../src/skills/submission-gate.js";
import type { ReviewResult } from "@pi-browser/protocol";

function identity(): GateIdentity {
  return { documentGeneration: "doc", frameId: 0, accountId: "account", interactionId: "composer", replyTarget: "post",
    draft: "A thoughtful reply", contextRevision: 1, planVersion: 1,
    reviewers: [{ key: "p/one", revision: "v1", memoryRevision: 1 }, { key: "p/two", revision: "v1", memoryRevision: 1 }] };
}
function result(ticket: ReviewTicket, decision: ReviewResult["decision"] = "clear"): ReviewResult {
  return { jobId: ticket.jobId, eventId: ticket.eventId, skillKey: ticket.skillKey, skillRevision: ticket.skillRevision, decision };
}

test("two reviewers hold one action; clearance requires both and consumes one gesture chain", () => {
  const gate = new SubmissionGate("review-before-submit"); gate.update(identity());
  assert.equal(gate.submit({ chainId: "first", phase: "click" }), "hold");
  const tickets = gate.beginReview();
  assert.equal(tickets.length, 2);
  assert.deepEqual(gate.beginReview(), []);
  gate.accept(result(tickets[0]!));
  assert.equal(gate.submit({ chainId: "second", phase: "click" }), "hold");
  gate.accept(result(tickets[1]!));
  assert.equal(gate.view().state, "clear");
  assert.equal(gate.submit({ chainId: "third", phase: "click" }), "allow");
  assert.equal(gate.submit({ chainId: "third", phase: "click" }), "duplicate");
  assert.equal(gate.submit({ chainId: "third", phase: "submit" }), "allow");
  assert.equal(gate.submit({ chainId: "third", phase: "submit" }), "duplicate");
  assert.equal(gate.submit({ chainId: "fourth", phase: "click" }), "hold");
});

test("suggestions aggregate; editing revokes results and exact-original approval", () => {
  const gate = new SubmissionGate("review-before-submit"); gate.update(identity());
  const tickets = gate.beginReview();
  gate.accept({ ...result(tickets[0]!, "suggest"), replacementText: "Try this" });
  gate.accept({ ...result(tickets[1]!, "suggest"), replacementText: "Or this" });
  assert.equal(gate.view().suggestions.length, 2);
  assert.equal(gate.authorizeOriginal(), true);
  gate.update({ ...identity(), draft: "edited" });
  assert.equal(gate.submit({ chainId: "changed", phase: "click" }), "hold");
  assert.deepEqual(gate.view().suggestions, []);
  assert.equal(gate.accept(result(tickets[0]!)), false);
});

test("all relevant identity changes revoke reviews even without input events", () => {
  const changes: Partial<GateIdentity>[] = [{ documentGeneration: "other" }, { frameId: 1 }, { accountId: "other" },
    { interactionId: "other" }, { replyTarget: "other" }, { draft: "changed programmatically" },
    { contextRevision: 2 }, { planVersion: 2 }, { reviewers: [{ key: "p/one", revision: "v2", memoryRevision: 2 }] }];
  for (const change of changes) {
    const gate = new SubmissionGate("review-before-submit"); gate.update(identity());
    const tickets = gate.beginReview();
    gate.update({ ...identity(), ...change });
    for (const ticket of tickets) assert.equal(gate.accept(result(ticket)), false);
    assert.equal(gate.view().state, "dirty");
  }
});

test("disconnect and timeout retain a local one-attempt bypass with no delayed posting", () => {
  let now = 0;
  const gate = new SubmissionGate("review-before-submit", () => now); gate.update(identity());
  const tickets = gate.beginReview();
  now = 10001;
  assert.equal(gate.view().state, "unavailable");
  assert.equal(gate.accept(result(tickets[0]!)), false);
  gate.setConnected(false);
  assert.equal(gate.authorizeOriginal(), true);
  // Merely authorizing has no submission side effect: a second real user gesture is required.
  assert.equal(gate.view().state, "authorized");
  assert.equal(gate.submit({ chainId: "user-click", phase: "keyboard" }), "allow");
  assert.equal(gate.submit({ chainId: "user-click", phase: "submit" }), "allow");
  assert.equal(gate.submit({ chainId: "another-click", phase: "submit" }), "hold");
});

test("expired bypass, IME composition and closed targets cannot release a gate", () => {
  let now = 0;
  const gate = new SubmissionGate("review-before-submit", () => now); gate.update(identity());
  gate.authorizeOriginal(); now = 15000;
  assert.equal(gate.submit({ chainId: "expired", phase: "click" }), "hold");
  gate.setComposition(true);
  assert.deepEqual(gate.beginReview(), []);
  assert.equal(gate.authorizeOriginal(), false);
  gate.setComposition(false);
  const tickets = gate.beginReview();
  gate.close();
  assert.equal(gate.accept(result(tickets[0]!)), false);
  gate.update(identity());
  assert.equal(gate.view().state, "closed");
  assert.equal(gate.authorizeOriginal(), false);
});

test("advisory never holds, while abstention and job failure never clear required reviews", () => {
  const advisory = new SubmissionGate("advisory");
  assert.equal(advisory.submit({ chainId: "user", phase: "click" }), "allow");
  const gate = new SubmissionGate("review-before-submit"); gate.update(identity());
  const tickets = gate.beginReview();
  assert.equal(gate.accept({ ...result(tickets[0]!), skillRevision: "wrong" }), false);
  assert.equal(gate.accept(result(tickets[0]!, "abstain")), true);
  assert.equal(gate.view().state, "unavailable");
  gate.update({ ...identity(), contextRevision: 2 });
  const next = gate.beginReview();
  gate.fail(next[0]!.jobId, "worker failed");
  assert.equal(gate.view().state, "unavailable");
});

test("large drafts are unreviewable without silent truncation, and bounded drafts retain bypass", () => {
  const gate = new SubmissionGate("review-before-submit");
  gate.update({ ...identity(), draft: "a".repeat(40_000) });
  assert.equal(gate.view().state, "unavailable");
  assert.deepEqual(gate.beginReview(), []);
  assert.equal(gate.authorizeOriginal(), true);
  gate.update({ ...identity(), draft: "a".repeat(300_000) });
  assert.equal(gate.view().state, "unavailable");
  assert.equal(gate.authorizeOriginal(), false);
});
