/**
 * Pi backend seam (PRODUCT.md §6).
 *
 * The ACP agent talks to Pi exclusively through this interface. Production
 * uses the Pi SDK (`createAgentSession`) in-process (the spec-preferred
 * implementation); tests use a scripted mock. The ACP boundary never leaks
 * the backend choice to Firefox.
 */
import type { TSchema } from "typebox";

export interface ModelOption {
  /** Stable value id: `${provider}/${modelId}`. */
  valueId: string;
  /** Human-readable label. */
  name: string;
}

export interface ListedSession {
  sessionId: string;
  cwd: string;
  /** ISO 8601 timestamp of last activity. */
  updatedAt: string;
  title?: string;
  messageCount?: number;
}

export interface ImageAttachment {
  /** base64-encoded image bytes. */
  data: string;
  mimeType: string;
}

export interface BackendPromptResult {
  /** True when the turn ended because of session.abort(), not model completion. */
  aborted: boolean;
}

/** Normalized agent events, independent of the underlying Pi event model. */
export type BackendEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partial: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export interface BackendSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isStreaming: boolean;
  readonly modelValueId: string | undefined;
  readonly thinkingLevel: string;
  /**
   * Send a prompt; resolves when the full turn finishes (including retries).
   * Rejects when the session cannot run the prompt at all.
   */
  prompt(text: string, images?: ImageAttachment[]): Promise<BackendPromptResult>;
  abort(): Promise<void>;
  setModel(valueId: string): Promise<void>;
  setThinkingLevel(level: string): void;
  subscribe(listener: (event: BackendEvent) => void): () => void;
  /**
   * Conversation history for ACP `session/load` replay. Optional: backends
   * without history support simply do not replay.
   */
  getHistory?(): Promise<Array<{ role: "user" | "assistant"; text: string }>>;
  dispose(): void;
}

export interface CreateSessionOptions {
  cwd: string;
  /** Custom agent tools (browser tools) registered on the session. */
  customTools?: ToolSpec[];
  /** Optional initial model ("provider/id"). */
  modelValueId?: string;
  /** Optional initial thinking level. */
  thinkingLevel?: string;
}

export interface OpenSessionOptions {
  sessionId: string;
  customTools?: ToolSpec[];
}

export interface ToolSpec {
  name: string;
  label?: string;
  description: string;
  /** TypeBox parameter schema. */
  parameters: TSchema;
  execute: (toolCallId: string, args: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<BackendToolResult>;
}

export interface BackendToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: Record<string, unknown>;
}

export interface PiBackend {
  /** Resolves when the backend is usable (e.g. model runtime initialized). */
  readonly ready: Promise<void>;
  readonly thinkingLevels: readonly string[];
  createSession(opts: CreateSessionOptions): Promise<BackendSession>;
  /** Open an existing persisted session by id. Throws SESSION_NOT_FOUND-shaped error when missing. */
  openSession(opts: OpenSessionOptions): Promise<BackendSession>;
  listSessions(cwd?: string): Promise<ListedSession[]>;
  listModels(): Promise<ModelOption[]>;
  dispose(): void;
}
