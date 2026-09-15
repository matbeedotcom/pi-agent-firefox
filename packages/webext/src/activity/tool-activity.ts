/** UI evidence from an executed browser operation (also used inside REPL cells). */
export interface BrowserActivity {
  id: string;
  title: string;
  status: string;
  input?: unknown;
  result?: unknown;
}

export interface ToolImage { data: string; mimeType: string }

export function resultParts(content: unknown): { text: string; images: ToolImage[] } {
  const text: string[] = [];
  const images: ToolImage[] = [];
  if (!Array.isArray(content)) return { text: "", images };
  for (const entry of content) {
    const c = entry?.type === "content" ? entry.content : entry;
    if (c?.type === "text" && typeof c.text === "string") text.push(c.text);
    if (c?.type === "image" && typeof c.data === "string" && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType)) {
      images.push({ data: c.data, mimeType: c.mimeType });
    }
  }
  return { text: text.join("\n"), images };
}

export function isVisualTool(title: string): boolean {
  return /^(browser_|mail_|contacts_|compose_|pi_)/.test(title) || title === "javascript" || title === "javascript_reset";
}

const labels: Record<string, [string, string]> = {
  browser_click: ["↖", "Click"], browser_click_at: ["↖", "Click"],
  browser_type: ["⌨", "Fill in text"], browser_press_key: ["⌨", "Press a key"],
  browser_screenshot: ["▧", "Capture the page"], browser_navigate: ["↗", "Open page"],
  browser_get_dom: ["◎", "Read page elements"], browser_get_accessibility_tree: ["◎", "Read page structure"],
  browser_get_page: ["◎", "Read the page"], browser_evaluate: ["◇", "Inspect the page"],
  browser_wait_for: ["◷", "Wait for the page"], browser_scroll: ["↓", "Scroll the page"],
  browser_type_focused: ["⌨", "Fill focused field"], browser_focus: ["◎", "Focus field"],
  browser_element_at: ["⌖", "Identify target"], browser_get_selection: ["❞", "Read selection"],
  browser_reload: ["↻", "Reload page"], browser_get_console: ["≡", "Read console"],
  browser_get_network: ["⇄", "Inspect requests"], browser_list_tabs: ["▤", "Browse tabs"],
  browser_open_tab: ["+", "Open tab"], browser_close_tab: ["×", "Close tab"],
  javascript: ["◇", "Work with the browser"], javascript_reset: ["↻", "Reset browser workspace"],
  mail_get_context: ["✉", "Read mail context"], mail_get_selected_messages: ["✉", "Read selected messages"],
  mail_get_displayed_messages: ["✉", "Read displayed messages"], mail_get_message: ["✉", "Read message"],
  mail_get_message_body: ["✉", "Read message body"], mail_search: ["⌕", "Search mail"],
  mail_list_attachments: ["◇", "Browse attachments"], mail_get_attachment: ["◇", "Read attachment"],
  mail_list_accounts: ["▤", "Browse accounts"], mail_list_folders: ["▤", "Browse folders"], mail_list_tags: ["#", "Browse tags"],
  mail_mark_read: ["✓", "Update read status"], mail_set_tags: ["#", "Update tags"],
  mail_archive: ["↓", "Archive messages"], mail_move: ["→", "Move messages"],
  contacts_search: ["⌕", "Find contacts"], contacts_get: ["◎", "Read contact"], contacts_list: ["◎", "Browse contacts"],
  compose_prepare_new: ["✎", "Prepare draft"], compose_prepare_reply: ["↩", "Prepare reply"],
  compose_prepare_forward: ["→", "Prepare forward"], compose_get: ["✎", "Read draft"],
  compose_update: ["✎", "Update draft"], compose_add_attachment: ["+", "Attach file"],
  pi_get_state: ["◎", "Read session state"], pi_new_session: ["+", "Create session"],
  pi_select_session: ["→", "Switch session"], pi_prompt: ["→", "Start task"], pi_cancel: ["■", "Stop task"],
  pi_close_session: ["×", "Close session"], pi_set_config_option: ["◇", "Update setting"],
  pi_bind_current_tab: ["⇄", "Connect tab"], pi_unbind_tab: ["⇄", "Disconnect tab"], pi_open_bound_tab: ["↗", "Show connected tab"],
};

export function activityLabel(title: string): [string, string] {
  return labels[title] ?? ["◎", title.replace(/^browser_/, "").replaceAll("_", " ")];
}

export function activityStatus(status: string): string {
  return ({ completed: "Done", failed: "Failed", interrupted: "Interrupted", pending: "Waiting", in_progress: "In progress" } as Record<string, string>)[status] ?? status;
}

/** A symbolic target preview; it does not pretend to be a page screenshot. */
export function targetPreview(title: string, input: unknown, text: string): { kind: string; label: string; detail: string } {
  const args = (input ?? {}) as Record<string, unknown>;
  let result: { clicked?: { text?: string; name?: string; role?: string }; typed?: { name?: string; role?: string }; chars?: number; url?: string } = {};
  try { result = JSON.parse(text) ?? {}; } catch { /* ordinary tool text */ }
  if (title === "browser_click" || title === "browser_click_at") {
    return { kind: "click", label: result.clicked?.name || result.clicked?.text || result.clicked?.role || String(args.ref ?? "Page target"), detail: "Click target" };
  }
  if (title === "browser_type" || title === "browser_type_focused") {
    return { kind: "type", label: result.typed?.name || result.typed?.role || "Text field", detail: typeof result.chars === "number" ? `${result.chars} characters entered` : "Entering text" };
  }
  const url = args.url ?? result.url;
  return { kind: "page", label: typeof url === "string" ? url : activityLabel(title)[1], detail: "Browser activity" };
}
