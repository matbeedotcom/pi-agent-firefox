import type { ReviewResult } from "@pi-browser/protocol";

export type GateState = "dirty" | "reviewing" | "clear" | "suggestion" | "unavailable" | "authorized" | "closed";
export interface GateIdentity {
  documentGeneration: string;
  frameId: number;
  accountId?: string;
  interactionId: string;
  replyTarget: string;
  draft: string;
  contextRevision: number;
  planVersion: number;
  reviewers: { key: string; revision: string; memoryRevision: number }[];
}
export interface ReviewTicket {
  jobId: string;
  eventId: string;
  skillKey: string;
  skillRevision: string;
  identity: GateIdentity;
}
export interface GateView {
  state: GateState;
  reason?: string;
  suggestions: ReviewResult[];
}
export interface SubmissionGesture {
  /** Adapter-owned ID for a tested click/keyboard-to-submit chain. Never page supplied. */
  chainId: string;
  phase: "click" | "keyboard" | "submit";
}
interface Attempt {
  chainId: string;
  expiresAt: number;
  phases: Set<SubmissionGesture["phase"]>;
}

/** No DOM actions, IPC, timers or async work. The adapter cancels held gestures synchronously. */
export class SubmissionGate {
  private identity?: GateIdentity;
  private identityKey = "";
  private status: GateState = "dirty";
  private reason?: string;
  private composing = false;
  private connected = true;
  private sequence = 0;
  private deadline = 0;
  private authorizedUntil = 0;
  private attempt?: Attempt;
  private tickets = new Map<string, ReviewTicket>();
  private results = new Map<string, ReviewResult>();

  constructor(private readonly mode: "advisory" | "review-before-submit", private readonly now: () => number = Date.now) {}

  /** Called with a freshly read bounded draft and target before every submission gesture. */
  update(identity: GateIdentity): void {
    if (this.status === "closed") return;
    if (!boundedIdentity(identity)) {
      this.identity = undefined;
      this.identityKey = "";
      this.invalidate("unavailable", "Draft or context exceeds review limits");
      return;
    }
    const key = JSON.stringify(identity);
    if (key === this.identityKey) return;
    this.identityKey = key;
    this.identity = structuredClone(identity);
    if (new TextEncoder().encode(key).length > 32_768) this.invalidate("unavailable", "Draft exceeds the review limit; local bypass is available");
    else this.invalidate("dirty");
  }

  private invalidate(state: GateState, reason?: string): void {
    this.status = state;
    this.reason = reason;
    this.authorizedUntil = 0;
    this.attempt = undefined;
    this.deadline = 0;
    this.tickets.clear();
    this.results.clear();
  }

  setComposition(composing: boolean): void {
    this.composing = composing;
    if (composing && this.status !== "closed") this.invalidate("dirty");
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (this.status === "closed") return;
    if (!connected) this.invalidate("unavailable", "Review connection lost; local bypass is available");
    // Reconnection requires a fresh plan/update before any new review can clear a gate.
  }

  /** Host/coordinator must echo these opaque IDs and bind its job to this exact identity. */
  beginReview(): ReviewTicket[] {
    if (this.status !== "dirty" || this.composing || !this.identity) return [];
    if (!this.connected || !this.identity.reviewers.length) {
      this.invalidate("unavailable", "Required review is unavailable");
      return [];
    }
    this.status = "reviewing";
    this.deadline = this.now() + 10_000;
    const eventId = `${this.identity.documentGeneration}:${this.identity.interactionId}:${++this.sequence}`;
    for (const [index, reviewer] of this.identity.reviewers.entries()) {
      const ticket = { jobId: `${eventId}:${index}`, eventId, skillKey: reviewer.key,
        skillRevision: reviewer.revision, identity: structuredClone(this.identity) };
      this.tickets.set(ticket.jobId, ticket);
    }
    return structuredClone([...this.tickets.values()]);
  }

  accept(result: ReviewResult): boolean {
    this.expire();
    if (this.status !== "reviewing" && this.status !== "suggestion") return false;
    const ticket = this.tickets.get(result.jobId);
    if (!ticket || !matchesTicket(ticket, result) || this.results.has(result.jobId)) return false;
    if (result.decision === "abstain") {
      this.invalidate("unavailable", "A required reviewer abstained; local bypass is available");
      return true;
    }
    this.results.set(result.jobId, structuredClone(result));
    if ([...this.results.values()].some((review) => review.decision === "suggest")) this.status = "suggestion";
    else if (this.results.size === this.tickets.size) this.status = "clear";
    return true;
  }

  fail(jobId: string, reason: string): void {
    if (!this.tickets.has(jobId) || this.status === "closed") return;
    this.invalidate("unavailable", reason.slice(0, 512));
  }

  /** Local user decision only: edits still require update() and another review. Never posts. */
  authorizeOriginal(): boolean {
    this.expire();
    if (!this.identity || this.composing || !["suggestion", "unavailable", "reviewing", "dirty"].includes(this.status)) return false;
    this.invalidate("authorized");
    this.authorizedUntil = this.now() + 15_000;
    return true;
  }

  submit(gesture: SubmissionGesture): "allow" | "hold" | "duplicate" {
    this.expire();
    if (this.status === "closed") return "hold";
    if (this.mode === "advisory") return "allow";
    if (this.composing || !this.identity) return "hold";
    if (this.attempt?.chainId === gesture.chainId) return this.continueAttempt(gesture);
    if (this.status !== "clear" && this.status !== "authorized") return "hold";
    this.invalidate("dirty");
    this.attempt = { chainId: gesture.chainId, expiresAt: this.now() + 1000, phases: new Set([gesture.phase]) };
    return "allow";
  }

  private continueAttempt(gesture: SubmissionGesture): "allow" | "duplicate" {
    const attempt = this.attempt!;
    // Only the associated submit may follow the original click/keyboard gesture.
    if (gesture.phase !== "submit" || attempt.phases.has("submit")) return "duplicate";
    attempt.phases.add("submit");
    return "allow";
  }

  private expire(): void {
    const now = this.now();
    if (this.attempt && now >= this.attempt.expiresAt) this.attempt = undefined;
    if (this.status === "authorized" && now >= this.authorizedUntil) this.invalidate("dirty");
    if (["reviewing", "suggestion", "clear"].includes(this.status) && now >= this.deadline) {
      this.invalidate("unavailable", "Review expired; local bypass is available");
    }
  }

  view(): GateView {
    this.expire();
    return { state: this.status, reason: this.reason,
      suggestions: structuredClone([...this.results.values()].filter((result) => result.decision === "suggest")) };
  }

  close(): void {
    this.invalidate("closed");
    this.identity = undefined;
    this.identityKey = "";
  }
}

function matchesTicket(ticket: ReviewTicket, result: ReviewResult): boolean {
  return ticket.eventId === result.eventId && ticket.skillKey === result.skillKey && ticket.skillRevision === result.skillRevision;
}

function boundedIdentity(identity: GateIdentity): boolean {
  if (identity.draft.length > 262_144 || identity.replyTarget.length > 2048) return false;
  if (identity.reviewers.length > 64 || new Set(identity.reviewers.map((reviewer) => reviewer.key)).size !== identity.reviewers.length) return false;
  const ids = [identity.documentGeneration, identity.accountId ?? "", identity.interactionId,
    ...identity.reviewers.flatMap((reviewer) => [reviewer.key, reviewer.revision])];
  if (ids.some((id) => id.length > 256)) return false;
  // Length precheck avoids encoding an unbounded draft on the synchronous path.
  return new TextEncoder().encode(JSON.stringify(identity)).length <= 262_144;
}
