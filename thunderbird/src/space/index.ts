/**
 * Pi Space view (THUNDERBIRD-PLAN.md §5, §36).
 *
 * Plain DOM, no framework. The background is the single source of truth for
 * connection state and sessions; this page keeps the in-memory transcript and
 * renders ACP session/update streams. Same model as the Firefox sidebar, laid
 * out as a full Space tab (session rail + conversation pane).
 */
import { applicationDisplayName, permissionPromptDescription } from "@pi-browser/protocol";
import { applyPiTheme, type PiTheme } from "@pi-browser/webext";
import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionUpdate,
  ToolCallUpdate,
} from "@pi-browser/protocol";

interface StatusInfo {
  state: string;
  detail?: string;
  agentInfo?: { name?: string; version?: string };
  piBrowserMeta?: { version: string; protocolVersion: number; browserToolVersion: number };
}

interface SessionUi {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  streaming: boolean;
  loaded: boolean;
  configOptions?: SessionConfigOption[];
}

interface UiState {
  status: StatusInfo;
  activeSessionId?: string;
  sessions: SessionUi[];
  lastSessionId?: string;
  spaceId?: number;
  /** Active browser theme (LWT colors); undefined when the API is unavailable. */
  theme?: PiTheme;
}

// ---------------------------------------------------------------------------
// Transcript model
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
// Background bridge
// ---------------------------------------------------------------------------

function action<A>(name: string, payload?: Record<string, unknown>): Promise<A> {
  return new Promise((resolve, reject) => {
    browser.runtime
      .sendMessage({ type: "pi/action", action: name, ...(payload !== undefined ? { payload } : {}) })
      .then((resp) => {
        if (resp && resp.ok === false) {
          reject(new Error(resp.error?.message ?? "action failed"));
        } else {
          resolve((resp?.result ?? resp) as A);
        }
      })
      .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
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
// is in the mail client and the prompt shows in the browser), the host
// notifies us (pi/permission_prompted). We can't answer it here — we just
// draw the user's attention to where the prompt is.
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
  renderOnboarding();
}

let onboardDismissed = false;
let onboardSeen = false;

function renderOnboarding(): void {
  const el = $<HTMLDivElement>("onboard-overlay");
  const s = uiState.status.state;
  if (s === "not_installed") onboardSeen = true;
  if (s === "connected") onboardSeen = false;
  const show = !onboardDismissed && onboardSeen && (s === "not_installed" || s === "connecting" || s === "disconnected");
  el.classList.toggle("hidden", !show);
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
      break;
    }
    case "connecting":
      el.textContent = "connecting to native host…";
      break;
    case "not_installed":
      el.classList.add("err");
      el.textContent = "native host not detected";
      el.title =
        "Auto-detecting: the space connects on its own as soon as the host is " +
        "installed (no reload needed).\n\n" + (s.detail ?? "");
      break;
    default:
      el.classList.add("err");
      el.textContent = "disconnected — reconnecting…";
      el.title = s.detail ?? "";
  }
}

function renderSessions(): void {
  const ul = $<HTMLUListElement>("sessions");
  ul.textContent = "";
  for (const s of uiState.sessions) {
    const li = document.createElement("li");
    if (s.sessionId === activeSessionId) li.classList.add("active");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = s.title || s.sessionId.slice(0, 8);
    const cwd = document.createElement("span");
    cwd.className = "cwd";
    cwd.textContent = s.cwd;
    li.append(title, cwd);
    if (s.streaming) {
      const dot = document.createElement("span");
      dot.className = "streaming";
      dot.textContent = "●";
      li.append(dot);
    }
    li.addEventListener("click", () => {
      void action("select_session", { sessionId: s.sessionId }).catch((err) => flash(`select failed: ${err.message}`));
    });
    ul.append(li);
  }
}

function renderCaps(): void {
  const el = $<HTMLDivElement>("caps");
  // T2: chat + read-only mail. Compose (draft-first, no send) arrives in T3.
  // Select an email and ask "Summarize this email." — the agent uses the
  // read-only mail tools against what you have selected/displayed.
  el.textContent = "capabilities: chat · read-only mail";
  el.title =
    "Pi can read the mail you select or view (context, messages, bodies, search, attachments, accounts, folders). " +
    "It cannot send, move, or delete. Compose (drafts) arrives in a later phase.";
}

function renderActive(): void {
  const session = uiState.sessions.find((s) => s.sessionId === activeSessionId);
  const pane = $<HTMLDivElement>("active-pane");
  const empty = $<HTMLDivElement>("empty");
  if (!session) {
    pane.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  pane.classList.remove("hidden");

  const meta = $<HTMLDivElement>("meta-row");
  meta.textContent = `cwd: ${session.cwd}${session.updatedAt ? ` · ${new Date(session.updatedAt).toLocaleString()}` : ""}`;

  renderConfigRow(session);
  updateComposerState(session);
}

function renderConfigRow(session: SessionUi): void {
  const row = $<HTMLDivElement>("config-row");
  row.textContent = "";
  const options = session.configOptions ?? [];
  if (options.length === 0) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  for (const opt of options) {
    if (opt.type !== "select") continue;
    const selectOpt = opt as SessionConfigSelect & { type: "select"; id: string; name: string };
    const label = document.createElement("label");
    label.textContent = `${selectOpt.name}: `;
    const select = document.createElement("select");
    const values = flattenOptions(selectOpt.options);
    for (const v of values) {
      const optEl = document.createElement("option");
      optEl.value = v.value;
      optEl.textContent = v.name;
      select.append(optEl);
    }
    select.value = String(selectOpt.currentValue ?? "");
    select.addEventListener("change", () => {
      void action("set_config", { sessionId: session.sessionId, configId: selectOpt.id, value: select.value }).catch((err) =>
        flash(`config change failed: ${err.message}`),
      );
    });
    row.append(label, select);
  }
}

function flattenOptions(
  options: Array<{ value: string; name: string } | { name: string; options: Array<{ value: string; name: string }> }>,
): Array<{ value: string; name: string }> {
  const out: Array<{ value: string; name: string }> = [];
  for (const o of options) {
    if ("options" in o) out.push(...o.options);
    else out.push(o);
  }
  return out;
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
// Conversation rendering (markdown-lite)
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
  // No HTML escaping here: every value below is inserted as a text node
  // (append(string)/textContent), which renders characters verbatim and is
  // safe from HTML injection. Escaping would show entities like "&gt;" raw.
  const lines = text.split("\n");
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

browser.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as {
    type?: string;
    state?: UiState;
    sessionId?: string;
    update?: SessionUpdate;
    request?: PermissionRequestUi;
    params?: { sessionId: string; toolCallId: string; tool: string; application: string };
  };
  if (msg.type === "pi/state" && msg.state) {
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
});

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
  browser.runtime.sendMessage({ type: "pi/permission_response", permId, optionId }).catch(() => {});
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
    browser.runtime
      .sendMessage({ type: "pi/permission_response", permId, optionId: "cancelled" })
      .catch(() => {});
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

$<HTMLButtonElement>("new-session").addEventListener("click", () => {
  $<HTMLDivElement>("new-panel").classList.toggle("hidden");
  if (!$<HTMLDivElement>("new-panel").classList.contains("hidden")) {
    const input = $<HTMLInputElement>("cwd-input");
    input.value = activeSessionId ? uiState.sessions.find((s) => s.sessionId === activeSessionId)?.cwd ?? "" : "";
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
$<HTMLButtonElement>("cwd-create").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitNewSession();
});
$<HTMLInputElement>("cwd-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitNewSession();
  if (e.key === "Escape") $<HTMLButtonElement>("cwd-cancel").click();
});

$<HTMLButtonElement>("refresh").addEventListener("click", () => {
  void action("refresh_sessions").catch(() => {});
});

$<HTMLButtonElement>("onboard-check").addEventListener("click", () => {
  browser.runtime
    .sendMessage({ type: "pi/ensure_connected" })
    .then((res: { connected?: boolean } | undefined) => {
      if (res?.connected) {
        void action<UiState>("get_state")
          .then((s) => {
            uiState = s;
            renderAll();
          })
          .catch(() => {});
      }
    })
    .catch(() => {});
});
$<HTMLButtonElement>("onboard-dismiss").addEventListener("click", () => {
  onboardDismissed = true;
  renderOnboarding();
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
  await action("prompt", { sessionId: activeSessionId, text }).catch((err) => flash(`send failed: ${err.message}`));
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

void (async () => {
  renderAll();
  try {
    const state = (await action<UiState>("get_state")) as UiState;
    uiState = state;
    activeSessionId = state.activeSessionId;
    applyPiTheme(state.theme);
    renderAll();
  } catch {
    // background not ready yet; state will arrive via push
  }
})();
