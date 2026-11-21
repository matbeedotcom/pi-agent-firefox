/**
 * Skills protocol surface for the native host (skills-runtime-design.md
 * §2, §7, §13 "addon-coordinator" host half).
 *
 * Application messages ride the existing ACP transport under the negotiated
 * x-trusted-ua/skills_* namespace; standard prompt traffic stays separate.
 * One SkillsProtocol instance wraps ONE client connection (one addon
 * connection = one source of verified identity) and shares the broker's
 * single SkillsHost across all clients.
 *
 * Flow (all messages carry explicit request IDs):
 *   client → host  skills_plan   compile a page plan for a verified source
 *   client → host  skills_event  submit a verified event (ack: accepted/…)
 *   host   → client skills_context  resolve contextRef (bounded snapshot)
 *   host   → client skills_result   deliver a job outcome (acked)
 *   client → host  skills_cancel / skills_status
 *
 * Identity rules (design §7): the coordinator's source identity is
 * authoritative — a page payload cannot claim another tab, frame, document
 * generation, epoch, account, or plan. Events naming an unknown or stale
 * plan are rejected, never guessed. Runtime failures are separate from
 * semantic results: an unavailable outcome never clears a required review.
 */
import {
  X_TRUSTED_UA,
  parseSkillsCancelParams,
  parseSkillsContextResult,
  parseSkillsEventParams,
  parseSkillsPlanParams,
  TRUSTED_UA_ERROR,
  type TrustedUaErrorCode,
  type ReviewResult,
  type SkillEvent,
  type SkillPlanRule,
  type SkillsCancelParams,
  type SkillsContextRequestParams,
  type SkillsContextResult,
  type SkillsEventParams,
  type SkillsEventResult,
  type SkillsPlanParams,
  type SkillsPlanResult,
  type SkillsResultParams,
  type SkillsStatusResult,
} from "@trusted-ua/protocol";
import { skillEventName } from "@trusted-ua/protocol";
import type { SkillsHost } from "./pi-integration.js";
import type { SkillsRegistry } from "./registry.js";
import type { SkillGrant, SkillsPlanner } from "./planner.js";
import type { SkillJobOutcome } from "./skills-service.js";
import type { Logger } from "../logger.js";

/** The host→client request channel (one client's ACP transport). */
export interface SkillsProtocolEndpoint {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export interface SkillsProtocolDeps {
  log: Logger;
  /** Broker-owned job service shared by every client. */
  host: SkillsHost;
  registry: SkillsRegistry;
  planner: SkillsPlanner;
  /** User grants (settings). No grants → nothing arms; plans stay empty. */
  grants: () => ReadonlyMap<string, SkillGrant>;
  endpoint: SkillsProtocolEndpoint;
  /** Bounded context snapshot size per review (design §9: 32 KiB). */
  maxContextBytes?: number;
  /** Host→client round-trip budget for context resolution. */
  contextTimeoutMs?: number;
  /**
   * Lifecycle observation sink (JSONL event log): one record per plan
   * compile, event ack, and job result — the agent's "what just happened"
   * channel for live skill development.
   */
  onLifecycle?: (event: SkillsLifecycleEvent) => void;
}

/** One line in the host skills event log (run dir `skills-events.jsonl`). */
export type SkillsLifecycleEvent =
  | { type: "plan"; doc: string; status: string; rules: number; unavailable: { skillKey: string; reason: string }[]; planVersion?: number; planId?: string }
  | { type: "event"; eventId: string; event: string; status: string; jobs?: number; reason?: string }
  | { type: "result"; jobId: string; skillKey: string; status: string; decision?: string; reason?: string }
  | { type: "reload"; packages: number; skills: number; generation: number; ok: boolean };

/** Per-client mutable state: one connection = one verified identity. */
interface ClientState {
  plans: Map<string, StoredPlan>;
  planVersions: Map<string, number>;
  jobKeys: Set<string>;
}

interface StoredPlan {
  planId: string;
  planVersion: number;
  expiresAt: number;
  rules: SkillPlanRule[];
}

const MAX_PLANS_PER_CLIENT = 64;
const MAX_JOBS_PER_CLIENT = 256;

interface SkillsProtocolContext {
  deps: SkillsProtocolDeps;
  state: ClientState;
  maxContextBytes: number;
  contextTimeoutMs: number;
  deliverResult: (outcome: SkillJobOutcome, rule: SkillPlanRule, jobId: string, eventId: string) => void;
}

export interface SkillsProtocol {
  /**
   * Route one client→host request. Returns true when the method belongs to
   * the skills surface (and a response was sent); false when the caller
   * should answer METHOD_NOT_FOUND.
   */
  handle(
    method: string,
    params: unknown,
    respond: (result: unknown) => void,
    respondError: (code: TrustedUaErrorCode, message: string) => void,
  ): boolean;
  /** Drop this client's plans and cancel its in-flight jobs. */
  dispose(): void;
  /** Live-plan diagnostics (skills_status / shutdown assertions). */
  plans(): { count: number; armedRules: number };
}

function planKey(source: SkillsPlanParams["source"]): string {
  return source.tabId !== undefined && source.frameId !== undefined
    ? `doc:${source.tabId}:${source.frameId}:${source.documentGeneration ?? ""}`
    : `mail:${source.accountId ?? "default"}`;
}

function handlePlan(ctx: SkillsProtocolContext, raw: unknown): SkillsPlanResult {
  const { deps, state } = ctx;
  const params = parseSkillsPlanParams(raw) as SkillsPlanParams;
  const key = planKey(params.source);
  const version = (state.planVersions.get(key) ?? 0) + 1;
  state.planVersions.set(key, version);
  let compiled;
  try {
    compiled = deps.planner.compile(
      {
        application: params.source.application,
        url: params.url,
        documentGeneration: params.source.documentGeneration ?? "mail",
        ...(params.source.accountId ? { accountId: params.source.accountId } : {}),
      },
      deps.grants(),
      version,
    );
  } catch (err) {
    deps.log.warn(`skills plan failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    deps.onLifecycle?.({ type: "plan", doc: key, status: "unavailable", rules: 0, unavailable: [] });
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (state.plans.size >= MAX_PLANS_PER_CLIENT && !state.plans.has(key)) state.plans.delete(state.plans.keys().next().value!);
  state.plans.set(key, { planId: compiled.planId, planVersion: compiled.planVersion, expiresAt: compiled.expiresAt, rules: compiled.rules });
  deps.onLifecycle?.({
    type: "plan", doc: key, status: "ok",
    rules: compiled.rules.length, unavailable: compiled.unavailable,
    planVersion: compiled.planVersion, planId: compiled.planId,
  });
  return { status: "ok", plan: compiled };
}

async function handleEvent(ctx: SkillsProtocolContext, raw: unknown): Promise<SkillsEventResult> {
  const { deps, state } = ctx;
  const params = parseSkillsEventParams(raw) as SkillsEventParams;
  const evt = params.event;
  const key = planKey(evt.source);
  const stored = state.plans.get(key);
  if (!stored || stored.planVersion !== evt.planVersion) {
    return { status: "stale-plan", reason: "no plan for this document generation or version mismatch; re-plan" };
  }
  if (Date.now() > stored.expiresAt) {
    return { status: "stale-plan", reason: "plan expired; re-plan" };
  }
  // Events are package-scoped: `packageId:local`. A rule matches when the
  // event's package is the rule's package and a subscription names it.
  const rules = stored.rules.filter((rule) =>
    rule.subscriptions.some((sub) => evt.event === skillEventName(rule.packageId, sub.event)));
  if (rules.length === 0) {
    deps.onLifecycle?.({ type: "event", eventId: evt.eventId, event: evt.event, status: "no-match" });
    return { status: "no-match" };
  }

  // Resolve the context snapshot through the coordinator's capability
  // (design §7: contextRef resolves ONLY here, privacy by request).
  // Field names are package-defined payload fields; the snapshot store
  // answers only the fields the matching rules requested.
  const resolved = await resolveEventContext(ctx, rules, evt);
  if (resolved.payload === undefined) return { status: "unavailable", reason: resolved.reason ?? "context unavailable" };

  const jobs = submitRuleJobs(ctx, evt, rules, resolved.payload);
  const result = jobs.length ? { status: "accepted" as const, jobs } : { status: "unavailable" as const, reason: "no usable rules" };
  deps.onLifecycle?.({
    type: "event", eventId: evt.eventId, event: evt.event, status: result.status,
    ...(result.status === "accepted" ? { jobs: result.jobs.length } : { reason: result.reason }),
  });
  return result;
}

async function resolveEventContext(
  ctx: SkillsProtocolContext,
  rules: SkillPlanRule[],
  evt: SkillEvent,
): Promise<{ payload?: string; reason?: string }> {
  const { deps } = ctx;
  const fields = [...new Set(
    rules.flatMap((rule) => {
      const skill = deps.registry.get(rule.skillKey);
      return skill ? [...skill.definition.context.required, ...skill.definition.context.optional] : [];
    }),
  )];
  try {
    const request: SkillsContextRequestParams = {
      contextRef: evt.contextRef, interactionId: evt.interactionId,
      planVersion: evt.planVersion, fields, maxBytes: ctx.maxContextBytes,
    };
    const response = await deps.endpoint.request<SkillsContextResult>(X_TRUSTED_UA.skills_context, request, ctx.contextTimeoutMs);
    const parsed = parseSkillsContextResult(response, ctx.maxContextBytes);
    return { payload: JSON.stringify(parsed.context) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log.warn(`skills context unavailable for ${evt.eventId}: ${reason}`);
    return { reason: `context unavailable: ${reason}` };
  }
}

function submitRuleJobs(
  ctx: SkillsProtocolContext,
  evt: SkillEvent,
  rules: SkillPlanRule[],
  contextPayload: string,
): NonNullable<SkillsEventResult["jobs"]> {
  const { deps, state } = ctx;
  const jobs: NonNullable<SkillsEventResult["jobs"]> = [];
  for (const rule of rules) {
    const skill = deps.registry.get(rule.skillKey);
    if (!skill) {
      deps.log.warn(`skills rule names unknown skill ${rule.skillKey}; skipped`);
      continue;
    }
    const jobId = `job:${evt.eventId}:${rule.skillKey}`;
    const dedupeKey = `${rule.skillKey}:${evt.interactionId}:${evt.draftRevision ?? 0}`;
    const local = evt.event.slice(rule.packageId.length + 1);
    const kind = rule.events[local]?.kind === "gate" ? "gate" : "speculative";
    void deps.host
      .submit({
        skill,
        context: contextPayload,
        eventId: evt.eventId,
        jobId,
        key: dedupeKey,
        kind,
        grantedTools: [],
      })
      .then((outcome) => ctx.deliverResult(outcome, rule, jobId, evt.eventId));
    if (state.jobKeys.size >= MAX_JOBS_PER_CLIENT) state.jobKeys.delete(state.jobKeys.values().next().value!);
    state.jobKeys.add(dedupeKey);
    jobs.push({ jobId, skillKey: rule.skillKey, key: dedupeKey });
  }
  return jobs;
}

function handleCancel(ctx: SkillsProtocolContext, raw: unknown): { cancelled: number } {
  const { deps, state } = ctx;
  const params = parseSkillsCancelParams(raw) as SkillsCancelParams;
  let cancelled = 0;
  for (const key of [...state.jobKeys]) {
    if (key.includes(`:${params.interactionId}:`)) {
      cancelled += deps.host.cancel(key);
      state.jobKeys.delete(key);
    }
  }
  return { cancelled };
}

function handleStatus(ctx: SkillsProtocolContext): SkillsStatusResult {
  const { deps, state } = ctx;
  const stats = deps.host.service.stats;
  return {
    available: !stats.closed,
    stats: {
      running: stats.running,
      queued: stats.queued,
      replacements: stats.replacements,
      closed: stats.closed,
      outcomes: { ...stats.outcomes },
    },
    plans: state.plans.size,
    armedRules: [...state.plans.values()].reduce((sum, p) => sum + p.rules.length, 0),
  };
}

function deliverResult(
  ctx: SkillsProtocolContext,
  outcome: SkillJobOutcome,
  rule: SkillPlanRule,
  jobId: string,
  eventId: string,
): void {
  const params: SkillsResultParams =
    outcome.status === "done" && outcome.value
      ? (() => {
          const report = outcome.value as ReviewResult;
          return {
            jobId, eventId, skillKey: rule.skillKey, skillRevision: rule.skillRevision, status: "done" as const,
            decision: report.decision,
            ...(report.explanation !== undefined ? { explanation: report.explanation } : {}),
            ...(report.replacementText !== undefined ? { replacementText: report.replacementText } : {}),
          };
        })()
      : {
          jobId, eventId, skillKey: rule.skillKey, skillRevision: rule.skillRevision, status: "unavailable",
          reason: outcome.reason ?? outcome.error?.message ?? outcome.status,
        };
  ctx.deps.onLifecycle?.({
    type: "result", jobId, skillKey: rule.skillKey, status: params.status,
    ...(params.status === "done" ? { decision: params.decision } : { reason: params.reason }),
  });
  // Delivery is best-effort and acked: a client that is gone (disconnect,
  // navigation) must not wedge the already-settled job.
  ctx.deps.endpoint
    .request(X_TRUSTED_UA.skills_result, params, ctx.contextTimeoutMs)
    .catch((err: unknown) => ctx.deps.log.warn(`skills result delivery failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`));
}

export function createSkillsProtocol(deps: SkillsProtocolDeps): SkillsProtocol {
  const state: ClientState = { plans: new Map(), planVersions: new Map(), jobKeys: new Set() };
  const ctx: SkillsProtocolContext = {
    deps,
    state,
    maxContextBytes: deps.maxContextBytes ?? 32_768,
    contextTimeoutMs: deps.contextTimeoutMs ?? 5_000,
    deliverResult: (outcome, rule, jobId, eventId) => deliverResult(ctx, outcome, rule, jobId, eventId),
  };
  return {
    handle(method, params, respond, respondError): boolean {
      const fail = (err: unknown) => {
        const message = `skills: ${err instanceof Error ? err.message : JSON.stringify(err)}`;
        deps.log.warn(`skills protocol error (${method}): ${message}`);
        respondError(TRUSTED_UA_ERROR.INTERNAL, message);
      };
      try {
        switch (method) {
          case X_TRUSTED_UA.skills_plan:
            respond(handlePlan(ctx, params));
            return true;
          case X_TRUSTED_UA.skills_event:
            void handleEvent(ctx, params).then(respond, fail);
            return true;
          case X_TRUSTED_UA.skills_cancel:
            respond(handleCancel(ctx, params));
            return true;
          case X_TRUSTED_UA.skills_status:
            respond(handleStatus(ctx));
            return true;
          default:
            return false;
        }
      } catch (err) {
        fail(err);
        return true;
      }
    },
    dispose(): void {
      for (const key of state.jobKeys) deps.host.cancel(key);
      state.jobKeys.clear();
      state.plans.clear();
      state.planVersions.clear();
    },
    plans(): { count: number; armedRules: number } {
      return { count: state.plans.size, armedRules: [...state.plans.values()].reduce((sum, p) => sum + p.rules.length, 0) };
    },
  };
}
