/**
 * Skills runtime — the addon-background facade that binds the transport
 * (SkillsCoordinator) to one submission-gate session per document
 * (skills-runtime-design.md §2, §7, §8, §13 "addon-coordinator").
 *
 * Responsibilities:
 * - Per-document ReviewSession lifecycle (one gate per eligible document).
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
} from "@pi-browser/protocol";
import { ActivationHistory } from "./activation-history.js";
import {
  SkillsCoordinator,
  type DocumentIdentity,
} from "./coordinator.js";
import type {
  SkillsCancelResult,
  SkillsPlanResult,
  SkillsStatusResult,
} from "@pi-browser/protocol";

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
  session: ReviewSession;
}

interface JobMapping {
  docKey: string;
  gateJobId: string;
  skillKey: string;
}

export interface SkillsRuntimeOptions {
  application: "firefox" | "thunderbird";
  mode: "advisory" | "review-before-submit";
  /** Client→host request channel (same native port as handleHostRequest). */
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  /** Card/management sync on every gate transition, per document. */
  onCardState?: (document: DocumentIdentity, view: GateView) => void;
  log?: (message: string) => void;
}

export interface SkillsArmInput {
  document: DocumentIdentity;
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
  private readonly onCardState: (document: DocumentIdentity, view: GateView) => void;
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

  /**
   * Arm one document for review. The host reads a fresh bounded draft and
   * target, compiles the plan, and passes both; exactly ONE transport event
   * carries the snapshot (the host fans it out to every subscribing rule).
   */
  async arm(input: SkillsArmInput): Promise<SkillsArmResult> {
    const docKey = this.coordinator.docKey(input.document);
    let entry = this.sessions.get(docKey);
    if (!entry) {
      const session = new ReviewSession({
        mode: this.opts.mode,
        history: this.history,
        onState: (view) => this.onCardState(entry!.document, view),
      });
      entry = { document: input.document, session };
      this.sessions.set(docKey, entry);
    }
    entry.document = input.document;
    const tickets = entry.session.arm({ ...input.identity, planVersion: input.plan.planVersion });
    if (tickets.length === 0) return { tickets, jobs: [] };

    // One event per arm: the eventId IS the gate's opaque ID, so the host's
    // skills_result echoes it back onto the exact armed identity.
    const result = await this.coordinator.submitEvent({
      document: input.document,
      event: "comment.before-submit",
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
      this.log(`skills arm: event not accepted for ${docKey}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
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
      this.jobIndex.set(job.jobId, { docKey, gateJobId, skillKey: job.skillKey });
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
    const entry = this.sessions.get(mapping.docKey);
    if (!entry) return;
    entry.session.ingest({ ...params, jobId: mapping.gateJobId });
  }

  /** Synchronous gate consult before a submit chain (per document). */
  gesture(document: DocumentIdentity, gesture: SubmissionGesture): "allow" | "hold" | "duplicate" {
    const entry = this.sessions.get(this.coordinator.docKey(document));
    return entry ? entry.session.gesture(gesture) : "hold";
  }

  draftChanged(document: DocumentIdentity, identity: GateIdentity): void {
    this.sessions.get(this.coordinator.docKey(document))?.session.draftChanged(identity);
  }

  compositionChanged(document: DocumentIdentity, composing: boolean): void {
    this.sessions.get(this.coordinator.docKey(document))?.session.compositionChanged(composing);
  }

  /** User bypass / keep-own-text on one document's gate. */
  authorize(document: DocumentIdentity): boolean {
    return this.sessions.get(this.coordinator.docKey(document))?.session.authorize() ?? false;
  }

  /** Record a user-applied suggestion (history only; host re-arms fresh). */
  applySuggestion(document: DocumentIdentity, params: Pick<SkillsResultParams, "jobId" | "eventId" | "skillKey" | "skillRevision">): void {
    this.sessions.get(this.coordinator.docKey(document))?.session.applySuggestion(params);
  }

  view(document: DocumentIdentity): GateView | undefined {
    return this.sessions.get(this.coordinator.docKey(document))?.session.view();
  }

  /** Cancel pending skill work for one interaction (all documents). */
  cancel(interactionId: string): Promise<SkillsCancelResult> {
    return this.coordinator.cancel(interactionId);
  }

  status(): Promise<SkillsStatusResult> {
    return this.coordinator.status();
  }

  /** Navigation / tab removal: drop the gate and its snapshots. */
  closeDocument(document: DocumentIdentity): void {
    const docKey = this.coordinator.docKey(document);
    this.sessions.get(docKey)?.session.close();
    this.sessions.delete(docKey);
    this.coordinator.forgetDocument(document);
    for (const [jobId, mapping] of this.jobIndex) {
      if (mapping.docKey === docKey) this.jobIndex.delete(jobId);
    }
  }

  /** Compact state for the sidebar/management view (bounded). */
  state(): { documents: { key: string; view: GateView }[]; history: ReturnType<ActivationHistory["summarize"]> } {
    return {
      documents: [...this.sessions.values()].map((entry) => ({
        key: this.coordinator.docKey(entry.document),
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
      if (mapping.docKey.startsWith(prefix)) this.jobIndex.delete(jobId);
    }
  }
}
