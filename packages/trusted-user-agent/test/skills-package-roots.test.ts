import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { DEFAULT_DATA_ROOT, resolveSkillPackageRoots } from "../src/skills/package-roots.js";

test("default: ~/.trusted-ua/packages, then the v0.4.0 ~/.pi/browser/packages", () => {
  assert.deepEqual(resolveSkillPackageRoots({}), [
    path.join(DEFAULT_DATA_ROOT, "packages"),
    path.join(homedir(), ".pi", "browser", "packages"),
  ]);
  assert.match(DEFAULT_DATA_ROOT, /\.trusted-ua$/);
});

test("TRUSTED_UA_DATA_ROOT wins over PI_BROWSER_DATA_ROOT; an explicit root has no fallback", () => {
  assert.deepEqual(
    resolveSkillPackageRoots({ TRUSTED_UA_DATA_ROOT: "/tmp/new", PI_BROWSER_DATA_ROOT: "/tmp/old" }),
    [path.join("/tmp/new", "packages")],
  );
});

test("PI_BROWSER_DATA_ROOT relocates the packages root", () => {
  assert.deepEqual(resolveSkillPackageRoots({ PI_BROWSER_DATA_ROOT: "/tmp/data" }), [path.join("/tmp/data", "packages")]);
});

test("PI_BROWSER_SKILL_ROOTS adds external roots, deduplicated and resolved", () => {
  const extra = ["/tmp/a", "/tmp/a", " "].join(path.delimiter);
  const roots = resolveSkillPackageRoots({ PI_BROWSER_DATA_ROOT: "/tmp/data", PI_BROWSER_SKILL_ROOTS: extra });
  assert.deepEqual(roots, [path.join("/tmp/data", "packages"), path.resolve("/tmp/a")]);
});
