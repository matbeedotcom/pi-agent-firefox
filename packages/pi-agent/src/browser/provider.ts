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
  permissionAllowed,
  toolRequiresApproval,
  REQUEST_PERMISSION_METHOD,
  type AcpTransportLike,
  type AgentApplication,
  type BrowserNotifyParams,
  type PermissionPromptedParams,
  type RequestPermissionResponse,
} from "@pi-browser/protocol";
import { BROWSER_TOOL_SCHEMAS, CONTROL_TOOL_SCHEMAS, type BrowserToolSchema } from "./schemas.js";
import { MAIL_TOOL_SCHEMAS, type MailToolSchema } from "../mail/schemas.js";
import { COMPOSE_TOOL_SCHEMAS, type ComposeToolSchema } from "../compose/schemas.js";
import { MAIL_MUTATION_TOOL_SCHEMAS, type MailMutationToolSchema } from "../mutation/schemas.js";
import { CONTACTS_TOOL_SCHEMAS, type ContactsToolSchema } from "../contacts/schemas.js";
import { McpAcpClient } from "./mcp-acp-client.js";
import type { CapabilityRegistry } from "../capability-registry.js";

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
  call(sessionId: string, tool: string, args: Record<string, unknown>): Promise<NormalizedToolResult>;
  dispose(): Promise<void>;
}

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
}

export class LegacyBrowserCallbackTransport implements BrowserToolTransport {
  readonly kind = "legacy" as const;

  constructor(
    private readonly transport: AcpTransportLike,
    private readonly options: LegacyTransportOptions = {},
  ) {}

  async call(sessionId: string, tool: string, args: Record<string, unknown>): Promise<NormalizedToolResult> {
    const timeoutMs = (this.options.timeoutMs ?? timeoutFor)(tool);
    const slackMs = this.options.slackMs ?? 5_000;
    try {
      const raw = await this.transport.request(
        X_PI_BROWSER.tool,
        { sessionId, tool, arguments: args, timeoutMs },
        timeoutMs + slackMs,
      );
      return normalizeToolResult(raw);
    } catch (err) {
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

  async call(_sessionId: string, tool: string, args: Record<string, unknown>): Promise<NormalizedToolResult> {
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

/** How long to wait for the user to answer a permission prompt. */
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
export class CapabilityToolProvider {
  private readonly sessions = new Map<string, SessionBrowserState>();
  /** Tools the user has approved with "Always allow" (per host lifetime). */
  private readonly alwaysAllowed = new Set<string>();
  /**
   * Tools the user has approved with "Allow for this session", keyed by ACP
   * session id. Cleared when the session is disposed.
   */
  private readonly sessionAllowed = new Map<string, Set<string>>();

  constructor(
    /**
     * Fallback transport (single-client / legacy mode). In registry (broker)
     * mode this may be undefined: every call is routed through the registry.
     */
    private readonly transport: AcpTransportLike | undefined,
    private readonly log: Logger,
    private readonly registry: CapabilityRegistry | undefined = undefined,
  ) {}

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
    return schemas.map((entry) => ({
      name: entry.name,
      label: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      execute: async (toolCallId, args, _signal) => {
        const sessionId = idRef.id;
        if (!sessionId) {
          throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "browser tool invoked before session id assigned");
        }
        // Route to the connected client that provides this tool (owner
        // first; cross-app peer otherwise, plan §29). In legacy (no
        // registry) mode there is a single client — it is always the target.
        const target = this.registry
          ? this.registry.resolveTarget(ownerClientId, entry.name)
          : undefined;
        const targetTransport = target ? target.transport : this.legacyTransport();
        const isOwnerPath = !target || target.clientId === ownerClientId;
        // Tools the policy marks as approval-gated (browser_screenshot on
        // Firefox; every mail-surface tool on Thunderbird) require explicit
        // user approval before they run. The policy is keyed on the
        // application of the client that EXECUTES the tool — the routed
        // target in broker mode, the owner otherwise.
        const executingApp = target ? target.application : ownerApplication;
        if (toolRequiresApproval(executingApp, entry.name)) {
          // Cross-app: the prompt shows in ANOTHER app than the one the user
          // is watching. Tell the session owner so its UI can point the user
          // at the mail/browser client (display-only; the executing client
          // owns the actual session/request_permission round-trip). In broker
          // mode the registry is authoritative for the owner's application
          // (the createTools parameter is only the legacy-mode default).
          if (this.willPrompt(sessionId, entry.name)) {
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
              toolName: entry.name,
            });
          }
          await this.requestPermission(sessionId, toolCallId, entry.name, targetTransport);
        }
        const state = this.ensureState(sessionId, mode, mcpServerId, isOwnerPath ? targetTransport : undefined);
        // The session's own MCP-over-ACP connection is used only for the
        // owner's own tools; cross-app tools always go over the target
        // client's legacy x-pi-browser/tool callback.
        const useOwnerMcp = isOwnerPath && state.mode === "mcp-acp" && state.mcp !== undefined;
        const transport = useOwnerMcp
          ? (state.mcp as NativeMcpOverAcpTransport)
          : new LegacyBrowserCallbackTransport(targetTransport);
        const result = await transport.call(sessionId, entry.name, args as Record<string, unknown>);
        if (result.isError) {
          const text = result.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text)
            .join("\n");
          throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, text || "browser tool failed", {
            tool: entry.name,
          });
        }
        return { content: result.content, details: { piBrowser: true, tool: entry.name } };
      },
    }));
  }

  /**
   * Ask the client for permission to run a sensitive tool. Blocks until the
   * user responds (or the prompt times out). "Always allow" is remembered for
   * the rest of the host lifetime. A denial/timeout surfaces a structured
   * BROWSER_PERMISSION_DENIED error so the agent can react.
   */
  /** True when a permission prompt WILL be sent for this tool call. */
  private willPrompt(sessionId: string, toolName: string): boolean {
    return !this.alwaysAllowed.has(toolName) && !this.sessionAllowed.get(sessionId)?.has(toolName);
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
  ): Promise<void> {
    if (!this.willPrompt(sessionId, toolName)) {
      this.log.debug(`${toolName}: already allowed (session or host scope); skipping permission prompt`);
      return;
    }
    const request = buildPermissionRequest({ sessionId, toolCallId, toolName });
    this.log.info(`${toolName}: requesting user permission (toolCall=${toolCallId})`);
    let response: RequestPermissionResponse;
    try {
      response = await target.request<RequestPermissionResponse>(
        REQUEST_PERMISSION_METHOD,
        request,
        PERMISSION_TIMEOUT_MS,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
        `permission request for ${toolName} failed or timed out: ${message}`,
        { tool: toolName },
      );
    }
    if (permissionAllowed(response)) {
      const optionId = response.outcome.outcome === "selected" ? response.outcome.optionId : "";
      if (optionId === "allow_always") {
        this.alwaysAllowed.add(toolName);
        this.log.info(`${toolName}: user chose Always allow`);
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
      return;
    }
    this.log.warn(`${toolName}: user denied permission`);
    throw new PiBrowserProtocolError(
      PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
      `user denied permission to run ${toolName}`,
      { tool: toolName },
    );
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
    // use time (isConnected). No host-side state to invalidate today; the
    // hook exists so future transports can react (e.g. drop MCP connections
    // when the bound tab closes).
    if (params.event === "tab_closed") {
      const state = this.sessions.get(params.sessionId);
      if (state?.mcp) {
        // Keep the MCP connection: the provider tab may have other tabs
        // bound later, and reconnecting is cheap. Log only.
      }
    }
  }

  /** Release per-session state (session/close or host shutdown). */
  async disposeSession(sessionId: string): Promise<void> {
    this.sessionAllowed.delete(sessionId);
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    if (state.mcp) await state.mcp.dispose();
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.disposeSession(id);
  }
}
