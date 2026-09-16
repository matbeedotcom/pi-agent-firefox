import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewSession } from "../src/skills/review-session.js";
import type { GateIdentity, GateView, ReviewTicket, SubmissionGesture } from "../src/skills/submission-gate.js";
import type { SkillsResultParams } from "@pi-browser/protocol";

const identity = (draft = "hello"): GateIdentity => ({
  documentGeneration: "gen1",
  frameId: 0,
  interactionId: "int1",
  replyTarget: "composer",
  draft,
  contextRevision: 1,
  planVersion: 7,
  reviewers: [
    { key: "skill:friendliness", revision: "v1", memoryRevision: 1 },
    { key: "skill:tone", revision: "v2", memoryRevision: 0 },
  ],
});

const result = (
  ticket: ReviewTicket,
  decision: "clear" | "suggest" | "abstain",
  extra: Partial<SkillsResultParams> = {},
): SkillsResultParams => ({
  jobId: ticket.jobId,
  eventId: ticket.eventId,
  skillKey: ticket.skillKey,
  skillRevision: ticket.skillRevision,
  status: "done",
  decision,
  ...extra,
});

const gesture = (chainId: string, phase: SubmissionGesture["phase"]): SubmissionGesture => ({ chainId, phase });

test("arm dispatches one ticket per required reviewer; two clears → one clear action", () => {
  const dispatched: ReviewTicket[] = [];
  const states: GateView[] = [];
  const session = new ReviewSession({ mode: "review-before-submit", dispatch: (t) => dispatched.push(t), onState: (v) => states.push(v) });
  const tickets = session.arm(identity());
  assert.equal(tickets.length, 2);
  assert.deepEqual(dispatched.map((t) => t.jobId), tickets.map((t) => t.jobId));
  session.ingest(result(tickets[0], "clear"));
  assert.equal(session.view().state, "reviewing");
  assert.equal(session.gesture(gesture("c1", "click")), "hold");
  session.ingest(result(tickets[1], "clear"));
  assert.equal(session.view().state, "clear");
  assert.equal(session.gesture(gesture("c1", "click")), "allow");
  assert.equal(session.gesture(gesture("c1", "submit")), "allow");
  assert.equal(session.gesture(gesture("c2", "click")), "hold");
  assert.ok(states.some((v) => v.state === "clear"));
});

test("one suggestion holds; the combined view carries only suggestions; apply does not grant submit", () => {
  const states: GateView[] = [];
  const session = new ReviewSession({ mode: "review-before-submit", onState: (v) => states.push(v) });
  const tickets = session.arm(identity());
  session.ingest(result(tickets[0], "clear"));
  session.ingest(result(tickets[1], "suggest", { explanation: "too formal", replacementText: "hey!" }));
  const view = session.view();
  assert.equal(view.state, "suggestion");
  assert.equal(view.suggestions.length, 1);
  assert.equal(view.suggestions[0].skillKey, "skill:tone");
  assert.equal(session.gesture(gesture("c1", "click")), "hold");
  session.applySuggestion({ jobId: tickets[1].jobId, eventId: tickets[1].eventId, skillKey: "skill:tone", skillRevision: "v2" });
  assert.equal(session.view().state, "suggestion");
  assert.equal(session.gesture(gesture("c1", "click")), "hold");
  assert.ok(session.history.snapshot(1)[0].outcome === "applied");
  // re-arm after the host edits the draft
  const second = session.arm(identity("hey!"));
  assert.equal(second.length, 2);
});

test("abstain and job failure leave a usable local bypass", () => {
  const session = new ReviewSession({ mode: "review-before-submit" });
  let tickets = session.arm(identity());
  session.ingest(result(tickets[0], "abstain", { reason: "no context" }));
  assert.equal(session.view().state, "unavailable");
  assert.ok(session.authorize());
  assert.equal(session.view().state, "authorized");
  assert.equal(session.gesture(gesture("c1", "click")), "allow");
  assert.ok(session.history.summarize().byOutcome.bypassed === 1);

  const session2 = new ReviewSession({ mode: "review-before-submit" });
  tickets = session2.arm(identity());
  session2.ingest({ jobId: tickets[0].jobId, eventId: tickets[0].eventId, skillKey: "skill:friendliness", skillRevision: "v1", status: "unavailable", reason: "host down" });
  assert.equal(session2.view().state, "unavailable");
  assert.equal(session2.view().reason, "host down");
  assert.ok(session2.history.summarize().byOutcome.unavailable === 1);
});

test("editing during review invalidates stale results (acceptance check)", () => {
  const session = new ReviewSession({ mode: "review-before-submit" });
  const tickets = session.arm(identity("original"));
  session.draftChanged(identity("edited"));
  assert.equal(session.view().state, "dirty");
  assert.equal(session.ingest(result(tickets[0], "clear")), false);
  assert.equal(session.view().state, "dirty");
  assert.equal(session.history.size, 0);
  const fresh = session.arm(identity("edited"));
  assert.equal(fresh.length, 2);
  assert.notEqual(fresh[0].eventId, tickets[0].eventId);
});

test("disconnect loses review protection; reconnect requires a fresh arm", () => {
  const session = new ReviewSession({ mode: "review-before-submit" });
  const tickets = session.arm(identity());
  session.ingest(result(tickets[0], "clear"));
  assert.equal(session.view().state, "reviewing");
  session.setConnected(false);
  assert.equal(session.view().state, "unavailable");
  assert.ok(session.ingest(result(tickets[1], "clear")) === false);
  session.setConnected(true);
  assert.equal(session.view().state, "unavailable");
  // Reconnection requires a fresh plan + identity before any new review (design §12).
  const fresh = session.arm({ ...identity(), planVersion: 8 });
  assert.equal(fresh.length, 2);
});

test("advisory mode never holds the gesture", () => {
  const session = new ReviewSession({ mode: "advisory" });
  session.arm(identity());
  assert.equal(session.gesture(gesture("c1", "click")), "allow");
  assert.equal(session.gesture(gesture("c2", "submit")), "allow");
  // A local decision is still permitted (it just never held anything in advisory mode).
  assert.equal(session.authorize(), true);
  assert.equal(session.view().state, "authorized");
  assert.equal(session.gesture(gesture("c3", "submit")), "allow");
});

test("close stops transitions; composing blocks review", () => {
  const session = new ReviewSession({ mode: "review-before-submit" });
  session.close();
  assert.equal(session.arm(identity()).length, 0);
  assert.equal(session.view().state, "closed");

  const session2 = new ReviewSession({ mode: "review-before-submit" });
  session2.gate.update(identity());
  session2.compositionChanged(true);
  assert.equal(session2.arm(identity()).length, 0);
  session2.compositionChanged(false);
  assert.equal(session2.gate.view().state, "dirty");
});
