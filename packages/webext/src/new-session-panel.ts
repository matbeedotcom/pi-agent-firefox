/**
 * "New session" panel — shared by the Firefox sidebar and the Thunderbird
 * Space and pane (one implementation, three mounts).
 *
 * Working directory: defaults to a fresh per-task workspace under the host's
 * workspace root (~/.pi/workspaces, sent in initialize _meta.piBrowser
 * .workspaceRoot). Creating with an empty cwd is what tells the host to
 * provision one, so the default needs no path from the UI. Clicking the
 * directory switches to a text field for a project path, with a link back to
 * the default.
 *
 * Creating a session takes several seconds on a real setup (the host loads
 * the user's pi packages, extensions and MCP config — ~14 s on a first
 * start), so the panel shows progress the whole time: the button turns into
 * a spinner, a status line counts the seconds and explains the wait, and a
 * failure is reported inline (not a transient flash) with the button
 * re-enabled.
 *
 * Agent (openspec sidebar-acp-agents): when the host lists external ACP
 * agents (Claude Code, Codex, ...), an "Agent" selector comes first; pi is
 * the default, unavailable agents are disabled with their reason, and the
 * last choice is remembered per app. Older hosts: no selector, pi sessions.
 */
import { agentChoices } from "./agents.js";
import type { AgentsResult } from "@trusted-ua/protocol";

export interface NewSessionPanelApi {
  /** The host's workspace root, when known (older hosts don't send it). */
  workspaceRoot(): string | undefined;
  /** A project directory worth pre-filling when the user chooses to edit (e.g. the active session's cwd). */
  suggestedCwd?(): string | undefined;
  /**
   * Create the session. `cwd` "" = new workspace; `agent` is the chosen
   * agent id (undefined = pi). Rejects with an Error on failure.
   */
  create(cwd: string, agent?: string): Promise<void>;
  /** The agents the host offers (undefined: older host, no selector). */
  agents?(): Promise<AgentsResult | undefined>;
  /** The agent chosen last time in this app. */
  lastAgent?(): Promise<string | undefined>;
  /** Remember the chosen agent for next time. */
  rememberAgent?(agentId: string): void;
  /** Called after a successful create or a cancel, to hide the panel. */
  close(): void;
}

export interface NewSessionPanel {
  /** Reset to the default (new workspace) and focus the create button. */
  open(): void;
  /** True while a create request is in flight. */
  busy(): boolean;
}

/** Long-wait hint threshold (s): first sessions load the user's pi packages. */
const SLOW_HINT_AFTER_S = 8;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Absolute on POSIX (/x), Windows (C:\x, C:/x) or UNC (\\server\share). */
export function isAbsolutePath(p: string): boolean {
  return /^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\])/.test(p);
}

/** True when `dir` is the workspace root itself or inside it. */
function isUnder(dir: string, root: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  const d = norm(dir);
  const r = norm(root);
  return d === r || d.startsWith(`${r}/`) || d.startsWith(`${r}\\`);
}

export function mountNewSessionPanel(container: HTMLElement, api: NewSessionPanelApi): NewSessionPanel {
  container.textContent = "";
  container.classList.add("nsp");

  const agentRow = el("div", "nsp-agent-row");
  const agentLabel = el("label", "nsp-label", "Agent");
  const agentSelect = el("select", "nsp-agent");
  agentSelect.setAttribute("aria-label", "Agent");
  agentLabel.append(agentSelect);
  agentRow.append(agentLabel);
  agentRow.hidden = true;

  const label = el("div", "nsp-label", "Working directory");

  // Default view: the new workspace, click to edit.
  const cwdButton = el("button", "nsp-cwd");
  cwdButton.type = "button";
  cwdButton.title = "Click to use a different folder";
  const cwdMain = el("span", "nsp-cwd-main", "New workspace");
  const cwdPath = el("span", "nsp-cwd-path");
  const cwdEdit = el("span", "nsp-cwd-edit", "Edit");
  cwdButton.append(cwdMain, cwdPath, cwdEdit);

  // Edit view: a path field + back-to-default link.
  const editRow = el("div", "nsp-edit-row");
  const input = el("input", "nsp-input");
  input.type = "text";
  input.placeholder = "/path/to/project";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Working directory");
  const useWorkspace = el("button", "nsp-link", "Use a new workspace instead");
  useWorkspace.type = "button";
  editRow.append(input, useWorkspace);

  const actions = el("div", "nsp-actions");
  const createButton = el("button", "nsp-create");
  createButton.type = "button";
  const createLabel = el("span", "nsp-create-label", "Create session");
  const spinner = el("span", "nsp-spinner");
  spinner.setAttribute("aria-hidden", "true");
  createButton.append(spinner, createLabel);
  const cancelButton = el("button", "nsp-cancel secondary", "Cancel");
  cancelButton.type = "button";
  actions.append(createButton, cancelButton);

  const status = el("div", "nsp-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  container.append(agentRow, label, cwdButton, editRow, actions, status);

  let editing = false;
  let pending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Display names of the listed agents (status text). */
  let agentNames = new Map<string, string>();

  function chosenAgent(): string | undefined {
    if (agentRow.hidden) return undefined;
    return agentSelect.value && agentSelect.value !== "pi" ? agentSelect.value : undefined;
  }

  async function refreshAgents(): Promise<void> {
    if (!api.agents) return;
    let result: AgentsResult | undefined;
    let remembered: string | undefined;
    try {
      [result, remembered] = await Promise.all([api.agents(), api.lastAgent?.() ?? Promise.resolve(undefined)]);
    } catch {
      result = undefined;
    }
    if (pending) return;
    const model = agentChoices(result, remembered);
    agentNames = new Map((result?.agents ?? []).map((a) => [a.id, a.name]));
    agentSelect.textContent = "";
    for (const o of model.options) {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.label;
      opt.disabled = o.disabled;
      if (o.title) opt.title = o.title;
      agentSelect.append(opt);
    }
    agentSelect.value = model.selected;
    agentRow.hidden = !model.show;
  }

  function renderCwd(): void {
    const root = api.workspaceRoot();
    const sep = root && root.includes("\\") && !root.includes("/") ? "\\" : "/";
    cwdPath.textContent = root ? `${root.replace(/[\\/]+$/, "")}${sep}…` : "created by Pi for this task";
    cwdPath.title = root ? `A fresh folder is created under ${root}` : "";
    cwdButton.hidden = editing;
    editRow.hidden = !editing;
  }

  function setEditing(on: boolean): void {
    editing = on;
    if (on) {
      const root = api.workspaceRoot();
      const suggestion = api.suggestedCwd?.();
      // Pre-fill a real project folder; never another task's workspace.
      input.value = suggestion && !(root && isUnder(suggestion, root)) ? suggestion : "";
    }
    renderCwd();
    if (on) {
      input.focus();
      input.select();
    }
  }

  function setStatus(text: string, kind: "" | "err" = ""): void {
    status.textContent = text;
    status.classList.toggle("err", kind === "err");
  }

  function setPending(on: boolean): void {
    pending = on;
    container.classList.toggle("pending", on);
    createButton.disabled = on;
    cwdButton.disabled = on;
    input.disabled = on;
    useWorkspace.disabled = on;
    agentSelect.disabled = on;
    createLabel.textContent = on ? "Starting…" : "Create session";
    cancelButton.textContent = on ? "Hide" : "Cancel";
    cancelButton.title = on ? "Hide this panel; the session still opens when it is ready" : "";
    if (timer) clearInterval(timer);
    timer = undefined;
    if (on) {
      const t0 = Date.now();
      const agent = chosenAgent();
      const name = agent ? (agentNames.get(agent) ?? agent) : undefined;
      const tick = () => {
        const s = Math.floor((Date.now() - t0) / 1000);
        setStatus(
          name
            ? s < SLOW_HINT_AFTER_S
              ? `Starting a ${name} session… ${s} s`
              : `Starting a ${name} session… ${s} s — the first session starts ${name}, which can take a while.`
            : s < SLOW_HINT_AFTER_S
              ? `Starting a Pi session… ${s} s`
              : `Starting a Pi session… ${s} s — loading your Pi packages and extensions; the first session can take 15 s or more.`,
        );
      };
      tick();
      timer = setInterval(tick, 1000);
    }
  }

  async function submit(): Promise<void> {
    if (pending) return;
    const cwd = editing ? input.value.trim() : "";
    // The host resolves a relative cwd against its own process directory —
    // never what the user meant. Empty = new workspace.
    if (cwd && !isAbsolutePath(cwd)) {
      setStatus("Enter an absolute path (e.g. C:\\code\\project or /home/me/project), or use a new workspace.", "err");
      input.focus();
      return;
    }
    const agent = chosenAgent();
    setPending(true);
    try {
      await api.create(cwd, agent);
      if (!agentRow.hidden) api.rememberAgent?.(agentSelect.value || "pi");
      setPending(false);
      setStatus("");
      api.close();
    } catch (err) {
      setPending(false);
      const message = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
      setStatus(`Could not start the session: ${message}`, "err");
      createButton.focus();
    }
  }

  cwdButton.addEventListener("click", () => setEditing(true));
  useWorkspace.addEventListener("click", () => {
    setEditing(false);
    createButton.focus();
  });
  createButton.addEventListener("click", () => void submit());
  cancelButton.addEventListener("click", () => {
    if (!pending) setStatus("");
    api.close();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") cancelButton.click();
  });
  container.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target !== input) cancelButton.click();
  });

  renderCwd();
  void refreshAgents();

  return {
    open() {
      if (!pending) {
        setStatus("");
        setEditing(false);
        void refreshAgents();
      } else {
        renderCwd();
      }
      createButton.focus();
    },
    busy: () => pending,
  };
}
