/**
 * Thunderbird background event page (THUNDERBIRD-PLAN.md §5, §36).
 *
 * Owns exactly one Native Messaging port, the ACP client, and the session
 * presentation state — the same core as the Firefox background, shared via
 * @pi-browser/webext. The Thunderbird-specific duties are:
 *
 *   - owning the **Pi Space** (created via browser.spaces.create at startup,
 *     which loads the space/ page that is the chat UI)
 *   - declaring the Thunderbird application identity + capabilities in the
 *     pi.agent.hello handshake
 *   - dispatching read-only mail tools (T2) over the legacy x-pi-browser/tool
 *     transport to the mail-dispatcher, which wraps Thunderbird's WebExtension
 *     mail APIs.
 *
 * The add-on is a Pi chat interface (session list, new/resume, prompt,
 * streaming, cancel) plus the read-only mail surface: the user selects an
 * email and asks "Summarize this email." Compose (T3) builds on the same
 * action bridge.
 */
import {
  AGENT_METHODS,
  isComposeTool,
  isMailTool,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  X_PI_BROWSER,
  type SessionInfo,
  type SessionNotification,
  type SessionUpdate,
} from "@pi-browser/protocol";
import { AcpClient, SessionStore, type HostStatus } from "@pi-browser/webext";
import { dispatchMailTool } from "./mail-dispatcher.js";
import { dispatchComposeTool } from "./compose-dispatcher.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const store = new SessionStore("piThunderbirdState");

let hostStatus: HostStatus = { state: "connecting" };
let activeSessionId: string | undefined;
let initialized = false;
let bootstrapInFlight = false;

/** The Pi Space's integer id (assigned by spaces.create at startup). */
let spaceId: number | undefined;

// ---------------------------------------------------------------------------
// Pi Space (THUNDERBIRD-PLAN.md §5)
// ---------------------------------------------------------------------------

const SPACE_NAME = "Pi";
const SPACE_URL = () => browser.runtime.getURL("space/index.html");

/**
 * Ensure the Pi Space exists and is registered in the spaces toolbar.
 *
 * Space names are unique per extension and spaces.create throws when the name
 * already exists, so we query first. This is idempotent across event-page
 * reloads and Thunderbird restarts (spaces persist per extension). The space's
 * tab loads the space/ WebExtension page — the full chat UI.
 */
async function ensurePiSpace(): Promise<number | undefined> {
  try {
    const existing = await browser.spaces.query({ name: SPACE_NAME, isSelfOwned: true });
    const found = existing.find((s) => s.name === SPACE_NAME);
    if (found) {
      spaceId = found.id;
      return spaceId;
    }
    const space = await browser.spaces.create(
      SPACE_NAME,
      { url: SPACE_URL(), linkHandler: "balanced" },
      { title: "Pi Agent" },
    );
    spaceId = space.id;
    return spaceId;
  } catch (err) {
    console.error("[pi-thunderbird] ensurePiSpace failed", err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// ACP client
// ---------------------------------------------------------------------------

const client = new AcpClient(
  {
    clientName: "pi-thunderbird",
    application: "thunderbird",
    // T2: read-only mail + attachments. T3 adds "compose" (draft-first, no send):
    // plan §18, §28. No send / compose-send / messagesModify* permissions.
    capabilities: ["mail", "attachments", "compose"],
  },
  {
    onSessionUpdate(params: SessionNotification) {
      pushSessionUpdate(params.sessionId, params.update);
    },
    // Read-only mail tools arrive over the legacy x-pi-browser/tool transport.
    // Dispatch the known mail tools; reject anything else with a structured
    // error (no browser or compose tools are served in T2).
    onToolCall: async (params) => {
      if (isMailTool(params.tool)) {
        const result = await dispatchMailTool(params.tool, params.arguments);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      if (isComposeTool(params.tool)) {
        const result = await dispatchComposeTool(params.tool, params.arguments);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND,
        `Thunderbird does not serve tool: ${params.tool}`,
      );
    },
    onMcpConnect: () =>
      Promise.reject(
        new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, "Thunderbird declares no MCP server (mail tools use the legacy transport)"),
      ),
    onMcpMessage: () =>
      Promise.reject(
        new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_UNAVAILABLE, "Thunderbird declares no MCP server (mail tools use the legacy transport)"),
      ),
    onMcpDisconnect: async () => {
      /* nothing to release */
    },
    // No sensitive tools in T1; deny any permission request defensively.
    onRequestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
    onStatus(status: HostStatus) {
      hostStatus = status;
      pushState();
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
  },
);

// ---------------------------------------------------------------------------
// UI bridge (space page)
// ---------------------------------------------------------------------------

interface UiState {
  status: HostStatus;
  activeSessionId?: string;
  sessions: ReturnType<SessionStore["snapshot"]>["sessions"];
  lastSessionId?: string;
  spaceId?: number;
}

/**
 * Pi pane Ports — the piPane Experiment mounts a native 4th-column <browser>
 * that hosts our pane/ page (a WebExtension view). That page opens a runtime
 * Port named "pi-pane" and shares the SAME state/update/action protocol as the
 * Space, but per-tab and streaming. The Experiment owns no Pi logic; it only
 * owns the native pane, so Thunderbird-version breakage stays isolated there.
 */
const panePorts = new Map<number, browser.runtime.Port>();

function postToPanes(message: Record<string, unknown>): void {
  for (const port of panePorts.values()) {
    try {
      port.postMessage(message);
    } catch {
      /* port torn down */
    }
  }
}

function currentUiState(): UiState {
  return {
    status: hostStatus,
    ...(activeSessionId ? { activeSessionId } : {}),
    sessions: store.snapshot().sessions,
    ...(store.lastSession ? { lastSessionId: store.lastSession } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
  };
}

function pushState(): void {
  const state = currentUiState();
  browser.runtime
    .sendMessage({ type: "pi/state", state })
    .catch(() => {
      /* space page not open */
    });
  postToPanes({ type: "pi/state", state });
}

function pushSessionUpdate(sessionId: string, update: SessionUpdate): void {
  browser.runtime
    .sendMessage({ type: "pi/session_update", sessionId, update })
    .catch(() => {
      /* space page not open */
    });
  postToPanes({ type: "pi/session_update", sessionId, update });
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
    console.warn("[pi-thunderbird] session/list failed", err);
  }
}

async function createSession(cwd: string): Promise<string> {
  const res = await client.request<{ sessionId: string; configOptions?: unknown }>(
    AGENT_METHODS.session_new,
    // No mcpServers: the add-on declares no MCP server. The host uses the
    // legacy transport; the mail tools are still registered because the client
    // advertises the "mail"/"attachments" capabilities in its hello.
    { cwd },
  );
  const sessionId = res.sessionId;
  store.upsertCreated(sessionId, cwd, res.configOptions as never);
  store.setLastSession(sessionId);
  activeSessionId = sessionId;
  pushState();
  return sessionId;
}

async function openExistingSession(sessionId: string, cwd: string, load: boolean): Promise<void> {
  const method = load ? AGENT_METHODS.session_load : AGENT_METHODS.session_resume;
  const res = await client.request<{ configOptions?: unknown }>(method, {
    sessionId,
    cwd,
  });
  const view = store.get(sessionId);
  if (view) view.configOptions = res.configOptions as never;
  if (load) store.markLoaded(sessionId);
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
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  if (!client.connected) return; // port dropped during boot; reconnect cycle retries
  try {
    await client.initialize();
    initialized = true;
  } catch (err) {
    console.error("[pi-thunderbird] initialize failed", err);
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
      console.warn("[pi-thunderbird] resuming last session failed", err);
    }
  }
  pushState();
}

// ---------------------------------------------------------------------------
// Space page actions
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as {
    type?: string;
    action?: string;
    payload?: Record<string, unknown>;
  };
  if (msg.type === "pi/ensure_connected") {
    // Onboarding: the space's "Check again now" button. Idempotent no-op when
    // already connected; otherwise attempts the connect immediately.
    client.ensureConnected();
    sendResponse({ ok: true, connected: client.connected });
    return;
  }
  if (msg.type !== "pi/action") return;
  void handleAction(msg.action ?? "", (msg.payload ?? {}) as never)
    .then((result) => sendResponse({ ok: true, ...(result !== undefined ? { result } : {}) }))
    .catch((err) => {
      const data =
        err instanceof PiBrowserProtocolError
          ? { piBrowserError: err.code, message: err.message }
          : { message: String(err) };
      sendResponse({ ok: false, error: data });
    });
  return true; // async response
});

interface ActionPayload {
  cwd?: string;
  sessionId?: string;
  text?: string;
  configId?: string;
  value?: unknown;
}

async function handleAction(action: string, payload: ActionPayload): Promise<unknown> {
  switch (action) {
    case "get_state": {
      return {
        status: hostStatus,
        ...(activeSessionId ? { activeSessionId } : {}),
        sessions: store.snapshot().sessions,
        ...(store.lastSession ? { lastSessionId: store.lastSession } : {}),
        ...(spaceId !== undefined ? { spaceId } : {}),
      };
    }
    case "new_session": {
      if (!client.connected) {
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.NATIVE_HOST_NOT_INSTALLED, "not connected to native host");
      }
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
    case "open_space": {
      if (spaceId === undefined) {
        // Space not created yet (startup race); try to ensure it now.
        await ensurePiSpace();
      }
      if (spaceId === undefined) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "Pi Space not available");
      await browser.spaces.open(spaceId);
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

// ---------------------------------------------------------------------------
// Pi pane: runtime.connect ports (see §5). The pane/ page opens a Port named
// "pi-pane"; we track it per tab and route its actions through handleAction,
// reusing the exact same handlers as the Space. The pane is a compact,
// message-inline chat; the full Space remains the expanded view.
// ---------------------------------------------------------------------------

browser.runtime.onConnect.addListener((port: browser.runtime.Port) => {
  if (port.name !== "pi-pane") return;
  let tabId: number | undefined;
  try {
    tabId = port.sender?.tab?.id;
  } catch {
    /* not from a tab */
  }

  port.onMessage.addListener((raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return;
    const msg = raw as {
      type?: string;
      tabId?: number;
      action?: string;
      payload?: Record<string, unknown>;
      requestId?: number;
    };

    if (msg.type === "pane.ready") {
      // The pane reports its own tabId (from its URL query); prefer that.
      tabId = typeof msg.tabId === "number" ? msg.tabId : tabId;
      if (tabId !== undefined) panePorts.set(tabId, port);
      try {
        port.postMessage({ type: "pi/state", state: currentUiState() });
      } catch {
        /* port already gone */
      }
      return;
    }

    if (msg.type !== "pane/action") return;
    const requestId = msg.requestId;
    void handleAction(msg.action ?? "", (msg.payload ?? {}) as never)
      .then((result) => {
        try {
          port.postMessage({
            type: "pane/action_result",
            requestId,
            ok: true,
            ...(result !== undefined ? { result } : {}),
          });
        } catch {
          /* port closed */
        }
      })
      .catch((err) => {
        const data =
          err instanceof PiBrowserProtocolError
            ? { piBrowserError: err.code, message: err.message }
            : { message: String(err) };
        try {
          port.postMessage({ type: "pane/action_result", requestId, ok: false, error: data });
        } catch {
          /* port closed */
        }
      });
  });

  port.onDisconnect.addListener(() => {
    for (const [id, p] of panePorts) {
      if (p === port) {
        panePorts.delete(id);
        break;
      }
    }
  });
});

function processCwdLikeFallback(): string {
  // The add-on has no cwd of its own; the space supplies one. Only reached when
  // the user hits "create" with an empty field.
  return "/";
}

// ---------------------------------------------------------------------------
// Pi side pane (Experiment API) — toolbar button toggles it beside the message
// ---------------------------------------------------------------------------
// The `browser.action` toolbar button toggles the native Pi pane on the active
// mail tab. Unlike the Pi Space (which is a full view that hides the mail), the
// pane sits beside the message so the user keeps the email in view. The pane
// hosts the same shared space/ UI, so sessions and ACP state are unchanged.

const piPaneAvailable = typeof browser.piPane !== "undefined";
if (!piPaneAvailable) {
  console.warn("[pi-thunderbird] browser.piPane unavailable (Experiment API not loaded — is the add-on privileged/temporary?)");
}

browser.action.onClicked.addListener(async () => {
  if (!piPaneAvailable) {
    console.warn("[pi-thunderbird] browser.piPane unavailable — Experiment API not loaded");
    return;
  }
  // Find the active mail tab's WebExtension tab id (needs the `tabs` permission).
  let tabId: number | undefined;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch (err) {
    console.warn("[pi-thunderbird] browser.tabs.query failed (missing 'tabs' permission?)", err);
    return;
  }
  if (tabId === undefined) {
    console.warn("[pi-thunderbird] no active tab");
    return;
  }
  try {
    const st = await browser.piPane.toggle(tabId);
    console.info(`[pi-thunderbird] piPane.toggle(${tabId}) -> open=${st.open}`);
  } catch (err) {
    console.warn(`[pi-thunderbird] piPane.toggle(${tabId}) failed`, err);
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

void (async () => {
  await store.hydrate();
  await ensurePiSpace();
  pushState();
  client.start();
})();

// Keep the MV3 event page alive and keep the link healthy (mirrors the
// Firefox background). Connected: periodic liveness ping. Disconnected:
// ensureConnected() auto-detects a host installed after startup.
setInterval(() => {
  if (client.connected && hostStatus.state === "connected") {
    client.request(X_PI_BROWSER.ping, {}, 5_000).catch(() => {
      /* the port's onDisconnect handler deals with dropped links */
    });
  } else {
    client.ensureConnected();
  }
}, 10_000);
