/**
 * Skills runtime — the addon-background facade that binds the transport
 * (SkillsCoordinator) to one submission-gate session per (document, gate
 * event) (skills-runtime-design.md §2, §7, §8, §13 "addon-coordinator").
 *
 * Responsibilities:
 * - Per-(document, gate event) ReviewSession lifecycle. A document may
 *   carry several rules (several skill packages); each rule with a gate
 *   event owns its own session, its own review chain, and its own card view.
 * - Job mapping: the gate's opaque ticket IDs (jobId/eventId) travel to the
 *   host as the transport eventId; the host's per-rule jobIds are mapped
 *   back by skillKey so skills_result deliveries reach the right ticket.
 * - Connection lifecycle: a new native epoch invalidates every session and
 *   job mapping; disconnects degrade every gate to its local bypass.
 *
 * It owns NO browser APIs — the host background pumps it and registers
 * `handleHostRequest` on the ACP client's onExtensionRequest.
 */
import type {
  PagePlan,
  SkillsEventJob,
  SkillsResultParams,
} from "@trusted-ua/protocol";
import { ActivationHistory } from "./activation-history.js";
import {
  SkillsCoordinator,
  type DocumentIdentity,
} from "./coordinator.js";
import type {
  SkillsCancelResult,
  SkillsPlanResult,
  SkillsStatusResult,
} from "@trusted-ua/protocol";

export type { DocumentIdentity };
import { ReviewSession } from "./review-session.js";
import type {
  GateIdentity,
  GateView,
  ReviewTicket,
  SubmissionGesture,
} from "./submission-gate.js";

interface SessionEntry {
  document: DocumentIdentity;
  /** Qualified gate event identity `<packageId>:<local>`. */
  event: string;
  session: ReviewSession;
}

interface JobMapping {
  sessionKey: string;
  gateJobId: string;
  skillKey: string;
}

export interface SkillsRuntimeOptions {
  application: "firefox" | "thunderbird";
  /** Client→host request channel (same native port as handleHostRequest). */
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  /** Card/management sync on every gate transition, per (document, event). */
  onCardState?: (document: DocumentIdentity, view: GateView, event: string) => void;
  log?: (message: string) => void;
}

export interface SkillsArmInput {
  document: DocumentIdentity;
  /** Qualified gate event identity `<packageId>:<local>` this arm belongs to. */
  event: string;
  /** Fresh bounded draft + target + reviewers read by the host just before arming. */
  identity: Omit<GateIdentity, "planVersion">;
  /** Current compiled plan for this document (from SkillsRuntime.plan). */
  plan: PagePlan;
  /** Bounded page context for this interaction (one snapshot per arm). */
  snapshot?: Record<string, unknown>;
  draftRevision?: number;
}

export interface SkillsArmResult {
  tickets: ReviewTicket[];
  jobs: SkillsEventJob[];
}

export class SkillsRuntime {
  readonly coordinator: SkillsCoordinator;
  /** Shared bounded activation history (management view, design §252). */
  readonly history: ActivationHistory;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly jobIndex = new Map<string, JobMapping>();
  private readonly onCardState: (document: DocumentIdentity, view: GateView, event: string) => void;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: SkillsRuntimeOptions) {
    this.onCardState = opts.onCardState ?? (() => {});
    this.log = opts.log ?? (() => {});
    this.history = new ActivationHistory();
    this.coordinator = new SkillsCoordinator({
      application: opts.application,
      request: opts.request,
      log: opts.log,
      onResult: (params) => this.ingest(params),
    });
  }

  /** Register on the ACP client's onExtensionRequest. */
  handleHostRequest(method: string, params: unknown): Promise<unknown> | unknown {
    return this.coordinator.handleHostRequest(method, params);
  }

  /**
   * New native-port connection (including reconnects): a fresh epoch
   * invalidates every event identity, plan, and job mapping.
   */
  noteConnection(): void {
    this.coordinator.noteConnection();
    for (const [key, entry] of this.sessions) {
      entry.session.close();
      this.sessions.delete(key);
    }
    this.jobIndex.clear();
    this.log("skills runtime: new connection epoch; all sessions reset");
  }

  /** Link down/up: every gate degrades to (or regains) local bypass. */
  setConnected(connected: boolean): void {
    for (const entry of this.sessions.values()) entry.session.setConnected(connected);
  }

  /** Compile the page plan for one document (host stores it, echoes planVersion). */
  plan(document: DocumentIdentity): Promise<SkillsPlanResult> {
    return this.coordinator.plan(document);
  }

  private sessionKey(docKey: string, event: string): string {
    return `${docKey}|${event}`;
  }

  private sessionsForDoc(docKey: string): SessionEntry[] {
    return [...this.sessions.entries()]
      .filter(([key]) => key.startsWith(`${docKey}|`))
      .map(([, entry]) => entry);
  }

  /**
   * Arm one (document, gate event) for review. The host reads a fresh
   * bounded payload, compiles the plan, and passes both; exactly ONE
   * transport event carries the snapshot, routed to the rules subscribed
   * to THIS event (the rule owns its gate).
   */
  async arm(input: SkillsArmInput): Promise<SkillsArmResult> {
    const docKey = this.coordinator.docKey(input.document);
    // One session per (document, gate): the review result is a property of
    // the draft, not of which event armed it (design §8 — one local
    // coordinator per composer). A speculative arm (draft.paused) lands in
    // the owning rule's GATE session, so the card shows the review BEFORE
    // the first submit and the submit consults the same session. The
    // transport keeps the armed event so the host schedules the right job
    // kind (speculative vs gate).
    const owner = input.plan.rules.find((rule) =>
      rule.subscriptions.some((sub) => `${rule.packageId}:${sub.event}` === input.event));
    let gateSub: { event: string } | undefined;
    if (owner) {
      const ownerRule = owner;
      gateSub = ownerRule.subscriptions.find((sub) => ownerRule.events[sub.event]?.kind === "gate");
    }
    const sessionEvent = gateSub && owner ? `${owner.packageId}:${gateSub.event}` : input.event;
    const key = this.sessionKey(docKey, sessionEvent);
    let entry = this.sessions.get(key);
    if (!entry) {
      const session = new ReviewSession({
        mode: owner?.mode ?? "review-before-submit",
        history: this.history,
        onState: (view) => this.onCardState(entry!.document, view, sessionEvent),
      });
      entry = { document: input.document, event: sessionEvent, session };
      this.sessions.set(key, entry);
    }
    entry.document = input.document;
    const tickets = entry.session.arm({ ...input.identity, planVersion: input.plan.planVersion });
    if (tickets.length === 0) return { tickets, jobs: [] };

    // One event per arm: the eventId IS the gate's opaque ID, so the host's
    // skills_result echoes it back onto the exact armed identity.
    const result = await this.coordinator.submitEvent({
      document: input.document,
      event: input.event,
      interactionId: input.identity.interactionId,
      planVersion: input.plan.planVersion,
      contextRevision: input.identity.contextRevision,
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      origin: "user",
      ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
      eventId: tickets[0].eventId,
    });
    if (result.status !== "accepted" || !result.jobs) {
      // No job will ever deliver: degrade the gate to a usable local bypass
      // instead of claiming protection that cannot clear (design §8).
      entry.session.failReview(`${result.status}${result.reason ? `: ${result.reason}` : ""}`);
      this.log(`skills arm: event not accepted for ${key}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
      return { tickets, jobs: [] };
    }
    // Map host jobIds → gate ticket jobIds by skillKey (unique per plan).
    const byKey = new Map(tickets.map((t) => [t.skillKey, t.jobId]));
    const jobs: SkillsEventJob[] = [];
    for (const job of result.jobs) {
      const gateJobId = byKey.get(job.skillKey);
      if (gateJobId === undefined) {
        this.log(`skills arm: host job for unknown reviewer ${job.skillKey}; ignored`);
        continue;
      }
      this.jobIndex.set(job.jobId, { sessionKey: key, gateJobId, skillKey: job.skillKey });
      jobs.push(job);
    }
    return { tickets, jobs };
  }

  /**
   * One delivered job outcome (coordinator skills_result). Results for
   * unknown/closed/stale jobs are dropped — the ack already went out.
   */
  private ingest(params: SkillsResultParams): void {
    const mapping = this.jobIndex.get(params.jobId);
    if (!mapping) {
      this.log(`skills runtime: result for unknown job ${params.jobId}; dropped`);
      return;
    }
    this.jobIndex.delete(params.jobId);
    const entry = this.sessions.get(mapping.sessionKey);
    if (!entry) return;
    entry.session.ingest({ ...params, jobId: mapping.gateJobId });
  }

  /** Synchronous gate consult before a submit chain (per document, per event). */
  gesture(document: DocumentIdentity, event: string, gesture: SubmissionGesture): "allow" | "hold" | "duplicate" {
    const key = this.sessionKey(this.coordinator.docKey(document), event);
    return this.sessions.get(key)?.session.gesture(gesture) ?? "hold";
  }

  draftChanged(document: DocumentIdentity, event: string, identity: GateIdentity): void {
    const key = this.sessionKey(this.coordinator.docKey(document), event);
    this.sessions.get(key)?.session.draftChanged(identity);
  }

  compositionChanged(document: DocumentIdentity, event: string, composing: boolean): void {
    const key = this.sessionKey(this.coordinator.docKey(document), event);
    this.sessions.get(key)?.session.compositionChanged(composing);
  }

  /** User bypass / keep-own-text on one (document, event) gate. */
  authorize(document: DocumentIdentity, event?: string): boolean {
    const docKey = this.coordinator.docKey(document);
    const targets = event
      ? [this.sessions.get(this.sessionKey(docKey, event))]
      : this.sessionsForDoc(docKey);
    return targets.some((entry) => entry?.session.authorize() ?? false);
  }

  /** Record a user-applied suggestion (history only; host re-arms fresh). */
  applySuggestion(document: DocumentIdentity, event: string, params: Pick<SkillsResultParams, "jobId" | "eventId" | "skillKey" | "skillRevision">): void {
    const key = this.sessionKey(this.coordinator.docKey(document), event);
    this.sessions.get(key)?.session.applySuggestion(params);
  }

  view(document: DocumentIdentity, event?: string): GateView | undefined {
    const docKey = this.coordinator.docKey(document);
    if (event !== undefined) return this.sessions.get(this.sessionKey(docKey, event))?.session.view();
    return this.sessionsForDoc(docKey).map((entry) => entry.session.view()).find((v) => v && v.state !== "closed");
  }

  /** All (document, event) sessions for one document (card sync payloads). */
  sessionsForDocument(document: DocumentIdentity): { event: string; view: GateView }[] {
    return this.sessionsForDoc(this.coordinator.docKey(document))
      .map((entry) => ({ event: entry.event, view: entry.session.view() }));
  }

  /** Cancel pending skill work for one interaction (all documents). */
  cancel(interactionId: string): Promise<SkillsCancelResult> {
    return this.coordinator.cancel(interactionId);
  }

  status(): Promise<SkillsStatusResult> {
    return this.coordinator.status();
  }

  /** Navigation / tab removal: drop the gates and their snapshots. */
  closeDocument(document: DocumentIdentity): void {
    const docKey = this.coordinator.docKey(document);
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(`${docKey}|`)) {
        this.sessions.get(key)!.session.close();
        this.sessions.delete(key);
      }
    }
    this.coordinator.forgetDocument(document);
    for (const [jobId, mapping] of this.jobIndex) {
      if (mapping.sessionKey.startsWith(`${docKey}|`)) this.jobIndex.delete(jobId);
    }
  }

  /** Compact state for the sidebar/management view (bounded). */
  state(): { documents: { key: string; view: GateView }[]; history: ReturnType<ActivationHistory["summarize"]> } {
    return {
      documents: [...this.sessions.values()].map((entry) => ({
        key: this.sessionKey(this.coordinator.docKey(entry.document), entry.event),
        view: entry.session.view(),
      })),
      history: this.history.summarize(),
    };
  }

  /** All sessions for one tab (documentGeneration may be unknown). */
  closeTab(tabId: number): void {
    const prefix = `doc:${tabId}:`;
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(prefix)) {
        this.sessions.get(key)!.session.close();
        this.sessions.delete(key);
      }
    }
    for (const [jobId, mapping] of this.jobIndex) {
      if (mapping.sessionKey.startsWith(prefix)) this.jobIndex.delete(jobId);
    }
  }
}
