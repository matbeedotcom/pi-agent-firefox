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
  isContactsTool,
  isMailTool,
  isMailMutationTool,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  X_PI_BROWSER,
  type PermissionClearResult,
  type PermissionConfigResult,
  type PermissionSetResult,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
  type SessionNotification,
  type SessionUpdate,
} from "@pi-browser/protocol";
import { AcpClient, fetchPiTheme, SessionStore, type HostStatus, type PiTheme } from "@pi-browser/webext";
import { dispatchMailTool, type MailToolContext } from "./mail-dispatcher.js";
import { dispatchComposeTool } from "./compose-dispatcher.js";
import { dispatchMutationTool } from "./mutation-dispatcher.js";
import { dispatchContactsTool } from "./contacts-dispatcher.js";

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

/** Active browser theme snapshot (browser.theme); undefined when unavailable. */
let theme: PiTheme | undefined;

// ---------------------------------------------------------------------------
// Permission prompts (sensitive tools require explicit user approval)
// ---------------------------------------------------------------------------

/**
 * Pending permission requests, keyed by the tool call id. When the host asks
 * for permission (session/request_permission) before running an approval-
 * gated mail tool, we push the prompt to the Pi Space AND every open Pi pane
 * and block here until the user answers (or the timer auto-cancels). The
 * user's click is the live approval that authorizes the LLM's access to the
 * given mail API / data.
 */
interface PendingPermission {
  resolve: (optionId: string | "cancelled") => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingPermissions = new Map<string, PendingPermission>();

/** Match the host's PERMISSION_TIMEOUT_MS (120s) with a small buffer. */
const PERMISSION_PROMPT_TIMEOUT_MS = 125_000;

function pushPermissionRequest(request: RequestPermissionRequest): void {
  broadcastUi({ type: "pi/permission_request", request });
}

/** Resolve a pending permission prompt (from the space/pane or a timeout). */
function resolvePermission(permId: string, optionId: string | "cancelled"): void {
  const pending = pendingPermissions.get(permId);
  if (!pending) {
    // The event page reloaded (map wiped) or the prompt already resolved:
    // the click is lost. Log it — a silent no-op here hides the
    // "I clicked Allow and nothing happened" class of stall.
    console.warn(`[pi-thunderbird] resolvePermission: no pending prompt for ${permId}, option=${optionId}`);
    return;
  }
  clearTimeout(pending.timer);
  pendingPermissions.delete(permId);
  pending.resolve(optionId);
}

/**
 * Ask the user to approve/deny a tool call. Blocks until the Space or a pane
 * answers or the prompt times out (auto-cancel → the host surfaces a denial).
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
    pendingPermissions.set(permId, { resolve, timer });
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
      await browser.piPane.registerSpaceButton(SPACE_NAME);
      return spaceId;
    }
    const space = await browser.spaces.create(
      SPACE_NAME,
      { url: SPACE_URL(), linkHandler: "balanced" },
      { title: "Pi Agent" },
    );
    spaceId = space.id;
    await browser.piPane.registerSpaceButton(SPACE_NAME);
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
    // Capabilities: T2 read-only mail + attachments, T3 draft-first compose
    // (no send), T4 mail organization (mailModify: mark read/tag/archive/move —
    // no delete), T6 contacts (read-only). plan §18, §28, §39, §41.
    capabilities: ["mail", "attachments", "compose", "mailModify", "contacts"],
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
        // Long searches stream batches over x-pi-browser/tool_update while the
        // original request stays pending. The sequence is per toolCallId and
        // strictly increasing; the host validates and maps each update. The
        // callback only reports results of the already-approved call — it
        // never authorizes anything.
        let updateSeq = 0;
        const context: MailToolContext | undefined = params.toolCallId
          ? {
              sessionId: params.sessionId,
              toolCallId: params.toolCallId,
              onUpdate: (update) => {
                updateSeq += 1;
                client.update({
                  sessionId: params.sessionId,
                  toolCallId: params.toolCallId!,
                  tool: "mail_search",
                  sequence: updateSeq,
                  update,
                });
              },
            }
          : undefined;
        const result = await dispatchMailTool(params.tool, params.arguments, context);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      if (isComposeTool(params.tool)) {
        const result = await dispatchComposeTool(params.tool, params.arguments);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      if (isMailMutationTool(params.tool)) {
        const result = await dispatchMutationTool(params.tool, params.arguments);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      if (isContactsTool(params.tool)) {
        const result = await dispatchContactsTool(params.tool, params.arguments);
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
    // Approval-gated mail tools: push the prompt to the Space and panes and
    // block until the user answers (or the timeout auto-cancels).
    onRequestPermission: (request) => requestPermissionFromUser(request),
    // Cross-app heads-up: a tool's approval prompt is showing in ANOTHER app
    // (e.g. the browser). Point the user there; we do not answer it.
    onPermissionPrompted: (params) => {
      broadcastUi({ type: "pi/permission_prompted", params });
    },
    // A peer app (browser) connected/disconnected: refresh the union in our
    // status copy and re-push state so the Space and panes can update their
    // "capabilities:" line.
    onCapabilitiesChanged: (params) => {
      if (hostStatus.state === "connected") {
        hostStatus = { ...hostStatus, capabilities: params.capabilities };
      }
      pushState();
    },
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
  theme?: PiTheme;
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
    ...(theme ? { theme } : {}),
  };
}

/**
 * Broadcast a UI message to the Pi Space (runtime.sendMessage) AND every
 * open Pi pane (its runtime Port). The Space's sendMessage rejects when the
 * page isn't open — expected, not an error.
 */
function broadcastUi(message: Record<string, unknown>): void {
  browser.runtime.sendMessage(message).catch(() => {
    /* space page not open */
  });
  postToPanes(message);
}

function pushState(): void {
  broadcastUi({ type: "pi/state", state: currentUiState() });
}

function pushSessionUpdate(sessionId: string, update: SessionUpdate): void {
  broadcastUi({ type: "pi/session_update", sessionId, update });
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
  const res = await client.request<{
    sessionId: string;
    configOptions?: unknown;
    _meta?: { piBrowser?: { workspace?: string } };
  }>(
    AGENT_METHODS.session_new,
    // No mcpServers: the add-on declares no MCP server. The host uses the
    // legacy transport; the mail tools are still registered because the client
    // advertises the "mail"/"attachments" capabilities in its hello.
    { cwd },
  );
  const sessionId = res.sessionId;
  // The agent may provision a per-task workspace as the session cwd (when the
  // requested cwd was neutral). Record the real cwd so the UI shows where the
  // model's files land.
  const effectiveCwd = res._meta?.piBrowser?.workspace ?? cwd;
  store.upsertCreated(sessionId, effectiveCwd, res.configOptions as never);
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
  if (msg.type === "pi/permission_response") {
    const permId = String((msg as { permId?: unknown }).permId ?? "");
    const optionId = String((msg as { optionId?: unknown }).optionId ?? "cancelled");
    resolvePermission(permId, optionId);
    sendResponse({ ok: true });
    return;
  }
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
  tool?: string;
  state?: string;
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
        ...(theme ? { theme } : {}),
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
    // Permission Configuration page (PRODUCT.md §55): the host is the
    // source of truth for the per-tool "always allow" state.
    case "permission_config": {
      return client.request<PermissionConfigResult>(X_PI_BROWSER.permissions, {}, 10_000);
    }
    case "permission_set": {
      const state = payload.state === "allow" || payload.state === "deny" || payload.state === "ask" ? payload.state : "ask";
      return client.request<PermissionSetResult>(
        X_PI_BROWSER.permission_set,
        { tool: String(payload.tool ?? ""), state },
        10_000,
      );
    }
    case "permission_clear": {
      return client.request<PermissionClearResult>(
        X_PI_BROWSER.permission_clear,
        payload.tool ? { tool: String(payload.tool) } : {},
        10_000,
      );
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

    if (msg.type === "pi/permission_response") {
      // The pane's permission modal answers the pending prompt.
      const permId = String((msg as { permId?: unknown }).permId ?? "");
      const optionId = String((msg as { optionId?: unknown }).optionId ?? "cancelled");
      resolvePermission(permId, optionId);
      return;
    }

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
// Startup
// ---------------------------------------------------------------------------

void (async () => {
  await store.hydrate();
  await ensurePiSpace();
  // Read the active browser theme so the Space and panes render with it;
  // re-read on theme change and re-push state (UIs apply theme per state).
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
