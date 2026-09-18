import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSkillPackage, parseSkillEvent, parseReviewResult, type RegisteredSkill } from "@pi-browser/protocol";
import { SkillsRegistry, discoverSkillPackages } from "../src/skills/registry.js";
import { SkillsPlanner, type SkillGrant } from "../src/skills/planner.js";

function manifest(packageId = "test-package", host = "example.com") {
  return {
    schemaVersion: 2, packageId, application: "firefox", hosts: [host],
    targets: { composer: "composer-x", submit: "submit-x" },
    events: {
      "before-submit": {
        kind: "gate", chainId: "t-submit",
        alternatives: [[{ dom: "click", target: "submit" }]],
        payload: { draft: { from: "composer", field: "value" }, replyTarget: { from: "composer", field: "text" } },
      },
      "draft.paused": {
        kind: "debounced", debounceMs: 100,
        sequence: [{ dom: "input", target: "composer" }],
        payload: { draft: { from: "composer", field: "value" } },
      },
      "mail.arrived": {
        kind: "debounced", debounceMs: 100,
        sequence: [{ dom: "input", target: "composer" }],
        payload: { draft: { from: "composer", field: "value" } },
      },
    },
    skills: [{ id: "friendliness", type: "triggered", instructions: "skills/friendliness/SKILL.md",
      subscriptions: [{ event: "before-submit" }],
      context: { required: ["draft", "replyTarget"], optional: [] },
      capabilities: ["context.read", "suggestion.present"], execution: { handler: "agent", timeoutMs: 10000 } }],
  };
}
function registered(packageId = "test-package", host = "example.com"): RegisteredSkill {
  const parsed = parseSkillPackage(manifest(packageId, host));
  return { key: `${packageId}/friendliness`, revision: "v1", packageId, definition: parsed.skills[0]!, instructions: "PRIVATE INSTRUCTIONS", manifest: parsed };
}
function registeredSubdomain(): RegisteredSkill {
  const parsed = parseSkillPackage({ ...manifest("sub-package", "example.com"), packageId: "sub-package", hosts: [], subdomainHosts: ["example.com"] });
  return { key: `sub-package/friendliness`, revision: "v1", packageId: "sub-package", definition: parsed.skills[0]!, instructions: "PRIVATE INSTRUCTIONS", manifest: parsed };
}
function grant(skill: RegisteredSkill): SkillGrant {
  return { enabled: true, revision: skill.revision, capabilities: ["context.read", "suggestion.present"] };
}
const context = { application: "firefox" as const, url: "https://example.com/thread", documentGeneration: "doc-1" };

test("manifest rejects escapes, code handlers, unknown operators and conflicting IDs", () => {
  for (const instructions of ["../SKILL.md", "/etc/SKILL.md", "skills/../SKILL.md", "skills\\SKILL.md", "C:/SKILL.md"]) {
    const input = manifest(); input.skills[0]!.instructions = instructions;
    assert.throws(() => parseSkillPackage(input));
  }
  const input = manifest(); input.skills.push(input.skills[0]!);
  assert.throws(() => parseSkillPackage(input), /Duplicate/);
  const executable = manifest(); executable.skills[0]!.execution.handler = "native";
  assert.throws(() => parseSkillPackage(executable), /Unsupported/);
  assert.throws(() => parseSkillPackage({ ...manifest(), extension: "evil.js" }), /Unknown field/);
  const unknownEvent = manifest(); unknownEvent.skills[0]!.subscriptions[0]!.event = "dom.anything";
  assert.throws(() => parseSkillPackage(unknownEvent), /undefined event/);
  const condition = manifest(); Object.assign(condition.skills[0]!.subscriptions[0]!, { conditions: { regex: ".*" } });
  assert.throws(() => parseSkillPackage(condition), /Unknown field/);
  const badTarget = manifest(); (badTarget.targets as Record<string, string>).composer = "el => {";
  assert.throws(() => parseSkillPackage(badTarget), /Target selector failed to parse/);
  const jsTarget = manifest(); (jsTarget.targets as Record<string, string>).composer = "el => true";
  assert.equal(parseSkillPackage(jsTarget).targets.composer!.kind, "js");
  assert.equal(parseSkillPackage(manifest()).targets.composer!.kind, "css");
  const textTarget = manifest(); (textTarget.targets as Record<string, unknown>).submit = { selector: "submit-x", text: "^(post|next)$", textFlags: "i" };
  assert.equal(parseSkillPackage(textTarget).targets.submit!.text, "^(post|next)$");
  const badRegex = manifest(); (badRegex.targets as Record<string, unknown>).submit = { selector: "submit-x", text: "(" };
  assert.throws(() => parseSkillPackage(badRegex), /text regex/);
});

test("gate events declare stopDefaultAction (default true); debounced events reject it", () => {
  const withFlag = manifest();
  (withFlag.events["before-submit"] as Record<string, unknown>).stopDefaultAction = false;
  assert.equal(parseSkillPackage(withFlag).events["before-submit"]!.stopDefaultAction, false);
  const defaulted = manifest();
  assert.equal(parseSkillPackage(defaulted).events["before-submit"]!.stopDefaultAction, undefined, "absent means the runtime default (hold)");
  const onDebounced = manifest();
  (onDebounced.events["draft.paused"] as Record<string, unknown>).stopDefaultAction = true;
  assert.throws(() => parseSkillPackage(onDebounced), /Invalid debounced event fields/);
});

test("active and passive contracts enforce their distinct activation requirements", () => {
  const active = manifest();
  Object.assign(active.skills[0]!, { type: "active", subscriptions: undefined, command: "reply" });
  assert.equal(parseSkillPackage(active).skills[0]!.command, "reply");
  const passive = manifest();
  Object.assign(passive.skills[0]!, { type: "passive", subscriptions: undefined, observations: [{ event: "mail.arrived" }], batch: { maxEvents: 64, maxWaitMs: 1000 } });
  assert.equal(parseSkillPackage(passive).skills[0]!.batch!.maxEvents, 64);
  Object.assign(passive.skills[0]!, { batch: { maxEvents: 65, maxWaitMs: 1000 } });
  assert.throws(() => parseSkillPackage(passive), /Invalid integer/);
});

test("review results reject replacement text on clearance and unknown decisions", () => {
  const base = { jobId: "j", eventId: "e", skillKey: "p/s", skillRevision: "r", decision: "clear" };
  assert.equal(parseReviewResult(base).decision, "clear");
  assert.throws(() => parseReviewResult({ ...base, replacementText: "changed" }));
  assert.throws(() => parseReviewResult({ ...base, decision: "submit" }));
  assert.equal(parseReviewResult({ ...base, decision: "suggest", replacementText: "" }).replacementText, "");
});

test("events require versioned bounded revisions and complete browser frame identity", () => {
  const event = { version: 1, eventId: "event", event: "test-package:before-submit", source: {
    application: "firefox", connectionEpoch: "epoch", documentGeneration: "doc", tabId: 0, frameId: 0,
  }, interactionId: "composer", contextRevision: 0, planVersion: 1, origin: "user", contextRef: "ref" };
  assert.deepEqual(parseSkillEvent(event), event);
  assert.throws(() => parseSkillEvent({ ...event, source: { ...event.source, frameId: undefined } }), /frame identity/);
  assert.throws(() => parseSkillEvent({ ...event, contextRevision: -1 }), /integer/);
  assert.throws(() => parseSkillEvent({ ...event, version: 2 }), /version/);
  assert.throws(() => parseSkillEvent({ ...event, event: "no-package-part" }), /Invalid event name/);
});

async function packageFixture(root: string, id: string, host = "example.com"): Promise<string> {
  const directory = path.join(root, id);
  await mkdir(path.join(directory, "skills/friendliness"), { recursive: true });
  await writeFile(path.join(directory, "activation.json"), JSON.stringify(manifest(id, host)));
  await writeFile(path.join(directory, "skills/friendliness/SKILL.md"), "---\nname: friendliness\ndescription: Review a reply\n---\nBe kind.");
  // Loading this package through an executable discovery mechanism would fail.
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", main: "evil.js", pi: { extensions: ["evil.js"] } }));
  await writeFile(path.join(directory, "evil.js"), "throw new Error('Package code executed');");
  return directory;
}

test("registry revisions, immutable snapshots, atomic failure, duplicate packages and symlink confinement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-runtime-"));
  try {
    const directory = await packageFixture(root, "test-package");
    const registry = new SkillsRegistry();
    await registry.reload([directory]);
    const first = registry.snapshot()[0]!;
    registry.snapshot()[0]!.definition.capabilities.length = 0;
    assert.equal(registry.get(first.key)!.definition.capabilities.length, 2);
    await writeFile(path.join(directory, "skills/friendliness/SKILL.md"), "Changed instructions");
    await registry.reload([directory]);
    assert.notEqual(first.revision, registry.get(first.key)!.revision);
    const second = registry.get(first.key)!;
    const updated = manifest(); updated.skills[0]!.execution.timeoutMs = 9999;
    await writeFile(path.join(directory, "activation.json"), JSON.stringify(updated));
    await registry.reload([directory]);
    assert.notEqual(second.revision, registry.get(first.key)!.revision);
    const version = registry.version;
    await assert.rejects(registry.reload([directory, directory]), /Duplicate package/);
    assert.equal(registry.version, version);
    const snapshot = registry.snapshot();
    await writeFile(path.join(root, "outside.md"), "outside");
    await rm(path.join(directory, "skills/friendliness/SKILL.md"));
    await symlink(path.join(root, "outside.md"), path.join(directory, "skills/friendliness/SKILL.md"));
    await assert.rejects(registry.reload([directory]), /escapes/);
    assert.deepEqual(registry.snapshot(), snapshot);
    await registry.reload([]);
    assert.equal(registry.snapshot().length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("1000 nonmatching packages load declaratively and produce an empty compact plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-scale-"));
  try {
    // Bound filesystem concurrency independently of registry size.
    for (let start = 0; start < 1000; start += 20) {
      await Promise.all(Array.from({ length: 20 }, (_, offset) => packageFixture(root, `package-${start + offset}`, "unrelated.example")));
    }
    const registry = new SkillsRegistry();
    await registry.reload(await discoverSkillPackages(root));
    assert.equal(registry.snapshot().length, 1000);
    const planner = new SkillsPlanner(registry.snapshot());
    const grants = new Map(registry.snapshot().map((skill) => [skill.key, grant(skill)]));
    const plan = planner.compile(context, grants, registry.version, 0);
    assert.deepEqual(plan.rules, []);
    assert.deepEqual(plan.unavailable, []);
    assert.ok(JSON.stringify(plan).length < 256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plans bind context and revisions, intersect grants and reveal no instruction text", () => {
  const skill = registered();
  const planner = new SkillsPlanner([skill]);
  const grants = new Map([[skill.key, { ...grant(skill), capabilities: ["context.read" as const] }]]);
  const plan = planner.compile(context, grants, 1, 0);
  assert.deepEqual(plan.rules[0]!.capabilities, ["context.read"]);
  assert.equal(plan.rules[0]!.world, "isolated");
  assert.equal(plan.expiresAt, 60_000);
  assert.ok(!JSON.stringify(plan).includes("PRIVATE INSTRUCTIONS"));
  assert.notEqual(planner.compile({ ...context, documentGeneration: "doc-2" }, grants, 1, 0).planId, plan.planId);
  grants.get(skill.key)!.revision = "old";
  const stale = planner.compile(context, grants, 2);
  assert.equal(stale.rules.length, 0);
  assert.match(stale.unavailable[0]!.reason, /Package changed/);
});

test("exact hosts, subdomain boundaries, frame URLs and account bindings", () => {
  const skill = registered();
  const grants = new Map([[skill.key, grant(skill)]]);
  const planner = new SkillsPlanner([skill]);
  for (const host of ["www.example.com", "badexample.com", "example.com.attacker.test"]) {
    assert.equal(planner.compile({ ...context, url: `https://${host}` }, grants, 1).rules.length, 0);
  }
  // Subdomain packages match the apex and its children, never lookalikes.
  const subdomainPlanner = new SkillsPlanner([registeredSubdomain()]);
  const subGrants = new Map([[registeredSubdomain().key, grant(registeredSubdomain())]]);
  assert.equal(subdomainPlanner.compile({ ...context, url: "https://www.example.com/thread" }, subGrants, 1).rules.length, 1);
  assert.equal(subdomainPlanner.compile({ ...context, url: "https://notexample.com/thread" }, subGrants, 1).rules.length, 0);
  grants.set(skill.key, { ...grant(skill), accounts: ["account-1"] });
  assert.equal(planner.compile(context, grants, 1).rules.length, 0);
  assert.equal(planner.compile({ ...context, accountId: "account-1" }, grants, 1).rules.length, 1);
});

test("review-before-submit without a gate subscription is explicitly unavailable", () => {
  const manifest2 = manifest();
  manifest2.skills[0]!.subscriptions = [{ event: "draft.paused" }];
  const parsed = parseSkillPackage(manifest2);
  const skill: RegisteredSkill = { key: "test-package/friendliness", revision: "v1", packageId: "test-package", definition: parsed.skills[0]!, instructions: "Be kind.", manifest: parsed };
  const planner = new SkillsPlanner([skill]);
  const grants = new Map([[skill.key, { ...grant(skill), mode: "review-before-submit" as const }]]);
  const plan = planner.compile(context, grants, 1);
  assert.equal(plan.rules.length, 0);
  assert.match(plan.unavailable[0]!.reason, /gate event/);
  // Advisory mode is fine with debounced-only subscriptions.
  const advisory = new Map([[skill.key, { ...grant(skill), mode: "advisory" as const }]]);
  assert.equal(planner.compile(context, advisory, 1).rules.length, 1);
});

test("world placement is manifest-derived: any JS target moves the whole rule", () => {
  const manifest2 = manifest();
  (manifest2.targets as Record<string, string>).composer = "el => el !== null";
  const parsed = parseSkillPackage(manifest2);
  const skill: RegisteredSkill = { key: "test-package/friendliness", revision: "v1", packageId: "test-package", definition: parsed.skills[0]!, instructions: "Be kind.", manifest: parsed };
  const planner = new SkillsPlanner([skill]);
  const grants = new Map([[skill.key, grant(skill)]]);
  const plan = planner.compile(context, grants, 1);
  assert.equal(plan.rules[0]!.world, "main");
});

test("matching overload refuses the entire plan and disabling removes a rule", () => {
  const skills = Array.from({ length: 65 }, (_, index) => registered(`package-${index}`));
  const planner = new SkillsPlanner(skills);
  const grants = new Map(skills.map((skill) => [skill.key, grant(skill)]));
  assert.throws(() => planner.compile(context, grants, 1), /limit exceeded/);
  grants.get(skills[0]!.key)!.enabled = false;
  assert.equal(planner.compile(context, grants, 2).rules.length, 64);
});

test("planner.reload swaps the index atomically (catalog reload)", () => {
  const a = registered("pkg-a");
  const b = registered("pkg-b");
  const planner = new SkillsPlanner([a]);
  assert.equal(planner.compile(context, new Map([[a.key, grant(a)]]), 1).rules.length, 1);
  planner.reload([b]);
  // Same planner instance now serves the new catalog; the old skill is a
  // non-candidate again (a grant alone no longer arms it).
  assert.deepEqual(planner.compile(context, new Map([[b.key, grant(b)]]), 2).rules.map((r) => r.skillKey), [b.key]);
  assert.equal(planner.compile(context, new Map([[a.key, grant(a)]]), 3).rules.length, 0);
  planner.reload([]);
  assert.equal(planner.compile(context, new Map([[b.key, grant(b)]]), 4).rules.length, 0);
});

test("registry size and revisionOf track reloads without cloning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-size-"));
  try {
    const directory = await packageFixture(root, "test-package");
    const registry = new SkillsRegistry();
    assert.equal(registry.size, 0);
    assert.equal(registry.revisionOf("test-package/friendliness"), "");
    await registry.reload([directory]);
    assert.equal(registry.size, 1);
    const first = registry.revisionOf("test-package/friendliness");
    assert.ok(first, "revisionOf returns the live revision");
    await writeFile(path.join(directory, "skills/friendliness/SKILL.md"), "Changed instructions");
    await registry.reload([directory]);
    assert.equal(registry.size, 1);
    assert.notEqual(first, registry.revisionOf("test-package/friendliness"), "reload re-revisions the key");
  } finally { await rm(root, { recursive: true, force: true }); }
});
