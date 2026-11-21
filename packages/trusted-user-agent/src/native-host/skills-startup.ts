/**
 * Skills runtime startup for the native host (skills-runtime-design.md §3, §13).
 *
 * The broker owns the registry and the SkillsService. The registry is
 * best-effort: a missing or invalid packages root degrades to "no skills"
 * and never blocks browser integration startup.
 */
import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { appendFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SkillsLifecycleEvent } from "../skills/skills-protocol.js";
import { discoverSkillPackages, SkillsRegistry } from "../skills/registry.js";
import { createSkillsHost, type SkillsHost } from "../skills/pi-integration.js";
import { SkillsPlanner } from "../skills/planner.js";
import { resolveSkillPackageRoots } from "../skills/package-roots.js";
import { PiSdkBackend } from "../acp/sdk-backend.js";
import type { PiBackend } from "../acp/backend.js";
import type { BrowserToolBridge } from "../tool-bridge.js";
import type { Logger } from "../logger.js";
import { toErrorObject } from "@trusted-ua/protocol";
import { createSkillsProtocol } from "../skills/skills-protocol.js";
import type { SkillGrant } from "../skills/planner.js";
import type { IsolatedSessionFactory } from "../skills/isolated-runner.js";
import type { AcpTransport } from "./transport.js";
import { runDir as brokerRunDir } from "../paths.js";
import { piAgentDir } from "../env.js";

export interface SkillsRuntime {
  host: SkillsHost;
  registry: SkillsRegistry;
  /** Rebuilt on every catalog reload (planner.reload) from the current
   * registry snapshot, so per-client protocol surfaces keep one instance. */
  planner: SkillsPlanner;
}

/** Discover the skill packages under every configured root (best-effort). */
async function loadSkillPackages(): Promise<string[]> {
  const packageRoots = resolveSkillPackageRoots();
  const packages = (
    await Promise.all(
      packageRoots.map(async (root) => {
        try {
          return await discoverSkillPackages(root);
        } catch {
          return []; // root absent (first run) — nothing to load from it
        }
      }),
    )
  ).flat();
  return packages;
}

/**
 * One catalog reload: re-discover the packages, atomically swap the
 * registry snapshot, and rebuild the planner index from it. A failed
 * reload preserves the previous snapshot (registry.reload contract), so a
 * half-written package can never take down the running catalog.
 */
export async function reloadSkillCatalog(
  log: Logger,
  runtime: SkillsRuntime,
): Promise<{ packages: number; skills: number; generation: number }> {
  const packages = await loadSkillPackages();
  await runtime.registry.reload(packages);
  runtime.planner.reload(runtime.registry.snapshot());
  const result = { packages: packages.length, skills: runtime.registry.size, generation: runtime.registry.version };
  log.info(`skills catalog reloaded (packages=${result.packages}, skills=${result.skills}, generation=${result.generation})`);
  return result;
}

const SKILLS_EVENT_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Bounded JSONL lifecycle log (run dir `skills-events.jsonl`): one line per
 * plan compile / event ack / job result / catalog reload. This is the
 * agent's machine-readable observation channel for live skill development
 * (the fixture beacon's host-side counterpart). Rotates to `.1` at 1 MiB.
 */
export interface SkillsEventLog {
  record(event: SkillsLifecycleEvent): void;
  close(): Promise<void>;
}

export function createSkillsEventLog(log: Logger, filePath: string): SkillsEventLog {
  let tail: Promise<void> = Promise.resolve();
  return {
    record(event: SkillsLifecycleEvent) {
      const line = `${JSON.stringify({ t: Date.now(), ...event })}\n`;
      tail = tail.then(async () => {
        try {
          // The first write creates the file; statSync is for rotation only.
          try {
            if (statSync(filePath).size > SKILLS_EVENT_LOG_MAX_BYTES) {
              await rename(filePath, `${filePath}.1`).catch(() => {});
            }
          } catch { /* no file yet */ }
          await appendFile(filePath, line, "utf8");
        } catch (err) {
          log.warn(`skills event log write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }).catch(() => {});
    },
    close: async () => { await tail.catch(() => {}); },
  };
}

/**
 * Dev-loop catalog reloader: the agent touches ONE file in the broker run
 * dir and the broker re-reads the skill packages without a host restart.
 *
 * Semantics:
 * - The trigger file is CONSUMED (unlinked) per reload; a second reload
 *   needs a second touch.
 * - Effective at the NEXT plan compile: a (re)loaded page re-arms from the
 *   new catalog immediately; existing armed plans run out their 60 s life.
 * - Reloads are debounced (250 ms) and serialized; failures log and keep
 *   the old snapshot, the agent re-touches to retry.
 */
export interface SkillsCatalogReloader {
  /** The file the agent touches to request a reload. */
  readonly path: string;
  close(): Promise<void>;
}

export function startSkillsCatalogReloader(deps: {
  log: Logger;
  runtime: SkillsRuntime;
  /** JSONL observation sink for reload outcomes. */
  record?: (event: SkillsLifecycleEvent) => void;
}): SkillsCatalogReloader {
  const runDir = brokerRunDir();
  const triggerPath = path.join(runDir, SKILLS_CATALOG_RELOAD_FILE);
  // Normally the broker created it already; don't depend on that ordering.
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | undefined;
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  const watcher: FSWatcher = watch(runDir, (eventType, filename) => {
    if (closed || filename !== SKILLS_CATALOG_RELOAD_FILE) return;
    // Consume the request IMMEDIATELY: the unlink itself fires a watch
    // event, and consuming at execution time would re-arm a second reload.
    void unlink(triggerPath).catch(() => { /* gone (double touch) — reload once */ });
    // Debounce: touch + the consuming unlink arrive as separate events;
    // the latter only re-arms the timer (the file is already gone).
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      tail = tail.then(async () => {
        try {
          const result = await reloadSkillCatalog(deps.log, deps.runtime);
          deps.record?.({ type: "reload", ...result, ok: true });
        } catch (err) {
          deps.log.warn(`skills catalog reload failed; keeping previous snapshot: ${err instanceof Error ? err.message : String(err)}`);
          deps.record?.({ type: "reload", packages: deps.runtime.registry.size, skills: deps.runtime.registry.size, generation: deps.runtime.registry.version, ok: false });
        }
      }).catch(() => {});
    }, 250);
  });
  watcher.on("error", (err) => deps.log.warn(`skills catalog reload watcher error: ${err.message}`));
  deps.log.info(`skills catalog reload armed: touch ${triggerPath}`);
  return {
    path: triggerPath,
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
      await tail.catch(() => {});
    },
  };
}

/** Trigger file name inside the broker run dir (host-side dev seam only). */
export const SKILLS_CATALOG_RELOAD_FILE = "skills-catalog-reload";

export async function startSkillsRuntime(deps: {
  log: Logger;
  backend: PiBackend;
  toolBridge: BrowserToolBridge;
  /** Test seam: scripted isolated-session factory (mock backend only). */
  sessionFactory?: IsolatedSessionFactory;
}): Promise<SkillsRuntime | undefined> {
  const registry = new SkillsRegistry();
  try {
    const packageRoots = resolveSkillPackageRoots();
    const packages = await loadSkillPackages();
    if (packages.length > 0) await registry.reload(packages);
    const host = createSkillsHost({
      log: deps.log,
      registry,
      browserBridge: deps.toolBridge,
      // Reuse the backend's model runtime so provider credentials resolve
      // identically for job sessions and chat sessions.
      ...(deps.backend instanceof PiSdkBackend ? { modelRuntime: await deps.backend.sharedModelRuntime() } : {}),
      ...(piAgentDir() ? { agentDir: piAgentDir() } : {}),
      ...(deps.sessionFactory ? { sessionFactory: deps.sessionFactory } : {}),
    });
    deps.log.info(
      `skills host ready (package roots=${packageRoots.length}, packages=${packages.length}, skills=${registry.snapshot().length})`,
    );
    return { host, registry, planner: new SkillsPlanner(registry.snapshot()) };
  } catch (err) {
    deps.log.warn("skills runtime unavailable; continuing without skills", err);
    return undefined;
  }
}

export interface ClientSkillsProtocol {
  /** Agent hook: claims x-trusted-ua/skills_* requests from one client. */
  extendedRequest: (method: string, params: unknown, id: number) => boolean;
  /** Drop this client's plans and cancel its in-flight jobs (on disconnect). */
  dispose: () => void;
}

/**
 * One skills protocol surface per client connection (design §7): verified
 * source identity is per-connection, results route back on the same
 * transport. v1 ships no settings store and no site adapters, so nothing is
 * granted and no plan arms a rule: the surface is fully wired but inert by
 * design (design §12: installed ≠ enabled ≠ armed). The getters are injected
 * so a later settings/adapter module swaps in real values without touching
 * the host wiring.
 */
export function createClientSkillsProtocol(deps: {
  log: Logger;
  runtime: SkillsRuntime;
  transport: AcpTransport;
  grants?: () => ReadonlyMap<string, SkillGrant>;
  /** Shared JSONL observation sink (one per broker, all clients). */
  record?: (event: SkillsLifecycleEvent) => void;
}): ClientSkillsProtocol {
  const protocol = createSkillsProtocol({
    log: deps.log,
    host: deps.runtime.host,
    registry: deps.runtime.registry,
    planner: deps.runtime.planner,
    grants: deps.grants ?? (() => new Map()),
    endpoint: deps.transport,
    ...(deps.record ? { onLifecycle: deps.record } : {}),
  });
  return {
    extendedRequest: (method, params, id) =>
      protocol.handle(
        method,
        params,
        (result) => deps.transport.respond(id, result),
        (code, message) => deps.transport.respondError(id, toErrorObject(code, message)),
      ),
    dispose: () => protocol.dispose(),
  };
}
