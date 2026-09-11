/**
 * Background event page (PRODUCT.md §13–15, §20–24).
 *
 * Owns exactly one Native Messaging port, the ACP client, session
 * presentation state, tab bindings, and the browser tool implementations.
 * All sidebar and content-script traffic routes through here.
 */
import {
  AGENT_METHODS,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  X_PI_BROWSER,
  type SessionInfo,
  type SessionNotification,
  type SessionUpdate,
} from "@pi-browser/protocol";
import { AcpClient, notifyHost, type HostStatus } from "./acp-client.js";
import { SessionStore } from "./session-store.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { McpServer, type ControlHandler } from "./mcp-server.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const store = new SessionStore();
const dispatcher = new ToolDispatcher(store);

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

// ---------------------------------------------------------------------------
// Sidebar bridge
// ---------------------------------------------------------------------------

interface UiState {
  status: HostStatus;
  activeSessionId?: string;
  sessions: ReturnType<SessionStore["snapshot"]>["sessions"];
  lastSessionId?: string;
}

function pushState(): void {
  const state: UiState = {
    status: hostStatus,
    ...(activeSessionId ? { activeSessionId } : {}),
    sessions: store.snapshot().sessions,
    ...(store.lastSession ? { lastSessionId: store.lastSession } : {}),
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
  try {
    const res = await client.request<{ sessionId: string; configOptions?: unknown }>(
      AGENT_METHODS.session_new,
      { cwd, mcpServers },
    );
    sessionId = res.sessionId;
    configOptions = res.configOptions;
  } catch (err) {
    decl.discard();
    throw err;
  }
  decl.resolve(sessionId);
  store.upsertCreated(sessionId, cwd, configOptions as never);
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

const client = new AcpClient({
  onSessionUpdate(params: SessionNotification) {
    pushSessionUpdate(params.sessionId, params.update);
    // Keep streaming state consistent even if a response was missed.
  },
  onToolCall: (params) => dispatcher.handleToolCall(params),
  onMcpConnect: (params) => mcpServer.handleConnect(params),
  onMcpMessage: (params) => mcpServer.handleMessage(params),
  onMcpDisconnect: (params) => mcpServer.handleDisconnect(params),
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
    hostStatus = { state: "disconnected", detail: err instanceof Error ? err.message : String(err) };
    pushState();
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
  const sessionId = store.sessionForTab(tabId);
  if (!sessionId) return;
  store.unbind(sessionId);
  notifyHost(client, { sessionId, event: "tab_closed", data: { tabId } });
  pushState();
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const navigated = changeInfo.status === "loading" || typeof changeInfo.url === "string";
  if (!navigated) return;
  const sessionId = store.sessionForTab(tabId);
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
      store.bind(sessionId, { tabId: tab.id, windowId: tab.windowId ?? 0, tabTitle: tab.title });
      pushState();
      return {};
    }
    case "unbind": {
      const sessionId = String(payload.sessionId);
      store.unbind(sessionId);
      pushState();
      return {};
    }
    case "open_bound_tab": {
      const sessionId = String(payload.sessionId);
      const binding = store.getBinding(sessionId);
      if (!binding) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_NOT_BOUND, "session has no bound tab");
      await browser.tabs.update(binding.tabId, { active: true });
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
  pushState();
  client.start();
})();

// Keep the MV3 event page alive: Firefox unloads idle event pages, which
// would silently drop the Native Messaging port (and with it the session).
// A periodic liveness ping doubles as the x-pi-browser/ping probe.
setInterval(() => {
  if (client.connected && hostStatus.state === "connected") {
    client.request(X_PI_BROWSER.ping, {}, 5_000).catch(() => {
      /* the port's onDisconnect handler deals with dropped links */
    });
  }
}, 25_000);
