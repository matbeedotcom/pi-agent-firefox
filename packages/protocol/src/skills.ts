/**
 * Declarative skills runtime v2.
 *
 * A skill package is ONE activation.json: the package declares the site it
 * covers (hosts), how that site's DOM maps to site events (targets + events),
 * and the skills that listen to those events. Subscriptions may only name
 * events defined in the same file — there is no global event catalog and no
 * cross-file reference to validate.
 *
 * `targets` carry a selector: a CSS selector string (isolated-world runtime,
 * no eval) or a JS dialect with the strict `el =>` prefix (main-world runtime
 * for rules that use it). Everything else is inert data.
 */
export const SKILL_CAPABILITIES = ["context.read", "suggestion.present", "draft.replace-on-accept", "memory.read", "memory.propose"] as const;
export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];
export type SkillApplication = "firefox" | "thunderbird";
export type SkillContextField = string;

/** DOM event types the page interpreter can observe. */
export const SKILL_DOM_TYPES = ["input", "keydown", "click"] as const;
export type SkillDomType = (typeof SKILL_DOM_TYPES)[number];
export const SKILL_KEY_MODIFIERS = ["alt", "ctrl", "shift", "meta"] as const;
export type SkillKeyModifier = (typeof SKILL_KEY_MODIFIERS)[number];

export type SkillTargetKind = "css" | "js";

/**
 * A named DOM predicate. `selector` is either a CSS selector string
 * (matched with el.matches in the isolated world) or the JS dialect with the
 * strict `el =>` prefix (compiled in the main world at arm time; a rule using
 * any JS target is placed in the main world by the planner).
 */
export interface SkillTarget {
  selector: string;
  kind: SkillTargetKind;
  /** Optional label regex applied to the element's normalized text. */
  text?: string;
  textFlags?: "i";
  /** Optional bound on textContent length (for context targets). */
  maxTextLength?: number;
}

/** One matcher in a site-event sequence: a DOM event on an element matching a target. */
export interface SkillDomMatcher {
  dom: SkillDomType;
  target: string;
  /** keydown only. */
  key?: string;
  /** keydown only. */
  modifiers?: SkillKeyModifier[];
}

/** A payload field resolved from a target's element at fire time. */
export interface SkillPayloadField {
  /** Target name whose last matched element provides the value. */
  from: string;
  field: "value" | "text";
  /**
   * Resolution mode: "matched" (default) uses the element the sequence last
   * matched for this target; "document" runs a bounded document scan for
   * the target at event FIRE time (rare — not per DOM event).
   */
  resolve?: "matched" | "document";
  /** Capture bound in characters (default 2048, hard cap 262144). */
  maxChars?: number;
}

/**
 * A site event definition. `debounced` fires after `debounceMs` of silence
 * following the final sequence match. `gate` fires synchronously when the
 * LAST matcher of one of its alternatives completes; that final match IS the
 * gesture the submission gate holds.
 */
export interface SkillEventDefinition {
  kind: "debounced" | "gate";
  /** debounced only; 0..60000. */
  debounceMs?: number;
  /** debounced only; suspend the pause timer while IME composition is active. */
  suspendDuringComposition?: boolean;
  /** debounced: 1..8 ordered matchers. */
  sequence?: SkillDomMatcher[];
  /** gate only; stable identity for chain dedup. */
  chainId?: string;
  /** gate: 1..16 ordered alternatives, each 1..8 matchers. */
  alternatives?: SkillDomMatcher[][];
  /**
   * gate only. Whether the held gesture stops the page's default action
   * (preventDefault + stopImmediatePropagation). Default true: the gate
   * blocks the send until reviewed. Set false for an advisory gesture:
   * the page proceeds with the user's own action and the skill only
   * observes it. Declared by the skill package, not the runtime.
   */
  stopDefaultAction?: boolean;
  /** Payload fields, package-defined names (≤ 8, each name ≤ 64). */
  payload?: Record<string, SkillPayloadField>;
}

export interface SkillSubscription {
  /** Local event name: must be a key of the package's `events`. */
  event: string;
  conditions?: { minCharacters?: number };
}

export interface SkillDefinition {
  id: string;
  type: "triggered" | "active" | "passive";
  instructions: string;
  subscriptions?: SkillSubscription[];
  command?: string;
  observations?: SkillSubscription[];
  batch?: { maxEvents: number; maxWaitMs: number };
  /** Payload field names the skill needs from event snapshots. */
  context: { required: string[]; optional: string[] };
  review?: { defaultMode: "advisory" | "review-before-submit" };
  capabilities: SkillCapability[];
  memory?: { namespace: string; scope: "account" | "profile" };
  execution: { handler: "agent"; timeoutMs: number };
}

/** The unified package manifest (activation.json, schemaVersion 2). */
export interface SkillPackageManifest {
  schemaVersion: 2;
  packageId: string;
  application: SkillApplication;
  /** Exact hosts; subdomains are permitted only through subdomainHosts. */
  hosts: string[];
  subdomainHosts?: string[];
  pathPrefixes?: string[];
  targets: Record<string, SkillTarget>;
  events: Record<string, SkillEventDefinition>;
  skills: SkillDefinition[];
}

export interface RegisteredSkill {
  key: string;
  revision: string;
  packageId: string;
  definition: SkillDefinition;
  instructions: string;
  /** Full package manifest; the planner reads hosts/targets/events from here. */
  manifest: SkillPackageManifest;
}

/** Global event identity: `<packageId>:<local event name>`. */
export function skillEventName(packageId: string, local: string): string {
  return `${packageId}:${local}`;
}

export interface SkillEvent {
  version: 1;
  eventId: string;
  /** `<packageId>:<local event name>`. */
  event: string;
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
function identifier(value: unknown, max = 64): string {
  const result = text(value, max);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new Error("Invalid identifier");
  return result;
}
/** Local event names: dotted/hyphenated lowercase, e.g. `draft.paused`. */
function eventName(value: unknown, max = 64): string {
  const result = text(value, max);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(result)) throw new Error("Invalid event name");
  return result;
}
/**
 * Context/payload field names: camelCase identifiers (package-defined).
 * The page payload, the skill's context requests, and the coordinator's
 * snapshot store all speak these names.
 */
function fieldName(value: unknown, max = 64): string {
  const result = text(value, max);
  if (!/^[a-z][a-zA-Z0-9]*$/.test(result)) throw new Error("Invalid field name");
  return result;
}
/** Global event identity `<packageId>:<local>` (max 128 total). */
function qualifiedEventName(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(result)) throw new Error("Invalid event name");
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

/**
 * Target selectors: two dialects, detected statically by the strict `el =>`
 * prefix. CSS is the isolated-world default; the JS dialect is syntax-checked
 * at load (the host has no CSP) and forces its rule into the main world.
 * Bounds keep a hostile package from shipping megabyte selectors.
 */
const JS_TARGET = /^el\s*=>/;

/** Extract the expression after the `el =>` prefix. */
function jsTargetExpression(selector: string): string {
  const match = /^el\s*=>\s*([\s\S]*)$/.exec(selector);
  if (!match) throw new Error("Invalid JS target");
  return match[1];
}

function parseTargetValue(value: unknown, context: string): SkillTarget {
  let selector: string;
  if (typeof value === "string") {
    selector = text(value, 16_384);
  } else {
    const entry = object(value, ["selector", "text", "textFlags", "maxTextLength"]);
    selector = text(entry.selector, 16_384);
    return parseTargetFields(selector, entry, context);
  }
  return parseTargetFields(selector, {}, context);
}

function parseTargetFields(selector: string, entry: Record<string, unknown>, context: string): SkillTarget {
  const target: SkillTarget = { selector, kind: JS_TARGET.test(selector) ? "js" : "css" };
  if (entry.text !== undefined) {
    target.text = text(entry.text, 1_024);
    try {
      new RegExp(target.text, target.textFlags ?? "");
    } catch (err) {
      throw new Error(`Invalid target text regex: ${String(err instanceof Error ? err.message : err)}`.slice(0, 200));
    }
  }
  if (entry.textFlags !== undefined) {
    if (entry.textFlags !== "i") throw new Error(`Unsupported textFlags: ${String(entry.textFlags)}`);
    target.textFlags = "i";
  }
  if (entry.maxTextLength !== undefined) target.maxTextLength = integer(entry.maxTextLength, 1, 100_000);
  if (target.kind === "js") checkJsTarget(target.selector, context);
  return target;
}

/** The page interpreter compiles the same shape at arm time (main world). */
function checkJsTarget(selector: string, context: string): void {
  try {
    // eslint-disable-next-line no-new-func
    new Function("el", `return (${jsTargetExpression(selector)});`);
  } catch (err) {
    throw new Error(`Target selector failed to parse (${context}): ${String(err instanceof Error ? err.message : err)}`.slice(0, 200));
  }
}

function parseTarget(value: unknown): SkillTarget {
  return parseTargetValue(value, "target");
}

function parseMatcher(value: unknown): SkillDomMatcher {
  const entry = object(value, ["dom", "target", "key", "modifiers"]);
  const result: SkillDomMatcher = { dom: choice(entry.dom, SKILL_DOM_TYPES), target: fieldName(entry.target, 64) };
  if (entry.key !== undefined) {
    if (result.dom !== "keydown") throw new Error("key is only valid for keydown");
    result.key = text(entry.key, 16);
  }
  if (entry.modifiers !== undefined) {
    if (result.dom !== "keydown") throw new Error("modifiers are only valid for keydown");
    result.modifiers = list(entry.modifiers, (m) => choice(m, SKILL_KEY_MODIFIERS), 4);
  }
  return result;
}

function parsePayloadField(value: unknown): SkillPayloadField {
  const entry = object(value, ["from", "field", "resolve", "maxChars"]);
  const result: SkillPayloadField = { from: fieldName(entry.from, 64), field: choice(entry.field, ["value", "text"] as const) };
  if (entry.resolve !== undefined) result.resolve = choice(entry.resolve, ["matched", "document"] as const);
  if (entry.maxChars !== undefined) result.maxChars = integer(entry.maxChars, 1, 262_144);
  return result;
}

/** Parse one event definition; `names` must contain every referenced target. */
function parseEventDefinition(value: unknown, targetNames: ReadonlySet<string>): SkillEventDefinition {
  const entry = object(value, ["kind", "debounceMs", "suspendDuringComposition", "sequence", "chainId", "alternatives", "stopDefaultAction", "payload"]);
  const result: SkillEventDefinition = { kind: choice(entry.kind, ["debounced", "gate"] as const) };
  const matchers = (value: unknown): SkillDomMatcher[] =>
    list(value, parseMatcher, 8).map((m) => { if (!targetNames.has(m.target)) throw new Error(`Unknown target: ${m.target}`); return m; });
  if (result.kind === "debounced") {
    if (entry.sequence === undefined) throw new Error("Debounced events require a sequence");
    result.sequence = matchers(entry.sequence);
    if (entry.chainId !== undefined || entry.alternatives !== undefined || entry.stopDefaultAction !== undefined) throw new Error("Invalid debounced event fields");
    result.debounceMs = integer(entry.debounceMs ?? 0, 0, 60_000);
    if (entry.suspendDuringComposition !== undefined) result.suspendDuringComposition = entry.suspendDuringComposition === true;
  } else {
    if (entry.alternatives === undefined) throw new Error("Gate events require alternatives");
    result.alternatives = list(entry.alternatives, (alt) => matchers(alt), 16);
    if (entry.sequence !== undefined) throw new Error("Invalid gate event fields");
    if (entry.stopDefaultAction !== undefined) result.stopDefaultAction = entry.stopDefaultAction === true;
    result.chainId = identifier(entry.chainId, 64);
  }
  if (entry.payload !== undefined) {
    const payload = object(entry.payload, Object.keys(entry.payload as object));
    result.payload = {};
    const names = Object.keys(payload);
    if (names.length > 8) throw new Error("Too many payload fields");
    for (const name of names) {
      if (!fieldName(name, 64)) throw new Error(`Invalid payload field name: ${name}`);
      const field = parsePayloadField(payload[name]);
      if (!targetNames.has(field.from)) throw new Error(`Unknown payload source: ${field.from}`);
      result.payload[name] = field;
    }
  }
  return result;
}

function parseSubscription(value: unknown, eventNames: ReadonlySet<string>): SkillSubscription {
  const entry = object(value, ["event", "conditions"]);
  const name = eventName(entry.event);
  if (!eventNames.has(name)) throw new Error(`Subscription names undefined event: ${name}`);
  const result: SkillSubscription = { event: name };
  if (entry.conditions !== undefined) {
    const conditions = object(entry.conditions, ["minCharacters"]);
    result.conditions = {};
    if (conditions.minCharacters !== undefined) result.conditions.minCharacters = integer(conditions.minCharacters, 0, 32_768);
  }
  return result;
}

/** Context field names: package-defined payload field names (camelCase). */
function contextField(value: unknown): string {
  return fieldName(value, 64);
}

function parseSkillActivation(entry: Record<string, unknown>, result: SkillDefinition, eventNames: ReadonlySet<string>, payloadFields: ReadonlySet<string>): void {
  const checkFields = (fields: string[]) => {
    for (const field of fields) if (!payloadFields.has(field)) throw new Error(`Context field not in any subscribed event payload: ${field}`);
  };
  if (result.type === "active") {
    result.command = identifier(entry.command);
    if (entry.subscriptions !== undefined || entry.observations !== undefined || entry.batch !== undefined) throw new Error("Active skills require a command only");
    checkFields(result.context.required);
    return;
  }
  if (entry.command !== undefined) throw new Error("Automatic skills cannot declare commands");
  if (result.type === "triggered") {
    result.subscriptions = list(entry.subscriptions, (v) => parseSubscription(v, eventNames));
    if (!result.subscriptions.length || entry.observations !== undefined || entry.batch !== undefined) throw new Error("Invalid triggered activation");
    checkFields([...result.context.required, ...result.context.optional]);
    return;
  }
  result.observations = list(entry.observations, (v) => parseSubscription(v, eventNames));
  if (!result.observations.length || entry.subscriptions !== undefined) throw new Error("Invalid passive activation");
  checkFields([...result.context.required, ...result.context.optional]);
  const batch = object(entry.batch, ["maxEvents", "maxWaitMs"]);
  result.batch = { maxEvents: integer(batch.maxEvents, 1, 64), maxWaitMs: integer(batch.maxWaitMs, 1, 300_000) };
}

function parseDefinition(value: unknown, eventNames: ReadonlySet<string>, payloadFields: ReadonlySet<string>): SkillDefinition {
  const entry = object(value, ["id", "type", "instructions", "subscriptions", "command", "observations", "batch", "context", "review", "capabilities", "memory", "execution"]);
  const context = object(entry.context, ["required", "optional"]);
  const execution = object(entry.execution, ["handler", "timeoutMs"]);
  const result: SkillDefinition = {
    id: identifier(entry.id), type: choice(entry.type, ["triggered", "active", "passive"] as const),
    instructions: skillRelativePath(entry.instructions),
    context: { required: list(context.required, contextField), optional: list(context.optional ?? [], contextField) },
    capabilities: list(entry.capabilities, (v) => choice(v, SKILL_CAPABILITIES)),
    execution: { handler: choice(execution.handler, ["agent"] as const), timeoutMs: integer(execution.timeoutMs, 1, 10_000) },
  };
  parseSkillActivation(entry, result, eventNames, payloadFields);
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

export function parseSkillPackage(value: unknown): SkillPackageManifest {
  const manifest = object(value, ["schemaVersion", "packageId", "application", "hosts", "subdomainHosts", "pathPrefixes", "targets", "events", "skills"]);
  if (manifest.schemaVersion !== 2) throw new Error("Unsupported skill schema version");
  const packageId = identifier(manifest.packageId);
  const application = choice(manifest.application, ["firefox", "thunderbird"] as const);
  const hosts = list(manifest.hosts, normalizeSkillHost, 128);
  const subdomainHosts = manifest.subdomainHosts === undefined ? [] : list(manifest.subdomainHosts, normalizeSkillHost, 128);
  if (!hosts.length && !subdomainHosts.length) throw new Error("Package requires at least one host");
  const result: SkillPackageManifest = {
    schemaVersion: 2, packageId, application, hosts,
    targets: {}, events: {},
    skills: [],
  };
  if (subdomainHosts.length) result.subdomainHosts = subdomainHosts;
  if (manifest.pathPrefixes !== undefined) result.pathPrefixes = list(manifest.pathPrefixes, (value) => {
    const prefix = text(value, 512);
    if (!prefix.startsWith("/") || /[?#\\*]/.test(prefix)) throw new Error("Invalid path prefix");
    return prefix;
  });
  const targets = object(manifest.targets, Object.keys(manifest.targets as object));
  const targetNames = Object.keys(targets);
  if (targetNames.length > 8) throw new Error("Too many targets");
  for (const name of targetNames) {
    if (!fieldName(name, 64)) throw new Error(`Invalid target name: ${name}`);
    result.targets[name] = parseTarget(targets[name]);
  }
  const events = object(manifest.events, Object.keys(manifest.events as object));
  const eventNames = Object.keys(events);
  if (!eventNames.length) throw new Error("Package requires at least one event");
  for (const name of eventNames) {
    if (!eventName(name, 64)) throw new Error(`Invalid event name: ${name}`);
    result.events[name] = parseEventDefinition(events[name], new Set(targetNames));
  }
  const payloadFields = new Set<string>();
  for (const def of Object.values(result.events)) {
    for (const field of Object.keys(def.payload ?? {})) payloadFields.add(field);
  }
  result.skills = list(manifest.skills, (v) => parseDefinition(v, new Set(eventNames), payloadFields), 16);
  if (new Set(result.skills.map((skill) => skill.id)).size !== result.skills.length) throw new Error("Duplicate skill ID");
  return result;
}

/** Shape validation is separate from coordinator verification of sender identity. */
export function parseSkillEvent(value: unknown): SkillEvent {
  const entry = object(value, ["version", "eventId", "event", "source", "interactionId", "draftRevision", "contextRevision", "planVersion", "origin", "causedBy", "contextRef"]);
  if (entry.version !== 1) throw new Error("Unsupported event version");
  const result: SkillEvent = {
    version: 1, eventId: text(entry.eventId), event: qualifiedEventName(entry.event),
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
  /** The package owns the site definition; the plan carries it to the page. */
  packageId: string;
  /**
   * Runtime placement, derived from the manifest at compile time:
   * "isolated" when every target is CSS (the default), "main" when any
   * target uses the JS dialect (its predicate must run where string
   * codegen is legal, and the gate consult is synchronous).
   */
  world: "isolated" | "main";
  targets: Record<string, SkillTarget>;
  /** Definitions of the subscribed events (local names). */
  events: Record<string, SkillEventDefinition>;
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
  fields: string[];
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
    fields: list(entry.fields, (f) => fieldName(f, 64), 8),
    maxBytes: integer(entry.maxBytes, 1, 32_768),
  };
}

/** The coordinator's snapshot payload; the host binds it to the job identity. */
export function parseSkillsContextResult(value: unknown, maxBytes: number): SkillsContextResult {
  const entry = object(value, ["contextRef", "context", "bytes"]);
  const inner = object(entry.context, Object.keys(entry.context as object));
  for (const key of Object.keys(inner)) if (!fieldName(key, 64)) throw new Error("Invalid context field");
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
