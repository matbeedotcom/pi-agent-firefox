import test from "node:test";
import assert from "node:assert/strict";
import { SkillsService, type SkillJobKind, type SkillJobRequest } from "../src/skills/skills-service.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not reached in time");
    await new Promise((settle) => setTimeout(settle, 2));
  }
}

function job(key: string, kind: SkillJobKind, run: SkillJobRequest["run"], timeoutMs = 2000): SkillJobRequest {
  return { key, kind, timeoutMs, run };
}

test("priority order with FIFO within class; limits are validated", () => {
  for (const bad of [{ maxConcurrent: 0 }, { maxQueued: 0 }, { agingMs: 0 }]) {
    assert.throws(() => new SkillsService(bad));
  }
});

test("admission: gate before active before speculative before passive, FIFO within class", async () => {
  const service = new SkillsService({ maxConcurrent: 1 });
  const order: string[] = [];
  const blocker = deferred<string>();
  const outcomes = [service.submit(job("blocker", "active", () => blocker.promise, 2000))];
  await waitFor(() => service.stats.running === 1);
  const names = ["passive-1", "spec-1", "active-1", "gate-1", "passive-2"] as const;
  const kinds: SkillJobKind[] = ["passive", "speculative", "active", "gate", "passive"];
  names.forEach((name, index) =>
    outcomes.push(service.submit(job(`k-${index}`, kinds[index]!, (signal) => {
      order.push(name);
      return Promise.resolve(name);
    }, 2000))),
  );
  blocker.resolve("done");
  const results = await Promise.all(outcomes);
  assert.deepEqual(order, ["gate-1", "active-1", "spec-1", "passive-1", "passive-2"]);
  assert.ok(results.every((outcome) => outcome.status === "done"));
  await service.close();
});

test("global concurrency is bounded at the configured limit", async () => {
  const service = new SkillsService({ maxConcurrent: 2 });
  let active = 0;
  let peak = 0;
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    service.submit(job(`k-${index}`, "speculative", () => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<unknown>((settle) => setTimeout(() => { active -= 1; settle(undefined); }, 20));
    }, 1000)),
  ));
  assert.equal(peak, 2);
  assert.ok(outcomes.every((outcome) => outcome.status === "done"));
  await service.close();
});

test("per-key coalescing: one pending job per key; superseded jobs never run", async () => {
  const service = new SkillsService({ maxConcurrent: 1 });
  const order: string[] = [];
  // Running key: newer submits supersede the running job (and each other).
  const first = deferred<string>();
  const o1 = service.submit(job("k", "gate", (signal) => {
    signal.addEventListener("abort", () => first.resolve("aborted"));
    return first.promise;
  }, 2000));
  await waitFor(() => service.stats.running === 1);
  const o2 = service.submit(job("k", "gate", () => { order.push("second"); return Promise.resolve("second"); }, 2000));
  const o3 = service.submit(job("k", "gate", () => { order.push("third"); return Promise.resolve("third"); }, 2000));
  const [r1, r2, r3] = await Promise.all([o1, o2, o3]);
  assert.equal(r1.status, "superseded");
  assert.equal(r2.status, "superseded");
  assert.deepEqual(r3, { status: "done", value: "third" });
  assert.deepEqual(order, ["third"], "superseded jobs never invoke their worker");

  // Queued key: a newer submit replaces the queued job in place.
  const blocker = deferred<string>();
  void service.submit(job("blocker", "gate", () => blocker.promise, 2000));
  await waitFor(() => service.stats.running === 1);
  const q1 = service.submit(job("q", "passive", () => Promise.resolve("q1"), 2000));
  const q2 = service.submit(job("q", "passive", () => { order.push("q2"); return Promise.resolve("q2"); }, 2000));
  blocker.resolve("done");
  const [s1, s2] = await Promise.all([q1, q2]);
  assert.equal(s1.status, "superseded");
  assert.deepEqual(s2, { status: "done", value: "q2" });
  assert.deepEqual(order, ["third", "q2"]);
  await service.close();
});

test("deadline aborts the worker and settles timed-out; the slot is released", async () => {
  const service = new SkillsService({ maxConcurrent: 1 });
  const order: string[] = [];
  let aborted = false;
  const o1 = service.submit(job("slow", "speculative", (signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise<void>(() => {});
  }, 40));
  const o2 = service.submit(job("next", "gate", () => { order.push("next"); return Promise.resolve("next"); }, 1000));
  const [r1, r2] = await Promise.all([o1, o2]);
  assert.equal(r1.status, "timed-out");
  assert.equal(aborted, true);
  assert.equal(r2.value, "next");
  assert.deepEqual(order, ["next"]);
  await service.close();
});

test("saturation: required work displaces speculative first; nothing evictable means unavailable", async () => {
  const service = new SkillsService({ maxConcurrent: 1, maxQueued: 2 });
  const order: string[] = [];
  const blocker = deferred<string>();
  void service.submit(job("blocker", "gate", () => blocker.promise, 2000));
  await waitFor(() => service.stats.running === 1);
  const r1 = service.submit(job("p1", "passive", () => { order.push("p1"); return Promise.resolve("p1"); }, 2000));
  const r2 = service.submit(job("p2", "passive", () => { order.push("p2"); return Promise.resolve("p2"); }, 2000));
  const r3 = await service.submit(job("s1", "speculative", () => Promise.resolve("s1"), 2000));
  assert.equal(r3.status, "unavailable", "saturated queue rejects speculative work");
  const r4 = service.submit(job("g1", "gate", () => { order.push("g1"); return Promise.resolve("g1"); }, 2000));
  blocker.resolve("done");
  const [rr1, rr2, rr4] = await Promise.all([r1, r2, r4]);
  assert.equal(rr1.status, "unavailable", "oldest evictable job displaced");
  assert.match(rr1.reason ?? "", /displaced/);
  assert.equal(rr2.status, "done");
  assert.equal(rr4.status, "done");
  assert.deepEqual(order, ["g1", "p2"], "gate runs before the remaining passive");
  await service.close();
});

test("aging promotes a long-waiting passive ahead of a fresh speculative", async () => {
  const service = new SkillsService({ maxConcurrent: 1, agingMs: 20 });
  const order: string[] = [];
  const blocker = deferred<string>();
  void service.submit(job("blocker", "gate", () => blocker.promise, 2000));
  await waitFor(() => service.stats.running === 1);
  void service.submit(job("p", "passive", () => { order.push("passive"); return Promise.resolve("passive"); }, 2000));
  await new Promise((settle) => setTimeout(settle, 50));
  void service.submit(job("s", "speculative", () => { order.push("spec"); return Promise.resolve("spec"); }, 2000));
  blocker.resolve("done");
  await waitFor(() => service.stats.running === 0 && service.stats.queued === 0);
  assert.deepEqual(order, ["passive", "spec"]);
  await service.close();
});

test("aging can never overtake fresh gate work", async () => {
  const service = new SkillsService({ maxConcurrent: 1, agingMs: 10 });
  const order: string[] = [];
  const blocker = deferred<string>();
  void service.submit(job("blocker", "gate", () => blocker.promise, 2000));
  await waitFor(() => service.stats.running === 1);
  void service.submit(job("p", "passive", () => { order.push("passive"); return Promise.resolve("passive"); }, 2000));
  await new Promise((settle) => setTimeout(settle, 100));
  void service.submit(job("g", "gate", () => { order.push("gate"); return Promise.resolve("gate"); }, 2000));
  blocker.resolve("done");
  await waitFor(() => service.stats.running === 0 && service.stats.queued === 0);
  assert.deepEqual(order, ["gate", "passive"]);
  await service.close();
});

test("cancel aborts running and queued jobs and never relaunches work", async () => {
  const service = new SkillsService({ maxConcurrent: 1 });
  const started: string[] = [];
  const blocker = deferred<string>();
  const oRun = service.submit(job("run", "gate", (signal) => {
    started.push("run");
    signal.addEventListener("abort", () => blocker.resolve("aborted"));
    return blocker.promise;
  }, 2000));
  await waitFor(() => service.stats.running === 1);
  const oQueue = service.submit(job("que", "passive", () => { started.push("que"); return Promise.resolve("que"); }, 2000));
  assert.equal(service.cancel("run"), 1);
  assert.equal(service.cancel("que"), 1);
  assert.equal(service.cancel("missing"), 0);
  const [a, b] = await Promise.all([oRun, oQueue]);
  assert.equal(a.status, "aborted");
  assert.equal(b.status, "aborted");
  assert.deepEqual(started, ["run"], "cancelled queued job never starts");
  await service.close();
});

test("failed runs settle failed with the error and release the slot", async () => {
  const service = new SkillsService({ maxConcurrent: 1 });
  const o1 = service.submit(job("f", "speculative", async () => { throw new Error("boom"); }, 1000));
  const o2 = service.submit(job("n", "gate", () => Promise.resolve("n"), 1000));
  const [a, b] = await Promise.all([o1, o2]);
  assert.equal(a.status, "failed");
  assert.match(a.error?.message ?? "", /boom/);
  assert.equal(b.value, "n");
  await service.close();
});

test("close aborts all pending work and resolves once everything settled", async () => {
  const service = new SkillsService({ maxConcurrent: 1 });
  const blocker = deferred<string>();
  const o1 = service.submit(job("a", "gate", () => blocker.promise, 5000));
  await waitFor(() => service.stats.running === 1);
  const o2 = service.submit(job("b", "passive", () => new Promise<void>(() => {}), 5000));
  await service.close();
  const [a, b] = await Promise.all([o1, o2]);
  assert.equal(a.status, "aborted");
  assert.equal(b.status, "aborted");
  assert.equal(service.stats.closed, true);
  const after = await service.submit(job("c", "gate", () => Promise.resolve("c"), 1000));
  assert.equal(after.status, "unavailable", "submit after close is unavailable");
});
