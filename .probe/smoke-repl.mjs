/**
 * Smoke probe: runs the REAL compiled ReplWorker child (pi-agent/dist/repl)
 * through ReplRuntime with a stub tool executor — the Phase 0 core, exactly
 * as the `javascript` tool will drive it (BROWSER-USE-REPL-PLAN.md).
 *
 * Covers: state persistence across cells, top-level await, last-expression
 * capture, cell-error state preservation, the page.* tool round-trip,
 * structured tool errors, screenshot image attachment, artifacts, and the
 * sync-infinite-loop timeout kill (child dies, host + next cell survive).
 *
 * Run:  npm run build -w @pi-browser/agent && node .probe/smoke-repl.mjs
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const DIST_REPL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "pi-agent", "dist", "repl");
const { ReplRuntime, ReplCellError } = await import(path.join(DIST_REPL, "runtime.js"));

const workspace = await mkdtemp(path.join(tmpdir(), "pi-repl-smoke-"));
const calls = [];
const runtime = new ReplRuntime({
  workspace,
  redact: ["supersecret123"],
  preamble: "Use page.snapshot() to inspect; page.click(ref) to act.",
  toolExecutor: async (tool, args) => {
    calls.push({ tool, args });
    switch (tool) {
      case "browser_get_page":
        return { url: "https://example.com/x", title: "Example Page" };
      case "browser_screenshot":
        return { data: Buffer.from("fake-jpeg").toString("base64"), mimeType: "image/jpeg" };
      case "browser_get_accessibility_tree":
        return { nodes: [{ ref: "a1", role: "heading", name: "Hi" }] };
      default:
        if (tool === "browser_navigate") throw Object.assign(new Error("nope"), { code: "BROWSER_TAB_CLOSED" });
        return { ok: true, tool, args };
    }
  },
  log: (line) => console.error(line),
});

let pass = 0;
const ok = (label) => { pass += 1; console.log(`  ok ${pass} - ${label}`); };

// 1. state persists across cells + preamble on first cell only
const c0 = await runtime.call("x = 41;");
assert.match(c0.text, /Use page.snapshot/);
ok("preamble emitted on first cell");
const c1 = await runtime.call("x + 1");
assert.match(c1.text, /42/);
assert.doesNotMatch(c1.text, /Use page.snapshot/);
ok("state persists across cells (x=41 -> x+1 prints 42); preamble not repeated");

// 2. top-level await + last expression
const c2 = await runtime.call(`await new Promise(r => setTimeout(r, 30)); 6 * 7`);
assert.match(c2.text, /42/);
ok("top-level await + last-expression capture");

// 4. tool round-trip with args
const c3 = await runtime.call("const i = await page.info(); i.url + ' | ' + i.title");
assert.match(c3.text, /https:\/\/example.com\/x \| Example Page/);
ok("page.info() round-trips through the executor");

// 5. structured tool error
const c4 = await runtime.call('try { await page.goto("https://x.test"); "unreached" } catch (e) { String(e.message) }');
assert.match(c4.text, /BROWSER_TAB_CLOSED: nope/);
ok("structured tool error surfaces as '<CODE>: message'");

// 6. snapshot + waitFor
const c5 = await runtime.call(`const s = await page.snapshot(); s.nodes.length`);
assert.match(c5.text, /1/);
ok("page.snapshot() maps browser_get_accessibility_tree nodes");

// 7. screenshot image attachment
const c6 = await runtime.call("await screenshot();");
assert.equal(c6.images.length, 1);
assert.equal(c6.images[0].mimeType, "image/jpeg");
ok("screenshot() attaches image to cell result");

// 8. cell error, state preserved
const c7 = await runtime.call("boom = 'kept'; throw new Error('cell failed');");
assert.match(c7.error ?? "", /cell failed/);
const c8 = await runtime.call("boom");
assert.match(c8.text, /kept/);
ok("cell code error reports failure, state preserved");

// 9. artifact
await runtime.call(`await artifact('probe.txt', 'from the repl');`);
assert.equal(await readFile(path.join(workspace, "probe.txt"), "utf8"), "from the repl");
ok("artifact() writes to the session workspace");

// 10. redaction
const c9 = await runtime.call(`console.log("token supersecret123 end");`);
assert.doesNotMatch(c9.text, /supersecret123/);
assert.match(c9.text, /\[REDACTED\]/);
ok("redaction scrubs secrets from output");

// 11. invalidation note
runtime.invalidate("binding changed: re-inspect before acting");
const c10 = await runtime.call("'noted'");
assert.match(c10.text, /\[repl\] binding changed/);
ok("invalidate() note prepended to next cell");

// 12. sync infinite loop: child killed, state reset, host survives
await runtime.call("keepAlive = 1;");
await assert.rejects(
  runtime.call("for (;;) {}", { timeoutMs: 1500 }),
  (e) => e instanceof ReplCellError && /exceeded 1500 ms/.test(e.message) && e.stateReset,
);
ok("sync infinite loop: cell timeout kills the child (state reset)");
const c11 = await runtime.call("typeof keepAlive");
assert.doesNotMatch(c11.text, /number/);
ok("host survives; fresh worker starts with no prior state");

// 13. dispose reaps the child
await runtime.dispose();
assert.equal(runtime.childPid, undefined);
ok("dispose() reaps the worker");

await rm(workspace, { recursive: true, force: true });
console.log(`\nsmoke-repl: all ${pass} checks passed`);
console.log(`tool calls routed: ${calls.map((c) => c.tool).join(", ")}`);
