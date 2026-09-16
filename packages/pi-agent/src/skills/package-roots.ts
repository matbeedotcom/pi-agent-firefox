/**
 * Skill package root resolution (skills-runtime-design.md §3).
 *
 * Application data lives under a configurable native-host data root
 * (default ~/.pi/browser): `packages/` holds skill source packages.
 * PI_BROWSER_SKILL_ROOTS adds registered external package roots
 * (path.delimiter separated).
 */
import path from "node:path";
import { homedir } from "node:os";

export const DEFAULT_DATA_ROOT = path.join(homedir(), ".pi", "browser");

export function resolveSkillPackageRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const dataRoot = env.PI_BROWSER_DATA_ROOT?.trim() || DEFAULT_DATA_ROOT;
  const roots: string[] = [path.join(dataRoot, "packages")];
  const extra = env.PI_BROWSER_SKILL_ROOTS?.trim();
  if (extra) {
    for (const entry of extra.split(path.delimiter)) {
      const root = entry.trim();
      if (root) roots.push(path.resolve(root));
    }
  }
  return [...new Set(roots)];
}
