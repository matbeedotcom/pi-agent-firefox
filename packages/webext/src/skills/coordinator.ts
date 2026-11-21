/**
 * Addon background skills coordinator (skills-runtime-design.md §2, §7,
 * §13 "addon-coordinator").
 *
 * The coordinator owns what a page payload must never claim:
 * - SOURCE IDENTITY — application, connectionEpoch, tab/frame/document
 *   generation. The coordinator stamps every event; page-provided payloads
 *   cannot name another account, tab, or plan.
 * - PLANS — it stores the latest plan per document and re-plans before a
 *   document is armed again (reconnect rule, design §12).
 * - CONTEXT SNAPSHOTS — a bounded store (4 snapshots / 256 KiB per document,
 *   design §9). Events carry a contextRef; the host resolves it through the
 *   coordinator's skills_context capability, and only the requested fields
 *   ever leave the addon.
 * - DEDUPLICATION — at-least-once transport is made safe by a bounded
 *   seen-set: a redelivered (interaction, event, draft, context) tuple acks
 *   as duplicate without resubmitting.
 *
 * It does NO agent reasoning: every decision comes back from the host over
 * skills_result, routed to the gate/UI via onResult.
 */
import {
  X_PI_BROWSER,
  parseSkillsContextRequestParams,
  parseSkillsResultParams,
  type SkillEvent,
  type SkillEventSource,
  type SkillsCancelParams,
  type SkillsCancelResult,
  type SkillsEventResult,
  type SkillsPlanResult,
  type SkillsResultAck,
  type SkillsResultParams,
  type SkillsStatusResult,
} from "@trusted-ua/protocol";

/** Bounded snapshot store limits (design §9, per document). */
const MAX_SNAPSHOTS_PER_DOC = 4;
const MAX_SNAPSHOT_BYTES_PER_DOC = 256 * 1024;
/** Redelivery dedup window (bounded LRU). */
const MAX_SEEN_EVENTS = 1024;

/** WebCrypto exists in the MV3 background page and the Node test runtime alike. */
const uuid = (): string => crypto.randomUUID();

/** The coordinator's view of one eligible document/frame. */
export interface DocumentIdentity {
  application: "firefox" | "thunderbird";
  tabId?: number;
  frameId?: number;
  documentGeneration?: string;
  accountId?: string;
  url: string;
}

export interface SkillsCoordinatorOptions {
  application: "firefox" | "thunderbird";
  /**
   * Client→host request channel. Must target the SAME native connection the
   * coordinator registers `handleHostRequest` on (identity is per-port).
   */
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  /** Route delivered job outcomes to the gate/UI. */
  onResult?: (params: SkillsResultParams) => void;
  log?: (message: string) => void;
}

interface SnapshotEntry {
  ref: string;
  docKey: string;
  bytes: number;
  /** Only context fields (the page payload minus identity). */
  snapshot: Record<string, unknown>;
}

export class SkillsCoordinator {
  private readonly snapshots = new Map<string, SnapshotEntry>();
  private readonly docBytes = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly lastPlan = new Map<string, { planVersion: number; expiresAt: number }>();
  private epoch: string;
  private readonly log: (message: string) => void;

  constructor(
    private readonly opts: SkillsCoordinatorOptions,
    epoch: string = uuid(),
  ) {
    this.epoch = epoch;
    this.log = opts.log ?? (() => {});
  }

  /** Current connection epoch (identity stamp for every event). */
  get connectionEpoch(): string {
    return this.epoch;
  }

  /**
   * Call once per native-port "connected" transition (including reconnects).
   * A new epoch invalidates every event identity from the previous
   * connection, so nothing stale can be replayed across a reconnect.
   */
  noteConnection(): void {
    this.epoch = uuid();
    this.snapshots.clear();
    this.docBytes.clear();
    this.seen.clear();
    this.lastPlan.clear();
    this.log(`skills coordinator: new connection epoch ${this.epoch}`);
  }

  /** Stable per-document key (tabs: tab/frame/document, mail: account). */
  docKey(id: DocumentIdentity): string {
    return id.tabId !== undefined && id.frameId !== undefined
      ? `doc:${id.tabId}:${id.frameId}:${id.documentGeneration ?? ""}`
      : `mail:${id.accountId ?? "default"}`;
  }

  private source(id: DocumentIdentity): SkillEventSource {
    const source: SkillEventSource = {
      application: id.application,
      connectionEpoch: this.epoch,
    };
    if (id.documentGeneration !== undefined) source.documentGeneration = id.documentGeneration;
    if (id.tabId !== undefined) source.tabId = id.tabId;
    if (id.frameId !== undefined) source.frameId = id.frameId;
    if (id.accountId !== undefined) source.accountId = id.accountId;
    return source;
  }

  /** Compile (or recompile) the page plan for one document. */
  async plan(id: DocumentIdentity): Promise<SkillsPlanResult> {
    const result = await this.opts.request<SkillsPlanResult>(
      X_PI_BROWSER.skills_plan,
      { source: this.source(id), url: id.url },
    );
    if (result.status === "ok" && result.plan) {
      this.lastPlan.set(this.docKey(id), {
        planVersion: result.plan.planVersion,
        expiresAt: result.plan.expiresAt,
      });
    } else {
      this.lastPlan.delete(this.docKey(id));
    }
    return result;
  }

  /**
   * Submit one verified event. `snapshot` is stored first (bounded); the
   * event carries only its contextRef. Returns the host's ack.
   */
  async submitEvent(input: {
    document: DocumentIdentity;
    /** Qualified event identity: `<packageId>:<local event name>`. */
    event: string;
    interactionId: string;
    planVersion: number;
    contextRevision: number;
    draftRevision?: number;
    origin: "user" | "site" | "skill";
    causedBy?: string;
    snapshot?: Record<string, unknown>;
    /**
     * Opaque ID the host must echo on skills_result. The submission gate
     * supplies its own eventId so review outcomes map back to the exact
     * armed identity; omitted, the coordinator generates one.
     */
    eventId?: string;
  }): Promise<SkillsEventResult> {
    const key = this.docKey(input.document);
    // Redelivery dedup (at-least-once transport, design §11). The identity
    // includes the document: the same interaction in another tab is a
    // different event, not a redelivery.
    const dedupeKey = [key, input.interactionId, input.event, input.draftRevision ?? 0, input.contextRevision].join(":");
    if (this.seen.has(dedupeKey)) return { status: "duplicate", reason: "event already submitted" };

    let contextRef: string;
    if (input.snapshot !== undefined) {
      contextRef = `snap:${uuid()}`;
      const bytes = JSON.stringify(input.snapshot).length;
      const used = this.docBytes.get(key) ?? 0;
      const docCount = [...this.snapshots.values()].filter((s) => s.docKey === key).length;
      if (docCount >= MAX_SNAPSHOTS_PER_DOC || used + bytes > MAX_SNAPSHOT_BYTES_PER_DOC) {
        return { status: "unavailable", reason: "snapshot store full for this document; no review armed" };
      }
      this.snapshots.set(contextRef, { ref: contextRef, docKey: key, bytes, snapshot: input.snapshot });
      this.docBytes.set(key, used + bytes);
    } else {
      contextRef = "none";
    }
    while (this.seen.size >= MAX_SEEN_EVENTS) this.seen.delete(this.seen.values().next().value!);
    this.seen.add(dedupeKey);

    const event: SkillEvent = {
      version: 1,
      eventId: input.eventId ?? `evt:${uuid()}`,
      event: input.event,
      source: this.source(input.document),
      interactionId: input.interactionId,
      contextRevision: input.contextRevision,
      planVersion: input.planVersion,
      origin: input.origin,
      contextRef,
    };
    if (input.draftRevision !== undefined) event.draftRevision = input.draftRevision;
    if (input.causedBy !== undefined) event.causedBy = input.causedBy;
    return this.opts.request<SkillsEventResult>(
      X_PI_BROWSER.skills_event,
      { event },
      15_000,
    );
  }

  async cancel(interactionId: string): Promise<SkillsCancelResult> {
    const params: SkillsCancelParams = { interactionId };
    return this.opts.request<SkillsCancelResult>(X_PI_BROWSER.skills_cancel, params);
  }

  status(): Promise<SkillsStatusResult> {
    return this.opts.request<SkillsStatusResult>(X_PI_BROWSER.skills_status);
  }

  /** Forget a document's snapshots/plan (navigation, removal, close). */
  forgetDocument(id: DocumentIdentity): void {
    const key = this.docKey(id);
    for (const [ref, entry] of this.snapshots) {
      if (entry.docKey === key) {
        this.snapshots.delete(ref);
        this.docBytes.set(key, (this.docBytes.get(key) ?? entry.bytes) - entry.bytes);
      }
    }
    this.lastPlan.delete(key);
  }

  /**
   * Host→client handler. Register via AcpClient's `onExtensionRequest`.
   * Returns the JSON-RPC result, or undefined for unknown methods.
   */
  handleHostRequest(method: string, params: unknown): Promise<unknown> | unknown {
    if (method === X_PI_BROWSER.skills_context) {
      const request = parseSkillsContextRequestParams(params);
      const entry = this.snapshots.get(request.contextRef);
      if (!entry) throw new Error(`unknown contextRef: ${request.contextRef}`);
      // Privacy by request: only the requested fields leave the addon.
      const context: Record<string, unknown> = {};
      for (const field of request.fields) {
        if (entry.snapshot[field] !== undefined) context[field] = entry.snapshot[field];
      }
      const bytes = JSON.stringify(context).length;
      if (bytes > request.maxBytes) throw new Error("context snapshot exceeds limit");
      return { contextRef: request.contextRef, context, bytes };
    }
    if (method === X_PI_BROWSER.skills_result) {
      const result = parseSkillsResultParams(params);
      this.opts.onResult?.(result);
      const ack: SkillsResultAck = { delivered: true };
      return ack;
    }
    return undefined;
  }
}
