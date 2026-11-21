/**
 * SkillsService: host-owned bounded job scheduler (skills-runtime-design.md §9, §13).
 *
 * Responsibilities: scheduling (priority + aging), deadlines, per-key
 * deduplication/coalescing, and worker admission.
 *
 * Invariants:
 * - at most `maxConcurrent` global model jobs run (default 2);
 * - the pending queue holds at most `maxQueued` jobs (default 64) plus one
 *   coalesced replacement per running job (replacements are not counted);
 * - at most one running and one pending job per key;
 * - required work (gate/active) that cannot be admitted settles
 *   "unavailable" — it never becomes "clear" by absence;
 * - superseded work is aborted cooperatively; cancelling a job never
 *   launches a replacement on its own.
 *
 * `run` bodies are called in-process. A production worker layer that maps
 * jobs onto disposable Pi worker processes terminates a worker that ignores
 * its deadline; this scheduler's settlement is authoritative either way.
 */
export type SkillJobKind = "gate" | "active" | "speculative" | "passive";

/** Lower runs first: held submissions > explicit Active > speculative > passive. */
const KIND_RANK: Record<SkillJobKind, number> = { gate: 0, active: 1, speculative: 2, passive: 3 };

export interface SkillJobLimits {
  /** Global concurrent model jobs, default 2. */
  maxConcurrent: number;
  /** Pending queue capacity, default 64. Per-key replacements are excluded. */
  maxQueued: number;
  /** A queued non-gate job gains one rank per agingMs of waiting, down to at
   * most "active" rank (starvation guard; it can never overtake gate work),
   * default 5000. */
  agingMs: number;
}

export interface SkillJobRequest {
  /** Deduplication key: skill key + interaction, e.g. "pkg/friendliness:composer-7". */
  key: string;
  kind: SkillJobKind;
  /** Review deadline; the job is cooperatively aborted and settled "timed-out". */
  timeoutMs: number;
  /** Worker body. Must observe `signal`; never invoked for rejected,
   * superseded, or cancelled jobs. */
  run: (signal: AbortSignal) => Promise<unknown>;
}

export interface SkillJobOutcome {
  status: "done" | "superseded" | "aborted" | "timed-out" | "failed" | "unavailable";
  /** Resolved value when "done". */
  value?: unknown;
  /** Why the job never ran ("unavailable") or what replaced it ("superseded"). */
  reason?: string;
  /** Rejection reason when "failed". */
  error?: Error;
}

export interface SkillsServiceStats {
  running: number;
  queued: number;
  replacements: number;
  closed: boolean;
  outcomes: Record<SkillJobOutcome["status"], number>;
}

interface Job {
  request: SkillJobRequest;
  queuedAt: number;
  state: "queued" | "replacement" | "running";
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  resolve: (outcome: SkillJobOutcome) => void;
  promise: Promise<SkillJobOutcome>;
}

const DEFAULT_LIMITS: SkillJobLimits = { maxConcurrent: 2, maxQueued: 64, agingMs: 5_000 };

export class SkillsService {
  private readonly limits: SkillJobLimits;
  private readonly queue: Job[] = [];
  private readonly running = new Map<string, Job>();
  private readonly replacements = new Map<string, Job>();
  private readonly outstanding = new Set<Promise<SkillJobOutcome>>();
  private readonly counts: Record<SkillJobOutcome["status"], number> = {
    done: 0, superseded: 0, aborted: 0, "timed-out": 0, failed: 0, unavailable: 0,
  };
  private closed = false;

  constructor(limits: Partial<SkillJobLimits> = {}) {
    const merged = { ...DEFAULT_LIMITS, ...limits };
    if (!Number.isInteger(merged.maxConcurrent) || merged.maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
    if (!Number.isInteger(merged.maxQueued) || merged.maxQueued < 1) throw new Error("maxQueued must be >= 1");
    if (!Number.isFinite(merged.agingMs) || merged.agingMs <= 0) throw new Error("agingMs must be > 0");
    this.limits = merged;
  }

  /** Schedule a job. Resolves with the job's own fate; admission rejection
   * resolves "unavailable" (required reviews degrade to unavailable, never clear). */
  submit(request: SkillJobRequest): Promise<SkillJobOutcome> {
    if (this.closed) return Promise.resolve({ status: "unavailable", reason: "service closed" });
    const job = this.createJob(request);

    const current = this.running.get(request.key);
    if (current) {
      // A newer job supersedes: register it as the replacement BEFORE
      // settling the running job, whose settlement promotes exactly the
      // replacement currently on record.
      const pending = this.replacements.get(request.key);
      if (pending) this.cancelJob(pending, "superseded", `replaced by a newer ${request.kind} job`);
      job.state = "replacement";
      this.replacements.set(request.key, job);
      this.cancelJob(current, "superseded", `superseded by a newer ${request.kind} job`);
    } else {
      const index = this.queue.findIndex((entry) => entry.request.key === request.key);
      if (index >= 0) {
        // Coalesce in place: keep the older queue position.
        this.cancelJob(this.queue[index]!, "superseded", `replaced by a newer ${request.kind} job`);
        this.queue[index] = job;
      } else {
        this.admit(job);
      }
    }
    this.pump();
    return job.promise;
  }

  /** Cancel a key's running and/or pending job. Returns how many were cancelled. */
  cancel(key: string): number {
    let cancelled = 0;
    const current = this.running.get(key);
    if (current) { this.cancelJob(current, "aborted", "cancelled"); cancelled += 1; }
    const pending = this.replacements.get(key);
    if (pending) { this.cancelJob(pending, "aborted", "cancelled"); cancelled += 1; }
    const index = this.queue.findIndex((entry) => entry.request.key === key);
    if (index >= 0) { this.cancelJob(this.queue[index]!, "aborted", "cancelled"); cancelled += 1; }
    return cancelled;
  }

  /** Abort all pending and running work; resolves once every job has settled. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const job of [...this.queue, ...this.replacements.values(), ...this.running.values()]) {
      this.cancelJob(job, "aborted", "service closed");
    }
    return Promise.all([...this.outstanding]).then(() => undefined);
  }

  get stats(): SkillsServiceStats {
    return {
      running: this.running.size,
      queued: this.queue.length,
      replacements: this.replacements.size,
      closed: this.closed,
      outcomes: { ...this.counts },
    };
  }

  private createJob(request: SkillJobRequest): Job {
    let resolve: (outcome: SkillJobOutcome) => void;
    const promise = new Promise<SkillJobOutcome>((settle) => { resolve = settle; });
    const job: Job = {
      request,
      queuedAt: Date.now(),
      state: "queued",
      controller: new AbortController(),
      settled: false,
      resolve: resolve!,
      promise,
    };
    this.outstanding.add(promise);
    return job;
  }

  /** Put a job in the pending queue; under saturation required work displaces
   * the oldest speculative/passive job first, everything else is unavailable. */
  private admit(job: Job): void {
    if (this.queue.length < this.limits.maxQueued) {
      this.queue.push(job);
      return;
    }
    if (KIND_RANK[job.request.kind] <= KIND_RANK.active) {
      const evictable = this.queue.find((entry) => KIND_RANK[entry.request.kind] >= KIND_RANK.speculative);
      if (evictable) {
        this.cancelJob(evictable, "unavailable", "displaced by required job under saturation");
        this.queue.push(job);
        return;
      }
    }
    this.settleJob(job, { status: "unavailable", reason: "queue saturated" });
  }

  /** Start the highest-priority queued jobs while slots are free.
   * Tie-break is FIFO. Aged non-gate jobs may rise to "active" rank, never past gate. */
  private pump(): void {
    while (this.running.size < this.limits.maxConcurrent && this.queue.length > 0) {
      const now = Date.now();
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.score(this.queue[i]!, now) < this.score(this.queue[best]!, now)) best = i;
      }
      this.startJob(this.queue.splice(best, 1)[0]!);
    }
  }

  private score(job: Job, now: number): number {
    const rank = KIND_RANK[job.request.kind];
    if (rank === KIND_RANK.gate) return rank;
    const aged = rank - Math.floor((now - job.queuedAt) / this.limits.agingMs);
    return Math.max(aged, KIND_RANK.active);
  }

  private startJob(job: Job): void {
    job.state = "running";
    this.running.set(job.request.key, job);
    job.timer = setTimeout(() => {
      job.controller.abort();
      this.settleJob(job, { status: "timed-out", reason: `exceeded ${job.request.timeoutMs}ms deadline` });
    }, job.request.timeoutMs);
    // Settlement is idempotent: a worker that ignores the abort signal cannot
    // overwrite the authoritative "timed-out" outcome (or vice versa). The
    // settled guard covers cancellation between startJob and this microtask.
    Promise.resolve()
      .then(() => (job.settled ? undefined : job.request.run(job.controller.signal)))
      .then(
        (value) => this.settleJob(job, { status: "done", value }),
        (error: unknown) =>
          this.settleJob(job, { status: "failed", error: error instanceof Error ? error : new Error(String(error)) }),
      );
  }

  /** First outcome wins; detaches the job and promotes a replacement if the
   * running slot for its key freed up. */
  private settleJob(job: Job, outcome: SkillJobOutcome): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    if (job.state === "running") {
      this.running.delete(job.request.key);
      const replacement = this.replacements.get(job.request.key);
      if (replacement) {
        this.replacements.delete(job.request.key);
        this.admit(replacement);
      }
    } else if (job.state === "replacement") {
      this.replacements.delete(job.request.key);
    } else {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
    }
    this.counts[outcome.status] += 1;
    this.outstanding.delete(job.promise);
    job.resolve(outcome);
    this.pump();
  }

  private cancelJob(job: Job, status: "superseded" | "aborted" | "unavailable", reason: string): void {
    job.controller.abort();
    this.settleJob(job, { status, reason });
  }
}
