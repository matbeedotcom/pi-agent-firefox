/**
 * Skills runtime startup for the native host (skills-runtime-design.md §3, §13).
 *
 * The broker owns the registry and the SkillsService. The registry is
 * best-effort: a missing or invalid packages root degrades to "no skills"
 * and never blocks browser integration startup.
 */
import { discoverSkillPackages, SkillsRegistry } from "../skills/registry.js";
import { createSkillsHost, type SkillsHost } from "../skills/pi-integration.js";
export type { SkillsHost };
import { resolveSkillPackageRoots } from "../skills/package-roots.js";
import { PiSdkBackend } from "../acp/sdk-backend.js";
import type { PiBackend } from "../acp/backend.js";
import type { BrowserToolBridge } from "../tool-bridge.js";
import type { Logger } from "../logger.js";

export async function startSkillsRuntime(deps: {
  log: Logger;
  backend: PiBackend;
  toolBridge: BrowserToolBridge;
}): Promise<SkillsHost | undefined> {
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
    });
    deps.log.info(
      `skills host ready (package roots=${packageRoots.length}, packages=${packages.length}, skills=${registry.snapshot().length})`,
    );
    return host;
  } catch (err) {
    deps.log.warn("skills runtime unavailable; continuing without skills", err);
    return undefined;
  }
}
