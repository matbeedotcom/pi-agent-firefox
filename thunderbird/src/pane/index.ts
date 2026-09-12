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
    renderAll();
  } else if (msg.type === "pi/session_update" && msg.sessionId && msg.update) {
    applySessionUpdate(msg.sessionId, msg.update);
  }
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
      break;
    }
    default:
      break;
  }
  if (activeSessionId === sessionId) renderConversation();
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
// Conversation rendering (markdown-lite, same as the Space)
// ---------------------------------------------------------------------------

function renderConversation(): void {
  const conv = $<HTMLDivElement>("conversation");
  const blocks = activeSessionId ? blocksFor(activeSessionId) : [];
  conv.textContent = "";
  for (const block of blocks) {
    const div = document.createElement("div");
    if (block.kind === "tool") {
      div.className = "msg tool";
      const head = document.createElement("div");
      head.className = "tool-head";
      const name = document.createElement("span");
      name.textContent = block.title;
      const status = document.createElement("span");
      status.className = `tool-status ${block.status === "completed" ? "done" : block.status === "failed" ? "failed" : ""}`;
      status.textContent = block.status;
      head.append(name, status);
      div.append(head);
      const body = renderMarkdown(block.text);
      body.classList.add("muted");
      div.append(body);
    } else {
      div.className = `msg ${block.kind}`;
      div.append(renderMarkdown(block.text));
    }
    conv.append(div);
  }
  conv.scrollTop = conv.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text: string): HTMLElement {
  const wrapper = document.createElement("div");
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      const pre = document.createElement("pre");
      const codeEl = document.createElement("code");
      codeEl.textContent = code.replace(/\n$/, "");
      pre.append(codeEl);
      wrapper.append(pre);
      return;
    }
    wrapper.append(renderInline(part));
  });
  return wrapper;
}

function renderInline(text: string): HTMLElement {
  const span = document.createElement("span");
  const lines = escapeHtml(text).split("\n");
  lines.forEach((line, idx) => {
    if (idx > 0) span.append(document.createElement("br"));
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const h = document.createElement(`h${Math.min(heading[1].length + 1, 5)}`);
      h.append(fragmentFromInline(heading[2]));
      span.append(h);
      return;
    }
    span.append(fragmentFromInline(line));
  });
  return span;
}

function fragmentFromInline(line: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) frag.append(line.slice(last, m.index));
    if (m[1]) {
      const code = document.createElement("code");
      code.className = "code";
      code.textContent = m[1].slice(1, -1);
      frag.append(code);
    } else if (m[2]) {
      const b = document.createElement("b");
      b.append(m[2].slice(2, -2));
      frag.append(b);
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) frag.append(line.slice(last));
  return frag;
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
