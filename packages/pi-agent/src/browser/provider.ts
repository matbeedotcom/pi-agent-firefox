/**
 * BrowserToolTransport interface + implementations (PRODUCT.md §29–30).
 *
 *   BrowserToolTransport.call(sessionId, tool, args)
 *
 *   - LegacyBrowserCallbackTransport: private x-pi-browser/tool JSON-RPC
 *     namespace over the Native Messaging connection (the working MVP
 *     transport).
 *   - NativeMcpOverAcpTransport: MCP-over-ACP (mcp/connect, mcp/message,
 *     mcp/disconnect) when the client declares an ACP-transport MCP server.
 *
 * Tool names, arguments, and results are identical across transports —
 * migrating changes only the transport.
 */
import {
  BROWSER_DOWNLOAD_TIMEOUT_MS,
  BROWSER_SCREENSHOT_TIMEOUT_MS,
  BROWSER_TOOL_TIMEOUT_MS,
  isComposeTool,
  isContactsTool,
  isMailTool,
  isMailMutationTool,
  COMPOSE_TOOL_TIMEOUT_MS,
  CONTACTS_TOOL_TIMEOUT_MS,
  MAIL_ATTACHMENT_TIMEOUT_MS,
  MAIL_MUTATION_TOOL_TIMEOUT_MS,
  MAIL_TOOL_TIMEOUT_MS,
  codeFromErrorObject,
  isStructuredErrorObject,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  X_PI_BROWSER,
  buildPermissionRequest,
  getGatedTool,
  listGatedTools,
  permissionAllowed,
  toolRequiresApproval,
  REQUEST_PERMISSION_METHOD,
  type AcpTransportLike,
  type AgentApplication,
  type BrowserNotifyParams,
  type BrowserToolUpdateParams,
  type PermissionClearResult,
  type PermissionConfigResult,
  type PermissionPromptedParams,
  type PermissionSetResult,
  type PermissionToolState,
  type RequestPermissionResponse,
} from "@pi-browser/protocol";
import { PermissionStore } from "../permission-store.js";
import type { MailSearchResult } from "@pi-browser/protocol";
import { BROWSER_TOOL_SCHEMAS, CONTROL_TOOL_SCHEMAS, type BrowserToolSchema } from "./schemas.js";
import { MAIL_TOOL_SCHEMAS, type MailToolSchema } from "../mail/schemas.js";
import { COMPOSE_TOOL_SCHEMAS, type ComposeToolSchema } from "../compose/schemas.js";
import { MAIL_MUTATION_TOOL_SCHEMAS, type MailMutationToolSchema } from "../mutation/schemas.js";
import { CONTACTS_TOOL_SCHEMAS, type ContactsToolSchema } from "../contacts/schemas.js";
import { McpAcpClient } from "./mcp-acp-client.js";
import type { CapabilityRegistry } from "../capability-registry.js";
import { REPL_PREAMBLE, ReplProvider, type ReplToolExecutor } from "../repl/provider.js";

export { MCP_PROTOCOL_VERSION } from "@pi-browser/protocol";
import { TransportClosedError, TransportTimeoutError } from "../native-host/transport.js";
import type { ToolSpec } from "../acp/backend.js";
import type { Logger } from "../logger.js";

/** Normalized tool result: MCP tools/call shape. */
export interface NormalizedToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface BrowserToolTransport {
  readonly kind: "legacy" | "mcp-acp";
  call(sessionId: string, tool: string, args: Record<string, unknown>, toolCallId?: string): Promise<NormalizedToolResult>;
  dispose(): Promise<void>;
}

/** Incremental progress for an in-flight tool call (x-pi-browser/tool_update). */
export type BrowserToolUpdate = BrowserToolUpdateParams["update"];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Convert an MCP tools/call result (or a raw object) into normalized content. */
export function normalizeToolResult(raw: unknown): NormalizedToolResult {
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as { content?: unknown }).content)) {
    const r = raw as { content: Array<Record<string, unknown>>; isError?: boolean };
    const content: NormalizedToolResult["content"] = [];
    for (const c of r.content) {
      if (c?.type === "text" && typeof c.text === "string") content.push({ type: "text", text: c.text });
      else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
        content.push({ type: "image", data: c.data, mimeType: c.mimeType });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "(empty result)" });
    return { content, isError: r.isError === true };
  }
  return { content: [{ type: "text", text: JSON.stringify(raw ?? null) }] };
}

function timeoutFor(tool: string): number {
  if (tool === "browser_screenshot") return BROWSER_SCREENSHOT_TIMEOUT_MS;
  if (tool === "browser_download") return BROWSER_DOWNLOAD_TIMEOUT_MS;
  if (tool === "mail_get_attachment") return MAIL_ATTACHMENT_TIMEOUT_MS;
  if (isMailTool(tool)) return MAIL_TOOL_TIMEOUT_MS;
  if (isComposeTool(tool)) return COMPOSE_TOOL_TIMEOUT_MS;
  if (isMailMutationTool(tool)) return MAIL_MUTATION_TOOL_TIMEOUT_MS;
  if (isContactsTool(tool)) return CONTACTS_TOOL_TIMEOUT_MS;
  return BROWSER_TOOL_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Legacy (x-pi-browser/tool) transport
// ---------------------------------------------------------------------------

export interface LegacyTransportOptions {
  /** Base timeout for a tool; defaults come from protocol constants. */
  timeoutMs?: (tool: string) => number;
  /** Host-side backstop buffer over the timeout hint (default 5s). */
  slackMs?: number;
  /**
   * Last streamed progress for a timed-out call (mail_search batches). When
   * present, the timeout error carries `partial` + the resumable cursor so
   * the caller can continue instead of losing the work.
   */
  getPartial?: (toolCallId: string) => { scanned?: number; nextCursor?: string } | undefined;
}

export class LegacyBrowserCallbackTransport implements BrowserToolTransport {
  readonly kind = "legacy" as const;

  constructor(
    private readonly transport: AcpTransportLike,
    private readonly options: LegacyTransportOptions = {},
  ) {}

  async call(sessionId: string, tool: string, args: Record<string, unknown>, toolCallId?: string): Promise<NormalizedToolResult> {
    const timeoutMs = (this.options.timeoutMs ?? timeoutFor)(tool);
    const slackMs = this.options.slackMs ?? 5_000;
    try {
      const raw = await this.transport.request(
        X_PI_BROWSER.tool,
        { sessionId, tool, arguments: args, timeoutMs, ...(toolCallId ? { toolCallId } : {}) },
        timeoutMs + slackMs,
      );
      return normalizeToolResult(raw);
    } catch (err) {
      // A timed-out incremental search still has a resumable cursor: surface
      // the partial progress so the model can continue with `cursor`.
      if (err instanceof TransportTimeoutError && toolCallId) {
        const partial = this.options.getPartial?.(toolCallId);
        if (partial && (partial.scanned !== undefined || partial.nextCursor)) {
          throw new PiBrowserProtocolError(
            PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT,
            `browser tool timed out: ${tool}`,
            {
              tool,
              partial: true,
              ...(partial.scanned !== undefined ? { scanned: partial.scanned } : {}),
              ...(partial.nextCursor ? { nextCursor: partial.nextCursor } : {}),
            },
          );
        }
      }
      throw translateTransportError(err, tool);
    }
  }

  async dispose(): Promise<void> {
    // Stateless; nothing to release.
  }
}

// ---------------------------------------------------------------------------
// MCP-over-ACP transport
// ---------------------------------------------------------------------------

export class NativeMcpOverAcpTransport implements BrowserToolTransport {
  readonly kind = "mcp-acp" as const;
  private client: McpAcpClient;

  constructor(
    transport: AcpTransportLike,
    serverId: string,
    log: Logger,
    private readonly sessionId: string,
  ) {
    this.client = new McpAcpClient({
      transport,
      serverId,
      log,
      timeoutMs: BROWSER_SCREENSHOT_TIMEOUT_MS + 5_000,
    });
  }

  async call(_sessionId: string, tool: string, args: Record<string, unknown>, _toolCallId?: string): Promise<NormalizedToolResult> {
    try {
      const raw = await this.client.call(tool, args);
      return normalizeToolResult(raw);
    } catch (err) {
      if (err instanceof PiBrowserProtocolError) throw err;
      if (isStructuredErrorObject(err)) {
        // Preserve structured codes the client sent (e.g. MCP_TOOL_NOT_FOUND).
        const code = codeFromErrorObject(err) ?? PI_BROWSER_ERROR.MCP_UNAVAILABLE;
        throw new PiBrowserProtocolError(code, err.message, { tool });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (/timed out|timeout/i.test(message)) {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT, `mcp tool call timed out: ${tool}`);
      }
      if (/disposed|closed/i.test(message)) {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `mcp connection unavailable: ${tool}`);
      }
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, `mcp tool call failed: ${message}`, { tool });
    }
  }

  async listTools(): Promise<import("./mcp-acp-client.js").McpToolInfo[]> {
    return this.client.listTools();
  }

  get connected(): boolean {
    return this.client.connected;
  }

  async dispose(): Promise<void> {
    await this.client.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shared error translation
// ---------------------------------------------------------------------------

export function translateTransportError(err: unknown, tool: string): PiBrowserProtocolError {
  if (err instanceof PiBrowserProtocolError) return err;
  if (err instanceof TransportTimeoutError) {
    return new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT, `browser tool timed out: ${tool}`);
  }
  if (err instanceof TransportClosedError) {
    return new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, "browser connection closed", { tool });
  }
  if (isStructuredErrorObject(err)) {
    const code = codeFromErrorObject(err) ?? PI_BROWSER_ERROR.INTERNAL;
    return new PiBrowserProtocolError(code, err.message, { tool });
  }
  return new PiBrowserProtocolError(
    PI_BROWSER_ERROR.INTERNAL,
    err instanceof Error ? err.message : String(err),
    { tool },
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type BrowserMode = "legacy" | "mcp-acp";

interface SessionBrowserState {
  mode: BrowserMode;
  mcp?: NativeMcpOverAcpTransport;
}

/** In-flight tool call state for tool_update validation + timeout recovery. */
interface ActiveToolCallState {
  sessionId: string;
  tool: string;
  /** Client executing the call (undefined in single-client legacy mode). */
  clientId: string | undefined;
  /** Last accepted x-pi-browser/tool_update sequence (0 = none). */
  lastSequence: number;
  lastBatch: MailSearchResult | undefined;
  lastScanned: number | undefined;
  /** Dispatch time; tool_update log lines report age since dispatch. */
  startedAt: number;
}

/**
 * Window during which parallel permission requests for the same session are
 * collected into one prompt. Models emit same-turn parallel tool calls within
 * the same tick, so 150 ms comfortably groups them with no perceptible delay.
 */
const PERMISSION_COALESCE_WINDOW_MS = 150;

/** One member of a coalesced permission group (one pending tool call). */
interface PermissionGroupMember {
  toolCallId: string;
  toolName: string;
  resolve: () => void;
  reject: (err: PiBrowserProtocolError) => void;
}

/** A session's in-flight coalesced permission prompt. */
interface PermissionGroup {
  members: PermissionGroupMember[];
  /** browser_evaluate has its own option set; it never mixes with the rest. */
  hasEvaluate: boolean;
  target: AcpTransportLike;
  settled: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
}

/** Compact, bounded JSON summary of tool args for permission log lines. */
function summarizeArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  try {
    const s = JSON.stringify(args);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return "[unserializable args]";
  }
}
const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * Registers capability tools on Pi sessions and routes their execution
 * through the per-session tool transport. The tool surface is selected by
 * the capabilities the client advertised in its hello (plan §19): "browser"
 * → browser tools, "mail"/"attachments" → read-only mail tools.
 *
 * With a `CapabilityRegistry` (broker mode, plan §26–29) the tool surface is
 * the UNION of all connected clients' capabilities, and each tool call is
 * routed to the connected client that provides it — the session owner when
 * it does, otherwise a peer application (cross-app routing).
 */
export interface CapabilityToolProviderOptions {
  /** Test seam: override per-tool deadlines (default: protocol constants). */
  timeoutMsFor?: (tool: string) => number;
  /**
   * Test seam: inject the persistent permission store (default: the
   * ~/.pi/browser/permissions.json file store).
   */
  permissionStore?: PermissionStore;
}

export class CapabilityToolProvider {
  private readonly sessions = new Map<string, SessionBrowserState>();
  /**
   * Persistent per-tool states (ask | deny | allow, PRODUCT.md §55). Shared
   * by every connected application (one broker process); survives host
   * restarts and is editable from the add-on's Configuration page.
   */
  private readonly permissions: PermissionStore;
  /**
   * Tools the user has approved with "Allow for this session", keyed by ACP
   * session id. Cleared when the session is disposed.
   */
  private readonly sessionAllowed = new Map<string, Set<string>>();
  /**
   * In-flight legacy tool calls: toolCallId → routing/sequence state.
   * Used to validate x-pi-browser/tool_update notifications (session, call
   * identity, client, monotonic sequence) and to recover the last streamed
   * batch when a call times out.
   */
  private readonly activeToolCalls = new Map<string, ActiveToolCallState>();
  /**
   * Set by the ACP agent: maps a validated tool update onto an ACP
   * `tool_call_update` session/update notification. Display-only — the
   * update never authorizes anything.
   */
  onToolUpdate: ((sessionId: string, toolCallId: string, update: BrowserToolUpdate) => void) | undefined;
  /** The host-side `javascript` REPL (BROWSER-USE-REPL-PLAN.md, option C). */
  private readonly repl = new ReplProvider({
    log: (line) => this.log.debug(line),
    // First-call recipe (observe -> act -> verify -> persist, guardrails,
    // ref lifecycle, permission semantics): BROWSER-USE-SUPPORT-PLAN.md WS1/T1.2.
    preamble: REPL_PREAMBLE,
  });

  constructor(
    /**
     * Fallback transport (single-client / legacy mode). In registry (broker)
     * mode this may be undefined: every call is routed through the registry.
     */
    private readonly transport: AcpTransportLike | undefined,
    private readonly log: Logger,
    private readonly registry: CapabilityRegistry | undefined = undefined,
    options: CapabilityToolProviderOptions = {},
  ) {
    this.timeoutForTool = options.timeoutMsFor ?? timeoutFor;
    this.permissions = options.permissionStore ?? new PermissionStore();
  }
  private readonly timeoutForTool: (tool: string) => number;

  /** The ACP transport a tool call / permission prompt goes to (legacy mode). */
  private legacyTransport(): AcpTransportLike {
    if (this.transport) return this.transport;
    throw new PiBrowserProtocolError(
      PI_BROWSER_ERROR.MCP_UNAVAILABLE,
      "no connected client for tool call (registry mode requires a connected owner)",
    );
  }

  /** Choose the transport for a session from the MCP servers the client declared. */
  selectMode(mcpServers?: unknown[]): BrowserMode {
    return mcpServers?.some(
      (s) => typeof s === "object" && s !== null && (s as { type?: unknown }).type === "acp",
    )
      ? "mcp-acp"
      : "legacy";
  }

  /**
   * Build the Pi custom-tool specs for a session. The session id is bound
   * lazily (idRef) because the backend assigns it at session creation.
   *
   * Control tools (pi_*) are only registered for the MCP-over-ACP mode:
   * they are served by the add-on's MCP server and have no equivalent on
   * the legacy x-pi-browser/tool callback path.
   *
   * `capabilities` selects the tool surface (plan §19): a client that
   * advertises "browser" gets the browser tools, one that advertises
   * "mail"/"attachments" gets the read-only mail tools. The default
   * (["browser"]) preserves the pre-capability behaviour for callers that
   * do not pass the client's declared capabilities.
   */
  createTools(
    idRef: { id?: string },
    mode: BrowserMode,
    mcpServerId?: string,
    capabilities: readonly string[] = ["browser"],
    ownerClientId?: string,
    ownerApplication: AgentApplication = "firefox",
  ): ToolSpec[] {
    // Broker mode: the session sees every connected provider (plan §29),
    // not only the owner's tools.
    const caps =
      this.registry && ownerClientId !== undefined
        ? this.registry.allCapabilities()
        : (capabilities ?? []);
    const hasBrowser = caps.includes("browser");
    const hasMail = caps.includes("mail") || caps.includes("attachments");
    const hasCompose = caps.includes("compose");
    const hasMailModify = caps.includes("mailModify");
    const hasContacts = caps.includes("contacts");
    const schemas: Array<
      | BrowserToolSchema
      | MailToolSchema
      | ComposeToolSchema
      | MailMutationToolSchema
      | ContactsToolSchema
    > = [];
    if (hasBrowser) {
      schemas.push(...BROWSER_TOOL_SCHEMAS);
      if (mode === "mcp-acp") schemas.push(...CONTROL_TOOL_SCHEMAS);
    }
    if (hasMail) {
      schemas.push(...MAIL_TOOL_SCHEMAS);
    }
    if (hasCompose) {
      schemas.push(...COMPOSE_TOOL_SCHEMAS);
    }
    if (hasMailModify) {
      schemas.push(...MAIL_MUTATION_TOOL_SCHEMAS);
    }
    if (hasContacts) {
      schemas.push(...CONTACTS_TOOL_SCHEMAS);
    }
    const specs: ToolSpec[] = schemas.map((entry) => ({
      name: entry.name,
      label: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      execute: async (toolCallId, args, _signal) => {
        const sessionId = idRef.id;
        if (!sessionId) {
          throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "browser tool invoked before session id assigned");
        }
        const result = await this.routeTool(
          sessionId,
          toolCallId,
          entry.name,
          args as Record<string, unknown>,
          mode,
          mcpServerId,
          ownerClientId,
          ownerApplication,
        );
        return { content: result.content, details: { piBrowser: true, tool: entry.name } };
      },
    }));
    // The host-side REPL (BROWSER-USE-REPL-PLAN.md): one `javascript` tool per
    // browser session; its cells' page.*/tabs.* primitives reuse the exact
    // routing (and permission prompts) of the regular browser tools.
    if (hasBrowser) {
      specs.push(this.replToolSpec(idRef, mode, mcpServerId, ownerClientId, ownerApplication));
    }
    return specs;
  }

  /** The session's REPL worker child pid (undefined when not running). */
  childPidFor(sessionId: string): number | undefined {
    return this.repl.childPidFor(sessionId);
  }

  /** The `javascript` ToolSpec, with cells' tool calls routed like any other. */
  private replToolSpec(
    idRef: { id?: string },
    mode: BrowserMode,
    mcpServerId: string | undefined,
    ownerClientId: string | undefined,
    ownerApplication: AgentApplication,
  ): ToolSpec {
    const executor: ReplToolExecutor = (sessionId, tool, args) =>
      this.routeTool(sessionId, `repl:${tool}:${crypto.randomUUID()}`, tool, args, mode, mcpServerId, ownerClientId, ownerApplication);
    return this.repl.toolSpec(idRef, executor);
  }

  /**
   * Execute one tool call arriving over the in-process tool bridge (a Pi
   * extension registering the browser tools for a session that the broker
   * did not create itself — e.g. a subagent session). Goes through the same
   * routing + approval path as the regular tool specs; sessionId and ctx
   * identify the owning ACP session (the bridge resolves the fallback).
   */
  async bridgeCall(opts: {
    tool: string;
    args: Record<string, unknown>;
    sessionId: string;
    toolCallId?: string;
    ctx?: import("../tool-bridge.js").BridgeSessionContext;
  }): Promise<NormalizedToolResult> {
    return this.routeTool(
      opts.sessionId,
      opts.toolCallId ?? `bridge:${opts.tool}:${crypto.randomUUID()}`,
      opts.tool,
      opts.args,
      opts.ctx?.mode ?? "legacy",
      opts.ctx?.mcpServerId,
      opts.ctx?.ownerClientId,
      opts.ctx?.ownerApplication ?? "firefox",
    );
  }

  /**
   * Route one tool call to the connected client that provides it (owner
   * first; cross-app peer otherwise, plan §29) and apply the approval
   * policy. Shared by the regular tool specs and the REPL's cell tool calls.
   */
  private async routeTool(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    mode: BrowserMode,
    mcpServerId: string | undefined,
    ownerClientId: string | undefined,
    ownerApplication: AgentApplication,
  ): Promise<NormalizedToolResult> {
    // In legacy (no registry) mode there is a single client — always the target.
    const target = this.registry ? this.registry.resolveTarget(ownerClientId, toolName) : undefined;
    const targetTransport = target ? target.transport : this.legacyTransport();
    const isOwnerPath = !target || target.clientId === ownerClientId;
    // Tools the policy marks as approval-gated (browser_screenshot on
    // Firefox; every mail-surface tool on Thunderbird) require explicit
    // user approval before they run. The policy is keyed on the application
    // of the client that EXECUTES the tool — the routed target in broker
    // mode, the owner otherwise.
    const executingApp = target ? target.application : ownerApplication;
    if (toolRequiresApproval(executingApp, toolName) && !this.autoApproves(toolName)) {
      // Persistent "Deny" (PRODUCT.md §55): the user configured this tool to
      // be refused WITHOUT asking — no prompt, structured denial.
      if (this.permissions.isDenied(toolName)) {
        this.log.info(`${toolName}: persistently denied by the user — refusing without a prompt`);
        throw new PiBrowserProtocolError(
          PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
          `${toolName} is denied by the user in the Permission Configuration. Ask them to set it to Ask or Always approve.`,
          { tool: toolName },
        );
      }
      // Cross-app: the prompt shows in ANOTHER app than the one the user is
      // watching. Tell the session owner so its UI can point the user at the
      // mail/browser client (display-only; the executing client owns the
      // actual session/request_permission round-trip). In broker mode the
      // registry is authoritative for the owner's application (the
      // createTools parameter is only the legacy-mode default).
      if (this.willPrompt(sessionId, toolName)) {
        const ownerApp =
          this.registry && ownerClientId !== undefined
            ? this.registry.get(ownerClientId)?.application ?? ownerApplication
            : ownerApplication;
        this.announceRemotePrompt({
          ownerClientId,
          ownerApplication: ownerApp,
          executingApp,
          sessionId,
          toolCallId,
          toolName,
        });
      }
      await this.requestPermission(sessionId, toolCallId, toolName, targetTransport, args);
    }
    if (toolRequiresApproval(executingApp, toolName) && this.autoApproves(toolName)) {
      this.log.info(`${toolName}: approval auto-granted via PI_BROWSER_AUTO_APPROVE (test seam)`);
    }
    const state = this.ensureState(sessionId, mode, mcpServerId, isOwnerPath ? targetTransport : undefined);
    // The session's own MCP-over-ACP connection is used only for the owner's
    // own tools; cross-app tools always go over the target client's legacy
    // x-pi-browser/tool callback.
    const useOwnerMcp = isOwnerPath && state.mode === "mcp-acp" && state.mcp !== undefined;
    const transport: BrowserToolTransport = useOwnerMcp
      ? (state.mcp as NativeMcpOverAcpTransport)
      : new LegacyBrowserCallbackTransport(targetTransport, {
          timeoutMs: this.timeoutForTool,
          // Last streamed batch for the timed-out call (mail_search).
          getPartial: (id) => this.partialFor(id),
        });
    // Track the call so tool_update notifications can be validated against
    // (and cleaned up after) it.
    this.activeToolCalls.set(toolCallId, {
      sessionId,
      tool: toolName,
      clientId: target?.clientId ?? ownerClientId,
      lastSequence: 0,
      lastBatch: undefined,
      lastScanned: undefined,
      startedAt: Date.now(),
    });
    const t0 = Date.now();
    try {
      const result = await this.executeWithTracking(transport, sessionId, toolName, args, toolCallId);
      this.log.info(
        `${toolName}: tool round-trip ${Date.now() - t0}ms (client=${target?.clientId ?? "legacy"}, transport=${useOwnerMcp ? "mcp-acp" : "callback"}, isError=${result.isError ?? false})`,
      );
      return result;
    } catch (err) {
      this.log.info(`${toolName}: tool round-trip FAILED after ${Date.now() - t0}ms: ${String(err)}`);
      throw err;
    } finally {
      this.activeToolCalls.delete(toolCallId);
    }
  }

  /**
   * Test-only approval seam: PI_BROWSER_AUTO_APPROVE (comma list of tool
   * names or "*") grants the host-side approval gate WITHOUT prompting a
   * user. Never read in production paths — the launcher must opt in.
   * Used by .probe/live-mail-search.mjs, which has no UI to click.
   */
  private autoApproves(toolName: string): boolean {
    const raw = process.env.PI_BROWSER_AUTO_APPROVE;
    if (!raw) return false;
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return list.includes("*") || list.includes(toolName);
  }

  // ------------------------------------------------------------------
  // Permission configuration (x-pi-browser/permissions|set|clear, §55)
  // ------------------------------------------------------------------

  /**
   * The full gated-tool inventory with each tool's persistent state
   * (ask | deny | allow) — the data the add-on's Configuration page
   * renders.
   */
  permissionConfig(): PermissionConfigResult {
    return {
      tools: listGatedTools().map((t) => ({
        name: t.name,
        description: t.description,
        group: t.group,
        state: this.permissions.getState(t.name),
        ...(t.managedBy ? { managedBy: t.managedBy } : {}),
        ...(t.note ? { note: t.note } : {}),
      })),
    };
  }

  /**
   * Set one tool's persistent state (ask | deny | allow) from the
   * Configuration page. Unknown tools and app-managed grants
   * (browser_evaluate — Firefox owns its userScripts permission) are
   * rejected.
   */
  setToolPermission(tool: string, state: PermissionToolState): PermissionSetResult {
    const entry = getGatedTool(tool);
    if (!entry) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown tool: ${tool}`);
    }
    if (entry.managedBy) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.INTERNAL,
        `${tool} is managed by ${entry.managedBy} — its grant cannot be changed here`,
      );
    }
    if (entry.note) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${tool} has no toggleable state: ${entry.note}`);
    }
    this.permissions.setState(tool, state);
    this.log.info(`${tool}: persistent state set to "${state}" from Configuration page`);
    return { tool, state };
  }

  /**
   * Clear one tool's persistent grant, or every grant when `tool` is
   * omitted. Returns the names that were cleared ("clear all" feedback).
   */
  clearToolPermissions(tool?: string): PermissionClearResult {
    if (tool !== undefined) {
      const entry = getGatedTool(tool);
      if (!entry) {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown tool: ${tool}`);
      }
      this.permissions.clear(tool);
      this.log.info(`${tool}: persistent allow cleared from Configuration page`);
      return { cleared: [tool] };
    }
    const cleared = this.permissions.clearAll();
    this.log.info(`permissions: cleared ALL persistent allows (${cleared.length} tool(s))`);
    return { cleared };
  }

  /** The last streamed progress for an in-flight call (timeout recovery). */
  private partialFor(toolCallId: string): { scanned?: number; nextCursor?: string } | undefined {
    const call = this.activeToolCalls.get(toolCallId);
    if (!call) return undefined;
    const scanned = call.lastBatch?.scanned ?? call.lastScanned;
    const nextCursor = call.lastBatch?.nextCursor ?? undefined;
    if (scanned === undefined && !nextCursor) return undefined;
    return { ...(scanned !== undefined ? { scanned } : {}), ...(nextCursor ? { nextCursor } : {}) };
  }

  private async executeWithTracking(
    transport: BrowserToolTransport,
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<NormalizedToolResult> {
    const result = await transport.call(sessionId, toolName, args, toolCallId);
    if (result.isError) {
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, text || "browser tool failed", {
        tool: toolName,
      });
    }
    return result;
  }

  /**
   * Validate one x-pi-browser/tool_update notification (client → host) and
   * forward it to the ACP mapping hook. Drops (never throws) when any check
   * fails:
   *   - the toolCallId is not an in-flight call;
   *   - the sessionId does not match the pending call;
   *   - the tool is not mail_search (the only streaming tool today);
   *   - the source client is not the client executing the call;
   *   - the sequence is not strictly greater than the last accepted one.
   * The update never authorizes anything — it only reports results of the
   * already-approved call.
   */
  handleToolUpdate(params: BrowserToolUpdateParams, sourceClientId: string | undefined): void {
    const call = this.activeToolCalls.get(params.toolCallId);
    if (!call) {
      this.log.debug(`tool_update dropped: unknown toolCall ${params.toolCallId}`);
      return;
    }
    if (params.sessionId !== call.sessionId) {
      this.log.debug(`tool_update dropped: session mismatch for ${params.toolCallId}`);
      return;
    }
    if (params.tool !== "mail_search" || call.tool !== "mail_search") {
      this.log.debug(`tool_update dropped: tool ${params.tool} does not stream`);
      return;
    }
    if (call.clientId !== undefined && sourceClientId !== undefined && call.clientId !== sourceClientId) {
      this.log.debug(`tool_update dropped: client ${sourceClientId} is not executing ${params.toolCallId}`);
      return;
    }
    if (params.sequence !== undefined) {
      if (params.sequence <= call.lastSequence) {
        this.log.debug(`tool_update dropped: non-monotonic sequence ${params.sequence} for ${params.toolCallId}`);
        return;
      }
      call.lastSequence = params.sequence;
    }
    if (params.update.kind === "batch") call.lastBatch = params.update.result as MailSearchResult;
    else if (params.update.kind === "progress") call.lastScanned = params.update.scanned;
    const extra =
      params.update.kind === "progress"
        ? ` scanned=${params.update.scanned} elapsedMs=${params.update.elapsedMs ?? "?"} pageMs=${params.update.pageMs ?? "?"}`
        : params.update.kind === "batch"
          ? ` messages=${params.update.result.messages.length} scanned=${params.update.result.scanned ?? "?"} complete=${params.update.result.complete ?? "?"}`
          : "";
    this.log.info(
      `mail_search tool_update kind=${params.update.kind} seq=${params.sequence ?? "-"}${extra} at ${Date.now() - call.startedAt}ms`,
    );
    this.onToolUpdate?.(call.sessionId, params.toolCallId, params.update);
  }

  /**
   * Coalesced permission groups: parallel tool calls that arrive while a
   * session's approval prompt is being assembled share ONE prompt card.
   * Models routinely emit several tool calls in the same turn (e.g. two
   * mail_get_message_body calls for two messages); without coalescing the
   * client UI shows only the last card and the other request times out.
   */
  private permissionGroups = new Map<string, PermissionGroup>();

  /**
   * Ask the client for permission to run a sensitive tool. Blocks until the
   * user responds (or the prompt times out). "Always allow" is remembered for
   * the rest of the host lifetime. A denial/timeout surfaces a structured
   * BROWSER_PERMISSION_DENIED error so the agent can react.
   *
   * Concurrent requests for the same session are coalesced: a short window
   * collects parallel calls, then ONE request_permission is sent whose card
   * names every coalesced call; the single answer applies to all of them.
   */
  /** True when a permission prompt WILL be sent for this tool call. */
  private willPrompt(sessionId: string, toolName: string): boolean {
    if (toolName === "browser_evaluate") return true; // Firefox checks the current browser grant.
    return (
      !this.autoApproves(toolName) &&
      !this.permissions.isAllowed(toolName) &&
      !this.sessionAllowed.get(sessionId)?.has(toolName)
    );
  }

  /**
   * Tell the session-owner client that the approval prompt is being shown in
   * a different app (cross-app routing, plan §29). Fire-and-forget: if the
   * owner's UI is closed or the app is a version without the banner, the
   * prompt still works — the executing client's modal is authoritative.
   */
  private announceRemotePrompt(ctx: {
    ownerClientId: string | undefined;
    ownerApplication: AgentApplication;
    executingApp: AgentApplication;
    sessionId: string;
    toolCallId: string;
    toolName: string;
  }): void {
    if (
      !this.registry ||
      ctx.ownerClientId === undefined ||
      ctx.ownerApplication === ctx.executingApp
    )
      return;
    const owner = this.registry.get(ctx.ownerClientId);
    if (!owner) return;
    const params: PermissionPromptedParams = {
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      tool: ctx.toolName,
      application: ctx.executingApp,
    };
    this.log.info(`${ctx.toolName}: approval prompt shows in ${ctx.executingApp}; notifying session owner ${owner.clientId} (${owner.application})`);
    owner.transport
      .request(X_PI_BROWSER.permission_prompted, params, 5_000)
      .catch((err) => {
        this.log.debug(
          `permission_prompted → owner ${owner.clientId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private async requestPermission(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    target: AcpTransportLike,
    args?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.willPrompt(sessionId, toolName)) {
      this.log.debug(`${toolName}: already allowed (session or host scope); skipping permission prompt`);
      return;
    }
    const argsSummary = summarizeArgs(args);
    this.log.info(
      `${toolName}: requesting user permission (toolCall=${toolCallId}${argsSummary ? ` args=${argsSummary}` : ""})`,
    );

    return new Promise<void>((resolve, reject) => {
      const isEvaluate = toolName === "browser_evaluate";
      let group = this.permissionGroups.get(sessionId);
      // browser_evaluate has a different option set (Firefox owns the grant);
      // it never joins a group of regular tools, and vice versa.
      if (group && group.hasEvaluate !== isEvaluate) group = undefined;
      if (!group) {
        group = { members: [], hasEvaluate: isEvaluate, target, settled: false };
        this.permissionGroups.set(sessionId, group);
        const captured = group;
        group.flushTimer = setTimeout(
          () => { void this.sendPermissionRequest(sessionId, captured); },
          PERMISSION_COALESCE_WINDOW_MS,
        );
      }
      group.members.push({ toolCallId, toolName, resolve, reject });
    });
  }

  /**
   * Send the single coalesced permission prompt for a group's members and
   * settle every member with the user's one decision.
   */
  private async sendPermissionRequest(
    sessionId: string,
    group: PermissionGroup,
  ): Promise<void> {
    if (group.settled) return;
    group.settled = true;
    if (group.flushTimer) clearTimeout(group.flushTimer);
    this.permissionGroups.delete(sessionId);
    const { members } = group;
    const first = members[0];
    const title = members.length === 1
      ? first.toolName
      : `${members.length} parallel calls: ` +
        [...new Set(members.map((m) => m.toolName))].map((n) => {
          const c = members.filter((m) => m.toolName === n).length;
          return c > 1 ? `${n} ×${c}` : n;
        }).join(", ");
    this.log.info(
      `permission: prompting for ${members.length} call(s) [${title}] (session=${sessionId})`,
    );
    const request = buildPermissionRequest({
      sessionId,
      toolCallId: first.toolCallId,
      title,
      toolName: first.toolName,
    });
    let response: RequestPermissionResponse | undefined;
    let failure: string | undefined;
    try {
      response = await group.target.request<RequestPermissionResponse>(
        REQUEST_PERMISSION_METHOD,
        request,
        PERMISSION_TIMEOUT_MS,
      );
    } catch (err) {
      failure = `permission request for ${first.toolName} failed or timed out: ${err instanceof Error ? err.message : String(err)}`;
    }
    const allowed = failure === undefined && permissionAllowed(response);
    if (allowed && response) {
      const optionId = response.outcome.outcome === "selected" ? response.outcome.optionId : "";
      // The card named every coalesced tool — the answer applies to all of
      // them, including the remembered scopes.
      for (const toolName of new Set(members.map((m) => m.toolName))) {
        if (toolName === "browser_evaluate") continue; // Never cache Firefox's revocable userScripts grant.
        if (optionId === "allow_always") {
          // Persistent: remembered across host restarts and toggleable from
          // the add-on's Configuration page.
          this.permissions.setAllowed(toolName, true);
          this.log.info(`${toolName}: user chose Always allow (persisted)`);
        } else if (optionId === "allow_session") {
          let set = this.sessionAllowed.get(sessionId);
          if (!set) {
            set = new Set();
            this.sessionAllowed.set(sessionId, set);
          }
          set.add(toolName);
          this.log.info(`${toolName}: user chose Allow for this session (${sessionId})`);
        } else {
          this.log.info(`${toolName}: user chose Allow once`);
        }
      }
    } else if (!allowed) {
      this.log.warn(`permission: user denied (or prompt failed) for [${title}]`);
    }
    for (const m of members) {
      if (allowed) {
        m.resolve();
      } else {
        m.reject(
          new PiBrowserProtocolError(
            PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
            failure ?? `user denied permission to run ${m.toolName}`,
            { tool: m.toolName },
          ),
        );
      }
    }
  }

  /** Ensure per-session transport state exists (called at tool execution). */
  ensureState(
    sessionId: string,
    mode: BrowserMode,
    mcpServerId?: string,
    ownerTransport?: AcpTransportLike,
  ): SessionBrowserState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      if (mode === "mcp-acp" && mcpServerId && ownerTransport) {
        // Only the session owner's MCP-over-ACP connection is created (the
        // owner passes its transport); peer (cross-app) calls use legacy.
        state = {
          mode,
          mcp: new NativeMcpOverAcpTransport(ownerTransport, mcpServerId, this.log, sessionId),
        };
      } else {
        state = { mode };
      }
      this.sessions.set(sessionId, state);
      this.log.info(`browser state for session ${sessionId}: mode=${state.mode}`);
    }
    return state;
  }


  /** Handle x-pi-browser/notify (tab closed/navigated, binding changes). */
  handleNotify(params: BrowserNotifyParams): void {
    this.log.debug(`x-pi-browser/notify ${params.event} session=${params.sessionId}`);
    // Element references are owned by the content script and validated at
    // use time (isConnected). No host-side ref state to invalidate today; the
    // hook exists so future transports can react (e.g. drop MCP connections
    // when the bound tab closes).
    if (params.event === "tab_closed") {
      const state = this.sessions.get(params.sessionId);
      if (state?.mcp) {
        // Keep the MCP connection: the provider tab may have other tabs
        // bound later, and reconnecting is cheap. Log only.
      }
    }
    // The REPL's page handle (active tab) and element refs are stale after
    // any of these events; the next cell starts with a warning note.
    const replNotes: Record<BrowserNotifyParams["event"], string> = {
      binding_changed: "The session's tab binding changed — inspect the page (snapshot) before acting.",
      binding_removed: "The session's tab binding was removed — page.* calls will fail with BROWSER_NOT_BOUND until re-bound.",
      tab_closed: "The bound tab was closed — page.* calls will fail with BROWSER_TAB_CLOSED until re-bound.",
      tab_navigated: "The bound tab navigated — element refs are stale; snapshot again before acting.",
    };
    this.repl.invalidate(params.sessionId, replNotes[params.event]);
  }

  /**
   * Bind a session's `javascript` REPL workspace to the task's scratch dir
   * (the session cwd). Delegates to the REPL provider; takes effect from the
   * session's next cell.
   */
  bindWorkspace(sessionId: string, workspace: string): void {
    this.repl.bindWorkspace(sessionId, workspace);
  }

  /** Release per-session state (session/close or host shutdown). */
  async disposeSession(sessionId: string): Promise<void> {
    this.sessionAllowed.delete(sessionId);
    const state = this.sessions.get(sessionId);
    if (state) {
      this.sessions.delete(sessionId);
      if (state.mcp) await state.mcp.dispose();
    }
    // Reap the session's REPL worker child (no orphan processes). A session
    // may have a runtime without browser state (cells that never touched a
    // browser tool), so this runs unconditionally and is idempotent.
    await this.repl.disposeSession(sessionId);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.disposeSession(id);
    // Runtimes of sessions with no browser state are reaped here.
    await this.repl.shutdown();
  }
}
