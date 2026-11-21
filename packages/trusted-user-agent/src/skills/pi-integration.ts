/**
 * Skills host wiring (skills-runtime-design.md §10, §13 "pi-integration").
 *
 * createSkillsHost() assembles the host-owned pieces:
 * - the bounded SkillsService (scheduling, deadlines, deduplication, admission)
 * - the IsolatedSkillRunner (isolated job execution)
 * - the extension-facing SkillsBridge (installed process-wide for extensions)
 *
 * The factory registers capabilities; it starts no global watchers or
 * background loops. SkillsService is owned by the embedding native host:
 * the host calls close() on shutdown, which drains every job and clears the
 * bridge.
 */
import { EventEmitter } from "node:events";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SkillJobOutcome } from "./skills-service.js";
import { SkillsService, type SkillJobKind, type SkillJobLimits } from "./skills-service.js";
import { IsolatedSkillRunner, type IsolatedSessionFactory, type SkillJobSpec } from "./isolated-runner.js";
import { setSkillsBridge, type SkillsBridge, type SkillsSessionBinding } from "./pi-bridge.js";
import type { SkillsRegistry } from "./registry.js";
import type { BrowserToolBridge } from "../tool-bridge.js";
import type { Logger } from "../logger.js";

export interface SkillsHostDeps {
  log: Logger;
  limits?: Partial<SkillJobLimits>;
  modelRuntime?: ModelRuntime;
  model?: unknown;
  cwd?: string;
  agentDir?: string;
  browserBridge?: BrowserToolBridge;
  /** Resolves active-skill keys (runActive); optional for host-side submit. */
  registry?: SkillsRegistry;
  sessionFactory?: IsolatedSessionFactory;
}

export interface SkillsHost {
  service: SkillsService;
  runner: IsolatedSkillRunner;
  bridge: SkillsBridge;
  /** Submit a job through the service; resolves with the job's fate. */
  submit(spec: SkillJobSpec): Promise<SkillJobOutcome>;
  cancel(key: string): number;
  /** Drain every job and clear the process-wide bridge. */
  close(): Promise<void>;
}

function kindFor(type: "triggered" | "active" | "passive"): SkillJobKind {
  return type === "triggered" ? "gate" : type === "active" ? "active" : "passive";
}

export function createSkillsHost(deps: SkillsHostDeps): SkillsHost {
  const runner = new IsolatedSkillRunner({
    log: deps.log,
    ...(deps.modelRuntime ? { modelRuntime: deps.modelRuntime } : {}),
    ...(deps.model !== undefined ? { model: deps.model } : {}),
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
    ...(deps.browserBridge ? { browserBridge: deps.browserBridge } : {}),
    ...(deps.sessionFactory ? { sessionFactory: deps.sessionFactory } : {}),
  });
  const service = new SkillsService(deps.limits);
  const events = new EventEmitter();
  let sessionBinding: SkillsSessionBinding | undefined;
  let attached = 0;

  const submit = (spec: SkillJobSpec): Promise<SkillJobOutcome> => {
    const key = spec.key ?? `${spec.skill.key}:${spec.eventId}`;
    const kind = spec.kind ?? kindFor(spec.skill.definition.type);
    const promise = service.submit({
      key,
      kind,
      timeoutMs: spec.timeoutMs ?? spec.skill.definition.execution.timeoutMs,
      // The service settles "done" with the run body's return value, so
      // return the raw report — never a pre-shaped outcome (double wrapping).
      run: (signal) =>
        runner.run(spec, signal).then((result) => {
          if (!result.ok || !result.report) throw new Error(result.error ?? "skill job failed");
          return result.report;
        }),
    });
    void promise.then((outcome) => events.emit("job-result", { key, outcome }));
    return promise;
  };

  const bridge: SkillsBridge = {
    runActive: (skillKey, instructions) => {
      const skill = deps.registry?.get(skillKey);
      if (!skill) {
        return Promise.resolve({ status: "unavailable", reason: `unknown skill: ${skillKey}` });
      }
      const spec: SkillJobSpec = {
        skill,
        context: JSON.stringify({ invocation: "active", instructions: instructions ?? "" }),
        eventId: "active",
        jobId: `active:${skillKey}`,
        kind: "active",
        grantedTools: [],
        key: `${skillKey}:active`,
      };
      return submit(spec);
    },
    cancel: (key) => service.cancel(key),
    get stats() {
      return service.stats;
    },
    bindSession: (binding) => {
      sessionBinding = binding;
    },
    unbindSession: () => {
      sessionBinding = undefined;
    },
    currentBinding: () => sessionBinding,
    sessionAttached: () => {
      attached += 1;
    },
    sessionDetached: () => {
      attached = Math.max(0, attached - 1);
    },
    onJobResult: (cb) => {
      const handler = (data: unknown) => cb(data as { key: string; outcome: SkillJobOutcome });
      events.on("job-result", handler);
      return () => events.off("job-result", handler);
    },
  };

  const host: SkillsHost = {
    service,
    runner,
    bridge,
    submit,
    cancel: (key) => service.cancel(key),
    close: async () => {
      // Clear the bridge first so no new extension-side work can arrive
      // while the service drains.
      setSkillsBridge(undefined);
      await service.close();
      events.removeAllListeners();
    },
  };
  setSkillsBridge(bridge);
  return host;
}
