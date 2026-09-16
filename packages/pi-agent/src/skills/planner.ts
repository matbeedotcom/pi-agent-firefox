import { createHash } from "node:crypto";
import {
  normalizeSkillHost, type RegisteredSkill, type SkillApplication,
  type SkillCapability, type SkillEventName, type SkillScope, type SkillSubscription,
} from "@pi-browser/protocol";

export interface SkillGrant {
  enabled: boolean;
  /** Approval is revision-bound: package changes require a fresh grant. */
  revision: string;
  capabilities: SkillCapability[];
  scope?: SkillScope;
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
export interface SkillAdapterCoverage {
  id: string;
  version: string;
  hosts: string[];
  events: SkillEventName[];
  gates: SkillEventName[];
}
export interface PageRule {
  skillKey: string;
  skillRevision: string;
  adapterId: string;
  adapterVersion: string;
  subscriptions: SkillSubscription[];
  mode: "advisory" | "review-before-submit";
  capabilities: SkillCapability[];
}
export interface PagePlan {
  planId: string;
  planVersion: number;
  documentGeneration: string;
  expiresAt: number;
  rules: PageRule[];
  unavailable: { skillKey: string; reason: string }[];
}

function matchesScope(scope: SkillScope, context: PlanContext, url: URL): boolean {
  if (!scope.applications.includes(context.application)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (scope.hosts !== undefined || scope.subdomainHosts !== undefined) {
    const exact = scope.hosts?.includes(host);
    const subdomain = scope.subdomainHosts?.some((base) => host === base || host.endsWith(`.${base}`));
    if (!exact && !subdomain) return false;
  }
  return scope.pathPrefixes === undefined || scope.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
}

/** Compact app/host index; global rules have a separate bounded bucket. No handlers are imported. */
export class SkillsPlanner {
  private readonly buckets = new Map<string, RegisteredSkill[]>();
  private readonly global = new Map<SkillApplication, RegisteredSkill[]>();

  constructor(skills: readonly RegisteredSkill[]) {
    for (const skill of structuredClone(skills)) this.index(skill);
  }

  private index(skill: RegisteredSkill): void {
    const scope = skill.definition.scope;
    for (const application of scope.applications) {
      if (scope.hosts === undefined && scope.subdomainHosts === undefined) {
        const entries = this.global.get(application) ?? [];
        if (entries.length >= 64) throw new Error("Global skill rule bucket exceeds limit");
        entries.push(skill);
        this.global.set(application, entries);
        continue;
      }
      for (const host of new Set([...(scope.hosts ?? []), ...(scope.subdomainHosts ?? [])])) {
        const key = `${application}:${normalizeSkillHost(host)}`;
        const entries = this.buckets.get(key) ?? [];
        entries.push(skill);
        this.buckets.set(key, entries);
      }
    }
  }

  private candidates(context: PlanContext, url: URL): RegisteredSkill[] {
    const found = new Map<string, RegisteredSkill>();
    for (const skill of this.global.get(context.application) ?? []) found.set(skill.key, skill);
    const labels = url.hostname.toLowerCase().replace(/\.$/, "").split(".");
    for (let i = 0; i < labels.length; i++) {
      for (const skill of this.buckets.get(`${context.application}:${labels.slice(i).join(".")}`) ?? []) found.set(skill.key, skill);
    }
    return [...found.values()].filter((skill) => matchesScope(skill.definition.scope, context, url));
  }

  compile(context: PlanContext, grants: ReadonlyMap<string, SkillGrant>, adapters: readonly SkillAdapterCoverage[], version: number, now = Date.now()): PagePlan {
    const url = new URL(context.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported document URL");
    const rules: PageRule[] = [];
    const unavailable: PagePlan["unavailable"] = [];
    for (const skill of this.candidates(context, url)) {
      const grant = grants.get(skill.key);
      if (!grant || !eligibleGrant(skill, grant, context, url)) continue;
      const result = compileRule(skill, grant, adapters, url.hostname.toLowerCase().replace(/\.$/, ""));
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

function eligibleGrant(skill: RegisteredSkill, grant: SkillGrant, context: PlanContext, url: URL): boolean {
  if (!grant.enabled || skill.definition.type === "active") return false;
  if (grant.scope && !matchesScope(grant.scope, context, url)) return false;
  if (grant.accounts && (!context.accountId || !grant.accounts.includes(context.accountId))) return false;
  return skill.definition.type !== "passive" || grant.learningEnabled === true;
}

function compileRule(skill: RegisteredSkill, grant: SkillGrant, adapters: readonly SkillAdapterCoverage[], host: string): PageRule | string {
  if (grant.revision !== skill.revision) return "Package changed; review permissions";
  const definition = skill.definition;
  const capabilities = definition.capabilities.filter((capability) => grant.capabilities.includes(capability));
  if (!capabilities.includes("context.read")) return "Context access is not granted";
  const subscriptions = definition.subscriptions ?? definition.observations ?? [];
  const adapter = adapters.find((candidate) => candidate.hosts.includes(host) && subscriptions.every((sub) => candidate.events.includes(sub.event)));
  if (!adapter) return "No supported adapter for these events";
  const mode = grant.mode ?? "advisory";
  if (mode === "review-before-submit" && !subscriptions.some((sub) => sub.event === "comment.before-submit" && adapter.gates.includes(sub.event))) {
    return "Review before submit is unsupported by this adapter";
  }
  return { skillKey: skill.key, skillRevision: skill.revision, adapterId: adapter.id, adapterVersion: adapter.version,
    subscriptions: structuredClone(subscriptions), mode, capabilities };
}
