import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSkillManifest, parseSkillEvent, parseReviewResult, type RegisteredSkill } from "@pi-browser/protocol";
import { SkillsRegistry, discoverSkillPackages } from "../src/skills/registry.js";
import { SkillsPlanner, type SkillGrant, type SkillAdapterCoverage } from "../src/skills/planner.js";

function manifest(packageId = "test-package", host = "example.com") {
  return {
    schemaVersion: 1, packageId,
    skills: [{ id: "friendliness", type: "triggered", instructions: "skills/friendliness/SKILL.md",
      scope: { applications: ["firefox"], hosts: [host] },
      subscriptions: [{ event: "comment.before-submit" }],
      context: { required: ["draft", "replyTarget"], optional: [] },
      capabilities: ["context.read", "suggestion.present"], execution: { handler: "agent", timeoutMs: 10000 } }],
  };
}
function registered(packageId = "test-package", host = "example.com"): RegisteredSkill {
  const parsed = parseSkillManifest(manifest(packageId, host));
  return { key: `${packageId}/friendliness`, revision: "v1", definition: parsed.skills[0]!, instructions: "PRIVATE INSTRUCTIONS" };
}
function grant(skill: RegisteredSkill): SkillGrant {
  return { enabled: true, revision: skill.revision, capabilities: ["context.read", "suggestion.present"] };
}
const context = { application: "firefox" as const, url: "https://example.com/thread", documentGeneration: "doc-1" };
const adapter: SkillAdapterCoverage = { id: "fixture", version: "1", hosts: ["example.com"], events: ["comment.before-submit"], gates: ["comment.before-submit"] };

test("manifest rejects escapes, code handlers, unknown operators and conflicting IDs", () => {
  for (const instructions of ["../SKILL.md", "/etc/SKILL.md", "skills/../SKILL.md", "skills\\SKILL.md", "C:/SKILL.md"]) {
    const input = manifest(); input.skills[0]!.instructions = instructions;
    assert.throws(() => parseSkillManifest(input));
  }
  const input = manifest(); input.skills.push(input.skills[0]!);
  assert.throws(() => parseSkillManifest(input), /Duplicate/);
  const executable = manifest(); executable.skills[0]!.execution.handler = "native";
  assert.throws(() => parseSkillManifest(executable), /Unsupported/);
  assert.throws(() => parseSkillManifest({ ...manifest(), extension: "evil.js" }), /Unknown field/);
  const unknownEvent = manifest(); unknownEvent.skills[0]!.subscriptions[0]!.event = "dom.anything";
  assert.throws(() => parseSkillManifest(unknownEvent), /Unsupported/);
  const condition = manifest(); Object.assign(condition.skills[0]!.subscriptions[0]!, { conditions: { regex: ".*" } });
  assert.throws(() => parseSkillManifest(condition), /Unknown field/);
});

test("active and passive contracts enforce their distinct activation requirements", () => {
  const active = manifest();
  Object.assign(active.skills[0]!, { type: "active", subscriptions: undefined, command: "reply" });
  assert.equal(parseSkillManifest(active).skills[0]!.command, "reply");
  const passive = manifest();
  Object.assign(passive.skills[0]!, { type: "passive", subscriptions: undefined, observations: [{ event: "mail.arrived" }], batch: { maxEvents: 64, maxWaitMs: 1000 } });
  assert.equal(parseSkillManifest(passive).skills[0]!.batch!.maxEvents, 64);
  Object.assign(passive.skills[0]!, { batch: { maxEvents: 65, maxWaitMs: 1000 } });
  assert.throws(() => parseSkillManifest(passive), /Invalid integer/);
});

test("review results reject replacement text on clearance and unknown decisions", () => {
  const base = { jobId: "j", eventId: "e", skillKey: "p/s", skillRevision: "r", decision: "clear" };
  assert.equal(parseReviewResult(base).decision, "clear");
  assert.throws(() => parseReviewResult({ ...base, replacementText: "changed" }));
  assert.throws(() => parseReviewResult({ ...base, decision: "submit" }));
  assert.equal(parseReviewResult({ ...base, decision: "suggest", replacementText: "" }).replacementText, "");
});

test("events require versioned bounded revisions and complete browser frame identity", () => {
  const event = { version: 1, eventId: "event", event: "comment.before-submit", source: {
    application: "firefox", connectionEpoch: "epoch", documentGeneration: "doc", tabId: 0, frameId: 0,
  }, interactionId: "composer", contextRevision: 0, planVersion: 1, origin: "user", contextRef: "ref" };
  assert.deepEqual(parseSkillEvent(event), event);
  assert.throws(() => parseSkillEvent({ ...event, source: { ...event.source, frameId: undefined } }), /frame identity/);
  assert.throws(() => parseSkillEvent({ ...event, contextRevision: -1 }), /integer/);
  assert.throws(() => parseSkillEvent({ ...event, version: 2 }), /version/);
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
    const plan = planner.compile(context, grants, [adapter], registry.version, 0);
    assert.deepEqual(plan.rules, []);
    assert.deepEqual(plan.unavailable, []);
    assert.ok(JSON.stringify(plan).length < 256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plans bind context and revisions, intersect grants and reveal no instruction text", () => {
  const skill = registered();
  const planner = new SkillsPlanner([skill]);
  const grants = new Map([[skill.key, { ...grant(skill), capabilities: ["context.read" as const] }]]);
  const plan = planner.compile(context, grants, [adapter], 1, 0);
  assert.deepEqual(plan.rules[0]!.capabilities, ["context.read"]);
  assert.equal(plan.expiresAt, 60_000);
  assert.ok(!JSON.stringify(plan).includes("PRIVATE INSTRUCTIONS"));
  assert.notEqual(planner.compile({ ...context, documentGeneration: "doc-2" }, grants, [adapter], 1, 0).planId, plan.planId);
  assert.notEqual(planner.compile(context, grants, [{ ...adapter, version: "2" }], 1, 0).planId, plan.planId);
  grants.get(skill.key)!.revision = "old";
  const stale = planner.compile(context, grants, [adapter], 2);
  assert.equal(stale.rules.length, 0);
  assert.match(stale.unavailable[0]!.reason, /Package changed/);
});

test("exact hosts, subdomain boundaries, frame URLs, account bindings and narrow overrides", () => {
  const skill = registered();
  const grants = new Map([[skill.key, grant(skill)]]);
  const planner = new SkillsPlanner([skill]);
  for (const host of ["www.example.com", "badexample.com", "example.com.attacker.test"]) {
    assert.equal(planner.compile({ ...context, url: `https://${host}` }, grants, [adapter], 1).rules.length, 0);
  }
  skill.definition.scope = { applications: ["firefox"], subdomainHosts: ["example.com"] };
  const subdomainPlanner = new SkillsPlanner([skill]);
  const subdomainContext = { ...context, url: "https://www.example.com/thread" };
  assert.equal(subdomainPlanner.compile(subdomainContext, grants, [{ ...adapter, hosts: ["www.example.com"] }], 1).rules.length, 1);
  grants.set(skill.key, { ...grant(skill), accounts: ["account-1"] });
  assert.equal(planner.compile(context, grants, [adapter], 1).rules.length, 0);
  assert.equal(planner.compile({ ...context, accountId: "account-1" }, grants, [adapter], 1).rules.length, 1);
  grants.set(skill.key, { ...grant(skill), scope: { applications: ["firefox"], hosts: ["other.example"] } });
  assert.equal(planner.compile(context, grants, [adapter], 1).rules.length, 0);
});

test("gate requests without verified adapter coverage are explicitly unavailable", () => {
  const skill = registered();
  const planner = new SkillsPlanner([skill]);
  const grants = new Map([[skill.key, { ...grant(skill), mode: "review-before-submit" as const }]]);
  const plan = planner.compile(context, grants, [{ ...adapter, gates: [] }], 1);
  assert.equal(plan.rules.length, 0);
  assert.match(plan.unavailable[0]!.reason, /unsupported/);
  assert.equal(planner.compile(context, grants, [adapter], 1).rules[0]!.mode, "review-before-submit");
});

test("matching overload refuses the entire plan and disabling removes a rule", () => {
  const skills = Array.from({ length: 65 }, (_, index) => registered(`package-${index}`));
  const planner = new SkillsPlanner(skills);
  const grants = new Map(skills.map((skill) => [skill.key, grant(skill)]));
  assert.throws(() => planner.compile(context, grants, [adapter], 1), /limit exceeded/);
  grants.get(skills[0]!.key)!.enabled = false;
  assert.equal(planner.compile(context, grants, [adapter], 2).rules.length, 64);
});
