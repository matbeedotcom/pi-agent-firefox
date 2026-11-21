/**
 * Skills event log (JSONL observation channel) tests: the first record
 * creates the file, concurrent records serialize in order, and the file
 * rotates to .1 once it exceeds 1 MiB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSkillsEventLog } from "../src/native-host/skills-startup.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", stderr: { write: () => true } });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("event log: first write creates the file, order preserved, rotates at 1 MiB", async () => {
  const dir = path.join(tmpdir(), `skills-event-log-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "skills-events.jsonl");
  try {
    const eventLog = createSkillsEventLog(log, file);

    // The first record must create the file (rotation's statSync sees none).
    eventLog.record({ type: "plan", doc: "d", status: "ok", rules: 1, unavailable: [] });
    await tick(50);
    assert.ok(existsSync(file), "first record creates the file");

    const n = 50;
    for (let i = 0; i < n; i++) {
      eventLog.record({ type: "event", eventId: `e${i}`, event: "before-submit", status: "accepted", jobs: 1 });
    }
    await tick(100);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, n + 1);
    const parsed = lines.map((l) => JSON.parse(l) as { t: number; type: string; eventId?: string });
    assert.ok(parsed.every((l) => typeof l.t === "number"), "every line carries a timestamp");
    assert.equal(parsed[0]!.type, "plan");
    assert.deepEqual(
      parsed.slice(1).map((l) => l.eventId),
      Array.from({ length: n }, (_, i) => `e${i}`),
      "record order is preserved under concurrent record() calls",
    );

    // Rotation: push past 1 MiB, then verify the current file holds only the
    // post-rotation lines.
    const huge = {
      type: "plan" as const, doc: "d", status: "unavailable" as const, rules: 0,
      unavailable: Array.from({ length: 30_000 }, (_, i) => ({ skillKey: `k${i}`, reason: "padding padding padding" })),
    };
    for (let i = 0; i < 4; i++) eventLog.record(huge);
    await tick(250);
    assert.ok(existsSync(`${file}.1`), "rotation creates .1");
    eventLog.record({ type: "event", eventId: "after", event: "before-submit", status: "accepted", jobs: 1 });
    await eventLog.close();
    const tail = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { eventId?: string });
    assert.deepEqual(tail.map((l) => l.eventId), ["after"], "current file keeps only post-rotation lines");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
