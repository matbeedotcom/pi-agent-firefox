/**
 * Sidebar view (PRODUCT.md §13, §39).
 *
 * Plain DOM, no framework. The background is the single source of truth
 * for connection state, sessions, and bindings; the sidebar keeps the
 * in-memory transcript and renders ACP session/update streams.
 */
import { applicationDisplayName, permissionPromptDescription } from "@pi-browser/protocol";
import { grantEvaluationPermission } from "../page-evaluation-permission.js";
import { applyPiTheme, MarkdownView, renderMarkdownInto, type PiTheme } from "@pi-browser/webext";
import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionNotification,
  SessionUpdate,
  ToolCallUpdate,
} from "@pi-browser/protocol";

import { resultParts, type BrowserActivity, type ToolImage } from "../tool-activity.js";
import { createActivityCard, type ActivityCardData } from "./activity-card.js";

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
  binding?: { tabId: number; windowId: number; tabTitle?: string };
  configOptions?: SessionConfigOption[];
}

interface UiState {
  status: StatusInfo;
  recoveringSessionIds?: string[];
  activeSessionId?: string;
  sessions: SessionUi[];
  /** Active browser theme (LWT colors); undefined when the API is unavailable. */
  theme?: PiTheme;
  /** Still-pending permission prompts; the modal is re-derived from this. */
  permissionRequests?: PermissionRequestUi[];
}

// ---------------------------------------------------------------------------
// Transcript model
// ---------------------------------------------------------------------------

type Block =
  | { id: number; kind: "user" | "assistant" | "thought"; text: string }
  | { id: number; kind: "tool"; toolCallId: string; title: string; status: string; text: string; input?: unknown; images?: ToolImage[]; activities?: BrowserActivity[] };

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
        input: update.rawInput,
        ...resultParts(update.content),
      });
      break;
    }
    case "tool_call_update": {
      const blocks = blocksFor(sessionId);
      const block = blocks.find((b) => b.kind === "tool" && b.toolCallId === (update as ToolCallUpdate).toolCallId);
      if (!block || block.kind !== "tool") break;
      if (update.status) block.status = update.status;
      if (update.title) block.title = update.title;
      if (update.rawInput !== undefined) block.input = update.rawInput;
      if (update.content !== undefined) Object.assign(block, resultParts(update.content));
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
// is in the Firefox sidebar and the prompt shows in the mail client), the
// host notifies us (pi/permission_prompted). We can't answer it here — we
// just draw the user's attention to where the prompt is.
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

/** Last seen status.state (from pi/state) — used to detect a mid-turn drop. */
let prevStatusState: string | undefined;

/**
 * Mark orphaned tool blocks after a connection drop: a dead host never sends
 * the final tool_call_update, so "in_progress" would spin forever and the
 * conversation would look stuck until the user manually nudged.
 */
function markInterruptedToolBlocks(): void {
  let changed = false;
  for (const blocks of transcripts.values()) {
    for (const b of blocks) {
      if (b.kind === "tool" && (b.status === "pending" || b.status === "in_progress")) {
        b.status = "interrupted";
        if (!b.text) {
          b.text = "Interrupted — the native host connection dropped. Automatic recovery will check the page before continuing.";
        }
        changed = true;
      }
    }
  }
  if (changed) renderConversation();
}

/**
 * The permission prompt is re-derivable from state: the background carries
 * every still-pending prompt in each pi/state (the prompt is LOST if the
 * sidebar was closed when it arrived), so the modal syncs against that list
 * — show the newest pending prompt, hide the modal once its prompt has been
 * answered / timed out / cancelled.
 */
let activePermId: string | undefined;

function syncPermissionPrompt(requests: PermissionRequestUi[] | undefined): void {
  if (!requests || requests.length === 0) {
    if (activePermId !== undefined) {
      activePermId = undefined;
      hidePermissionPrompt();
    }
    return;
  }
  const req = requests[requests.length - 1];
  if (activePermId !== req.toolCall.toolCallId) showPermissionPrompt(req);
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let uiState: UiState = { status: { state: "connecting" }, sessions: [] };
let activeSessionId: string | undefined;

function renderAll(): void {
  renderStatus();
  renderSessions();
  renderActive();
  renderConversation();
  renderRemotePromptBanner();
  renderOnboarding();
}

// Onboarding screen ("no ACP server detected"). Dismissal is per sidebar
// open — it reappears the next time the sidebar opens while not_installed.
// Once not_installed has been seen in this page session, the screen stays
// up through the connecting/disconnected reconnect flicker until a real
// connection is established (or the user dismisses it).
let onboardDismissed = false;
let onboardSeen = false;

function renderOnboarding(): void {
  const el = $<HTMLDivElement>("onboard-overlay");
  const s = uiState.status.state;
  if (s === "not_installed") onboardSeen = true;
  if (s === "connected") onboardSeen = false;
  const show =
    !onboardDismissed &&
    onboardSeen &&
    (s === "not_installed" || s === "connecting" || s === "disconnected");
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
      el.title = s.piBrowserMeta
        ? `integration v${s.piBrowserMeta.version}, protocol v${s.piBrowserMeta.protocolVersion}, tools v${s.piBrowserMeta.browserToolVersion}`
        : "";
      break;
    }
    case "connecting":
      el.textContent = "connecting to native host…";
      break;
    case "not_installed":
      el.classList.add("err");
      el.textContent = "native host not detected — run /pi-browser install";
      el.title =
        "Auto-detecting: the add-on connects on its own as soon as the host " +
        "is installed (no reload needed).\n\n" + (s.detail ?? "");
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
  renderBindingRow(session);
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
    if ("options" in o) {
      out.push(...o.options);
    } else {
      out.push(o);
    }
  }
  return out;
}

function renderBindingRow(session: SessionUi): void {
  const row = $<HTMLDivElement>("binding-row");
  row.textContent = "";
  const title = document.createElement("span");
  title.className = "binding-title";
  if (session.binding) {
    title.textContent = `Bound tab: ${session.binding.tabTitle || `#${session.binding.tabId}`}`;
  } else {
    title.textContent = "No tab bound";
  }
  row.append(title);

  if (session.binding) {
    const open = document.createElement("button");
    open.textContent = "Open tab";
    open.className = "secondary";
    open.addEventListener("click", () => {
      void action("open_bound_tab", { sessionId: session.sessionId }).catch(() => {});
    });
    row.append(open);
    const unbind = document.createElement("button");
    unbind.textContent = "Unbind";
    unbind.className = "secondary";
    unbind.addEventListener("click", () => {
      void action("unbind", { sessionId: session.sessionId }).catch(() => {});
    });
    row.append(unbind);
  } else {
    const bind = document.createElement("button");
    bind.textContent = "Bind current tab";
    bind.addEventListener("click", () => {
      void action("bind_current_tab", { sessionId: session.sessionId }).catch((err) => flash(`bind failed: ${err.message}`));
    });
    row.append(bind);
  }
}

function updateComposerState(session: SessionUi): void {
  const recovering = uiState.recoveringSessionIds?.includes(session.sessionId) ?? false;
  $<HTMLButtonElement>("stop").classList.toggle("hidden", !session.streaming && !recovering);
  $<HTMLButtonElement>("send").disabled = session.streaming || uiState.status.state !== "connected";
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(text: string): void {
  const status = $<HTMLDivElement>("status");
  const prev = status.textContent;
  status.textContent = text;
  status.classList.add("err");
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => renderStatus(), 4000);
  void prev;
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
  updateActivity?: (data: ActivityCardData) => void;
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
  return status === "completed" ? "done" : status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "";
}

function buildBlockDom(block: Block, conv: HTMLElement): BlockDom {
  const wrap = document.createElement("div");
  let dom: BlockDom;
  if (block.kind === "tool") {
    const card = createActivityCard(block);
    dom = { wrap: card.wrap, updateActivity: card.update };
    conv.append(card.wrap);
    blockDoms.set(block.id, dom);
    return dom;
  }
  else {
    wrap.className = `msg ${block.kind}`;
    let content: HTMLElement = wrap;
    if (block.kind === "thought") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Reasoning";
      content = document.createElement("div");
      details.append(summary, content);
      wrap.append(details);
    }
    const md = new MarkdownView(content);
    md.write(block.text);
    dom = { wrap, md, written: block.text.length };
  }
  conv.append(wrap);
  blockDoms.set(block.id, dom);
  return dom;
}

function updateToolDom(block: Extract<Block, { kind: "tool" }>, dom: BlockDom): void {
  if (dom.updateActivity) {
    dom.updateActivity(block);
    return;
  }
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
}

function renderConversation(): void {
  const conv = $<HTMLDivElement>("conversation");
  const followTail = domSession !== activeSessionId || conv.scrollHeight - conv.scrollTop - conv.clientHeight < 48;
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
        updateToolDom(block, dom);
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
  if (followTail) conv.scrollTop = conv.scrollHeight;
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
    activity?: BrowserActivity;
    params?: { sessionId: string; toolCallId: string; tool: string; application: string };
  };
  if (msg.type === "pi/state" && msg.state) {
    const state = msg.state;
    // The connection dropped mid-turn (host exit, port EOF, event-page
    // reload): tool blocks left at "in_progress" will never receive a final
    // tool_call_update — mark them so the transcript tells the truth and the
    // user knows the turn is over and a nudge is safe.
    if (prevStatusState === "connected" && state.status.state !== "connected") {
      markInterruptedToolBlocks();
    }
    prevStatusState = state.status.state;
    uiState = state;
    activeSessionId = state.activeSessionId;
    applyPiTheme(state.theme);
    renderAll();
    syncPermissionPrompt(state.permissionRequests);
  } else if (msg.type === "pi/session_update" && msg.sessionId && msg.update) {
    applySessionUpdate(msg.sessionId, msg.update as SessionNotification["update"]);
  } else if (msg.type === "pi/browser_activity" && msg.sessionId && msg.activity) {
    applyBrowserActivity(msg.sessionId, msg.activity);
  } else if (msg.type === "pi/permission_request" && msg.request) {
    showPermissionPrompt(msg.request);
  } else if (msg.type === "pi/permission_prompted" && msg.params) {
    const { sessionId, toolCallId, tool, application } = msg.params;
    remotePrompts.set(`${sessionId}:${toolCallId}`, { tool, application });
    renderRemotePromptBanner();
  }
});

function applyBrowserActivity(sessionId: string, activity: BrowserActivity): void {
  const blocks = blocksFor(sessionId);
  const existing = blocks.find((b) => b.kind === "tool" && b.activities?.some((a) => a.id === activity.id));
  const parent = existing ?? [...blocks].reverse().find((b) => b.kind === "tool" && b.title === "javascript" && b.status === "in_progress");
  if (!parent || parent.kind !== "tool") return;
  const activities = parent.activities ??= [];
  const index = activities.findIndex((a) => a.id === activity.id);
  if (index < 0) activities.push(activity);
  else activities[index] = activity;
  if (activeSessionId === sessionId) renderConversation();
}

// ---------------------------------------------------------------------------
// Permission prompt (sensitive tools, §43)
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

function showPermissionPrompt(request: PermissionRequestUi): void {
  const overlay = $("perm-overlay");
  const desc = $("perm-desc");
  const optionsWrap = $("perm-options");
  const permId = request.toolCall.toolCallId;
  activePermId = permId;
  // Guard against a stale sidebar (no modal markup): answer "cancelled" so the
  // host never hangs, rather than crashing the message handler.
  if (!overlay || !desc || !optionsWrap) {
    browser.runtime.sendMessage({ type: "pi/permission_response", permId, optionId: "cancelled" }).catch(() => {});
    return;
  }
  const tool = request._meta?.piBrowser?.tool ?? request.toolCall.title ?? "an action";

  // Friendly per-tool description.
  desc.textContent = permissionPromptDescription(tool);
  $("perm-title").textContent = tool === "browser_evaluate" ? "Enable UI automation?" : "Allow this action?";

  optionsWrap.textContent = "";
  // Order: Allow once (primary), Allow for this session, Always allow, Deny.
  // Branch on the optionId (the host's identity for each option) with a kind
  // fallback so unknown future options still get a sensible style.
  const order = ["allow_once", "allow_session", "allow_always", "reject_once"];
  const rank = (o: PermissionOptionUi): number => {
    const byId = order.indexOf(o.optionId);
    return byId !== -1 ? byId : order.indexOf(o.kind);
  };
  const sorted = [...request.options].sort((a, b) => rank(a) - rank(b));
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
        btn.className = opt.kind.startsWith("allow") ? "perm-always" : "perm-reject";
    }
    btn.addEventListener("click", () => answerPermissionOption(tool, permId, opt));
    optionsWrap.append(btn);
  }
  overlay.classList.remove("hidden");
}

function answerPermissionOption(tool: string, permId: string, opt: PermissionOptionUi): void {
  const answer = (optionId: string) => {
    void browser.runtime.sendMessage({ type: "pi/permission_response", permId, optionId }).catch(() => {});
    if (activePermId === permId) {
      activePermId = undefined;
      hidePermissionPrompt();
    }
  };
  if (tool !== "browser_evaluate" || !opt.kind.startsWith("allow")) {
    answer(opt.optionId);
    return;
  }
  // Firefox requires the request to originate synchronously from this click.
  const granted = grantEvaluationPermission();
  $("perm-options").querySelectorAll("button").forEach((button) => { button.disabled = true; });
  void granted.then((allowed) => answer(allowed ? opt.optionId : "cancelled"))
    .catch(() => answer("cancelled"));
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

$<HTMLButtonElement>("cwd-create").addEventListener("click", () => {
  const cwd = $<HTMLInputElement>("cwd-input").value.trim();
  void action<{ sessionId: string }>("new_session", { cwd })
    .then(() => {
      $<HTMLDivElement>("new-panel").classList.add("hidden");
    })
    .catch((err) => flash(`create failed: ${err.message}`));
});

$<HTMLButtonElement>("cwd-create").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("cwd-create").click();
});
$<HTMLInputElement>("cwd-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("cwd-create").click();
  if (e.key === "Escape") $<HTMLButtonElement>("cwd-cancel").click();
});

$<HTMLButtonElement>("refresh").addEventListener("click", () => {
  void action("refresh_sessions").catch(() => {});
});

// Onboarding: "Check again now" asks the background for an immediate
// (idempotent) connect attempt; a status push then hides the screen if the
// host appeared. "Dismiss" hides it for this sidebar open.
$<HTMLButtonElement>("onboard-check").addEventListener("click", () => {
  browser.runtime
    .sendMessage({ type: "pi/ensure_connected" })
    .then((res: { connected?: boolean } | undefined) => {
      if (res?.connected) {
        // Fast path: refresh so the UI flips before the next status push.
        void action<UiState>("get_state").then((s) => {
          uiState = s;
          renderAll();
        }).catch(() => {});
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
    prevStatusState = state.status.state;
    applyPiTheme(state.theme);
    renderAll();
    syncPermissionPrompt(state.permissionRequests);
    // Rehydrate the transcript of the active session if needed.
    const active = state.sessions.find((s) => s.sessionId === activeSessionId);
    if (active) {
      // The background may already have the ACP session open (and therefore
      // mark it loaded), but this new sidebar has an empty transcript. Ask
      // for an explicit history replay so tool cards and images reappear.
      blocksFor(active.sessionId).length = 0;
      domSession = undefined;
      void action("load_session", { sessionId: active.sessionId }).catch(() => {});
    }
  } catch {
    // background not ready yet; state will arrive via push
  }
})();
