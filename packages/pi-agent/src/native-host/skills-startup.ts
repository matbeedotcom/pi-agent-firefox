/**
 * Skills runtime startup for the native host (skills-runtime-design.md §3, §13).
 *
 * The broker owns the registry and the SkillsService. The registry is
 * best-effort: a missing or invalid packages root degrades to "no skills"
 * and never blocks browser integration startup.
 */
import { discoverSkillPackages, SkillsRegistry } from "../skills/registry.js";
import { createSkillsHost, type SkillsHost } from "../skills/pi-integration.js";
import { SkillsPlanner } from "../skills/planner.js";
import { resolveSkillPackageRoots } from "../skills/package-roots.js";
import { PiSdkBackend } from "../acp/sdk-backend.js";
import type { PiBackend } from "../acp/backend.js";
import type { BrowserToolBridge } from "../tool-bridge.js";
import type { Logger } from "../logger.js";
import { toErrorObject } from "@pi-browser/protocol";
import { createSkillsProtocol } from "../skills/skills-protocol.js";
import type { SkillAdapterCoverage, SkillGrant } from "../skills/planner.js";
import type { IsolatedSessionFactory } from "../skills/isolated-runner.js";
import type { AcpTransport } from "./transport.js";

export interface SkillsRuntime {
  host: SkillsHost;
  registry: SkillsRegistry;
  /** Compiled from the registry snapshot at startup. v1 has no runtime
   * package reload, so the planner never goes stale; a future reload path
   * must rebuild it from registry.snapshot(). */
  planner: SkillsPlanner;
}

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
    if (packages.length > 0) await registry.reload(packages);
    const host = createSkillsHost({
      log: deps.log,
      registry,
      browserBridge: deps.toolBridge,
      // Reuse the backend's model runtime so provider credentials resolve
      // identically for job sessions and chat sessions.
      ...(deps.backend instanceof PiSdkBackend ? { modelRuntime: await deps.backend.sharedModelRuntime() } : {}),
      ...(process.env.PI_BROWSER_AGENT_DIR ? { agentDir: process.env.PI_BROWSER_AGENT_DIR } : {}),
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
  /** Agent hook: claims x-pi-browser/skills_* requests from one client. */
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
  adapters?: () => readonly SkillAdapterCoverage[];
}): ClientSkillsProtocol {
  const protocol = createSkillsProtocol({
    log: deps.log,
    host: deps.runtime.host,
    registry: deps.runtime.registry,
    planner: deps.runtime.planner,
    grants: deps.grants ?? (() => new Map()),
    adapters: deps.adapters ?? (() => []),
    endpoint: deps.transport,
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
