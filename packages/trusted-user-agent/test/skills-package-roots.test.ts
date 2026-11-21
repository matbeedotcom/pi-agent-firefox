import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DEFAULT_DATA_ROOT, resolveSkillPackageRoots } from "../src/skills/package-roots.js";

test("default: <data root>/packages only", () => {
  assert.deepEqual(resolveSkillPackageRoots({}), [path.join(DEFAULT_DATA_ROOT, "packages")]);
});

test("PI_BROWSER_DATA_ROOT relocates the packages root", () => {
  assert.deepEqual(resolveSkillPackageRoots({ PI_BROWSER_DATA_ROOT: "/tmp/data" }), [path.join("/tmp/data", "packages")]);
});

test("PI_BROWSER_SKILL_ROOTS adds external roots, deduplicated and resolved", () => {
  const extra = ["/tmp/a", "/tmp/a", " "].join(path.delimiter);
  const roots = resolveSkillPackageRoots({ PI_BROWSER_DATA_ROOT: "/tmp/data", PI_BROWSER_SKILL_ROOTS: extra });
  assert.deepEqual(roots, [path.join("/tmp/data", "packages"), path.resolve("/tmp/a")]);
});
