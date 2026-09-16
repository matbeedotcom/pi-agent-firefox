/**
 * Fault-matrix integration tests for the skills host.
 *
 * 1. In-process: every scenario in tests/skills-host/scenarios runs through
 *    the REAL host stack (AcpAgent + MockBackend + registry + service +
 *    isolated runner + skills protocol) via test/skills-host/runner.ts.
 * 2. Process: fake-host.mjs (the real native host with PI_BROWSER_BACKEND=
 *    mock) is spawned and driven over the real native-messaging framing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FrameDecoder, encodeFrame } from "../../src/native-host/framing.js";
import { findRepoRoot, runScenario, runScenarioDir, type Scenario, type ScenarioResult } from "./runner.js";
import {
  AGENT_METHODS,
  PROTOCOL_VERSION,
  buildAgentHelloMeta,
  X_PI_BROWSER,
} from "@pi-browser/protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(findRepoRoot(), "tests/skills-host/scenarios");
const CLIENT_METHODS_XPI = { permission_prompted: X_PI_BROWSER.permission_prompted };
const scenarioFiles = readdirSync(scenariosDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

test("fault matrix: scenarios are all present", () => {
  assert.deepEqual(scenarioFiles, [
    "bridge-delay.json",
    "bridge-fail.json",
    "client-disconnect.json",
    "duplicate-request.json",
    "happy-plan-apply.json",
    "request-storm.json",
    "stale-draft.json",
  ]);
});

for (const file of scenarioFiles) {
  test(`in-process scenario ${file}`, async () => {
    const scenario = JSON.parse(readFileSync(path.join(scenariosDir, file), "utf8")) as Scenario;
    const result = await runScenario(scenario);
    if (!result.ok) console.error(`[${result.name}]`, result.failures);
    assert.equal(result.failures.length, 0, result.failures.join("; "));
  });
}

test("in-process: runScenarioDir reports every scenario", async () => {
  const results = await runScenarioDir(scenariosDir);
  assert.equal(results.length, scenarioFiles.length);
  assert.ok(results.every((r: ScenarioResult) => r.ok), results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.failures.join("; ")}`).join(" | "));
});

// --- fake-host process tests (real native-messaging framing) ----------------

class FrameClient {
  private decoder = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout }>();
  onHostRequest: (method: string, params: unknown, id: number) => void = () => {};

  constructor(private proc: ChildProcess) {
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.decoder.push(chunk);
      for (const frame of this.decoder.readAll()) {
        this.dispatch(JSON.parse(frame.toString("utf8")));
      }
    });
  }

  private dispatch(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) this.onHostRequest(msg.method, msg.params, msg.id);
    // notifications are ignored by these tests
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`frame client: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.proc.stdin!.write(encodeFrame({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }

  respond(id: number, result: unknown): void {
    this.proc.stdin!.write(encodeFrame({ jsonrpc: "2.0", id, result: result === undefined ? null : result }));
  }

  close(): void {
    this.proc.stdin!.end();
  }
}

function spawnFakeHost(scenarioFile: string): { proc: ChildProcess; stderr: string[] } {
  const scenario = JSON.parse(readFileSync(path.join(scenariosDir, scenarioFile), "utf8")) as Scenario;
  // fake-host.mjs is a source file (tsc does not copy .mjs into dist-tests):
  // resolve it from the repo root, not from this compiled test's directory.
  const fakeHost = path.join(findRepoRoot(), "packages/pi-agent/test/skills-host/fake-host.mjs");
  const proc = spawn(process.execPath, [fakeHost], {
    env: {
      ...process.env,
      FAKE_HOST_SCENARIO: path.join(scenariosDir, scenarioFile),
      PI_BROWSER_LOG_FILE: "off",
      PI_BROWSER_DATA_ROOT: path.join("/tmp", `fake-host-data-${process.pid}-${scenarioFile}`),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  proc.stderr!.on("data", (c: Buffer) => stderr.push(c.toString()));
  return { proc, stderr };
}

const hello = {
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: "fake-host-test-client", version: "0.0.0" },
  _meta: buildAgentHelloMeta({
    client: { application: "firefox", extensionId: "fake-host@test", version: "0.0.0" },
    capabilities: ["browser"],
  }),
};

test("fake-host process: browser tool round-trip with a delayed bridge (bridge-delay)", async () => {
  const { proc, stderr } = spawnFakeHost("bridge-delay.json");
  const client = new FrameClient(proc);
  const toolCalls: Array<{ tool: string; url?: string }> = [];
  client.onHostRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.tool) {
      const p = params as { tool: string; arguments?: { url?: string } };
      toolCalls.push({ tool: p.tool, url: p.arguments?.url });
      client.respond(id, { content: [{ type: "text", text: "navigated" }] });
      return;
    }
    if (method === CLIENT_METHODS_XPI.permission_prompted) client.respond(id, { ok: true });
  };

  try {
    await client.request(AGENT_METHODS.initialize, hello);
    const session = (await client.request(AGENT_METHODS.session_new, { cwd: process.cwd() })) as { sessionId: string };
    const res = (await client.request(AGENT_METHODS.session_prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "OPEN-FIXTURE" }],
    }, 20_000)) as { stopReason?: string };
    assert.notEqual(res.stopReason, "cancelled");
    assert.deepEqual(toolCalls, [{ tool: "browser_navigate", url: "http://127.0.0.1:9/fixture-basic.html" }]);
  } finally {
    client.close();
    const exited = await exitCode(proc, 15_000);
    assert.equal(exited, 0, `host stderr: ${stderr.join("")}`);
  }
});

test("fake-host process: full skills happy path over native framing (happy-plan-apply)", async () => {
  const { proc, stderr } = spawnFakeHost("happy-plan-apply.json");
  const client = new FrameClient(proc);
  const results: unknown[] = [];
  client.onHostRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.skills_context) {
      const p = params as { contextRef: string; fields?: string[] };
      const context: Record<string, unknown> = {
        draft: "Planning a hike next weekend",
        replyTarget: "Alice's post about trails",
      };
      const payload: Record<string, unknown> = {};
      for (const f of p.fields ?? []) payload[f] = context[f] ?? null;
      client.respond(id, { contextRef: p.contextRef, context: payload, bytes: JSON.stringify(payload).length });
      return;
    }
    if (method === X_PI_BROWSER.skills_result) {
      results.push(params);
      client.respond(id, { delivered: true });
      return;
    }
    if (method === CLIENT_METHODS_XPI.permission_prompted) client.respond(id, { ok: true });
  };

  const source = { application: "firefox", connectionEpoch: "epoch-1", documentGeneration: "gen-1", tabId: 1, frameId: 0 };
  try {
    await client.request(AGENT_METHODS.initialize, hello);
    const session = (await client.request(AGENT_METHODS.session_new, { cwd: process.cwd() })) as { sessionId: string };

    // The scripted turn runs when the prompt lands; plan before the event.
    const promptDone = client.request(AGENT_METHODS.session_prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "REVIEW" }],
    }, 20_000);

    const plan = (await client.request(X_PI_BROWSER.skills_plan, { source, url: "http://127.0.0.1:9/fixture-basic.html" })) as {
      status: string;
      plan?: { planVersion: number; rules: unknown[] };
    };
    assert.equal(plan.status, "ok");
    assert.ok(plan.plan && plan.plan.rules.length >= 1, "grant + adapter armed at least one rule");

    const event = (await client.request(X_PI_BROWSER.skills_event, {
      event: {
        version: 1,
        eventId: "evt-proc-1",
        event: "comment.before-submit",
        source,
        interactionId: "int-proc-1",
        draftRevision: 1,
        contextRevision: 1,
        planVersion: plan.plan!.planVersion,
        origin: "user",
        contextRef: "ctx-proc-1",
      },
    })) as { status: string };
    assert.equal(event.status, "accepted");

    // The job runs asynchronously (scripted factory); poll for the delivery
    // rather than racing it against prompt completion.
    const deadline = Date.now() + 10_000;
    while (results.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await promptDone;
    assert.equal(results.length, 1, `skills_result delivered once; host stderr: ${stderr.join("")}`);
    const delivered = results[0] as { status: string; decision: string; replacementText: string; skillKey: string };
    assert.equal(delivered.status, "done");
    assert.equal(delivered.decision, "suggest");
    assert.equal(delivered.replacementText, "Fixture reply: Planning a hike");
    assert.equal(delivered.skillKey, "fixture-skill/fixture-reply");
  } finally {
    client.close();
    const exited = await exitCode(proc, 15_000);
    assert.equal(exited, 0, `host stderr: ${stderr.join("")}`);
  }
});

function exitCode(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
