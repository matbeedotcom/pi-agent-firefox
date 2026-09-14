/**
 * ReplRuntime — host-side owner of one session's ReplWorker child
 * (BROWSER-USE-REPL-PLAN.md, Phase 0).
 *
 * One worker, one active cell. Termination is the cancellation boundary:
 * a cell timeout or cancellation SIGKILLs the child, which resets all
 * JavaScript state (the same contract as the SDK worker a timeout can kill
 * a synchronous infinite loop; in-process execution cannot provide that
 * guarantee). The child is a dumb JS sandbox: every browser primitive is a
 * tool request answered by the host through the session's existing
 * browser-tool transport (permissions and binding rules apply unchanged).
 *
 * Ported and adapted from browser-use-pi `src/runtime.ts` (MIT).
 */
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ReplCellResult, ReplImage, ReplResponse, ReplToolRequest } from "./types.js";

/** A cell failed (code error, timeout, or worker death). Partial output included. */
export class ReplCellError extends Error {
  constructor(
    message: string,
    readonly result: { text: string; images: ReplImage[]; outputFile?: string },
    /** True when JavaScript state was reset (timeout/crash), not preserved (code error). */
    readonly stateReset: boolean,
  ) {
    super(message);
    this.name = "ReplCellError";
  }
}

export interface ReplCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReplCallOutcome extends ReplCellResult {
  /** Present when the cell's code threw (state preserved). */
  error?: string;
}

export interface ReplRuntimeOptions {
  /** Directory for cell output + artifact/checkpoint files (0700, session-scoped). */
  workspace: string;
  redact?: string[];
  maxOutputChars?: number;
  /** One-time recipe prepended to the first cell's output. */
  preamble?: string;
  /**
   * Executes a browser tool for the session's current tab. Must apply the
   * same permission flow as direct tool calls (e.g. screenshot prompts).
   */
  toolExecutor: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 2_000;

export class ReplRuntime {
  private child: ChildProcess | undefined;
  private busy = false;
  private workerLoss: Error | undefined;
  private closed = false;
  private starting: Promise<ChildProcess> | undefined;
  private pending: ((error: Error) => void) | undefined;
  private nextToolId = 0;
  private toolPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notes: string[] = [];

  constructor(private readonly opts: ReplRuntimeOptions) {}

  /**
   * Run one cell. Rejects with ReplCellError for code errors, timeouts and
   * worker death (partial output in `error.result`); resolves with the
   * result otherwise.
   */
  async call(code: string, options: ReplCallOptions = {}): Promise<ReplCallOutcome> {
    if (this.closed) throw new ReplCellError("Repl runtime is closed.", { text: "", images: [] }, true);
    if (this.busy) throw new Error("A Repl cell is already running. Await it before starting another.");
    const timeoutMs = this.normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal;
    if (signal?.aborted) throw new ReplCellError("Execution cancelled.", { text: "", images: [] }, true);
    if (!code.trim()) throw new Error("Provide JavaScript code to execute.");
    if (this.workerLoss) {
      const error = this.workerLoss;
      this.workerLoss = undefined;
      // No new cell ran. Expose the same reset contract as a crash during execution.
      throw new ReplCellError(error.message, { text: "", images: [] }, true);
    }
    this.busy = true;
    try {
      const child = await this.start(signal);
      if (signal?.aborted) throw new ReplCellError("Execution cancelled.", { text: "", images: [] }, true);
      const directory = join(this.opts.workspace, ".repl", "cells");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const outputFile = join(directory, `${randomUUID()}.txt`);
      await writeFile(outputFile, "", { flag: "wx", mode: 0o600 });
      const response = this.receive(child, timeoutMs, signal);
      const notes = this.notes;
      this.notes = [];
      const sendError = child.send(
        { type: "execute", code, outputFile, timeoutMs, ...(notes.length ? { notes } : {}) },
        (error) => {
          if (error) this.pending?.(error);
        },
      );
      if (!sendError) this.pending?.(new Error("Repl IPC send failed."));
      let message: ReplResponse;
      try {
        message = await response;
      } catch (error) {
        await this.terminate();
        const text = await readFileSafe(outputFile).catch(() => "");
        throw new ReplCellError(
          String(error instanceof Error ? error.message : error),
          { text, images: [], outputFile },
          true,
        );
      }
      if (message.type !== "result") throw new ReplCellError("Unexpected Repl worker response.", { text: "", images: [] }, true);
      return { ...message.result, ...(message.error !== undefined ? { error: message.error } : {}) };
    } finally {
      this.busy = false;
    }
  }

  /** Queue a note (e.g. "binding changed") to prepend to the next cell's output. */
  invalidate(note: string): void {
    this.notes.push(note);
  }

  /** The worker child's pid (undefined when not running); for supervision/tests. */
  get childPid(): number | undefined {
    return this.child?.pid;
  }

  /** Idempotent. Cancels execution and reaps the child. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.busy) {
      this.pending?.(new Error("Repl runtime closed during execution."));
      await this.terminate();
    }
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const sendError = child.send({ type: "close" }, (err) => {
        if (err) this.log(`repl close send failed: ${err.message}`);
      });
      if (!sendError) this.pending?.(new Error("Repl IPC send failed."));
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, CLOSE_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private normalizeTimeout(timeoutMs: number): number {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
      throw new Error(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS} (got ${String(timeoutMs)}).`);
    return timeoutMs;
  }

  private log(line: string): void {
    this.opts.log?.(`[repl] ${line}`);
  }

  private start(signal?: AbortSignal): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    this.starting ??= this.doStart(signal);
    return this.starting;
  }

  private async doStart(signal?: AbortSignal): Promise<ChildProcess> {
    const worker = fork(new URL("./worker.js", import.meta.url), [], {
      execArgv: ["--max-old-space-size=256"], // Never inherit host loaders/preload flags.
      env: {}, // Provider keys stay in the host process.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.child = worker;
    // Only tool calls are handled here; ready/result/closed are consumed by
    // the receive() waiter registered before any message can arrive.
    worker.on("message", (message: ReplResponse | ReplToolRequest) => {
      if (message.type === "tool") void this.handleToolCall(worker, message);
    });
    worker.on("error", (error) => this.pending?.(error));
    worker.on("exit", (code, sig) => {
      if (this.child !== worker) return;
      this.child = undefined;
      const error = new Error(
        `Repl worker exited (${sig ?? code}). JavaScript state was reset; inspect the page before retrying an action.`,
      );
      for (const [, pending] of [...this.toolPending]) pending.reject(error);
      this.toolPending.clear();
      if (this.pending) this.pending(error);
      else this.workerLoss = error;
    });
    try {
      const response = this.receive(worker, READY_TIMEOUT_MS, signal);
      const sendError = worker.send(
        {
          workspace: this.opts.workspace,
          redact: this.opts.redact ?? [],
          maxOutputChars: this.opts.maxOutputChars ?? 12_000,
          ...(this.opts.preamble !== undefined ? { preamble: this.opts.preamble } : {}),
        },
        (error) => {
          if (error) this.pending?.(error);
        },
      );
      if (!sendError) this.pending?.(new Error("Repl IPC send failed."));
      const ready = await response;
      if (ready.type !== "ready") throw new Error("Repl worker did not initialize.");
      this.starting = undefined;
      return worker;
    } catch (error) {
      this.starting = undefined;
      await this.terminate();
      throw error;
    }
  }

  private async handleToolCall(worker: ChildProcess, message: ReplToolRequest): Promise<void> {
    if (message.tool === "javascript") {
      this.replyTool(worker, message.id, undefined, "the javascript tool cannot be called from inside a cell");
      return;
    }
    try {
      const result = await this.opts.toolExecutor(message.tool, message.args);
      this.replyTool(worker, message.id, result, undefined);
    } catch (error) {
      // Preserve structured codes (BROWSER_NOT_BOUND, BROWSER_PERMISSION_DENIED, …)
      // in the message the cell sees: `<CODE>: <message>`.
      const code = (error as { code?: unknown })?.code;
      const message2 = error instanceof Error ? error.message : String(error);
      this.replyTool(worker, message.id, undefined, typeof code === "string" && code ? `${code}: ${message2}` : message2);
    }
  }

  private replyTool(worker: ChildProcess, id: number, result: unknown, error: string | undefined): void {
    // Tool results must be JSON-serializable for the JSON IPC channel.
    let payload: { result?: unknown; error?: string };
    if (error !== undefined) {
      payload = { error };
    } else {
      try {
        JSON.stringify(result);
        payload = { result };
      } catch {
        payload = { result: String(result) };
      }
    }
    const ok = worker.send({ type: "tool-result", id, ...payload }, (err) => {
      if (err) {
        const pending = this.toolPending.get(id);
        if (pending) {
          this.toolPending.delete(id);
          pending.reject(err);
        }
      }
    });
    if (!ok) {
      const pending = this.toolPending.get(id);
      if (pending) {
        this.toolPending.delete(id);
        pending.reject(new Error("Repl IPC closed."));
      }
    }
  }

  private receive(worker: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<ReplResponse> {
    return new Promise((resolve, reject) => {
      const finish = (value: ReplResponse | Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        worker.off("message", onMessage);
        this.pending = undefined;
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const onMessage = (message: ReplResponse) => {
        if (message.type === "ready" || message.type === "result" || message.type === "closed") finish(message);
      };
      const abort = () =>
        finish(
          new Error(
            "Execution cancelled. JavaScript state was reset; browser actions may already have happened.",
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `Cell exceeded ${timeoutMs} ms. JavaScript state was reset; inspect the page before retrying actions.`,
            ),
          ),
        timeoutMs,
      );
      this.pending = (error) => finish(error);
      worker.on("message", onMessage);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private async terminate(): Promise<void> {
    const worker = this.child;
    this.child = undefined;
    for (const [, pending] of [...this.toolPending]) pending.reject(new Error("Repl worker terminated."));
    this.toolPending.clear();
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      worker.kill("SIGKILL");
      await exited;
    }
  }
}

async function readFileSafe(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
