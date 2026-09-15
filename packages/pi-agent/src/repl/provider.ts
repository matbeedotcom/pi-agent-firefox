/**
 * ReplProvider — per-session owner of the `javascript` REPL (BROWSER-USE-REPL-PLAN.md,
 * Phase 1).
 *
 * Owns one lazily-created ReplRuntime per ACP session (its own V8 worker
 * child) and exposes the `javascript` ToolSpec. The worker's `page.*`/
 * `tabs.*` primitives come back as tool requests that this provider answers
 * by routing through the SAME transport + permission path as direct browser
 * tool calls (screenshots taken from a cell still prompt the user).
 *
 * Per-session workspace (P1.4): `~/.pi/browser-repl/<sessionId>/` (0700)
 * holds artifact/checkpoint files and cell output spills.
 */
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  REPL_TOOLS,
  isReplTool,
} from "@pi-browser/protocol";
import { REPL_TOOL_SCHEMAS } from "../browser/schemas.js";
import type { ToolSpec, BackendToolResult } from "../acp/backend.js";
import type { NormalizedToolResult } from "../browser/provider.js";
import { ReplRuntime, ReplCellError, type ReplCallOutcome } from "./runtime.js";

export type ReplToolExecutor = (
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ReplProviderOptions {
  log: (line: string) => void;
  /** Root for per-session workspaces (default ~/.pi/browser-repl, override for tests). */
  workspaceRoot?: string;
  /** Secrets scrubbed from cell output. */
  redact?: string[];
  /** Recipe text prepended to each session's first cell output. */
  preamble?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Keep at most this many queued invalidation notes per session. */
const MAX_QUEUED_NOTES = 5;

/**
 * Unwrap a normalized tool result into the raw value the worker's primitives
 * expect: single text part -> its parsed JSON (the add-on ships JSON), one
 * image (optionally accompanied by capture notes) -> { data, mimeType },
 * else the content array itself.
 */
export function unwrapToolResult(result: NormalizedToolResult): unknown {
  if (result.isError) {
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, text || "browser tool failed");
  }
  // Firefox screenshots include a text note naming the capture API. That
  // metadata must not hide the image from the worker's screenshot primitive.
  const images = result.content.filter((part) => part.type === "image");
  if (images.length === 1) return { data: images[0].data, mimeType: images[0].mimeType };
  if (result.content.length === 1) {
    const part = result.content[0];
    if (part.type !== "text") return result.content;
    try {
      return JSON.parse(part.text);
    } catch {
      return part.text;
    }
  }
  return result.content;
}

export class ReplProvider {
  private readonly runtimes = new Map<string, ReplRuntime>();
  /** Invalidation notes queued before the session's runtime exists. */
  private readonly queuedNotes = new Map<string, string[]>();

  constructor(private readonly opts: ReplProviderOptions) {}

  get root(): string {
    return (
      this.opts.workspaceRoot ??
      process.env.PI_BROWSER_REPL_DIR ??
      path.join(os.homedir(), ".pi", "browser-repl")
    );
  }

  workspaceFor(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.root, safe);
  }

  /** The `javascript` ToolSpec for a session (bound to idRef at execute time). */
  toolSpec(idRef: { id?: string }, executor: ReplToolExecutor): ToolSpec {
    const def = REPL_TOOLS.find((t) => t.name === "javascript");
    const schema = REPL_TOOL_SCHEMAS.find((t) => t.name === "javascript");
    if (!def || !schema) throw new Error("javascript tool definition missing");
    return {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: schema.parameters,
      execute: async (_toolCallId, args, signal) => {
        const sessionId = idRef.id;
        if (!sessionId) {
          throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "javascript tool invoked before session id assigned");
        }
        const code = (args as { code?: unknown }).code;
        if (typeof code !== "string" || code.trim() === "") {
          throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "javascript tool requires a non-empty code string");
        }
        const rawTimeout = (args as { timeoutMs?: unknown }).timeoutMs;
        const timeoutMs = typeof rawTimeout === "number" ? rawTimeout : DEFAULT_TIMEOUT_MS;
        let outcome: ReplCallOutcome;
        try {
          outcome = await this.call(sessionId, code, timeoutMs, signal, executor);
        } catch (error) {
          // Timeout / crash / worker death: the cell may have performed real
          // browser actions before dying. Report partial output + the reset
          // contract as model-readable content (not a tool error), so the
          // model can inspect the page instead of blindly retrying.
          if (error instanceof ReplCellError) {
            const content: BackendToolResult["content"] = [];
            if (error.result.text) content.push({ type: "text", text: error.result.text });
            content.push({
              type: "text",
              text: `[cell aborted] ${error.message} JavaScript state was reset; inspect the page (snapshot/screenshot) before retrying any action.`,
            });
            for (const img of error.result.images) {
              content.push({ type: "image", data: img.data, mimeType: img.mimeType });
            }
            return { content, details: { piBrowser: true, repl: true, aborted: true } };
          }
          throw error;
        }
        const content: BackendToolResult["content"] = [];
        if (outcome.text) content.push({ type: "text", text: outcome.text });
        if (outcome.error) {
          content.push({ type: "text", text: `[cell error] ${outcome.error}` });
        }
        for (const img of outcome.images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
        return {
          content: content.length ? content : [{ type: "text", text: "(no output)" }],
          details: { piBrowser: true, repl: true, ...(outcome.outputFile ? { outputFile: outcome.outputFile } : {}) },
        };
      },
    };
  }

  /**
   * Run one cell in the session's runtime (created lazily on first use).
   * The runtime workspace is created 0700 before the child starts.
   */
  async call(
    sessionId: string,
    code: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    executor: ReplToolExecutor,
  ): Promise<ReplCallOutcome> {
    let runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      const workspace = this.workspaceFor(sessionId);
      // The worker chdirs into the workspace at startup; it must exist.
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      runtime = new ReplRuntime({
        workspace,
        redact: this.opts.redact ?? [],
        preamble: this.opts.preamble,
        log: this.opts.log,
        toolExecutor: (tool, args) => {
          if (isReplTool(tool)) {
            return Promise.reject(new Error("the javascript tool cannot be called from inside a cell"));
          }
          return Promise.resolve(
            unwrapToolResultPromise(executor(sessionId, tool, args)),
          );
        },
      });
      this.runtimes.set(sessionId, runtime);
      for (const note of this.queuedNotes.get(sessionId) ?? []) runtime.invalidate(note);
      this.queuedNotes.delete(sessionId);
      this.opts.log(`repl runtime for session ${sessionId} (workspace ${workspace})`);
    }
    return runtime.call(code, { timeoutMs, signal });
  }

  /** The session's worker child pid (undefined when no runtime is running). */
  childPidFor(sessionId: string): number | undefined {
    return this.runtimes.get(sessionId)?.childPid;
  }

  /**
   * Queue a note for the session's next cell (binding/tab events). Notes are
   * kept even before the first cell so a late-created runtime still sees them.
   */
  invalidate(sessionId: string, note: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.invalidate(note);
      return;
    }
    const notes = this.queuedNotes.get(sessionId) ?? [];
    notes.push(note);
    while (notes.length > MAX_QUEUED_NOTES) notes.shift();
    this.queuedNotes.set(sessionId, notes);
  }

  /** Kill the session's worker child (session close / host shutdown). */
  async disposeSession(sessionId: string): Promise<void> {
    this.queuedNotes.delete(sessionId);
    const runtime = this.runtimes.get(sessionId);
    this.runtimes.delete(sessionId);
    if (runtime) await runtime.dispose();
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) await this.disposeSession(id);
  }
}

/** The executor returns a NormalizedToolResult; unwrap before the worker sees it. */
function unwrapToolResultPromise(p: Promise<unknown>): Promise<unknown> {
  return p.then((result) => unwrapToolResult(result as NormalizedToolResult));
}
