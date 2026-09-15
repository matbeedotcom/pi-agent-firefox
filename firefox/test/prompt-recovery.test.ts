import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptRecovery, RECOVERY_PROMPT } from "../src/background/prompt-recovery.js";

function setup() {
  const calls: string[] = [];
  const state = { ready: false };
  const recovery = new PromptRecovery({
    ready: () => state.ready,
    restore: async (id) => { calls.push(`restore:${id}`); },
    prompt: async (id, text) => { assert.equal(text, RECOVERY_PROMPT); calls.push(`prompt:${id}`); },
    notice: () => {},
  });
  return { calls, state, recovery };
}

test("waits for reconnect, restores before nudging, and does not nudge twice", async () => {
  const { recovery, calls, state } = setup();
  recovery.begin("a"); recovery.interrupt("a");
  await recovery.resumePending();
  assert.deepEqual(calls, []);
  state.ready = true;
  await Promise.all([recovery.resumePending(), recovery.resumePending()]);
  assert.deepEqual(calls, ["restore:a", "prompt:a"]);
  assert.deepEqual(recovery.pendingSessions(), []);
  await recovery.resumePending();
  assert.equal(calls.length, 2);
});

test("Stop cancels pending recovery while disconnected", async () => {
  const { recovery, calls, state } = setup();
  recovery.begin("a"); recovery.interrupt("a"); recovery.cancel("a");
  state.ready = true;
  await recovery.resumePending();
  assert.deepEqual(calls, []);
});

test("a new user message or Stop invalidates recovery during restoration", async () => {
  for (const cancel of [false, true]) {
    let finish!: () => void;
    let prompts = 0;
    const recovery = new PromptRecovery({
      ready: () => true,
      restore: () => new Promise<void>((resolve) => { finish = resolve; }),
      prompt: async () => { prompts++; }, notice: () => {},
    });
    recovery.begin("a"); recovery.interrupt("a");
    const pending = recovery.resumePending();
    if (cancel) recovery.cancel("a"); else recovery.begin("a");
    finish(); await pending;
    assert.equal(prompts, 0);
  }
});

test("repeated interruptions are bounded and a new user prompt resets the budget", async () => {
  const { recovery, calls, state } = setup();
  state.ready = true; recovery.begin("a");
  for (let i = 0; i < 5; i++) { recovery.interrupt("a"); await recovery.resumePending(); }
  assert.equal(calls.filter((c) => c.startsWith("prompt")).length, 3);
  recovery.begin("a"); recovery.interrupt("a"); await recovery.resumePending();
  assert.equal(calls.filter((c) => c.startsWith("prompt")).length, 4);
});

test("failed restore never sends a prompt and stops retrying protocol failures", async () => {
  let prompts = 0;
  const recovery = new PromptRecovery({
    ready: () => true, restore: async () => { throw new Error("missing session"); },
    prompt: async () => { prompts++; }, notice: () => {},
  });
  recovery.begin("a"); recovery.interrupt("a"); await recovery.resumePending();
  assert.equal(prompts, 0);
  assert.deepEqual(recovery.pendingSessions(), []);
});

test("a second disconnect during an automatic prompt queues the next reconnect", async () => {
  let ready = false;
  let prompts = 0;
  const recovery = new PromptRecovery({
    ready: () => ready, restore: async () => {}, notice: () => {},
    prompt: async () => {
      prompts++;
      if (prompts === 1) {
        ready = false;
        recovery.interrupt("a");
        throw new Error("port disconnected");
      }
    },
  });
  recovery.begin("a"); recovery.interrupt("a"); ready = true;
  await recovery.resumePending();
  assert.deepEqual(recovery.pendingSessions(), ["a"]);
  assert.equal(prompts, 1);
  ready = true; await recovery.resumePending();
  assert.equal(prompts, 2);
  assert.deepEqual(recovery.pendingSessions(), []);
});
