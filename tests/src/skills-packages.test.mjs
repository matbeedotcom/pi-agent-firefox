/**
 * Test skill packages for the controlled skills matrix.
 *
 * `tests/skills-packages/` holds deterministic, registry-validated skill
 * packages (activation.json + SKILL.md, design §3) scoped to the 127.0.0.1
 * fixture origin. The e2e harness points PI_BROWSER_SKILL_ROOTS at this
 * directory; these tests prove the packages parse and register.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverSkillPackages, SkillsRegistry } from "@pi-browser/agent/dist/skills/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = path.resolve(HERE, "..", "skills-packages");

// The page adapters (fixture/*) live on the host side (scenario skillsConfig);
// the packages here carry only skill definitions.
const EXPECTED = [
  "fixture-reply/reply",
  "fixture-keyboard/reply",
  "fixture-contenteditable/reply",
];

test("discoverSkillPackages finds the three fixture packages", async () => {
  // The root also holds non-fixture packages (fb-comment-tone, tone-rewrite);
  // the matrix contract is that the three fixture packages are present.
  const found = (await discoverSkillPackages(PACKAGES_ROOT)).map((p) => path.basename(p));
  for (const name of ["fixture-contenteditable", "fixture-keyboard", "fixture-reply"]) {
    assert.ok(found.includes(name), `missing package ${name} (found: ${found.join(", ")})`);
  }
});

test("SkillsRegistry.reload registers all skills with valid definitions", async () => {
  const registry = new SkillsRegistry();
  const discovered = await discoverSkillPackages(PACKAGES_ROOT);
  await registry.reload(discovered);
  const snapshot = registry.snapshot();
  // Every discovered package registers (one skill each) — none is rejected.
  assert.equal(snapshot.length, discovered.length);
  for (const key of EXPECTED) {
    const skill = registry.get(key);
    assert.ok(skill, `missing skill ${key}`);
    assert.equal(skill.definition.type, "triggered");
    // v2: scope lives on the package manifest, not the skill definition.
    assert.equal(skill.manifest.application, "firefox");
    assert.ok(skill.manifest.hosts.includes("127.0.0.1"), `${key} must scope to the fixture host`);
    // CSS-dialect targets (bare selector strings normalize to { selector, kind: "css" }).
    assert.equal(skill.manifest.targets.composer.kind, "css");
    assert.ok(skill.definition.subscriptions.some((s) => s.event === "before-submit" && skill.manifest.events[s.event].kind === "gate"));
    assert.ok(skill.definition.subscriptions.some((s) => s.event === "draft.paused"));
    assert.equal(skill.definition.review.defaultMode, "review-before-submit");
    assert.ok(skill.definition.capabilities.includes("suggestion.present"));
    assert.ok(skill.definition.capabilities.includes("draft.replace-on-accept"));
    assert.equal(skill.definition.execution.handler, "agent");
    assert.ok(skill.instructions.includes(`Fixture reply: ${key.split("/")[0]}`), `${key} instructions carry the assertion token`);
    assert.ok(skill.revision.length === 64, "revision is a sha256 hex digest");
  }
  assert.ok(registry.version >= 1);
});
