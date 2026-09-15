import { activityLabel } from "./tool-activity.js";

/** Bounded, text-only view models. Untrusted tool output is never treated as HTML. */
export interface ResultRow {
  label: string;
  detail: string;
  badge: string;
  tone?: "error" | "active";
  duration?: number;
}

export interface ResultView {
  kind: "page" | "outline" | "tabs" | "network" | "console" | "quote" | "value" | "action" | "mail" | "contact" | "file" | "draft";
  heading: string;
  caption?: string;
  rows?: ResultRow[];
  value?: unknown;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseResult(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function rows(value: unknown, project: (row: Record<string, unknown>) => ResultRow): ResultRow[] {
  return Array.isArray(value) ? value.slice(0, 40).map((item) => project(record(item))) : [];
}

function outlineRow(row: Record<string, unknown>): ResultRow {
  return {
    label: string(row.name || row.text || row.ref || "Unnamed element"),
    detail: [row.disabled === true ? "Disabled" : "", row.checked === true ? "Checked" : "", string(row.href)].filter(Boolean).join(" · "),
    badge: string(row.role || row.tag || "element"),
  };
}

function tabRow(row: Record<string, unknown>): ResultRow {
  return { label: string(row.title || row.url || "Untitled tab"), detail: string(row.url), badge: row.bound === true ? "Current" : "Tab", tone: row.bound === true ? "active" : undefined };
}

function networkRow(row: Record<string, unknown>): ResultRow {
  return {
    label: string(row.url), detail: string(row.error || row.statusText),
    badge: [string(row.method), string(row.status || (row.failed ? "Failed" : "Pending"))].join(" "),
    tone: row.failed === true || Number(row.status) >= 400 ? "error" : undefined,
    duration: typeof row.durationMs === "number" && Number.isFinite(row.durationMs) ? Math.max(0, row.durationMs) : undefined,
  };
}

function consoleRow(row: Record<string, unknown>): ResultRow {
  return { label: string(row.text), detail: string(row.source), badge: string(row.level), tone: row.level === "error" ? "error" : undefined };
}

function messageRow(row: Record<string, unknown>): ResultRow {
  return { label: string(row.subject || "(No subject)"), detail: [row.author, row.date, row.folder].map(string).filter(Boolean).join(" · "), badge: row.read === false ? "Unread" : "Message" };
}

function contactRow(row: Record<string, unknown>): ResultRow {
  return { label: string(row.name || "Unnamed contact"), detail: [Array.isArray(row.emails) ? row.emails.join(", ") : "", string(row.organization)].filter(Boolean).join(" · "), badge: "Contact" };
}

function fileRow(row: Record<string, unknown>): ResultRow {
  return { label: string(row.name || row.partName || "File"), detail: [string(row.contentType), typeof row.size === "number" ? `${row.size.toLocaleString()} bytes` : ""].filter(Boolean).join(" · "), badge: row.truncated ? "Partial file" : "File" };
}

function folderRow(row: Record<string, unknown>): ResultRow {
  return { label: string(row.name || row.tag || row.key || row.id), detail: string(row.path || row.type), badge: row.isRoot ? "Account" : "Item" };
}

const collections: Record<string, { key: string; kind: ResultView["kind"]; label: string; project: (row: Record<string, unknown>) => ResultRow }> = {
  browser_get_dom: { key: "elements", kind: "outline", label: "page elements", project: outlineRow },
  browser_get_accessibility_tree: { key: "nodes", kind: "outline", label: "page elements", project: outlineRow },
  browser_list_tabs: { key: "tabs", kind: "tabs", label: "tabs", project: tabRow },
  browser_get_network: { key: "requests", kind: "network", label: "requests", project: networkRow },
  browser_get_console: { key: "messages", kind: "console", label: "console messages", project: consoleRow },
  mail_get_context: { key: "selectedMessages", kind: "mail", label: "selected messages", project: messageRow },
  mail_get_selected_messages: { key: "messages", kind: "mail", label: "messages", project: messageRow },
  mail_get_displayed_messages: { key: "messages", kind: "mail", label: "messages", project: messageRow },
  mail_search: { key: "messages", kind: "mail", label: "messages", project: messageRow },
  mail_list_attachments: { key: "attachments", kind: "file", label: "attachments", project: fileRow },
  mail_list_accounts: { key: "accounts", kind: "outline", label: "accounts", project: folderRow },
  mail_list_folders: { key: "folders", kind: "outline", label: "folders", project: folderRow },
  mail_list_tags: { key: "tags", kind: "outline", label: "tags", project: folderRow },
  contacts_list: { key: "contacts", kind: "contact", label: "contacts", project: contactRow },
  contacts_search: { key: "contacts", kind: "contact", label: "contacts", project: contactRow },
};

function collectionView(title: string, result: Record<string, unknown>): ResultView | undefined {
  const spec = collections[title];
  if (!spec) return;
  if (title === "mail_get_context") result = record(result.context);
  if (typeof result.tree === "string") return { kind: "outline", heading: "Page structure", value: result.tree, caption: result.truncated ? "Tool returned a partial outline" : undefined };
  const items = result[spec.key];
  if (!Array.isArray(items)) return;
  return {
    kind: spec.kind, heading: `${items.length} ${spec.label} returned`, rows: rows(items, spec.project),
    caption: [items.length > 40 ? "Showing first 40; full result below" : "", result.truncated || result.nextCursor ? "More results available" : "", string(result.note)].filter(Boolean).join(" · "),
  };
}

function pageView(title: string, result: Record<string, unknown>, args: Record<string, unknown>): ResultView {
  const url = string(result.url || result.navigatingTo || result.reloaded || args.url);
  const viewport = record(result.viewport);
  const captions: Record<string, string> = {
    browser_navigate: "Navigation requested", browser_reload: "Reload requested",
    browser_open_tab: "New tab opened", browser_close_tab: `Closed tab ${string(result.closed || args.tabId)}`,
  };
  return { kind: "page", heading: string(result.title) || url || captions[title] || "Page", caption: captions[title] || (viewport.width ? `${viewport.width} × ${viewport.height}` : undefined), value: result.title ? url : undefined };
}

function actionView(title: string, result: Record<string, unknown>, args: Record<string, unknown>): ResultView | undefined {
  if (title === "browser_wait_for") return { kind: "action", heading: result.found === true ? `Condition met: ${string(result.state || args.state || "visible")}` : "Condition not met", caption: typeof result.waitedMs === "number" ? `Waited ${(result.waitedMs / 1000).toFixed(1)}s` : undefined };
  if (result.found === false) return { kind: "action", heading: "No element found at this point", caption: `${string(args.x)}, ${string(args.y)} · viewport coordinates` };
  const targets: Record<string, string> = { browser_focus: "focused", browser_scroll: "scrolled", browser_element_at: "element" };
  const target = record(result[targets[title]]);
  if (!targets[title]) return;
  return { kind: "action", heading: string(target.name || target.text || target.role || args.ref || "Page target"), caption: ({ browser_focus: "Field focused", browser_scroll: "Scrolled into view", browser_element_at: "Observed target" } as Record<string, string>)[title] };
}

export function resultView(title: string, input: unknown, text: string): ResultView | undefined {
  if (!text) return;
  const value = parseResult(text);
  const result = record(value);
  const args = record(input);
  const collection = collectionView(title, result);
  if (collection) return collection;
  if (["browser_get_page", "browser_navigate", "browser_reload", "browser_open_tab", "browser_close_tab"].includes(title)) return pageView(title, result, args);
  if (title === "browser_get_selection") return { kind: "quote", heading: result.text ? "Selected text" : "No text selected", value: string(result.text) };
  if (title === "browser_evaluate" || title === "javascript") return { kind: "value", heading: "Returned result", value: Object.hasOwn(result, "result") ? result.result : value };
  if (/^(mail_|compose_|contacts_|pi_)/.test(title)) return applicationView(title, result, args);
  return actionView(title, result, args);
}

function applicationView(title: string, result: Record<string, unknown>, args: Record<string, unknown>): ResultView {
  if (title === "mail_get_message") return { kind: "mail", heading: "Message", rows: [messageRow(record(result.message || result))] };
  if (title === "mail_get_message_body") return { kind: "quote", heading: "Message body", value: result.bodyText, caption: result.truncated ? "Partial body returned" : undefined };
  if (title === "contacts_get") return { kind: "contact", heading: "Contact", rows: [contactRow(result)] };
  if (title === "mail_get_attachment" || title === "compose_add_attachment") return { kind: "file", heading: title.startsWith("compose") ? "Attachment added" : "Attachment returned", rows: [fileRow(result)] };
  if (title.startsWith("compose_")) return draftView(title, result, args);
  if (title.startsWith("mail_") && typeof result.note === "string") return { kind: "action", heading: result.note, caption: Array.isArray(args.messageIds) ? `Messages: ${args.messageIds.join(", ")}` : undefined };
  if (title.startsWith("pi_") && title !== "pi_get_state") return {
    kind: "action", heading: activityLabel(title)[1],
    caption: title === "pi_set_config_option" ? `${string(args.configId)} → ${String(args.value)}` : string(result.sessionId || args.sessionId),
    value: result,
  };
  return { kind: "value", heading: "Returned result", value: result };
}

function draftView(title: string, result: Record<string, unknown>, args: Record<string, unknown>): ResultView {
  // Prepare/update only return a window id; distinguish requested fields from a read-back.
  const observed = title === "compose_get";
  const fields = observed ? result : args;
  const headers = ["to", "cc", "bcc"].filter((key) => fields[key]).map((key) => ({ label: string(fields[key]), badge: key.toUpperCase(), detail: "" }));
  return {
    kind: "draft", heading: string(fields.subject) || "Draft message", rows: headers,
    caption: `${observed ? "Read from draft" : "Requested draft fields"} · Window ${string(result.composeTabId)} · Not sent`,
    value: fields.body ? { [fields.contentType === "text/plain" ? "Body" : "Body source (HTML)"]: fields.body } : undefined,
  };
}
