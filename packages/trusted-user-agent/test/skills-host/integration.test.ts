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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { FrameDecoder, encodeFrame } from "../../src/native-host/framing.js";
import { findRepoRoot, runScenario, runScenarioDir, type Scenario, type ScenarioResult } from "./runner.js";
import {
  AGENT_METHODS,
  PROTOCOL_VERSION,
  buildAgentHelloMeta,
  X_TRUSTED_UA,
} from "@trusted-ua/protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(findRepoRoot(), "tests/skills-host/scenarios");
const CLIENT_METHODS_XPI = { permission_prompted: X_TRUSTED_UA.permission_prompted };
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
  const fakeHost = path.join(findRepoRoot(), "packages/trusted-user-agent/test/skills-host/fake-host.mjs");
  const proc = spawn(process.execPath, [fakeHost], {
    env: {
      ...process.env,
      FAKE_HOST_SCENARIO: path.join(scenariosDir, scenarioFile),
      PI_BROWSER_LOG_FILE: "off",
      PI_BROWSER_DATA_ROOT: path.join(tmpdir(), `fake-host-data-${process.pid}-${scenarioFile}`),
      // Hermetic: never read the developer's ~/.pi/browser/permissions.json
      // (an "always allow" there silently skipped the approval prompt).
      PI_BROWSER_PERMISSIONS_FILE: path.join(tmpdir(), `fake-host-perms-${process.pid}-${scenarioFile}.json`),
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
    if (method === X_TRUSTED_UA.tool) {
      const p = params as { tool: string; arguments?: { url?: string } };
      toolCalls.push({ tool: p.tool, url: p.arguments?.url });
      client.respond(id, { content: [{ type: "text", text: "navigated" }] });
      return;
    }
    if (method === CLIENT_METHODS_XPI.permission_prompted) client.respond(id, { ok: true });
    // browser_navigate is approval-gated: answer like the sidebar's "Allow once".
    if (method === "session/request_permission") client.respond(id, { outcome: { outcome: "selected", optionId: "allow_once" } });
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
    if (method === X_TRUSTED_UA.skills_context) {
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
    if (method === X_TRUSTED_UA.skills_result) {
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

    const plan = (await client.request(X_TRUSTED_UA.skills_plan, { source, url: "http://127.0.0.1:9/fixture-basic.html" })) as {
      status: string;
      plan?: { planVersion: number; rules: unknown[] };
    };
    assert.equal(plan.status, "ok");
    assert.ok(plan.plan && plan.plan.rules.length >= 1, "grant + adapter armed at least one rule");

    const event = (await client.request(X_TRUSTED_UA.skills_event, {
      event: {
        version: 1,
        eventId: "evt-proc-1",
        event: "fixture-skill:before-submit",
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

test("fake-host process: catalog reload via trigger file picks up a new package (no restart)", async () => {
  const base = `/tmp/skills-catalog-reload-${process.pid}-${Date.now()}`;
  const skillRoots = path.join(base, "packages");
  const runDir = path.join(base, "run");
  const trigger = path.join(runDir, "skills-catalog-reload");
  const config = path.join(base, "skills-config.json");
  mkdirSync(runDir, { recursive: true });
  // Writable copy of the fixture package + a grant for a package that does
  // not exist yet: the grant is inert until the catalog reload sees it.
  cpSync(path.join(findRepoRoot(), "tests/skills-host/packages/fixture-skill"), path.join(skillRoots, "fixture-skill"), { recursive: true });
  writeFileSync(config, JSON.stringify({
    grants: [
      { skillKey: "fixture-skill/fixture-reply", revision: "*", capabilities: ["context.read", "suggestion.present"] },
      { skillKey: "reload-pkg/reload-skill", revision: "*", capabilities: ["context.read", "suggestion.present"] },
    ],
    job: {},
  }));

  const fakeHost = path.join(findRepoRoot(), "packages/trusted-user-agent/test/skills-host/fake-host.mjs");
  const proc = spawn(process.execPath, [fakeHost], {
    env: {
      ...process.env,
      PI_BROWSER_FAKE_HOST_STUB: "1",
      PI_BROWSER_SKILLS_CONFIG: config,
      PI_BROWSER_SKILL_ROOTS: skillRoots,
      PI_BROWSER_DATA_ROOT: path.join(base, "data"),
      PI_BROWSER_BROKER_DIR: runDir,
      PI_BROWSER_LOG_FILE: "off",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  proc.stderr!.on("data", (c: Buffer) => stderr.push(c.toString()));
  const client = new FrameClient(proc);

  const source = { application: "firefox", connectionEpoch: "epoch-r1", documentGeneration: "gen-r1", tabId: 1, frameId: 0 };
  const plan = () => client.request(X_TRUSTED_UA.skills_plan, { source, url: "http://127.0.0.1:9/fixture-basic.html" }) as Promise<{
    status: string;
    plan?: { planVersion: number; rules: { skillKey: string }[] };
  }>;

  try {
    await client.request(AGENT_METHODS.initialize, hello);
    const first = await plan();
    assert.equal(first.status, "ok");
    assert.deepEqual(first.plan!.rules.map((r) => r.skillKey), ["fixture-skill/fixture-reply"], `new-package grant is inert before the package exists; plan=${JSON.stringify(first)}; host stderr: ${stderr.join("")}`);

    // Add the package to the root, then request a catalog reload by
    // touching the trigger file in the broker run dir.
    const pkg = path.join(skillRoots, "reload-pkg");
    mkdirSync(path.join(pkg, "skill"), { recursive: true });
    writeFileSync(path.join(pkg, "activation.json"), JSON.stringify({
      schemaVersion: 2, packageId: "reload-pkg", application: "firefox", hosts: ["127.0.0.1"],
      targets: { composer: "textarea[data-skill-fixture]", submit: "button[data-skill-fixture=\"submit\"]" },
      events: {
        "before-submit": {
          kind: "gate", chainId: "reload-submit",
          alternatives: [[{ dom: "click", target: "submit" }]],
          payload: { draft: { from: "composer", field: "value" } },
        },
      },
      skills: [{
        id: "reload-skill", type: "triggered", instructions: "skill/SKILL.md",
        subscriptions: [{ event: "before-submit" }],
        context: { required: ["draft"], optional: [] },
        capabilities: ["context.read", "suggestion.present"],
        execution: { handler: "agent", timeoutMs: 5000 },
      }],
    }));
    writeFileSync(path.join(pkg, "skill/SKILL.md"), "Review the draft.\n");
    writeFileSync(trigger, "");

    // Poll the plan until the reload is observable (debounce + reload).
    const deadline = Date.now() + 5_000;
    let reloaded: { status: string; plan?: { planVersion: number; rules: { skillKey: string }[] } } | undefined;
    for (;;) {
      reloaded = await plan();
      if (reloaded.plan?.rules.some((r) => r.skillKey === "reload-pkg/reload-skill")) break;
      if (Date.now() > deadline) throw new Error(`catalog reload not observable; host stderr: ${stderr.join("")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(reloaded.plan!.rules.some((r) => r.skillKey === "fixture-skill/fixture-reply"), "old package survives the reload");
    assert.equal(existsSync(trigger), false, "the trigger file is consumed per reload");

    // The JSONL event log (the agent observation channel) records the plan
    // compiles and the successful reload in the broker run dir.
    const eventLog = path.join(runDir, "skills-events.jsonl");
    assert.ok(existsSync(eventLog), `event log missing at ${eventLog}`);
    const lines = readFileSync(eventLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; status?: string; ok?: boolean });
    assert.ok(lines.some((l) => l.type === "plan" && l.status === "ok"), `plan line recorded: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.type === "reload" && l.ok === true), `reload line recorded: ${JSON.stringify(lines)}`);
  } finally {
    client.close();
    const exited = await exitCode(proc, 15_000);
    assert.equal(exited, 0, `host stderr: ${stderr.join("")}`);
    rmSync(base, { recursive: true, force: true });
  }
});
