/**
 * Permission Configuration view (PRODUCT.md §55, 2026-09-15).
 *
 * Shared by the Firefox sidebar and the Thunderbird pane/space: every tool
 * the add-ons provide is approval-gated, and this view lets the user see
 * each tool's persistent state and set it to one of:
 *
 *   Ask             prompt the user on every call (default)
 *   Deny            refuse the tool without asking
 *   Always approve  allow the tool without asking
 *
 * The data comes from the host (x-pi-browser/permissions|set|clear) through
 * the app-specific `api` callbacks; this module is pure DOM.
 *
 * Rendered inside each app's settings overlay (#settings-body container).
 */
import {
  PERMISSION_TOOL_GROUP_LABELS,
  PERMISSION_TOOL_GROUPS,
  applicationDisplayName,
  type PermissionConfigResult,
  type PermissionConfigTool,
  type PermissionToolState,
} from "@pi-browser/protocol";

/** App-specific bridge to the host's permission configuration. */
export interface PermissionSettingsApi {
  getConfig(): Promise<PermissionConfigResult>;
  setTool(tool: string, state: PermissionToolState): Promise<void>;
  clear(tool?: string): Promise<void>;
}

/** The three states, in row order, with their button labels. */
const STATES: readonly { state: PermissionToolState; label: string }[] = [
  { state: "ask", label: "Ask" },
  { state: "deny", label: "Deny" },
  { state: "allow", label: "Always approve" },
];

interface RowState {
  tool: PermissionConfigTool;
  buttons: Map<PermissionToolState, HTMLButtonElement>;
}

/**
 * Mount the Configuration view into `container`. Returns an unmount
 * function. The view fetches its initial state on mount and re-fetches
 * after every change, so the host is always the source of truth.
 */
export function mountPermissionSettings(
  container: HTMLElement,
  api: PermissionSettingsApi,
): () => void {
  container.textContent = "";

  const root = document.createElement("div");
  root.className = "perm-settings";

  const intro = document.createElement("p");
  intro.className = "ps-intro";
  intro.textContent =
    "Pi asks for your approval before every tool call. Set each tool to Ask (prompt every time), " +
    "Deny (never run without asking), or Always approve (never ask). States are stored on the Pi host and shared by all connected apps.";
  root.append(intro);

  const status = document.createElement("div");
  status.className = "ps-status";
  root.append(status);

  const list = document.createElement("div");
  list.className = "ps-list";
  root.append(list);

  const footer = document.createElement("div");
  footer.className = "ps-footer";
  const clearAll = document.createElement("button");
  clearAll.className = "ps-clear-all";
  clearAll.textContent = "Reset all to Ask";
  clearAll.title = "Set every tool back to asking for approval";
  footer.append(clearAll);
  root.append(footer);

  container.append(root);
  const rows = new Map<string, RowState>();
  let busy = false;

  function setStatus(text: string, kind: "ok" | "err" = "ok"): void {
    status.textContent = text;
    status.className = `ps-status ${kind}`;
  }

  function renderGroups(config: PermissionConfigResult): void {
    list.textContent = "";
    rows.clear();
    const byGroup = new Map<string, PermissionConfigTool[]>();
    for (const tool of config.tools) {
      const arr = byGroup.get(tool.group) ?? [];
      arr.push(tool);
      byGroup.set(tool.group, arr);
    }
    for (const group of PERMISSION_TOOL_GROUPS) {
      const tools = byGroup.get(group);
      if (!tools || tools.length === 0) continue;
      const heading = document.createElement("h4");
      heading.className = "ps-group";
      heading.textContent = PERMISSION_TOOL_GROUP_LABELS[group];
      list.append(heading);
      for (const tool of tools) list.append(renderRow(tool));
    }
  }

  function renderRow(tool: PermissionConfigTool): HTMLElement {
    const row = document.createElement("div");
    row.className = `ps-row ps-row-${tool.managedBy || tool.note ? "static" : tool.state}`;

    const name = document.createElement("span");
    name.className = "ps-name";
    name.textContent = tool.name;

    if (tool.managedBy) {
      // App-owned grant (browser_evaluate): informational only.
      const badge = document.createElement("span");
      badge.className = "ps-managed";
      badge.textContent = `managed by ${applicationDisplayName(tool.managedBy)}`;
      row.append(name, badge);
    } else if (tool.note) {
      const note = document.createElement("span");
      note.className = "ps-note";
      note.textContent = tool.note;
      row.append(name, note);
    } else {
      const seg = document.createElement("div");
      seg.className = "ps-seg";
      seg.setAttribute("role", "radiogroup");
      seg.setAttribute("aria-label", `Permission for ${tool.name}`);
      const buttons = new Map<PermissionToolState, HTMLButtonElement>();
      for (const { state, label } of STATES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `ps-seg-btn ps-seg-${state}`;
        btn.textContent = label;
        btn.title = {
          ask: "Prompt for approval on every call",
          deny: "Refuse this tool without asking",
          allow: "Allow this tool without asking",
        }[state];
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", state === tool.state ? "true" : "false");
        if (state === tool.state) btn.classList.add("active");
        btn.addEventListener("click", () => {
          if (state !== tool.state) void onChange(tool, state, buttons);
        });
        seg.append(btn);
        buttons.set(state, btn);
      }
      row.append(seg, name);
      rows.set(tool.name, { tool, buttons });
    }

    const desc = document.createElement("div");
    desc.className = "ps-desc";
    desc.textContent = tool.description;
    row.append(desc);
    return row;
  }

  async function onChange(tool: PermissionConfigTool, state: PermissionToolState, buttons: Map<PermissionToolState, HTMLButtonElement>): Promise<void> {
    if (busy) return;
    busy = true;
    for (const btn of buttons.values()) btn.disabled = true;
    try {
      await api.setTool(tool.name, state);
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "change failed", "err");
      for (const btn of buttons.values()) btn.disabled = false;
    } finally {
      busy = false;
    }
  }

  async function refresh(): Promise<void> {
    try {
      const config = await api.getConfig();
      renderGroups(config);
      setStatus("");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "failed to load permissions", "err");
    }
  }

  clearAll.addEventListener("click", () => {
    if (busy) return;
    if (!window.confirm("Reset ALL tool permissions to Ask? Deny and Always approve states will be cleared.")) return;
    void (async () => {
      busy = true;
      clearAll.disabled = true;
      try {
        await api.clear();
        setStatus("All permissions reset to Ask.");
        await refresh();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "clear failed", "err");
      } finally {
        busy = false;
        clearAll.disabled = false;
      }
    })();
  });

  void refresh();

  return () => {
    container.textContent = "";
  };
}
