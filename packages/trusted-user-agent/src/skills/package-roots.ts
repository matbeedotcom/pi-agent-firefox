/**
 * Skill package root resolution (skills-runtime-design.md §3).
 *
 * Application data lives under a configurable native-host data root
 * (default ~/.pi/browser): `packages/` holds skill source packages.
 * TRUSTED_UA_SKILL_ROOTS adds registered external package roots
 * (path.delimiter separated).
 */
import path from "node:path";
import { homedir } from "node:os";
import { homeRoot, legacyDataRoot } from "../paths.js";
import { envValue } from "../env.js";

/** Default data root (`~/.trusted-ua`). */
export const DEFAULT_DATA_ROOT = homeRoot(homedir());

export function resolveSkillPackageRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicitRoot = envValue("DATA_ROOT", env)?.trim();
  const roots: string[] = [path.join(explicitRoot || DEFAULT_DATA_ROOT, "packages")];
  // Packages installed by v0.4.0 under ~/.pi/browser/packages stay available.
  if (!explicitRoot) roots.push(path.join(legacyDataRoot(homedir()), "packages"));
  const extra = envValue("SKILL_ROOTS", env)?.trim();
  if (extra) {
    for (const entry of extra.split(path.delimiter)) {
      const root = entry.trim();
      if (root) roots.push(path.resolve(root));
    }
  }
  return [...new Set(roots)];
}
