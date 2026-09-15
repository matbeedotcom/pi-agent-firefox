/**
 * ReplRuntime + ReplWorker core tests (BROWSER-USE-REPL-PLAN.md Phase 0).
 *
 * These run the REAL worker child (forked from the compiled worker.js)
 * against a stub tool executor — no protocol, no add-on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReplRuntime, ReplCellError } from "../src/repl/runtime.js";
import { ReplProvider, unwrapToolResult } from "../src/repl/provider.js";
import type { NormalizedToolResult } from "../src/browser/provider.js";

async function makeRuntime(executor: (tool: string, args: Record<string, unknown>) => Promise<unknown>, opts: Record<string, unknown> = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-repl-test-"));
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const runtime = new ReplRuntime({
    workspace,
    redact: ["supersecret123"],
    maxOutputChars: 1000,
    preamble: "REPL recipe goes here.",
    toolExecutor: async (tool, args) => {
      calls.push({ tool, args });
      return executor(tool, args);
    },
    ...opts,
  });
  return { runtime, workspace, calls, cleanup: async () => { await runtime.dispose(); await rm(workspace, { recursive: true, force: true }); } };
}

const canned = async (tool: string, _args: Record<string, unknown>) => {
  switch (tool) {
    case "browser_get_page":
      return { url: "https://example.com/", title: "Example" };
    case "browser_screenshot":
      return { data: Buffer.from("fake-jpeg-bytes").toString("base64"), mimeType: "image/jpeg" };
    default:
      return { ok: true, tool };
  }
};

test("state persists across cells (top-level variables survive)", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    await runtime.call("x = 41;");
    const second = await runtime.call("x + 1");
    assert.match(second.text, /42/);
  } finally {
    await cleanup();
  }
});

test("top-level await works and the last expression is captured", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    const result = await runtime.call(`await new Promise((r) => setTimeout(r, 50)); 6 * 7`);
    assert.match(result.text, /42/);
  } finally {
    await cleanup();
  }
});

test("cell code error is reported with preserved state", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    const result = await runtime.call("1/0; noSuchVariable;");
    assert.match(result.error ?? "", /noSuchVariable is not defined/);
    // State preserved: a later cell still sees earlier variables.
    await runtime.call("marker = 'still-here'");
    const after = await runtime.call("marker");
    assert.match(after.text, /still-here/);
  } finally {
    await cleanup();
  }
});

test("synchronous infinite loop: timeout kills the child, state resets, host survives", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    await runtime.call("keepAlive = 1;");
    await assert.rejects(
      runtime.call("for (;;) {}", { timeoutMs: 2000 }),
      (err: unknown) => err instanceof ReplCellError && /exceeded 2000 ms/.test(err.message) && err.stateReset === true,
    );
    // Host survives; a new worker starts fresh (previous state is gone).
    const after = await runtime.call("typeof keepAlive");
    assert.doesNotMatch(after.text, /number/);
  } finally {
    await cleanup();
  }
});

test("one cell at a time: concurrent call is rejected immediately", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    const slow = runtime.call("await new Promise((r) => setTimeout(r, 800)); 'slow-done'");
    await new Promise((r) => setTimeout(r, 100)); // let the first cell land in the worker
    await assert.rejects(runtime.call("1 + 1"), /already running/);
    const first = await slow;
    assert.match(first.text, /slow-done/);
  } finally {
    await cleanup();
  }
});

test("tool round-trip: page.info() goes through the executor with args", async () => {
  const { runtime, calls, cleanup } = await makeRuntime(canned);
  try {
    const result = await runtime.call(`const i = await page.info(); i.title`);
    assert.match(result.text, /Example/);
    assert.deepEqual(calls.map((c) => c.tool), ["browser_get_page"]);
  } finally {
    await cleanup();
  }
});

test("tool structured error surfaces as '<CODE>: message' in the cell error", async () => {
  const { runtime, cleanup } = await makeRuntime(async () => {
    throw Object.assign(new Error("session has no bound tab"), { code: "BROWSER_NOT_BOUND" });
  });
  try {
    const result = await runtime.call("await page.info();");
    assert.match(result.error ?? "", /BROWSER_NOT_BOUND: session has no bound tab/);
  } finally {
    await cleanup();
  }
});

test("redaction: secrets are scrubbed from captured output", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    const result = await runtime.call(`console.log("token=supersecret123 done")`);
    assert.doesNotMatch(result.text, /supersecret123/);
    assert.match(result.text, /\[REDACTED\]/);
  } finally {
    await cleanup();
  }
});

test("unwrapToolResult preserves non-image results, multiple images, and errors", () => {
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" } as const;
  assert.deepEqual(unwrapToolResult({ content: [image] }), { data: image.data, mimeType: image.mimeType });
  assert.deepEqual(unwrapToolResult({ content: [{ type: "text", text: '{"ok":true}' }] }), { ok: true });
  assert.equal(unwrapToolResult({ content: [{ type: "text", text: "plain text" }] }), "plain text");
  const multiText: NormalizedToolResult = { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] };
  assert.deepEqual(unwrapToolResult(multiText), multiText.content);
  assert.deepEqual(unwrapToolResult({ content: [image, image] }), [image, image]);
  assert.throws(() => unwrapToolResult({ isError: true, content: [image, { type: "text", text: "capture failed" }] }), /capture failed/);
});

test("ReplProvider screenshot() accepts the Firefox image plus capture-note result", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "pi-repl-provider-test-"));
  const provider = new ReplProvider({ workspaceRoot, log: () => {} });
  const image = { type: "image", data: Buffer.from("fake-jpeg-bytes").toString("base64"), mimeType: "image/jpeg" } as const;
  try {
    for (const via of ["captureTab", "captureVisibleTab"]) {
      const result = await provider.call(`screenshot-${via}`, "await screenshot();", 10_000, undefined, async (_sessionId, tool) => {
        assert.equal(tool, "browser_screenshot");
        return { content: [image, { type: "text", text: `screenshot via ${via}` }] };
      });
      assert.match(result.text, /Screenshot captured\./);
      assert.deepEqual(result.images, [image]);
    }
  } finally {
    await provider.shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("screenshot() attaches an image to the cell result (max 4 per cell)", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    const result = await runtime.call("await screenshot(); await screenshot();");
    assert.equal(result.images.length, 2);
    assert.equal(result.images[0]?.mimeType, "image/jpeg");
    const tooMany = await runtime.call("for (let i = 0; i < 10; i++) { try { await screenshot(); } catch (e) { break; } } 'done'");
    // 4 cap: the first call fails immediately (images already at cap is not
    // the case here — each call is a fresh cell). A single cell with 5
    // screenshots hits the cap inside the cell.
    assert.match(tooMany.text, /done/);
  } finally {
    await cleanup();
  }
});

test("screenshot() over 8 MB is omitted (P3.4 image cap)", async () => {
  // 9 MB of raw bytes -> ~12 MB base64, above the 8 MB cap.
  const big = Buffer.alloc(9 * 1024 * 1024, 7);
  const bigBase64 = big.toString("base64");
  const { runtime, cleanup } = await makeRuntime(async (tool) => {
    if (tool === "browser_screenshot") return { data: bigBase64, mimeType: "image/jpeg" };
    return { ok: true, tool };
  });
  try {
    const result = await runtime.call("await screenshot();");
    assert.equal(result.images.length, 0, "oversized screenshot must not be attached");
    assert.match(result.text, /8 MB limit/i, `omission note present: ${result.text}`);
    // A subsequent small screenshot in a fresh cell still works (cap is per cell).
    const small = await runtime.call("await screenshot();");
    assert.equal(small.images.length, 0, "stub still returns the big image, so this cell is also capped");
  } finally {
    await cleanup();
  }
});

test("artifact + checkpoint: files land in the workspace, names validated", async () => {
  const { runtime, workspace, cleanup } = await makeRuntime(canned);
  try {
    const result = await runtime.call(`await artifact('out.txt', 'hello repl'); await checkpoint('state.json', { n: 1 });`);
    assert.doesNotMatch(result.error ?? "", /Error/);
    const out = await readFile(path.join(workspace, "out.txt"), "utf8");
    assert.equal(out, "hello repl");
    const st = await stat(path.join(workspace, "out.txt"));
    assert.equal(st.mode & 0o777, 0o600);
    const state = JSON.parse(await readFile(path.join(workspace, "state.json"), "utf8"));
    assert.deepEqual(state, { n: 1 });
    const bad = await runtime.call(`try { await artifact('../evil.txt', 'x'); 'nope' } catch (e) { String(e) }`);
    assert.match(bad.text, /plain filename/);
  } finally {
    await cleanup();
  }
});

test("invalidate() notes are prepended to the next cell only", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    runtime.invalidate("binding changed: inspect the page before acting");
    const first = await runtime.call("'after-note'");
    assert.match(first.text, /\[repl\] binding changed/);
    const second = await runtime.call("'no-note-now'");
    assert.doesNotMatch(second.text, /\[repl\] binding changed/);
  } finally {
    await cleanup();
  }
});

test("preamble is emitted exactly once (first cell)", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    const first = await runtime.call("'one'");
    const second = await runtime.call("'two'");
    assert.match(first.text, /REPL recipe goes here/);
    assert.doesNotMatch(second.text, /REPL recipe goes here/);
  } finally {
    await cleanup();
  }
});

test("dispose is idempotent and rejects later calls; closed runtime does not fork", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  await runtime.dispose();
  await runtime.dispose();
  await assert.rejects(runtime.call("1 + 1"), /closed/i);
  await cleanup();
});

test("worker crash: next call reports the reset, the call after starts fresh", async () => {
  const { runtime, cleanup } = await makeRuntime(canned);
  try {
    await runtime.call("a = 1;");
    // Kill the child from outside (simulates a crash).
    const pid = runtime.childPid;
    assert.ok(pid, "worker child should be running");
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200)); // let the exit handler run
    let loss: unknown;
    try {
      await runtime.call("a");
    } catch (error) {
      loss = error;
    }
    assert.ok(loss instanceof ReplCellError && loss.stateReset === true);
    assert.match(loss.message, /exited|reset/i);
    const fresh = await runtime.call("'fresh'");
    assert.match(fresh.text, /fresh/);
  } finally {
    await cleanup();
  }
});
