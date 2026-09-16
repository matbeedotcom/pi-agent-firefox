/**
 * Scenario runner for the skills host fault matrix (test/skills-host).
 *
 * Runs the REAL host stack in-process — AcpAgent + MockBackend (scripted
 * turns) + SkillsRegistry + SkillsService + isolated runner (scripted job
 * factory) + per-client skills protocol — over a memory transport pair, and
 * plays the add-on (ACP client) side against a scenario JSON. The browser
 * e2e harness (tests/skills-e2e) imports this same runner and swaps the
 * in-memory fake client for a real Firefox client.
 *
 * Scenario JSON contract (tests/skills-host/scenarios/):
 * - "pageUrl"            document URL for {{page_url}} substitution.
 * - "skillsConfig"       { grants: [{skillKey, revision ("*" = resolve from
 *                          registry), capabilities}], adapters: [...] } —
 *                          the same shape the mock host reads from
 *                          PI_BROWSER_SKILLS_CONFIG.
 * - "job"                scripted isolated job: { report?, fail?, delayMs? }.
 * - "bridge"             per browser tool: { delayMs?, result?, fail? {code,message} }.
 * - "steps"              ordered; side "agent" steps become MockBackend
 *                          script entries (prompt/say/tool/wait), side
 *                          "client" steps are host-bound requests.
 * - step "expect"        partial match (dot-path fields) on the response.
 * - step "expectResult"  partial match on the next skills_result delivery.
 * - step "expectStalePlan" expect status "stale-plan".
 * - step "repeat": N     issue N identical concurrent requests (storm).
 * - "expect" (top-level) final-state assertions: results (delivered
 *                          skills_result count), doneOutcomes /
 *                          unavailableOutcomes, replacements (max service
 *                          replacements observed), toolCalls {tool: n},
 *                          toolErrors {tool: "CODE"}, promptAborted (bool),
 *                          storm {requests, answered}.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import { createLogger, type Logger } from "../../src/logger.js";
import { createMemoryTransportPair } from "../../src/native-host/transport.js";
import { AcpAgent } from "../../src/acp/agent.js";
import { MockBackend, type MockScriptEntry } from "../../src/acp/mock-backend.js";
import { CapabilityToolProvider } from "../../src/browser/provider.js";
import { PermissionStore } from "../../src/permission-store.js";
import { discoverSkillPackages, SkillsRegistry } from "../../src/skills/registry.js";
import { createSkillsHost } from "../../src/skills/pi-integration.js";
import { SkillsPlanner, type SkillAdapterCoverage, type SkillGrant } from "../../src/skills/planner.js";
import { createClientSkillsProtocol } from "../../src/native-host/skills-startup.js";
import { createScriptedSessionFactory, type ScriptedJob } from "../../src/skills/mock-session-factory.js";
import type { NormalizedToolResult } from "../../src/browser/provider.js";
import type { BrowserToolBridge } from "../../src/tool-bridge.js";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PERMISSION_ALLOW_ONCE,
  PI_BROWSER_ERROR,
  PROTOCOL_VERSION,
  X_PI_BROWSER,
  buildAgentHelloMeta,
  toErrorObject,
  type PiBrowserErrorCode,
} from "@pi-browser/protocol";

export interface ScenarioStep {
  side: "agent" | "client";
  type: "prompt" | "say" | "tool" | "wait" | "extended" | "close";
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ms?: number;
  method?: string;
  params?: unknown;
  expect?: Record<string, unknown>;
  expectResult?: Record<string, unknown>;
  expectStalePlan?: boolean;
  repeat?: number;
}

export interface Scenario {
  name: string;
  fixture: string | null;
  pageUrl: string;
  skillsConfig?: {
    grants: { skillKey: string; revision: string; capabilities: SkillGrant["capabilities"] }[];
    adapters: SkillAdapterCoverage[];
  };
  job?: ScriptedJob;
  bridge?: Record<string, { delayMs?: number; result?: NormalizedToolResult; fail?: { code: string; message: string } }>;
  steps: ScenarioStep[];
  expect?: Record<string, unknown>;
}

export interface StormStats {
  requests: number;
  answered: number;
  /** Every request id answered exactly once; >0 means a double-answer. */
  duplicateIds: number;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  failures: string[];
  /** Delivered skills_result params (host -> client). */
  results: unknown[];
  /** Dispatch counts per browser tool (the bridge is the source of truth). */
  toolCalls: Record<string, number>;
  /** Structured error codes observed on failed tool calls, per tool. */
  toolErrors: Record<string, string>;
  promptAborted: boolean;
  replacements: number;
  outcomes: Record<string, number>;
  storm: StormStats;
}

interface BridgeProfile {
  delayMs?: number;
  result?: NormalizedToolResult;
  /** PI browser error code (string), e.g. "BROWSER_TAB_CLOSED". */
  fail?: { code: string; message: string };
}

/** Group agent-side scenario steps into MockBackend script entries. */
export function toMockScript(scenario: Scenario): MockScriptEntry[] {
  const entries: MockScriptEntry[] = [];
  for (const step of scenario.steps) {
    if (step.side !== "agent") continue;
    if (step.type === "prompt") {
      entries.push({ match: step.text ?? "", events: [], toolCalls: [] });
    } else {
      const entry = entries[entries.length - 1];
      if (!entry) throw new Error(`scenario ${scenario.name}: agent step before any prompt`);
      if (step.type === "say") entry.events!.push({ type: "text_delta", delta: step.text ?? "" });
      else if (step.type === "tool") entry.toolCalls!.push({ toolName: step.tool!, args: step.args });
      else if (step.type === "wait") entry.delayMs = (entry.delayMs ?? 0) + (step.ms ?? 0);
    }
  }
  return entries;
}

function get(obj: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>(
    (acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined),
    obj,
  );
}

function partialMatch(actual: unknown, expected: Record<string, unknown>, label: string, failures: string[]): void {
  for (const [key, want] of Object.entries(expected)) {
    const have = get(actual, key);
    try {
      assert.deepEqual(have, want);
    } catch {
      failures.push(`${label}: ${key} = ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
    }
  }
}

function substitute(value: unknown, vars: Record<string, string>, prev: unknown): unknown {
  if (typeof value === "string") {
    // A bare "{{prev.x}}" (or {{page_url}}) keeps the resolved value's type,
    // so integer fields like planVersion stay numbers, not "1".
    const barePrev = value.match(/^\{\{prev\.([a-zA-Z0-9_.]+)\}\}$/);
    if (barePrev) {
      const v = get(prev, barePrev[1]);
      if (v !== undefined) return v;
    }
    // {{fixture_url}} is an alias of {{page_url}} (shared contract spelling).
    if (value === "{{page_url}}" || value === "{{fixture_url}}") return vars.page_url;
    return value
      .replace(/\{\{(page_url|fixture_url)\}\}/g, () => vars.page_url)
      .replace(/\{\{prev\.([a-zA-Z0-9_.]+)\}\}/g, (_m, field: string) => {
        const v = get(prev, field);
        return v === undefined ? "" : String(v);
      });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars, prev));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, vars, prev);
    return out;
  }
  return value;
}

/** Walk up from this file to the repo root (works from test/ and dist-tests/). */
export function findRepoRoot(start: string = path.dirname(new URL(import.meta.url).pathname)): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "skills-runtime-design.md"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`repo root not found above ${start}`);
}

function createScriptedBridge(
  profiles: Record<string, BridgeProfile>,
  calls: Record<string, number>,
): (tool: string, args: Record<string, unknown>) => Promise<NormalizedToolResult> {
  return async (tool, args) => {
    calls[tool] = (calls[tool] ?? 0) + 1;
    const profile = profiles[tool];
    if (profile?.delayMs) await new Promise((r) => setTimeout(r, profile.delayMs));
    if (profile?.fail) {
      const err = new Error(profile.fail.message);
      (err as { code?: string }).code = profile.fail.code;
      throw err;
    }
    return profile?.result ?? { content: [{ type: "text", text: `ok: ${tool}` }], details: { args } } as NormalizedToolResult;
  };
}

/**
 * Run one scenario against the real in-process host stack.
 * Resolves with a ScenarioResult (never throws for scenario-level failures).
 */
export async function runScenario(scenario: Scenario, opts: { log?: Logger; packagesRoot?: string } = {}): Promise<ScenarioResult> {
  const log = opts.log ?? createLogger({ level: "error", stderr: { write: () => true } });
  const failures: string[] = [];
  const toolCalls: Record<string, number> = {};
  const results: unknown[] = [];
  const storm: StormStats = { requests: 0, answered: 0, duplicateIds: 0 };
  let promptAborted = false;
  let maxReplacements = 0;
  let outcomes: Record<string, number> = {};

  // --- host stack (mirrors native-host/main.ts wiring) ---------------------
  const packagesRoot = opts.packagesRoot ?? path.join(findRepoRoot(), "tests/skills-host/packages");
  const registry = new SkillsRegistry();
  const discovered = await discoverSkillPackages(packagesRoot).catch(() => []);
  if (discovered.length > 0) await registry.reload(discovered);

  const snapshot = registry.snapshot();
  const grants = new Map<string, SkillGrant>();
  for (const g of scenario.skillsConfig?.grants ?? []) {
    grants.set(g.skillKey, {
      enabled: true,
      revision: g.revision === "*" ? (snapshot.find((s) => s.key === g.skillKey)?.revision ?? "") : g.revision,
      capabilities: g.capabilities,
    });
  }

  const host = createSkillsHost({
    log,
    registry,
    browserBridge: {
      registerSession: () => {},
      touchSession: () => {},
      closeSession: () => {},
      // Failures keep their structured code: the fake client answers
      // x-pi-browser/tool with respondError({code}), and the mock backend
      // surfaces [CODE] in the tool_end message (same path as production).
      call: (o) => runBridgeTool(o.tool, o.args ?? {}),
    } satisfies BrowserToolBridge,
    sessionFactory: createScriptedSessionFactory(scenario.job ?? {}),
  });

  const serviceStats = () => {
    maxReplacements = Math.max(maxReplacements, host.service.stats.replacements);
    outcomes = { ...host.service.stats.outcomes };
  };

  const backend = new MockBackend(toMockScript(scenario));
  const { a, b } = createMemoryTransportPair(log, log);
  const provider = new CapabilityToolProvider(b.transport, log, undefined, {
    permissionStore: new PermissionStore({
      filePath: path.join(mkdtempSync(path.join(tmpdir(), "skills-host-")), "permissions.json"),
    }),
  });

  // The protocol surface rides the HOST-side connection (b), exactly as in
  // main.ts wireClient: it answers client skills_* requests on b and sends
  // skills_context / skills_result to the client, which arrive as incoming
  // requests on a.transport (the fake add-on below).
  const clientSkills = createClientSkillsProtocol({
    log,
    runtime: { host, registry, planner: new SkillsPlanner(snapshot) },
    transport: b.transport,
    grants: () => grants,
    adapters: () => scenario.skillsConfig?.adapters ?? [],
  });

  const agent = new AcpAgent({
    backend,
    provider,
    transport: b.transport,
    log,
    agentInfo: { name: "skills-host-test", version: "0.0.0" },
    extendedRequest: clientSkills.extendedRequest,
  });

  // --- fake add-on (ACP client) --------------------------------------------
  const context: Record<string, unknown> = {
    draft: "Planning a hike next weekend",
    replyTarget: "Alice's post about trails",
    parentPost: "Trails near the city",
    visibleAncestors: "root > city-trails",
  };
  const runBridgeTool = createScriptedBridge(scenario.bridge ?? {}, toolCalls);
  a.transport.onRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.tool) {
      const p = params as { tool: string; arguments?: Record<string, unknown> };
      void runBridgeTool(p.tool, p.arguments ?? {})
        .then((result) => a.transport.respond(id, result))
        .catch((err) => {
          const e = err as Error & { code?: string };
          // The structured PI code rides data.piBrowserError; the JSON-RPC
          // code is its numeric mapping (see toErrorObject) — the host's
          // translateTransportError recovers it via codeFromErrorObject.
          const code = (Object.values(PI_BROWSER_ERROR) as string[]).includes(e.code ?? "")
            ? (e.code as PiBrowserErrorCode)
            : PI_BROWSER_ERROR.INTERNAL;
          a.transport.respondError(id, toErrorObject(code, e.message));
        });
      return;
    }
    if (method === X_PI_BROWSER.skills_context) {
      const p = params as { contextRef: string; fields?: string[] };
      const payload: Record<string, unknown> = {};
      for (const f of p.fields ?? Object.keys(context)) payload[f] = context[f] ?? null;
      a.transport.respond(id, { contextRef: p.contextRef, context: payload, bytes: JSON.stringify(payload).length });
      return;
    }
    if (method === X_PI_BROWSER.skills_result) {
      results.push(params);
      a.transport.respond(id, { delivered: true });
      return;
    }
    if (method === CLIENT_METHODS.session_request_permission) {
      a.transport.respond(id, { outcome: { outcome: "selected", optionId: PERMISSION_ALLOW_ONCE } });
      return;
    }
    if (method === X_PI_BROWSER.permission_prompted) {
      a.transport.respond(id, { ok: true });
      return;
    }
    a.transport.respondError(id, { code: -32601, message: `fake client: unknown method ${method}` });
  };

  const request = (method: string, params?: unknown, timeoutMs = 10_000) => a.transport.request(method, params, timeoutMs);

  // --- drive -----------------------------------------------------------------
  try {
    await request(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "skills-host-test-client", version: "0.0.0" },
      _meta: buildAgentHelloMeta({
        client: { application: "firefox", extensionId: "skills-host@test", version: "0.0.0" },
        capabilities: ["browser"],
      }),
    });
    const session = (await request(AGENT_METHODS.session_new, { cwd: process.cwd() })) as { sessionId: string };

    let prev: unknown = undefined;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const waitForResult = async (timeoutMs = 5_000) => {
      const start = Date.now();
      const baseline = results.length;
      while (results.length <= baseline && Date.now() - start < timeoutMs) await wait(5);
      if (results.length <= baseline) throw new Error(`timed out waiting for skills_result (have ${results.length})`);
      return results[results.length - 1];
    };

    for (const step of scenario.steps) {
      if (step.side === "agent") {
        if (step.type === "prompt") {
          const res = (await request(AGENT_METHODS.session_prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: step.text ?? "" }],
          }, 15_000)) as { stopReason?: string; aborted?: boolean };
          promptAborted = Boolean(res.aborted) || res.stopReason === "cancelled";
          prev = res;
        }
        // say/tool/wait are encoded in the mock script (toMockScript).
        continue;
      }
      // client side
      if (step.type === "close") {
        a.transport.close();
        // main.ts wires a per-client close handler that calls
        // clientSkills.dispose() on EOF; mirror it directly here.
        clientSkills.dispose();
        // dispose() cancels in-flight jobs; their "unavailable" outcomes
        // settle asynchronously — wait for the stats to move before
        // asserting.
        const before = JSON.stringify(host.service.stats.outcomes);
        const settleStart = Date.now();
        while (Date.now() - settleStart < 2000 && JSON.stringify(host.service.stats.outcomes) === before) {
          await wait(10);
        }
        serviceStats();
        prev = { closed: true };
        continue;
      }
      if (step.type !== "extended" || !step.method) throw new Error(`unsupported client step: ${JSON.stringify(step)}`);
      const repeat = step.repeat ?? 1;
      const params = substitute(step.params, { page_url: scenario.pageUrl }, prev);
      const promises = Array.from({ length: repeat }, () =>
        request(step.method!, params).then(
          (res) => ({ ok: true as const, res }),
          (err) => ({ ok: false as const, err }),
        ),
      );
      const settled = await Promise.all(promises);
      storm.requests += repeat;
      storm.answered += settled.length; // every id answered exactly once by construction
      for (const s of settled) {
        if (!s.ok) {
          const code = (s.err as { code?: string })?.code;
          if (code === undefined) {
            failures.push(`${step.method}: request failed: ${s.err instanceof Error ? s.err.message : String(s.err)}`);
            continue;
          }
          if (step.expect && Object.keys(step.expect).length > 0) {
            failures.push(`${step.method}: expected success, got error [${code}] ${String((s.err as { message?: string }).message)}`);
          }
          continue;
        }
        if (step.expect) partialMatch(s.res, step.expect, step.method, failures);
        if (step.expectStalePlan && (s.res as { status?: string }).status !== "stale-plan") {
          failures.push(`${step.method}: want stale-plan, got ${JSON.stringify(s.res)}`);
        }
      }
      if (step.expectResult) {
        const result = await waitForResult();
        partialMatch(result, step.expectResult, "skills_result", failures);
      }
      const last = settled[settled.length - 1];
      if (last?.ok) prev = last.res;
    }

    serviceStats();
  } catch (err) {
    failures.push(`runner: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }

  // --- tool errors observed by the mock sessions ------------------------------
  const toolErrors: Record<string, string> = {};
  for (const session of backend.sessions.values()) {
    for (const t of session.executedTools) {
      if (!t.isError) continue;
      const text = typeof t.result === "string" ? t.result : JSON.stringify(t.result ?? "");
      const m = text.match(/^\[([A-Z_]+)\] /);
      if (m) toolErrors[t.toolName] = m[1];
      else if (!toolErrors[t.toolName]) toolErrors[t.toolName] = "UNKNOWN";
    }
  }

  // --- final expectations ------------------------------------------------------
  const finalView: Record<string, unknown> = {
    results: results.length,
    replacements: maxReplacements,
    doneOutcomes: outcomes.done ?? 0,
    unavailableOutcomes: outcomes.unavailable ?? 0,
    abortedOutcomes: outcomes.aborted ?? 0,
    supersededOutcomes: outcomes.superseded ?? 0,
    toolCalls,
    toolErrors,
    promptAborted,
    storm,
  };
  for (const [key, want] of Object.entries(scenario.expect ?? {})) {
    if (key === "note") continue;
    const have = finalView[key];
    if (key === "toolCalls" || key === "toolErrors" || key === "storm") {
      partialMatch(have, want as Record<string, unknown>, key, failures);
    } else {
      try {
        assert.deepEqual(have, want);
      } catch {
        failures.push(`expect.${key} = ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
      }
    }
  }

  return {
    name: scenario.name,
    ok: failures.length === 0,
    failures,
    results,
    toolCalls,
    toolErrors,
    promptAborted,
    replacements: maxReplacements,
    outcomes,
    storm,
  };
}

/** Load and run every scenario JSON in a directory. */
export async function runScenarioDir(dir: string, opts: { log?: Logger } = {}): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const scenario = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Scenario;
    out.push(await runScenario(scenario, opts));
  }
  return out;
}
