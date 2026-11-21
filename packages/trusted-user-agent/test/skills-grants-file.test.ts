import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillsGrantFile, skillsGrantsPath } from "../src/skills/grants-file.js";
import type { Logger } from "../src/logger.js";

const SHA = "a".repeat(64);
const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function withDataRoot(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "skills-grants-test-"));
  const prev = process.env.PI_BROWSER_DATA_ROOT;
  process.env.PI_BROWSER_DATA_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_BROWSER_DATA_ROOT;
    else process.env.PI_BROWSER_DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("missing file: nothing granted, no throw", async () => {
  await withDataRoot(async () => {
    const grants = loadSkillsGrantFile(quiet)();
    assert.equal(grants.size, 0);
  });
});

test("valid grant file: keyed by skillKey, revision-bound", async () => {
  await withDataRoot(async (dir) => {
    const file = skillsGrantsPath();
    await writeFile(file, JSON.stringify({
      grants: [{
        skillKey: "tone-rewrite/tone",
        revision: SHA,
        capabilities: ["context.read", "suggestion.present", "draft.replace-on-accept"],
        mode: "advisory",
      }],
    }));
    const grants = loadSkillsGrantFile(quiet)();
    assert.equal(grants.size, 1);
    const grant = grants.get("tone-rewrite/tone");
    assert.ok(grant);
    assert.equal(grant.enabled, true);
    assert.equal(grant.revision, SHA);
    assert.equal(grant.mode, "advisory");
    assert.deepEqual(grant.capabilities, ["context.read", "suggestion.present", "draft.replace-on-accept"]);
  });
});

test("revision must be a 64-char sha256 (real grants are revision-bound)", async () => {
  await withDataRoot(async (dir) => {
    const file = skillsGrantsPath();
    await writeFile(file, JSON.stringify({
      grants: [{ skillKey: "p/s", revision: "not-a-sha", capabilities: ["context.read"] }],
    }));
    assert.equal(loadSkillsGrantFile(quiet)().size, 0);
  });
});

test("invalid capability fails closed", async () => {
  await withDataRoot(async (dir) => {
    const file = skillsGrantsPath();
    await writeFile(file, JSON.stringify({
      grants: [{ skillKey: "p/s", revision: SHA, capabilities: ["not.a.capability"] }],
    }));
    assert.equal(loadSkillsGrantFile(quiet)().size, 0);
  });
});

test("unknown root field fails closed", async () => {
  await withDataRoot(async (dir) => {
    const file = skillsGrantsPath();
    await writeFile(file, JSON.stringify({ grants: [], extra: 1 }));
    assert.equal(loadSkillsGrantFile(quiet)().size, 0);
  });
});

test("re-read on file change (plan-time live reload)", async () => {
  await withDataRoot(async (dir) => {
    const file = skillsGrantsPath();
    const grants = loadSkillsGrantFile(quiet);
    assert.equal(grants().size, 0);
    await writeFile(file, JSON.stringify({
      grants: [{ skillKey: "p/s", revision: SHA, capabilities: ["context.read"] }],
    }));
    assert.equal(grants().size, 1);
    // unchanged file: same empty/identity result, no re-parse warning
    assert.equal(grants().size, 1);
  });
});

test("corrupt file fails closed (warn once, empty)", async () => {
  await withDataRoot(async (dir) => {
    const file = skillsGrantsPath();
    await writeFile(file, "{ not json");
    const grants = loadSkillsGrantFile(quiet);
    assert.equal(grants().size, 0);
    assert.equal(grants().size, 0);
  });
});
