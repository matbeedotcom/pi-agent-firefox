/**
 * Background event page (PRODUCT.md §13–15, §20–24).
 *
 * Owns exactly one Native Messaging port, the ACP client, session
 * presentation state, tab bindings, and the browser tool implementations.
 * All sidebar and content-script traffic routes through here.
 */
import {
  AGENT_METHODS,
  PI_BROWSER,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  PERMISSION_ALLOW_ALWAYS,
  PERMISSION_ALLOW_ONCE,
  PERMISSION_REJECT,
  X_PI_BROWSER,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
  type SessionNotification,
  type SessionUpdate,
} from "@pi-browser/protocol";
import { AcpClient, bindingRefId, fetchPiTheme, notifyHost, SessionStore, type HostStatus, type PiTheme } from "@pi-browser/webext";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { McpServer, type ControlHandler } from "./mcp-server.js";
import { networkLog } from "./network-log.js";
import { ReplTabs } from "./repl-tabs.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const store = new SessionStore();
/** REPL-owned tabs (javascript tool, BROWSER-USE-REPL-PLAN.md P2.3). */
const replTabs = new ReplTabs();
const dispatcher = new ToolDispatcher(store, replTabs);

/**
 * A REPL-owned tab was closed (by the user or browser_close_tab). Restore
 * the user's home tab if the session's binding pointed at it; otherwise
 * just unbind (the original tab_closed behavior).
 */
async function restoreAfterReplTabClosed(sessionId: string, tabId: number): Promise<void> {
  const binding = store.getBinding(sessionId);
  if (binding && bindingRefId(binding) === tabId) {
    const home = replTabs.takeHome(sessionId);
    if (home) store.bind(sessionId, home);
    else store.unbind(sessionId);
  } else {
    store.unbind(sessionId);
  }
}

/** Close every REPL-owned tab of the session (session unbinds / ends). */
async function closeReplTabs(sessionId: string): Promise<void> {
  for (const tabId of replTabs.clear(sessionId)) {
    await browser.tabs.remove(tabId).catch(() => {}); // may already be gone
  }
}

/**
 * Control tools (pi_*) served over the MCP channel (PRODUCT.md §26, Phase 5).
 * They execute the same handlers as the sidebar's pi/action bridge, so the
 * agent and the UI have one behavioral source of truth. A web page can never
 * reach these: the only path is agent → host → mcp/message → here (§49-4/5).
 */
const controlHandler: ControlHandler = (tool, args) => {
  switch (tool) {
    case "pi_get_state":
      return handleAction("get_state", {});
    case "pi_new_session":
      return handleAction("new_session", { cwd: typeof args.cwd === "string" ? args.cwd : undefined });
    case "pi_select_session":
      return handleAction("select_session", { sessionId: String(args.sessionId ?? "") });
    case "pi_prompt":
      return handleAction("prompt", { sessionId: String(args.sessionId ?? ""), text: String(args.text ?? "") });
    case "pi_cancel":
      return handleAction("cancel", { sessionId: String(args.sessionId ?? "") });
    case "pi_close_session":
      return handleAction("close_session", { sessionId: String(args.sessionId ?? "") });
    case "pi_set_config_option":
      return handleAction("set_config", {
        sessionId: String(args.sessionId ?? ""),
        configId: String(args.configId ?? ""),
        value: args.value,
      });
    case "pi_bind_current_tab":
      return handleAction("bind_current_tab", { sessionId: String(args.sessionId ?? "") });
    case "pi_unbind_tab":
      return handleAction("unbind", { sessionId: String(args.sessionId ?? "") });
    case "pi_open_bound_tab":
      return handleAction("open_bound_tab", { sessionId: String(args.sessionId ?? "") });
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown control tool: ${tool}`);
  }
};

const mcpServer = new McpServer(dispatcher, controlHandler);

let hostStatus: HostStatus = { state: "connecting" };
let activeSessionId: string | undefined;
let initialized = false;
let bootstrapInFlight = false;
/** Active browser theme snapshot (browser.theme); undefined when unavailable. */
let theme: PiTheme | undefined;

// ---------------------------------------------------------------------------
// Permission prompts (PRODUCT.md §43)
// ---------------------------------------------------------------------------

/**
 * Pending permission requests. Keyed by the tool call id. When the host asks
 * for permission (session/request_permission), we push the prompt to the
 * sidebar and block here until the user answers (or the timer auto-cancels).
 * The user's click is the live gesture that makes the sensitive tool's host
 * access (activeTab) available.
 */
interface PendingPermission {
  resolve: (optionId: string | "cancelled") => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * The original request, kept so the prompt can be re-derived from state:
   * the sidebar may have been CLOSED (or the event page reloaded) when the
   * prompt first arrived, so every pi/state carries the still-pending list
   * and the sidebar re-shows the modal on the next push / on open.
   */
  request: RequestPermissionRequest;
}
const pendingPermissions = new Map<string, PendingPermission>();

/** Match the host's PERMISSION_TIMEOUT_MS with a small buffer. */
const PERMISSION_PROMPT_TIMEOUT_MS = 125_000;

function pushPermissionRequest(request: RequestPermissionRequest): void {
  browser.runtime
    .sendMessage({ type: "pi/permission_request", request })
    .catch(() => {
      /* sidebar not open */
    });
}

/** Resolve a pending permission prompt (from the sidebar or a timeout). */
function resolvePermission(permId: string, optionId: string | "cancelled"): void {
  const pending = pendingPermissions.get(permId);
  if (!pending) {
    // The event page reloaded (map wiped) or the prompt already resolved:
    // the click is lost. Log it — a silent no-op here hides the
    // "I clicked Allow and nothing happened" class of stall.
    console.warn(`[pi-browser] resolvePermission: no pending prompt for ${permId}, option=${optionId}`);
    return;
  }
  clearTimeout(pending.timer);
  pendingPermissions.delete(permId);
  pending.resolve(optionId);
  // Re-sync the sidebar: its modal is stale now (a click hides it locally,
  // but a timeout/cancel/late reply must close it too, and a NEW pending
  // prompt, if any, should be shown next).
  pushState();
}

/**
 * Ask the user to approve a sensitive tool call. Blocks until the sidebar
 * answers or the prompt times out (auto-cancel). Returns the ACP outcome.
 */
function requestPermissionFromUser(
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const permId = request.toolCall.toolCallId;
  const knownOptions = new Set(request.options.map((o) => o.optionId));
  const timer = setTimeout(() => {
    // Timed out: treat as cancelled so the host surfaces a denial.
    resolvePermission(permId, "cancelled");
  }, PERMISSION_PROMPT_TIMEOUT_MS);
  const answer = new Promise<string | "cancelled">((resolve) => {
    pendingPermissions.set(permId, { resolve, timer, request });
  });
  pushPermissionRequest(request);
  return answer.then((optionId) => {
    if (optionId === "cancelled" || !knownOptions.has(optionId)) {
      return { outcome: { outcome: "cancelled" as const } };
    }
    return {
      outcome: { outcome: "selected" as const, optionId },
    };
  });
}

// ---------------------------------------------------------------------------
// Sidebar bridge
// ---------------------------------------------------------------------------

interface UiState {
  status: HostStatus;
  activeSessionId?: string;
  sessions: ReturnType<SessionStore["snapshot"]>["sessions"];
  lastSessionId?: string;
  theme?: PiTheme;
  /** Still-pending permission prompts (sidebar re-shows the modal from this). */
  permissionRequests: RequestPermissionRequest[];
}

function pendingPermissionRequests(): RequestPermissionRequest[] {
  return [...pendingPermissions.values()].map((p) => p.request);
}

function pushState(): void {
  const state: UiState = {
    status: hostStatus,
    ...(activeSessionId ? { activeSessionId } : {}),
    sessions: store.snapshot().sessions,
    ...(store.lastSession ? { lastSessionId: store.lastSession } : {}),
    ...(theme ? { theme } : {}),
    permissionRequests: pendingPermissionRequests(),
  };
  browser.runtime
    .sendMessage({ type: "pi/state", state })
    .catch(() => {
      /* sidebar not open */
    });
}

function pushSessionUpdate(sessionId: string, update: SessionUpdate): void {
  browser.runtime
    .sendMessage({ type: "pi/session_update", sessionId, update })
    .catch(() => {
      /* sidebar not open */
    });
}

// ---------------------------------------------------------------------------
// ACP session flows
// ---------------------------------------------------------------------------

async function refreshSessionList(): Promise<void> {
  try {
    const res = await client.request<{ sessions: SessionInfo[] }>(AGENT_METHODS.session_list, { cwd: null });
    store.upsertFromList(res.sessions ?? []);
    pushState();
  } catch (err) {
    console.warn("[pi-browser] session/list failed", err);
  }
}

async function createSession(cwd: string): Promise<string> {
  const decl = mcpServer.declarePending();
  const mcpServers = [{ name: "firefox-browser", type: "acp", serverId: decl.serverId }];
  let sessionId: string;
  let configOptions: unknown;
  let effectiveCwd: string;
  try {
    const res = await client.request<{
      sessionId: string;
      configOptions?: unknown;
      _meta?: { piBrowser?: { workspace?: string } };
    }>(AGENT_METHODS.session_new, { cwd, mcpServers });
    sessionId = res.sessionId;
    configOptions = res.configOptions;
    // The agent may provision a per-task workspace as the session cwd (when
    // the requested cwd was neutral). Record the real cwd so the UI shows
    // where the model's files land, not the fallback we sent.
    effectiveCwd = res._meta?.piBrowser?.workspace ?? cwd;
  } catch (err) {
    decl.discard();
    throw err;
  }
  decl.resolve(sessionId);
  store.upsertCreated(sessionId, effectiveCwd, configOptions as never);
  store.setLastSession(sessionId);
  activeSessionId = sessionId;
  pushState();
  return sessionId;
}

async function openExistingSession(sessionId: string, cwd: string, load: boolean): Promise<void> {
  const decl = mcpServer.declarePending();
  const mcpServers = [{ name: "firefox-browser", type: "acp", serverId: decl.serverId }];
  const method = load ? AGENT_METHODS.session_load : AGENT_METHODS.session_resume;
  try {
    const res = await client.request<{ configOptions?: unknown }>(method, {
      sessionId,
      cwd,
      mcpServers,
    });
    decl.resolve(sessionId);
    const view = store.get(sessionId);
    if (view) view.configOptions = res.configOptions as never;
    if (load) store.markLoaded(sessionId);
  } catch (err) {
    decl.discard();
    throw err;
  }
  store.setLastSession(sessionId);
  activeSessionId = sessionId;
  pushState();
}

async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const view = store.get(sessionId);
  if (!view) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
  if (view.streaming) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_BUSY, "session is busy");
  store.setStreaming(sessionId, true);
  pushState();
  try {
    await client.request(AGENT_METHODS.session_prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    }, 0); // no timeout: the turn runs until done or cancelled
  } finally {
    store.setStreaming(sessionId, false);
    pushState();
  }
}

// ---------------------------------------------------------------------------
// ACP client
// ---------------------------------------------------------------------------

const client = new AcpClient(
  {
    clientName: "pi-browser-firefox",
    application: "firefox",
    capabilities: ["browser"],
    extensionId: PI_BROWSER.extensionId,
  },
  {
  onSessionUpdate(params: SessionNotification) {
    pushSessionUpdate(params.sessionId, params.update);
    // Keep streaming state consistent even if a response was missed.
  },
  onToolCall: (params) => dispatcher.handleToolCall(params),
  onMcpConnect: (params) => mcpServer.handleConnect(params),
  onMcpMessage: (params) => mcpServer.handleMessage(params),
  onMcpDisconnect: (params) => mcpServer.handleDisconnect(params),
  onRequestPermission: (params) => requestPermissionFromUser(params),
  // Cross-app heads-up: a tool's approval prompt is showing in ANOTHER app
  // (e.g. Thunderbird). The sidebar draws the user's attention there. This
  // client does NOT answer the prompt — the executing client owns it.
  onPermissionPrompted: (params) => {
    browser.runtime
      .sendMessage({ type: "pi/permission_prompted", params })
      .catch(() => {
        /* sidebar not open */
      });
  },
  onStatus(status: HostStatus) {
    hostStatus = status;
    pushState();
    // The port is up: drive the ACP initialize handshake (which flips the
    // status to "connected" on success) and sync session state. Deferred to
    // a later task so connect() has fully finished (port assigned, listeners
    // attached) before any request goes out.
    if (status.state === "connecting" && !initialized && !bootstrapInFlight) {
      bootstrapInFlight = true;
      setTimeout(() => {
        void bootstrap().finally(() => {
          bootstrapInFlight = false;
        });
      }, 0);
    }
    if (status.state === "disconnected" || status.state === "not_installed") {
      initialized = false;
    }
  },
  });

async function bootstrap(): Promise<void> {
  if (!client.connected) return; // port dropped during boot; reconnect cycle retries
  try {
    await client.initialize();
    initialized = true;
  } catch (err) {
    console.error("[pi-browser] initialize failed", err);
    // Only downgrade to "disconnected" when the port is still alive (a real
    // protocol failure). If the port is gone, onDisconnect has already set
    // the precise state (not_installed vs disconnected) — overwriting it
    // here used to mask "not_installed" and suppress the onboarding screen.
    if (client.connected && hostStatus.state === "connecting") {
      hostStatus = { state: "disconnected", detail: err instanceof Error ? err.message : String(err) };
      pushState();
    }
    return;
  }
  await refreshSessionList();
  const last = store.lastSession;
  if (last) {
    const view = store.get(last);
    try {
      if (view) {
        await openExistingSession(last, view.cwd, !view.loaded);
      } else {
        activeSessionId = undefined;
      }
    } catch (err) {
      console.warn("[pi-browser] resuming last session failed", err);
    }
  }
  pushState();
}

// ---------------------------------------------------------------------------
// Tab lifecycle -> host notifications (invalidate element refs, etc.)
// ---------------------------------------------------------------------------

browser.tabs.onRemoved.addListener((tabId) => {
  const boundSession = store.sessionForRef(tabId);
  if (boundSession) {
    const wasReplOwned = replTabs.has(boundSession, tabId);
    replTabs.close(boundSession, tabId);
    if (wasReplOwned) {
      // The REPL tab the session was bound to went away: restore the
      // user's home tab (or unbind when there is none).
      void restoreAfterReplTabClosed(boundSession, tabId);
    } else {
      store.unbind(boundSession);
    }
    notifyHost(client, { sessionId: boundSession, event: "tab_closed", data: { tabId } });
    pushState();
    return;
  }
  // Not the bound tab: it may be an ORPHANED REPL-owned auxiliary tab.
  const owner = replTabs.ownerOf(tabId);
  if (owner) replTabs.close(owner, tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const navigated = changeInfo.status === "loading" || typeof changeInfo.url === "string";
  if (!navigated) return;
  const sessionId = store.sessionForRef(tabId);
  if (!sessionId) return;
  notifyHost(client, { sessionId, event: "tab_navigated", data: { tabId } });
});

browser.tabs.onActivated.addListener(async () => {
  // Refresh binding tab titles occasionally.
  pushState();
});

// ---------------------------------------------------------------------------
// Sidebar actions
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as { type?: string; action?: string; payload?: Record<string, unknown> };
  if (msg.type === "pi/permission_response") {
    const permId = String((msg as { permId?: unknown }).permId ?? "");
    const optionId = String((msg as { optionId?: unknown }).optionId ?? "cancelled");
    resolvePermission(permId, optionId);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "pi/ensure_connected") {
    // Onboarding: the sidebar's "Check again now" button. Idempotent no-op
    // when already connected; otherwise attempts the connect immediately.
    client.ensureConnected();
    sendResponse({ ok: true, connected: client.connected });
    return;
  }
  if (msg.type !== "pi/action") return;
  void handleAction(msg.action ?? "", (msg.payload ?? {}) as never)
    .then((result) => sendResponse({ ok: true, ...(result !== undefined ? { result } : {}) }))
    .catch((err) => {
      const data = err instanceof PiBrowserProtocolError ? { piBrowserError: err.code, message: err.message } : { message: String(err) };
      sendResponse({ ok: false, error: data });
    });
  return true; // async response
});

async function handleAction(action: string, payload: ActionPayload): Promise<unknown> {
  switch (action) {
    case "get_state": {
      return {
        status: hostStatus,
        ...(activeSessionId ? { activeSessionId } : {}),
        sessions: store.snapshot().sessions,
        ...(store.lastSession ? { lastSessionId: store.lastSession } : {}),
        ...(theme ? { theme } : {}),
        permissionRequests: pendingPermissionRequests(),
      };
    }
    case "new_session": {
      if (!client.connected) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.NATIVE_HOST_NOT_INSTALLED, "not connected to native host");
      const cwd = String(payload.cwd ?? "").trim() || processCwdLikeFallback();
      const sessionId = await createSession(cwd);
      return { sessionId };
    }
    case "select_session": {
      const sessionId = String(payload.sessionId);
      const view = store.get(sessionId);
      if (!view) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
      if (!view.loaded) {
        await openExistingSession(sessionId, view.cwd, true);
      } else {
        store.setLastSession(sessionId);
        activeSessionId = sessionId;
        pushState();
      }
      return {};
    }
    case "prompt": {
      const sessionId = String(payload.sessionId);
      const text = String(payload.text ?? "");
      if (!text.trim()) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "empty prompt");
      void sendPrompt(sessionId, text);
      return { accepted: true };
    }
    case "cancel": {
      const sessionId = String(payload.sessionId);
      await client.request(AGENT_METHODS.session_cancel, { sessionId });
      return {};
    }
    case "close_session": {
      const sessionId = String(payload.sessionId);
      await client.request(AGENT_METHODS.session_close, { sessionId });
      store.setStreaming(sessionId, false);
      if (activeSessionId === sessionId) activeSessionId = undefined;
      pushState();
      return {};
    }
    case "set_config": {
      const sessionId = String(payload.sessionId);
      const res = await client.request<{ configOptions?: unknown }>(AGENT_METHODS.session_set_config_option, {
        sessionId,
        configId: String(payload.configId),
        value: payload.value,
      });
      store.setConfigOptions(sessionId, (res.configOptions ?? []) as never);
      pushState();
      return {};
    }
    case "bind_current_tab": {
      const sessionId = String(payload.sessionId);
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_NOT_BOUND, "no active tab to bind");
      store.bind(sessionId, {
        ref: tab.id,
        refId: tab.id,
        label: tab.title,
        windowId: tab.windowId ?? 0,
        owner: "bound",
        // legacy fields kept so persisted state + the sidebar's inline type stay valid
        tabId: tab.id,
        tabTitle: tab.title,
      });
      // An explicit user bind becomes the restore point for REPL tabs.
      replTabs.rememberHome(sessionId, store.getBinding(sessionId)!);
      pushState();
      return {};
    }
    case "unbind": {
      const sessionId = String(payload.sessionId);
      store.unbind(sessionId);
      // The REPL's auxiliary tabs are owned by the session: unbind reaps them.
      await closeReplTabs(sessionId);
      pushState();
      return {};
    }
    case "open_bound_tab": {
      const sessionId = String(payload.sessionId);
      const binding = store.getBinding(sessionId);
      if (!binding) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_NOT_BOUND, "session has no bound tab");
      const tabId = bindingRefId(binding);
      if (tabId === undefined) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_NOT_BOUND, "session binding has no tab");
      await browser.tabs.update(tabId, { active: true });
      if (binding.windowId) await browser.windows.update(binding.windowId, { focused: true }).catch(() => {});
      return {};
    }
    case "refresh_sessions": {
      await refreshSessionList();
      return {};
    }
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `unknown action: ${action}`);
  }
}

interface ActionPayload {
  cwd?: string;
  sessionId?: string;
  text?: string;
  configId?: string;
  value?: unknown;
}

function processCwdLikeFallback(): string {
  // The add-on has no cwd of its own; the sidebar supplies one. This is only
  // reached when the user hits "create" with an empty field.
  return "/";
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

void (async () => {
  await store.hydrate();
  // Start observing tab requests for browser_get_network (PRODUCT.md §36).
  networkLog.start();
  // Read the active browser theme so the sidebar renders with it; re-read on
  // theme change and re-push state (the sidebar applies theme on every state).
  theme = await fetchPiTheme();
  if (typeof browser.theme !== "undefined" && browser.theme?.onUpdated) {
    browser.theme.onUpdated.addListener(() => {
      void fetchPiTheme().then((t) => {
        theme = t;
        pushState();
      });
    });
  }
  pushState();
  client.start();
})();

// Keep the MV3 event page alive and keep the link healthy: Firefox unloads
// idle event pages, which would silently drop the Native Messaging port (and
// with it the session). Two duties on one interval:
//   - connected:  periodic liveness ping (doubles as the x-pi-browser/ping
//     probe; the host refreshes the add-on heartbeat it uses for onboarding
//     auto-detection in /pi-browser status|doctor)
//   - NOT connected: ensureConnected() — auto-detects a host installed AFTER
//     the add-on loaded (add-on-first onboarding), even if the event page was
//     unloaded in the meantime and the 3s reconnect timer was lost. The
//     pending interval itself is what keeps the event page alive in this
//     state.
setInterval(() => {
  if (client.connected && hostStatus.state === "connected") {
    client.request(X_PI_BROWSER.ping, {}, 5_000).catch(() => {
      /* the port's onDisconnect handler deals with dropped links */
    });
  } else {
    client.ensureConnected();
  }
}, 10_000);
