/** Declarative skills runtime v1. Definitions never carry executable code. */
export const SKILL_EVENTS = ["comment.draft.paused", "comment.before-submit", "mail.arrived"] as const;
export const SKILL_CAPABILITIES = ["context.read", "suggestion.present", "draft.replace-on-accept", "memory.read", "memory.propose"] as const;
export type SkillEventName = typeof SKILL_EVENTS[number];
export type SkillCapability = typeof SKILL_CAPABILITIES[number];
export type SkillApplication = "firefox" | "thunderbird";
export interface SkillScope {
  applications: SkillApplication[];
  /** Exact hosts; subdomains are permitted only through subdomainHosts. */
  hosts?: string[];
  subdomainHosts?: string[];
  pathPrefixes?: string[];
}
export interface SkillSubscription {
  event: SkillEventName;
  conditions?: { minCharacters?: number };
  debounceMs?: number;
}
export interface SkillDefinition {
  id: string;
  type: "triggered" | "active" | "passive";
  instructions: string;
  scope: SkillScope;
  subscriptions?: SkillSubscription[];
  command?: string;
  observations?: SkillSubscription[];
  batch?: { maxEvents: number; maxWaitMs: number };
  context: { required: string[]; optional: string[] };
  review?: { defaultMode: "advisory" | "review-before-submit" };
  capabilities: SkillCapability[];
  memory?: { namespace: string; scope: "account" | "profile" };
  execution: { handler: "agent"; timeoutMs: number };
}
export interface SkillManifest { schemaVersion: 1; packageId: string; skills: SkillDefinition[] }
export interface RegisteredSkill {
  key: string;
  revision: string;
  definition: SkillDefinition;
  instructions: string;
}
export interface SkillEvent {
  version: 1;
  eventId: string;
  event: SkillEventName;
  source: {
    application: SkillApplication;
    connectionEpoch: string;
    documentGeneration?: string;
    tabId?: number;
    frameId?: number;
    accountId?: string;
  };
  interactionId: string;
  draftRevision?: number;
  contextRevision: number;
  planVersion: number;
  origin: "user" | "site" | "skill";
  causedBy?: string;
  contextRef: string;
}
export interface ReviewResult {
  jobId: string;
  eventId: string;
  skillKey: string;
  skillRevision: string;
  decision: "clear" | "suggest" | "abstain";
  explanation?: string;
  replacementText?: string;
}

/** Strict objects reject unsupported operators instead of silently ignoring them. */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown field: ${key}`);
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid string");
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error(`Unsupported value: ${String(value)}`);
  return value as T;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("Invalid integer");
  return value as number;
}
function list<T>(value: unknown, parse: (item: unknown) => T, max = 64): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid array");
  return value.map(parse);
}
function identifier(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new Error("Invalid identifier");
  return result;
}
export function skillRelativePath(value: unknown): string {
  const result = text(value, 512);
  if (result.includes("\\") || result.includes("\0") || result.includes(":")) throw new Error("Invalid package path");
  if (result.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Path escapes package");
  if (!result.endsWith("/SKILL.md")) throw new Error("Instructions must name SKILL.md");
  return result;
}
export function normalizeSkillHost(value: unknown): string {
  const host = text(value, 253).toLowerCase().replace(/\.$/, "");
  if (!host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new Error("Invalid hostname");
  return host;
}
function parseScope(value: unknown): SkillScope {
  const scope = object(value, ["applications", "hosts", "subdomainHosts", "pathPrefixes"]);
  const applications = list(scope.applications, (app) => choice(app, ["firefox", "thunderbird"] as const), 2);
  if (!applications.length) throw new Error("Application scope is empty");
  const result: SkillScope = { applications };
  if (scope.hosts !== undefined) result.hosts = list(scope.hosts, normalizeSkillHost);
  if (scope.subdomainHosts !== undefined) result.subdomainHosts = list(scope.subdomainHosts, normalizeSkillHost);
  if (scope.pathPrefixes !== undefined) result.pathPrefixes = list(scope.pathPrefixes, (value) => {
    const prefix = text(value, 512);
    if (!prefix.startsWith("/") || /[?#\\*]/.test(prefix)) throw new Error("Invalid path prefix");
    return prefix;
  });
  return result;
}
function parseSubscription(value: unknown): SkillSubscription {
  const entry = object(value, ["event", "conditions", "debounceMs"]);
  const result: SkillSubscription = { event: choice(entry.event, SKILL_EVENTS) };
  if (entry.debounceMs !== undefined) result.debounceMs = integer(entry.debounceMs, 0, 60_000);
  if (entry.conditions !== undefined) {
    const conditions = object(entry.conditions, ["minCharacters"]);
    result.conditions = {};
    if (conditions.minCharacters !== undefined) result.conditions.minCharacters = integer(conditions.minCharacters, 0, 32_768);
  }
  return result;
}
function parseActivation(entry: Record<string, unknown>, result: SkillDefinition): void {
  if (result.type === "active") {
    result.command = identifier(entry.command);
    if (entry.subscriptions !== undefined || entry.observations !== undefined || entry.batch !== undefined) throw new Error("Active skills require a command only");
    return;
  }
  if (entry.command !== undefined) throw new Error("Automatic skills cannot declare commands");
  if (result.type === "triggered") {
    result.subscriptions = list(entry.subscriptions, parseSubscription);
    if (!result.subscriptions.length || entry.observations !== undefined || entry.batch !== undefined) throw new Error("Invalid triggered activation");
    return;
  }
  result.observations = list(entry.observations, parseSubscription);
  if (!result.observations.length || entry.subscriptions !== undefined) throw new Error("Invalid passive activation");
  const batch = object(entry.batch, ["maxEvents", "maxWaitMs"]);
  result.batch = { maxEvents: integer(batch.maxEvents, 1, 64), maxWaitMs: integer(batch.maxWaitMs, 1, 300_000) };
}
function parseDefinition(value: unknown): SkillDefinition {
  const entry = object(value, ["id", "type", "instructions", "scope", "subscriptions", "command", "observations", "batch", "context", "review", "capabilities", "memory", "execution"]);
  const context = object(entry.context, ["required", "optional"]);
  const fields = ["draft", "replyTarget", "parentPost", "visibleAncestors", "mail", "applicationRecord"] as const;
  const execution = object(entry.execution, ["handler", "timeoutMs"]);
  const result: SkillDefinition = {
    id: identifier(entry.id), type: choice(entry.type, ["triggered", "active", "passive"] as const),
    instructions: skillRelativePath(entry.instructions), scope: parseScope(entry.scope),
    context: { required: list(context.required, (v) => choice(v, fields)), optional: list(context.optional ?? [], (v) => choice(v, fields)) },
    capabilities: list(entry.capabilities, (v) => choice(v, SKILL_CAPABILITIES)),
    execution: { handler: choice(execution.handler, ["agent"] as const), timeoutMs: integer(execution.timeoutMs, 1, 10_000) },
  };
  parseActivation(entry, result);
  if (entry.review !== undefined) {
    const review = object(entry.review, ["defaultMode"]);
    result.review = { defaultMode: choice(review.defaultMode, ["advisory", "review-before-submit"] as const) };
  }
  if (entry.memory !== undefined) {
    const memory = object(entry.memory, ["namespace", "scope"]);
    result.memory = { namespace: identifier(memory.namespace), scope: choice(memory.scope, ["account", "profile"] as const) };
  }
  return result;
}
export function parseSkillManifest(value: unknown): SkillManifest {
  const manifest = object(value, ["schemaVersion", "packageId", "skills"]);
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported skill schema version");
  const skills = list(manifest.skills, parseDefinition, 1024);
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) throw new Error("Duplicate skill ID");
  return { schemaVersion: 1, packageId: identifier(manifest.packageId), skills };
}

/** Shape validation is separate from coordinator verification of sender identity. */
export function parseSkillEvent(value: unknown): SkillEvent {
  const entry = object(value, ["version", "eventId", "event", "source", "interactionId", "draftRevision", "contextRevision", "planVersion", "origin", "causedBy", "contextRef"]);
  if (entry.version !== 1) throw new Error("Unsupported event version");
  const result: SkillEvent = {
    version: 1, eventId: text(entry.eventId), event: choice(entry.event, SKILL_EVENTS),
    source: parseEventSource(entry.source), interactionId: text(entry.interactionId),
    contextRevision: integer(entry.contextRevision, 0, Number.MAX_SAFE_INTEGER),
    planVersion: integer(entry.planVersion, 0, Number.MAX_SAFE_INTEGER),
    origin: choice(entry.origin, ["user", "site", "skill"] as const), contextRef: text(entry.contextRef),
  };
  if (entry.draftRevision !== undefined) result.draftRevision = integer(entry.draftRevision, 0, Number.MAX_SAFE_INTEGER);
  if (entry.causedBy !== undefined) result.causedBy = text(entry.causedBy);
  return result;
}

function parseEventSource(value: unknown): SkillEvent["source"] {
  const source = object(value, ["application", "connectionEpoch", "documentGeneration", "tabId", "frameId", "accountId"]);
  const result: SkillEvent["source"] = {
    application: choice(source.application, ["firefox", "thunderbird"] as const), connectionEpoch: text(source.connectionEpoch),
  };
  if (source.documentGeneration !== undefined) result.documentGeneration = text(source.documentGeneration);
  if (source.accountId !== undefined) result.accountId = text(source.accountId);
  if (source.tabId !== undefined) result.tabId = integer(source.tabId, 0, Number.MAX_SAFE_INTEGER);
  if (source.frameId !== undefined) result.frameId = integer(source.frameId, 0, Number.MAX_SAFE_INTEGER);
  if (result.application === "firefox" && (result.documentGeneration === undefined || result.tabId === undefined || result.frameId === undefined)) {
    throw new Error("Browser events require document, tab and frame identity");
  }
  return result;
}
/** Parse semantic output only. The caller must bind it to the immutable job identity. */
export function parseReviewResult(value: unknown): ReviewResult {
  const entry = object(value, ["jobId", "eventId", "skillKey", "skillRevision", "decision", "explanation", "replacementText"]);
  const result: ReviewResult = {
    jobId: text(entry.jobId), eventId: text(entry.eventId), skillKey: text(entry.skillKey),
    skillRevision: text(entry.skillRevision), decision: choice(entry.decision, ["clear", "suggest", "abstain"] as const),
  };
  if (entry.explanation !== undefined) result.explanation = text(entry.explanation, 4096);
  if (entry.replacementText !== undefined) {
    if (result.decision !== "suggest") throw new Error("Only suggestions can replace text");
    if (typeof entry.replacementText !== "string" || entry.replacementText.length > 32_768) throw new Error("Invalid replacement text");
    result.replacementText = entry.replacementText;
  }
  return result;
}
