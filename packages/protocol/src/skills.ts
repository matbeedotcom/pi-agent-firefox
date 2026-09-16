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
export type SkillEventSource = SkillEvent["source"];

// ---------------------------------------------------------------------------
// ACP protocol surface (skills-runtime-design.md §2, §7)
//
// Application messages ride the existing ACP transport under the negotiated
// x-pi-browser/ namespace (X_PI_BROWSER.skills_*). Standard prompt traffic
// stays separate; neither ACP nor MCP is the scheduler.
// ---------------------------------------------------------------------------

/** One armed rule in a compiled page plan (host → client, display + arming). */
export interface SkillPlanRule {
  skillKey: string;
  skillRevision: string;
  adapterId: string;
  adapterVersion: string;
  subscriptions: SkillSubscription[];
  mode: "advisory" | "review-before-submit";
  capabilities: SkillCapability[];
}

/** Compiled page plan delivered to the coordinator for one document. */
export interface PagePlan {
  planId: string;
  planVersion: number;
  documentGeneration: string;
  /** Plans expire; the coordinator re-plans before arming again. */
  expiresAt: number;
  rules: SkillPlanRule[];
  unavailable: { skillKey: string; reason: string }[];
}

/** Context fields a rule may request from the coordinator's snapshot. */
export const SKILL_CONTEXT_FIELDS = ["draft", "replyTarget", "parentPost", "visibleAncestors", "mail", "applicationRecord"] as const;
export type SkillContextField = (typeof SKILL_CONTEXT_FIELDS)[number];

/** Client → host: compile a page plan for a verified source identity. */
export interface SkillsPlanParams {
  source: SkillEventSource;
  /** The frame's own URL, supplied by the addon, never a page payload. */
  url: string;
}
export interface SkillsPlanResult {
  status: "ok" | "unavailable";
  reason?: string;
  plan?: PagePlan;
}

/** Client → host: submit a verified skill event. */
export interface SkillsEventParams {
  event: SkillEvent;
}
export interface SkillsEventJob {
  jobId: string;
  skillKey: string;
  /** Scheduler key the coordinator can target with skills_cancel. */
  key: string;
}
export interface SkillsEventResult {
  status: "accepted" | "no-match" | "stale-plan" | "unavailable" | "duplicate";
  reason?: string;
  jobs?: SkillsEventJob[];
}

/** Client → host: cancel pending skill work for one interaction. */
export interface SkillsCancelParams {
  interactionId: string;
}
export interface SkillsCancelResult {
  cancelled: number;
}

/** Client → host: probe the skill runtime. */
export interface SkillsStatusResult {
  available: boolean;
  stats: { running: number; queued: number; replacements: number; closed: boolean; outcomes: Record<string, number> };
  plans: number;
  armedRules: number;
}

/** Host → client: resolve a contextRef against the coordinator's bounded snapshot store. */
export interface SkillsContextRequestParams {
  contextRef: string;
  interactionId: string;
  planVersion: number;
  /** Only these snapshot fields are returned (privacy by request). */
  fields: SkillContextField[];
  maxBytes: number;
}
export interface SkillsContextResult {
  contextRef: string;
  context: Record<string, unknown>;
  bytes: number;
}

/** Host → client: deliver a job outcome; the coordinator acks delivery. */
export interface SkillsResultParams {
  jobId: string;
  eventId: string;
  skillKey: string;
  skillRevision: string;
  status: "done" | "unavailable";
  decision?: "clear" | "suggest" | "abstain";
  reason?: string;
  explanation?: string;
  replacementText?: string;
}
export interface SkillsResultAck {
  delivered: true;
}

function parseDocumentUrl(value: unknown): string {
  const raw = text(value, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid document URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported document URL");
  return raw;
}

export function parseSkillsPlanParams(value: unknown): SkillsPlanParams {
  const entry = object(value, ["source", "url"]);
  return { source: parseEventSource(entry.source), url: parseDocumentUrl(entry.url) };
}

export function parseSkillsEventParams(value: unknown): SkillsEventParams {
  const entry = object(value, ["event"]);
  return { event: parseSkillEvent(entry.event) };
}

export function parseSkillsCancelParams(value: unknown): SkillsCancelParams {
  const entry = object(value, ["interactionId"]);
  return { interactionId: text(entry.interactionId) };
}

export function parseSkillsContextRequestParams(value: unknown): SkillsContextRequestParams {
  const entry = object(value, ["contextRef", "interactionId", "planVersion", "fields", "maxBytes"]);
  return {
    contextRef: text(entry.contextRef), interactionId: text(entry.interactionId),
    planVersion: integer(entry.planVersion, 0, Number.MAX_SAFE_INTEGER),
    fields: list(entry.fields, (f) => choice(f, SKILL_CONTEXT_FIELDS), 8),
    maxBytes: integer(entry.maxBytes, 1, 32_768),
  };
}

/** The coordinator's snapshot payload; the host binds it to the job identity. */
export function parseSkillsContextResult(value: unknown, maxBytes: number): SkillsContextResult {
  const entry = object(value, ["contextRef", "context", "bytes"]);
  const inner = object(entry.context, SKILL_CONTEXT_FIELDS);
  const json = JSON.stringify(inner);
  if (json.length > maxBytes) throw new Error("Context snapshot exceeds limit");
  return { contextRef: text(entry.contextRef), context: inner, bytes: json.length };
}

export function parseSkillsResultParams(value: unknown): SkillsResultParams {
  const entry = object(value, ["jobId", "eventId", "skillKey", "skillRevision", "status", "decision", "reason", "explanation", "replacementText"]);
  const result: SkillsResultParams = {
    jobId: text(entry.jobId), eventId: text(entry.eventId), skillKey: text(entry.skillKey),
    skillRevision: text(entry.skillRevision), status: choice(entry.status, ["done", "unavailable"] as const),
  };
  if (result.status === "done") {
    result.decision = choice(entry.decision, ["clear", "suggest", "abstain"] as const);
    if (entry.explanation !== undefined) result.explanation = text(entry.explanation, 4096);
    if (entry.replacementText !== undefined) {
      if (result.decision !== "suggest") throw new Error("Only suggestions can replace text");
      if (typeof entry.replacementText !== "string" || entry.replacementText.length > 32_768) throw new Error("Invalid replacement text");
      result.replacementText = entry.replacementText;
    }
  } else {
    if (entry.decision !== undefined || entry.explanation !== undefined || entry.replacementText !== undefined) {
      throw new Error("Unavailable results carry no decision");
    }
    result.reason = text(entry.reason, 4096);
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
