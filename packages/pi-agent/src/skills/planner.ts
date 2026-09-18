import { createHash } from "node:crypto";
import {
  normalizeSkillHost, type PagePlan, type RegisteredSkill, type SkillApplication,
  type SkillCapability, type SkillPlanRule, type SkillPackageManifest, type SkillSubscription,
} from "@pi-browser/protocol";

export interface SkillGrant {
  enabled: boolean;
  /** Approval is revision-bound: package changes require a fresh grant. */
  revision: string;
  capabilities: SkillCapability[];
  accounts?: string[];
  mode?: "advisory" | "review-before-submit";
  learningEnabled?: boolean;
}
export interface PlanContext {
  application: SkillApplication;
  /** Supplied by the addon from the frame's own URL, never a page payload. */
  url: string;
  documentGeneration: string;
  accountId?: string;
}
// The plan wire contract lives in @pi-browser/protocol (shared with the
// coordinator); the planner produces it.
export type { PagePlan, SkillPlanRule as PageRule } from "@pi-browser/protocol";

/** Package-level scope match: the manifest owns hosts, the URL is the truth. */
function matchesPackage(manifest: SkillPackageManifest, context: PlanContext, url: URL): boolean {
  if (manifest.application !== context.application) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const exact = manifest.hosts.includes(host);
  const subdomain = manifest.subdomainHosts?.some((base) => host === base || host.endsWith(`.${base}`)) ?? false;
  if (!exact && !subdomain) return false;
  return manifest.pathPrefixes === undefined || manifest.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
}

/**
 * Compact app/host index over package manifests. The package IS its adapter:
 * coverage of a subscription is derived from the manifest's own event
 * definitions (validated at load), so a host-matched package's subscriptions
 * are always covered — the only failure modes are revision and mode.
 */
function indexInto(buckets: Map<string, RegisteredSkill[]>, skill: RegisteredSkill): void {
  const manifest = skill.manifest;
  for (const host of new Set([...manifest.hosts, ...(manifest.subdomainHosts ?? [])])) {
    const key = `${manifest.application}:${normalizeSkillHost(host)}`;
    const entries = buckets.get(key) ?? [];
    if (entries.length >= 4096) throw new Error("Host skill rule bucket exceeds limit");
    entries.push(skill);
    buckets.set(key, entries);
  }
}

export class SkillsPlanner {
  private buckets: Map<string, RegisteredSkill[]>;

  constructor(skills: readonly RegisteredSkill[]) {
    const buckets = new Map<string, RegisteredSkill[]>();
    for (const skill of structuredClone(skills)) indexInto(buckets, skill);
    this.buckets = buckets;
  }

  /**
   * Replace the index atomically from a fresh registry snapshot (catalog
   * reload). The instance stays the same object, so per-client protocol
   * surfaces keep compiling against the new index; already-compiled plans
   * keep their stored rules until re-planned.
   */
  reload(skills: readonly RegisteredSkill[]): void {
    const buckets = new Map<string, RegisteredSkill[]>();
    for (const skill of structuredClone(skills)) indexInto(buckets, skill);
    this.buckets = buckets;
  }

  private candidates(context: PlanContext, url: URL): RegisteredSkill[] {
    const found = new Map<string, RegisteredSkill>();
    const labels = url.hostname.toLowerCase().replace(/\.$/, "").split(".");
    for (let i = 0; i < labels.length; i++) {
      for (const skill of this.buckets.get(`${context.application}:${labels.slice(i).join(".")}`) ?? []) found.set(skill.key, skill);
    }
    return [...found.values()].filter((skill) => matchesPackage(skill.manifest, context, url));
  }

  compile(context: PlanContext, grants: ReadonlyMap<string, SkillGrant>, version: number, now = Date.now()): PagePlan {
    const url = new URL(context.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported document URL");
    const rules: SkillPlanRule[] = [];
    const unavailable: PagePlan["unavailable"] = [];
    for (const skill of this.candidates(context, url)) {
      const grant = grants.get(skill.key);
      if (!grant || !eligibleGrant(skill, grant, context)) continue;
      const result = compileRule(skill, grant);
      if (typeof result === "string") unavailable.push({ skillKey: skill.key, reason: result });
      else rules.push(result);
    }
    if (rules.length > 64 || rules.reduce((count, rule) => count + rule.subscriptions.length, 0) > 64) {
      throw new Error("Document rule limit exceeded; no plan armed");
    }
    if (unavailable.length > 64) throw new Error("Too many unavailable rules; no plan armed");
    const identity = JSON.stringify({ context, version, rules, unavailable });
    return { planId: createHash("sha256").update(identity).digest("hex"), planVersion: version,
      documentGeneration: context.documentGeneration, expiresAt: now + 60_000, rules, unavailable };
  }
}

function eligibleGrant(skill: RegisteredSkill, grant: SkillGrant, context: PlanContext): boolean {
  if (!grant.enabled || skill.definition.type === "active") return false;
  if (grant.accounts && (!context.accountId || !grant.accounts.includes(context.accountId))) return false;
  return skill.definition.type !== "passive" || grant.learningEnabled === true;
}

function compileRule(skill: RegisteredSkill, grant: SkillGrant): SkillPlanRule | string {
  if (grant.revision !== skill.revision) return "Package changed; review permissions";
  const definition = skill.definition;
  const capabilities = definition.capabilities.filter((capability) => grant.capabilities.includes(capability));
  if (!capabilities.includes("context.read")) return "Context access is not granted";
  const subscriptions: SkillSubscription[] = definition.subscriptions ?? definition.observations ?? [];
  const mode = grant.mode ?? "advisory";
  if (mode === "review-before-submit" && !subscriptions.some((sub) => skill.manifest.events[sub.event]?.kind === "gate")) {
    return "Review before submit requires a gate event subscription";
  }
  const events: SkillPlanRule["events"] = {};
  for (const sub of subscriptions) {
    const event = skill.manifest.events[sub.event];
    if (!event) return `Package event is missing: ${sub.event}`;
    events[sub.event] = structuredClone(event);
  }
  // Runtime placement: JS-dialect targets must execute where string codegen
  // is legal, and the gate consult is synchronous — so ANY js target in the
  // rule's events moves the WHOLE rule to the main world. Manifest-derived,
  // static, auditable.
  const usedTargets = new Set<string>();
  for (const event of Object.values(events)) {
    for (const matcher of [...(event.sequence ?? []), ...(event.alternatives ?? []).flat()]) usedTargets.add(matcher.target);
    for (const field of Object.values(event.payload ?? {})) usedTargets.add(field.from);
  }
  const world = [...usedTargets].some((name) => skill.manifest.targets[name]?.kind === "js") ? "main" : "isolated";
  return { skillKey: skill.key, skillRevision: skill.revision, packageId: skill.packageId, world,
    targets: structuredClone(skill.manifest.targets), events,
    subscriptions: structuredClone(subscriptions), mode, capabilities };
}
