/**
 * Pi pane (THUNDERBIRD-PLAN.md §5).
 *
 * A compact, message-inline Pi chat rendered in a native 4th column beside the
 * message pane — the piPane Experiment mounts this page in a real WebExtension
 * <browser>, so it has the full `browser.*` API. It is the SAME chat as the Pi
 * Space (same transcript model, same ACP session/update rendering) but:
 *   - transported over a per-tab runtime Port ("pi-pane") instead of the Space's
 *     broadcast runtime.sendMessage — ideal for streaming, and scoped to this tab, and
 *   - laid out as a single narrow column (top status, a session dropdown, and the
 *     conversation) since it sits beside the email at ~320px.
 *
 * The background is the single source of truth; this page keeps the in-memory
 * transcript and renders ACP session/update streams pushed over the Port.
 */
import { applicationDisplayName, permissionPromptDescription } from "@pi-browser/protocol";
import { applyPiTheme, MarkdownView, renderMarkdownInto, type PiTheme } from "@pi-browser/webext";
import type { SessionUpdate, ToolCallUpdate } from "@pi-browser/protocol";

interface StatusInfo {
  state: string;
  detail?: string;
  agentInfo?: { name?: string; version?: string };
}

interface SessionUi {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  streaming: boolean;
  loaded: boolean;
}

interface UiState {
  status: StatusInfo;
  activeSessionId?: string;
  sessions: SessionUi[];
  lastSessionId?: string;
  /** Active browser theme (LWT colors); undefined when the API is unavailable. */
  theme?: PiTheme;
}

// ---------------------------------------------------------------------------
// Transcript model (same as the Space)
// ---------------------------------------------------------------------------

type Block =
  | { id: number; kind: "user" | "assistant" | "thought"; text: string }
  | { id: number; kind: "tool"; toolCallId: string; title: string; status: string; text: string; input?: unknown };

let blockCounter = 0;
const transcripts = new Map<string, Block[]>();

function blocksFor(sessionId: string): Block[] {
  let blocks = transcripts.get(sessionId);
  if (!blocks) {
    blocks = [];
    transcripts.set(sessionId, blocks);
  }
  return blocks;
}

function addBlock(sessionId: string, block: Block): void {
  block.id = ++blockCounter;
  blocksFor(sessionId).push(block);
}

// ---------------------------------------------------------------------------
// Background bridge (runtime Port, name "pi-pane")
// ---------------------------------------------------------------------------

let port: browser.runtime.Port | null = null;
let reqCounter = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reconnectAttempts = 0;

function connect(): void {
  try {
    port = browser.runtime.connect({ name: "pi-pane" });
  } catch (err) {
    console.warn("[pi-pane] connect failed", err);
    scheduleReconnect();
    return;
  }
  const p = port;
  const params = new URLSearchParams(location.search);
  const rawTab = Number(params.get("tabId"));
  const tabId = Number.isFinite(rawTab) && rawTab !== 0 ? rawTab : undefined;
  try {
    p.postMessage({ type: "pane.ready", tabId });
  } catch (err) {
    console.warn("[pi-pane] ready post failed", err);
  }
  p.onMessage.addListener(onPortMessage);
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    for (const { reject } of pending.values()) reject(new Error("disconnected from background"));
    pending.clear();
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  // The background event page stays alive while a Port is open, so a drop usually
  // means the background reloaded (or the tab reloaded). Retry with a short
  // backoff; the pane re-delivers its full state via the next pane.ready.
  reconnectAttempts += 1;
  if (reconnectAttempts > 10) {
    flash("disconnected from Pi background");
    return;
  }
  const delay = Math.min(500 * reconnectAttempts, 4000);
  setTimeout(() => {
    if (port === null) connect();
  }, delay);
}

function onPortMessage(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw as {
    type?: string;
    state?: UiState;
    sessionId?: string;
    update?: SessionUpdate;
    request?: PermissionRequestUi;
    params?: { sessionId: string; toolCallId: string; tool: string; application: string };
    requestId?: number;
    ok?: boolean;
    result?: unknown;
    error?: { message?: string };
  };

  if (msg.type === "pane/action_result") {
    if (typeof msg.requestId === "number" && pending.has(msg.requestId)) {
      const entry = pending.get(msg.requestId)!;
      pending.delete(msg.requestId);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error?.message ?? "action failed"));
    }
    return;
  }

  if (msg.type === "pi/state" && msg.state) {
    reconnectAttempts = 0;
    uiState = msg.state;
    activeSessionId = msg.state.activeSessionId;
    applyPiTheme(msg.state.theme);
    renderAll();
  } else if (msg.type === "pi/session_update" && msg.sessionId && msg.update) {
    applySessionUpdate(msg.sessionId, msg.update);
  } else if (msg.type === "pi/permission_request" && msg.request) {
    showPermissionPrompt(msg.request);
  } else if (msg.type === "pi/permission_prompted" && msg.params) {
    const { sessionId, toolCallId, tool, application } = msg.params;
    remotePrompts.set(`${sessionId}:${toolCallId}`, { tool, application });
    renderRemotePromptBanner();
  }
}

// ---------------------------------------------------------------------------
// Tool approval prompt (sensitive mail tools)
// ---------------------------------------------------------------------------

interface PermissionOptionUi {
  optionId: string;
  name: string;
  kind: string;
}
interface PermissionRequestUi {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string };
  options: PermissionOptionUi[];
  _meta?: { piBrowser?: { tool?: string } };
}

function answerPermission(permId: string, optionId: string): void {
  // Reply over the same Port the background pushed the prompt on.
  if (port) {
    try {
      port.postMessage({ type: "pi/permission_response", permId, optionId });
    } catch {
      /* port torn down; the background's timeout auto-cancels */
    }
  }
  hidePermissionPrompt();
}

function showPermissionPrompt(request: PermissionRequestUi): void {
  const overlay = $("perm-overlay");
  const desc = $("perm-desc");
  const toolEl = $("perm-tool");
  const optionsWrap = $("perm-options");
  const permId = request.toolCall.toolCallId;
  // Guard against a stale page (no modal markup): answer "cancelled" so the
  // host never hangs, rather than crashing the message handler.
  if (!overlay || !desc || !optionsWrap) {
    if (port) {
      try {
        port.postMessage({ type: "pi/permission_response", permId, optionId: "cancelled" });
      } catch {
        /* port torn down */
      }
    }
    return;
  }
  const tool = request._meta?.piBrowser?.tool ?? request.toolCall.title ?? "an action";
  desc.textContent = permissionPromptDescription(tool);
  if (toolEl) toolEl.textContent = tool;

  optionsWrap.textContent = "";
  renderPermissionOptions(optionsWrap, request.options, permId, (optionId) =>
    answerPermission(permId, optionId),
  );
  overlay.classList.remove("hidden");
}

/**
 * Render the approval buttons in the canonical order. Branches on the
 * optionId (the host's identity for each option) with a kind fallback so
 * unknown future options still get a sensible style.
 */
function renderPermissionOptions(
  wrap: HTMLElement,
  options: PermissionOptionUi[],
  permId: string,
  answer: (optionId: string) => void,
): void {
  const order = ["allow_once", "allow_session", "allow_always", "reject_once"];
  const rank = (o: PermissionOptionUi): number => {
    const byId = order.indexOf(o.optionId);
    return byId !== -1 ? byId : order.indexOf(o.kind);
  };
  const sorted = [...options].sort((a, b) => rank(a) - rank(b));
  for (const opt of sorted) {
    const btn = document.createElement("button");
    btn.textContent = opt.name;
    switch (opt.optionId) {
      case "allow_once":
        btn.className = "perm-primary";
        break;
      case "allow_session":
        btn.className = "perm-session";
        break;
      case "allow_always":
        btn.className = "perm-always";
        break;
      case "reject_once":
        btn.className = "perm-reject";
        break;
      default:
        // Unknown option: style by kind (allow* → always style, else reject).
        btn.className = opt.kind.startsWith("allow") ? "perm-always" : "perm-reject";
    }
    btn.addEventListener("click", () => answer(opt.optionId));
    wrap.append(btn);
  }
}

function hidePermissionPrompt(): void {
  const overlay = $("perm-overlay");
  if (overlay) overlay.classList.add("hidden");
}

/**
 * Send a command to the background over the Port and await its result.
 * Quick control actions (get_state, new_session, select, cancel, refresh) resolve
 * in well under a second; `prompt` only resolves when the whole turn finishes,
 * so it gets a long timeout to avoid a spurious "timed out" on long turns (the
 * streaming output still arrives via the separate session_update pushes).
 */
function action<A>(name: string, payload?: Record<string, unknown>, timeoutMs = 30_000): Promise<A> {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error("not connected to background"));
      return;
    }
    const id = ++reqCounter;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    try {
      port.postMessage({
        type: "pane/action",
        action: name,
        ...(payload !== undefined ? { payload } : {}),
        requestId: id,
      });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("action timed out: " + name));
      }
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// ACP session/update -> transcript
// ---------------------------------------------------------------------------

let activeSessionId: string | undefined;

function applySessionUpdate(sessionId: string, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const text = chunkText(update);
      if (!text) break;
      const blocks = blocksFor(sessionId);
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "user") last.text += text;
      else addBlock(sessionId, { id: 0, kind: "user", text });
      break;
    }
    case "agent_message_chunk": {
      const text = chunkText(update);
      if (!text) break;
      const blocks = blocksFor(sessionId);
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "assistant") last.text += text;
      else addBlock(sessionId, { id: 0, kind: "assistant", text });
      break;
    }
    case "agent_thought_chunk": {
      const text = chunkText(update);
      if (!text) break;
      const blocks = blocksFor(sessionId);
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "thought") last.text += text;
      else addBlock(sessionId, { id: 0, kind: "thought", text });
      break;
    }
    case "tool_call": {
      addBlock(sessionId, {
        id: 0,
        kind: "tool",
        toolCallId: update.toolCallId,
        title: update.title ?? "tool",
        status: update.status ?? "in_progress",
        text: "",
        input: update.rawInput,
      });
      break;
    }
    case "tool_call_update": {
      const blocks = blocksFor(sessionId);
      const block = blocks.find((b) => b.kind === "tool" && b.toolCallId === (update as ToolCallUpdate).toolCallId);
      if (!block || block.kind !== "tool") break;
      if (update.status) block.status = update.status;
      if (update.title) block.title = update.title;
      const text = toolUpdateText(update);
      if (text) block.text = text;
      // The tool finished (approved or denied elsewhere): the remote
      // approval banner for it is stale.
      if (update.status && isTerminalToolStatus(update.status)) {
        clearRemotePrompt(sessionId, (update as ToolCallUpdate).toolCallId);
      }
      break;
    }
    default:
      break;
  }
  if (activeSessionId === sessionId) renderConversation();
  renderRemotePromptBanner();
}

// ---------------------------------------------------------------------------
// Remote approval banner (cross-app, plan §29)
//
// When a tool in THIS session needs approval in ANOTHER app (e.g. the user
// is in the mail pane and the prompt shows in the browser), the host notifies
// us (pi/permission_prompted). We can't answer it here — we just draw the
// user's attention to where the prompt is.
// ---------------------------------------------------------------------------

interface RemotePrompt {
  tool: string;
  application: string;
}
const remotePrompts = new Map<string, RemotePrompt>(); // key: `${sessionId}:${toolCallId}`

function isTerminalToolStatus(status: string): boolean {
  return status !== "pending" && status !== "in_progress";
}

function clearRemotePrompt(sessionId: string, toolCallId: string): void {
  if (remotePrompts.delete(`${sessionId}:${toolCallId}`)) renderRemotePromptBanner();
}

function renderRemotePromptBanner(): void {
  const el = $("remote-prompt-banner");
  if (!el) return;
  const pending = new Map<string, RemotePrompt>();
  if (activeSessionId) {
    for (const [key, rp] of remotePrompts) {
      if (key.startsWith(`${activeSessionId}:`)) pending.set(key, rp);
    }
  }
  if (pending.size === 0) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  const first = pending.values().next().value as RemotePrompt;
  el.textContent = "";
  const icon = document.createElement("span");
  icon.className = "rp-icon";
  icon.textContent = "🔔";
  const msg = document.createElement("span");
  const label = applicationDisplayName(first.application as never);
  const count = pending.size > 1 ? ` (+${pending.size - 1} more)` : "";
  msg.append(`${first.tool} is waiting for your approval in `);
  const b = document.createElement("b");
  b.textContent = label;
  msg.append(b, ` — the prompt will appear in your ${first.application === "thunderbird" ? "mail" : "browser"} client${count}.`);
  el.append(icon, msg);
  el.classList.remove("hidden");
}

function chunkText(update: SessionUpdate): string {
  const chunk = update as { content?: { type?: string; text?: string } };
  return chunk.content?.type === "text" ? (chunk.content.text ?? "") : "";
}

function toolUpdateText(update: SessionUpdate): string {
  const u = update as ToolCallUpdate;
  if (!Array.isArray(u.content)) return "";
  const parts: string[] = [];
  for (const c of u.content as Array<{ type?: string; content?: { type?: string; text?: string } }>) {
    if (c?.type === "content" && c.content?.type === "text" && typeof c.content.text === "string") {
      parts.push(c.content.text);
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let uiState: UiState = { status: { state: "connecting" }, sessions: [] };

function renderAll(): void {
  renderStatus();
  renderSessions();
  renderCaps();
  renderActive();
  renderConversation();
  renderRemotePromptBanner();
}

function renderStatus(): void {
  const el = $<HTMLDivElement>("status");
  const s = uiState.status;
  el.classList.remove("ok", "err");
  switch (s.state) {
    case "connected": {
      el.classList.add("ok");
      const agent = s.agentInfo ? `${s.agentInfo.name ?? "agent"} ${s.agentInfo.version ?? ""}`.trim() : "connected";
      el.textContent = `Pi · ${agent}`;
      el.title = "Connected to the Pi native host.";
      break;
    }
    case "connecting":
      el.textContent = "connecting to native host…";
      el.title = "";
      break;
    case "not_installed":
      el.classList.add("err");
      el.textContent = "native host not detected";
      el.title = "No ACP server found. Install the Pi package and run /pi-browser install thunderbird; this pane reconnects automatically.";
      break;
    default:
      el.classList.add("err");
      el.textContent = "disconnected — reconnecting…";
      el.title = s.detail ?? "";
  }
}

function renderSessions(): void {
  const sel = $<HTMLSelectElement>("sessions");
  const row = $<HTMLDivElement>("session-row");
  sel.textContent = "";
  if (uiState.sessions.length === 0) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  for (const s of uiState.sessions) {
    const opt = document.createElement("option");
    opt.value = s.sessionId;
    opt.textContent = (s.title || s.sessionId.slice(0, 12)) + (s.streaming ? " ●" : "");
    if (s.sessionId === activeSessionId) opt.selected = true;
    sel.append(opt);
  }
  if (!activeSessionId && uiState.sessions.length > 0) sel.value = uiState.sessions[0].sessionId;
}

function renderCaps(): void {
  const el = $<HTMLDivElement>("caps");
  el.textContent = "capabilities: chat · read-only mail";
  el.title =
    "Pi can read the mail you select or view (context, messages, bodies, search, attachments, accounts, folders). " +
    "It cannot send, move, or delete. Compose (drafts) arrives in a later phase.";
}

function renderActive(): void {
  const session = uiState.sessions.find((s) => s.sessionId === activeSessionId);
  const pane = $<HTMLDivElement>("active-pane");
  const empty = $<HTMLDivElement>("empty");
  const composer = $<HTMLDivElement>("composer");
  const connected = uiState.status.state === "connected";

  if (!session) {
    pane.classList.add("hidden");
    composer.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = connected
      ? "No session selected. Create one with “+ New”."
      : "Waiting for Pi to connect…";
    return;
  }

  empty.classList.add("hidden");
  pane.classList.remove("hidden");
  composer.classList.remove("hidden");
  const meta = $<HTMLDivElement>("meta-row");
  meta.textContent = `cwd: ${session.cwd}${session.updatedAt ? ` · ${new Date(session.updatedAt).toLocaleString()}` : ""}`;
  updateComposerState(session);
}

function updateComposerState(session: SessionUi): void {
  $<HTMLButtonElement>("stop").classList.toggle("hidden", !session.streaming);
  $<HTMLButtonElement>("send").disabled = session.streaming || uiState.status.state !== "connected";
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(text: string): void {
  const status = $<HTMLDivElement>("status");
  status.textContent = text;
  status.classList.add("err");
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => renderStatus(), 4000);
}

// ---------------------------------------------------------------------------
// Conversation rendering (streaming-markdown, incremental DOM)
//
// Text blocks (user/assistant/thought) stream in: each block owns one
// streaming-markdown parser, and parser_write only appends new DOM nodes, so
// already-streamed text stays selectable and finished blocks are never
// re-rendered. Tool blocks re-render their body when the (replaced) text
// changes.
// ---------------------------------------------------------------------------

interface BlockDom {
  wrap: HTMLElement;
  /** Live markdown view for text blocks; undefined for tool blocks. */
  md?: MarkdownView;
  /** Chars of block.text already written into `md`. */
  written?: number;
  /** Tool blocks: head spans + body, patched when title/status/text change. */
  name?: HTMLSpanElement;
  status?: HTMLSpanElement;
  body?: HTMLDivElement;
  toolText?: string;
  toolStatus?: string;
  toolTitle?: string;
}

const blockDoms = new Map<number, BlockDom>();
/** Session the conversation DOM currently shows; a change forces a rebuild. */
let domSession: string | undefined;

function toolStatusClass(status: string): string {
  return status === "completed" ? "done" : status === "failed" ? "failed" : "";
}

function buildBlockDom(block: Block, conv: HTMLElement): BlockDom {
  const wrap = document.createElement("div");
  let dom: BlockDom;
  if (block.kind === "tool") {
    wrap.className = "msg tool";
    const head = document.createElement("div");
    head.className = "tool-head";
    const name = document.createElement("span");
    name.textContent = block.title;
    const status = document.createElement("span");
    status.className = `tool-status ${toolStatusClass(block.status)}`;
    status.textContent = block.status;
    head.append(name, status);
    const body = document.createElement("div");
    body.classList.add("muted");
    if (block.text) renderMarkdownInto(body, block.text);
    wrap.append(head, body);
    dom = { wrap, name, status, body, toolText: block.text, toolStatus: block.status, toolTitle: block.title };
  } else {
    wrap.className = `msg ${block.kind}`;
    const md = new MarkdownView(wrap);
    md.write(block.text);
    dom = { wrap, md, written: block.text.length };
  }
  conv.append(wrap);
  blockDoms.set(block.id, dom);
  return dom;
}

function renderConversation(): void {
  const conv = $<HTMLDivElement>("conversation");
  const blocks = activeSessionId ? blocksFor(activeSessionId) : [];
  if (domSession !== activeSessionId) {
    // Page load or session switch: rebuild from scratch.
    domSession = activeSessionId;
    blockDoms.clear();
    conv.textContent = "";
    for (const block of blocks) buildBlockDom(block, conv);
  } else {
    // Same session: append new blocks, patch changed tool blocks, stream new
    // text into the tail. Chunks only ever append, so each block is written
    // exactly once and finished blocks' DOM is left alone.
    let prev: BlockDom | undefined;
    for (const block of blocks) {
      let dom = blockDoms.get(block.id);
      if (!dom) {
        // A new block started: the previous text block is final.
        prev?.md?.end();
        dom = buildBlockDom(block, conv);
      } else if (block.kind === "tool") {
        if (dom.toolTitle !== block.title && dom.name) {
          dom.name.textContent = block.title;
          dom.toolTitle = block.title;
        }
        if (dom.toolStatus !== block.status && dom.status) {
          dom.status.className = `tool-status ${toolStatusClass(block.status)}`;
          dom.status.textContent = block.status;
          dom.toolStatus = block.status;
        }
        if (dom.toolText !== block.text && dom.body) {
          dom.body.textContent = "";
          if (block.text) renderMarkdownInto(dom.body, block.text);
          dom.toolText = block.text;
        }
      } else if (dom.md && block.text.length > (dom.written ?? 0)) {
        dom.md.write(block.text.slice(dom.written ?? 0));
        dom.written = block.text.length;
      }
      prev = dom;
    }
  }
  // When the turn is not streaming, the last text block is final: flush its
  // pending tokens (e.g. a stray ** at the end of the stream).
  const streaming = uiState.sessions.some((s) => s.sessionId === activeSessionId && s.streaming);
  if (!streaming) {
    const last = blocks[blocks.length - 1];
    if (last) blockDoms.get(last.id)?.md?.end();
  }
  conv.scrollTop = conv.scrollHeight;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$<HTMLButtonElement>("new-session").addEventListener("click", () => {
  const panel = $<HTMLDivElement>("new-panel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    const input = $<HTMLInputElement>("cwd-input");
    const active = uiState.sessions.find((s) => s.sessionId === activeSessionId);
    input.value = active?.cwd ?? "";
    input.focus();
  }
});

$<HTMLButtonElement>("cwd-cancel").addEventListener("click", () => {
  $<HTMLDivElement>("new-panel").classList.add("hidden");
});

function submitNewSession(): void {
  const cwd = $<HTMLInputElement>("cwd-input").value.trim();
  void action<{ sessionId: string }>("new_session", { cwd })
    .then(() => {
      $<HTMLDivElement>("new-panel").classList.add("hidden");
    })
    .catch((err) => flash(`create failed: ${err.message}`));
}

$<HTMLButtonElement>("cwd-create").addEventListener("click", submitNewSession);
$<HTMLInputElement>("cwd-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitNewSession();
  if (e.key === "Escape") $<HTMLDivElement>("new-panel").classList.add("hidden");
});

$<HTMLButtonElement>("refresh").addEventListener("click", () => {
  void action("refresh_sessions").catch(() => {});
});

$<HTMLSelectElement>("sessions").addEventListener("change", () => {
  const id = $<HTMLSelectElement>("sessions").value;
  if (!id) return;
  void action("select_session", { sessionId: id }).catch((err) => flash(`select failed: ${err.message}`));
});

$<HTMLButtonElement>("send").addEventListener("click", () => {
  void sendPrompt();
});

$<HTMLButtonElement>("stop").addEventListener("click", () => {
  if (!activeSessionId) return;
  void action("cancel", { sessionId: activeSessionId }).catch(() => {});
});

$<HTMLTextAreaElement>("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendPrompt();
  }
});

async function sendPrompt(): Promise<void> {
  const input = $<HTMLTextAreaElement>("prompt");
  const text = input.value.trim();
  if (!text || !activeSessionId) return;
  const session = uiState.sessions.find((s) => s.sessionId === activeSessionId);
  if (session?.streaming) return;
  input.value = "";
  addBlock(activeSessionId, { id: 0, kind: "user", text });
  renderConversation();
  await action("prompt", { sessionId: activeSessionId, text }, 1_800_000).catch((err) => flash(`send failed: ${err.message}`));
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

connect();
renderAll();
