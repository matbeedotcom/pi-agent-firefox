/**
 * Review session — the glue between the submission gate, the coordinator's
 * job transport, activation history, and the review card
 * (skills-runtime-design.md §8, §13 "submission-gate" + "skills-ui").
 *
 * Pure orchestration: no DOM, no IPC, no timers. The host owns everything
 * external and pumps the session in a fixed order:
 *
 *   arm(identity)            — host reads a fresh bounded draft + target,
 *                               then arms for review. One ticket per
 *                               required reviewer goes to `dispatch`.
 *   ingest(params)           — coordinator's skills_result delivery.
 *   draftChanged / compositionChanged / setConnected — live invalidation.
 *   applySuggestion / authorize — the user's explicit choices (history only;
 *   applying a suggestion does NOT grant submit — the host edits the draft
 *   and re-arms with a fresh identity).
 *   gesture(g)               — the host consults the gate synchronously
 *                               before every submit chain.
 *
 * The gate remains the single source of truth for state, staleness, and
 * authorization; this session adds job routing, activation history, and
 * state notifications for the card.
 */
import type { SkillsResultParams } from "@trusted-ua/protocol";
import { ActivationHistory } from "./activation-history.js";
import {
  SubmissionGate,
  type GateIdentity,
  type GateView,
  type ReviewTicket,
  type SubmissionGesture,
} from "./submission-gate.js";

export interface ReviewSessionOptions {
  mode: "advisory" | "review-before-submit";
  now?: () => number;
  /** Shared with the management view (design §252 bounded activity). */
  history?: ActivationHistory;
  /** Host starts one isolated review job per ticket (design §10). */
  dispatch?: (ticket: ReviewTicket) => void;
  /** Host syncs the review card / management view on every transition. */
  onState?: (view: GateView) => void;
}

export class ReviewSession {
  readonly gate: SubmissionGate;
  readonly history: ActivationHistory;
  private readonly now: () => number;
  private readonly opts: ReviewSessionOptions;

  constructor(opts: ReviewSessionOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.gate = new SubmissionGate(opts.mode, this.now);
    this.history = opts.history ?? new ActivationHistory();
  }

  /** Host reads the fresh draft, then arms. Returns tickets to dispatch. */
  arm(identity: GateIdentity): ReviewTicket[] {
    this.gate.update(identity);
    const tickets = this.gate.beginReview();
    for (const ticket of tickets) this.opts.dispatch?.(ticket);
    this.sync();
    return tickets;
  }

  /** One delivered job outcome (coordinator `skills_result`). */
  ingest(params: SkillsResultParams): boolean {
    // A done-without-decision is a malformed delivery: degrade to a usable
    // local bypass rather than trusting it (design §8 "no false protection").
    if (params.status === "unavailable" || !params.decision) {
      this.gate.fail(params.jobId, params.reason ?? "Review unavailable");
      this.record(params, "unavailable", params.reason);
      this.sync();
      return true;
    }
    const accepted = this.gate.accept({
      jobId: params.jobId,
      eventId: params.eventId,
      skillKey: params.skillKey,
      skillRevision: params.skillRevision,
      decision: params.decision,
      ...(params.explanation !== undefined ? { explanation: params.explanation } : {}),
      ...(params.replacementText !== undefined ? { replacementText: params.replacementText } : {}),
    });
    if (!accepted) {
      this.sync();
      return false;
    }
    this.record(params, params.decision, params.decision === "abstain" ? params.reason : undefined);
    this.sync();
    return true;
  }

  /** User applied a suggestion. The host edits the draft and re-arms;
   *  this only records the outcome — it never grants submit. */
  applySuggestion(params: Pick<SkillsResultParams, "jobId" | "eventId" | "skillKey" | "skillRevision">): void {
    this.record(params, "applied");
    this.sync();
  }

  /** User keeps their own text / bypasses an unavailable required review. */
  authorize(): boolean {
    const view = this.gate.view();
    const ok = this.gate.authorizeOriginal();
    if (ok) {
      const declined = view.suggestions[0];
      this.record(
        declined ?? { jobId: "-", eventId: "", skillKey: "gate", skillRevision: "" },
        "bypassed",
        view.reason,
      );
      this.sync();
    }
    return ok;
  }

  draftChanged(identity: GateIdentity): void {
    this.gate.update(identity);
    this.sync();
  }

  compositionChanged(composing: boolean): void {
    this.gate.setComposition(composing);
    this.sync();
  }

  setConnected(connected: boolean): void {
    this.gate.setConnected(connected);
    this.sync();
  }

  /** Synchronous gate consult before a submit chain (design §179). */
  gesture(gesture: SubmissionGesture): "allow" | "hold" | "duplicate" {
    const verdict = this.gate.submit(gesture);
    this.sync();
    return verdict;
  }

  view(): GateView {
    return this.gate.view();
  }

  /** The armed review cannot complete (event rejected, plan gone). */
  failReview(reason: string): void {
    this.gate.failAll(reason);
    this.sync();
  }

  close(): void {
    this.gate.close();
    this.sync();
  }

  private sync(): void {
    this.opts.onState?.(this.gate.view());
  }

  private record(
    identity: { jobId: string; eventId: string; skillKey: string; skillRevision: string },
    outcome: "clear" | "suggest" | "abstain" | "unavailable" | "applied" | "bypassed",
    note?: string,
  ): void {
    this.history.record(
      {
        skillKey: identity.skillKey,
        skillRevision: identity.skillRevision,
        eventId: identity.eventId,
        outcome,
        ...(note ? { note } : {}),
      },
      this.now(),
    );
  }
}
