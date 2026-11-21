/**
 * Repl IPC types (BROWSER-USE-REPL-PLAN.md, Phase 0).
 *
 * The ReplWorker child speaks this small JSON protocol with the host
 * ReplRuntime over Node IPC. The worker never touches the network protocol;
 * every browser primitive becomes a tool request the host executes through
 * the session's existing browser-tool transport.
 */

export interface ReplImage {
  type: "image";
  /** base64-encoded image bytes. */
  data: string;
  mimeType: string;
}

/** One completed cell: captured console/text output plus attached images. */
export interface ReplCellResult {
  text: string;
  images: ReplImage[];
  /** Full captured output path, present when the model-facing text was clipped. */
  outputFile?: string;
}

export type ReplRequest =
  | {
      type: "execute";
      code: string;
      /** Worker appends captured output here (host creates the empty file). */
      outputFile: string;
      /** Cell deadline; the host kills the child when it elapses. */
      timeoutMs: number;
      /** Notes (e.g. binding changed) to prepend to this cell's output. */
      notes?: string[];
    }
  | { type: "close" };

export type ReplResponse =
  | { type: "ready" }
  | { type: "result"; result: ReplCellResult; error?: string }
  | { type: "closed" };

/** Worker → host: execute a browser tool for the session's current tab. */
export interface ReplToolRequest {
  type: "tool";
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

/** Host → worker: tool outcome (result XOR error). */
export interface ReplToolResponse {
  type: "tool-result";
  id: number;
  result?: unknown;
  error?: string;
}

/** First IPC message: worker configuration (never argv/env). */
export interface ReplWorkerConfig {
  /** Directory for artifact()/checkpoint() files and cell output spill. */
  workspace: string;
  /** Secrets redacted from all captured output. */
  redact: string[];
  /** Model-facing cell text budget before clipping to the output file. */
  maxOutputChars: number;
  /** Prepended exactly once, before the first cell's output (recipe). */
  preamble?: string;
}
