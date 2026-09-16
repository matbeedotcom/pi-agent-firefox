import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivationHistory } from "../src/skills/activation-history.js";

const base = { skillKey: "p/s1", skillRevision: "v1", eventId: "e1" };

test("records are bounded, newest-first, and note-clamped", () => {
  const history = new ActivationHistory();
  for (let i = 0; i < 600; i++) history.record({ ...base, eventId: `e${i}`, outcome: "clear" }, i);
  assert.equal(history.size, 512);
  const snapshot = history.snapshot();
  assert.equal(snapshot.length, 100);
  assert.equal(snapshot[0].eventId, "e599");
  history.record({ ...base, outcome: "unavailable", note: "x".repeat(900) }, 1000);
  const record = history.snapshot(1)[0];
  assert.equal(record.note, "x".repeat(512));
});

test("summarizes by outcome and per-skill applied/bypassed", () => {
  const history = new ActivationHistory();
  history.record({ ...base, outcome: "suggest" }, 1);
  history.record({ ...base, outcome: "applied" }, 2);
  history.record({ ...base, outcome: "clear" }, 3);
  history.record({ skillKey: "p/s2", skillRevision: "v9", eventId: "e2", outcome: "bypassed", note: "host down" }, 4);
  const summary = history.summarize();
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byOutcome, { clear: 1, suggest: 1, abstain: 0, unavailable: 0, applied: 1, bypassed: 1 });
  assert.deepEqual(summary.bySkill, [
    { skillKey: "p/s1", count: 3, applied: 1, bypassed: 0 },
    { skillKey: "p/s2", count: 1, applied: 0, bypassed: 1 },
  ]);
});

test("clear empties the history", () => {
  const history = new ActivationHistory();
  history.record({ ...base, outcome: "clear" }, 1);
  history.clear();
  assert.equal(history.size, 0);
  assert.equal(history.summarize().total, 0);
});
