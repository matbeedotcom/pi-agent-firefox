/**
 * Thunderbird read-only mail tool dispatcher (THUNDERBIRD-PLAN.md §9–14).
 *
 * Maps the ten protocol mail tools onto Thunderbird's WebExtension mail APIs
 * (mailTabs, messageDisplay, messages, folders, accounts) and normalizes the
 * results into the protocol's context model (MailMessageRef, ThunderbirdContext,
 * ...). The agent only ever sees these normalized shapes, never raw
 * WebExtension types.
 *
 * Safety (plan §8, §14):
 *  - Every tool here is read-only; there is no send/delete/move/compose.
 *  - Numeric `messageId` is transient; `headerMessageId` is the durable id.
 *  - Bodies/attachments are returned as data only — untrusted content.
 */
import {
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  type MailFolderRef,
  type MailMessageRef,
  type ThunderbirdContext,
} from "@pi-browser/protocol";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_BODY_CHARS = 50_000;
const MAX_BODY_CHARS = 200_000;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_ATTACHMENT_BYTES = 1_048_576; // 1 MiB
const MAX_ATTACHMENT_BYTES = 5_242_880; // 5 MiB

/** Envelope for tools that return a structured object. Single-message tools
 *  return a `MailMessageRef` directly; the dispatcher's return is `unknown`
 *  because the result is only ever JSON-serialized for the agent. */
export type MailToolResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------
function reqInt(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${key} must be a number`);
  }
  return v;
}
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `${key} must be a non-empty string`);
  }
  return v;
}
function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function clampInt(v: unknown, def: number, max: number): number {
  const n = optNum(v);
  if (n === undefined || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
function boolOf(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
function normDate(d?: browser.mailTypes.Date): string | undefined {
  if (d === undefined) return undefined;
  if (typeof d === "number") return new Date(d).toISOString();
  return d;
}

function normFolderRef(f: browser.folders.MailFolder): MailFolderRef {
  const out: MailFolderRef = { id: f.id ?? "", name: f.name ?? "" };
  if (f.path !== undefined) out.path = f.path;
  if (f.accountId !== undefined) out.accountId = f.accountId;
  if (f.isRoot) out.isRoot = true;
  if (f.isUnified) out.isUnified = true;
  if (f.isVirtual) out.isVirtual = true;
  if (f.isTag) out.isTag = true;
  if (f.isFavorite) out.isFavorite = true;
  return out;
}

function normalizeHeader(h: browser.mailTypes.MessageHeader): MailMessageRef {
  const ref: MailMessageRef = { messageId: h.id };
  if (h.headerMessageId) ref.headerMessageId = h.headerMessageId;
  if (h.subject) ref.subject = h.subject;
  if (h.author) ref.author = h.author;
  if (h.recipients && h.recipients.length) ref.recipients = h.recipients;
  if (h.ccList && h.ccList.length) ref.cc = h.ccList;
  const date = normDate(h.date);
  if (date) ref.date = date;
  if (typeof h.read === "boolean") ref.read = h.read;
  if (typeof h.flagged === "boolean") ref.flagged = h.flagged;
  if (typeof h.size === "number") ref.size = h.size;
  if (h.folder?.name) ref.folder = h.folder.name;
  if (h.folder?.id) ref.folderId = h.folder.id;
  return ref;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Drain a paginated MessageList up to `limit` messages. */
async function drainMessageList(
  list: browser.mailTypes.MessageList,
  limit: number,
): Promise<browser.mailTypes.MessageHeader[]> {
  const out: browser.mailTypes.MessageHeader[] = [];
  let cursor: string | null = list.id;
  let page = list.messages;
  while (out.length < limit) {
    const take = page.slice(0, limit - out.length);
    out.push(...take);
    if (!cursor) break;
    if (take.length < limit - out.length && page.length === 0) break;
    const next = await browser.messages.continueList(cursor);
    cursor = next.id;
    page = next.messages;
    if (page.length === 0) break;
  }
  return out.slice(0, limit);
}

/**
 * Resolve the mail tab the user is working in.
 *
 * Fast path: the active tab is a mail tab — true when using the Pi pane, where
 * the mail tab stays the active tab. Slow path: the user is in a non-mail tab
 * (e.g. the full Pi Space, a separate tab), so `getCurrent()` returns nothing and
 * we fall back to the mail tab that actually has content: prefer an active mail
 * tab, then the first mail tab showing a displayed message, else the first one.
 */
async function resolveContextTab(): Promise<{ tab: ThunderbirdContext["tab"]; tabId: number } | null> {
  try {
    const t = await browser.mailTabs.getCurrent();
    if (t && typeof t.tabId === "number") {
      return { tab: { tabId: t.tabId, type: "mail" }, tabId: t.tabId };
    }
  } catch {
    /* the active tab is not a mail tab */
  }
  const tabs = await browser.mailTabs
    .query()
    .catch(() => [] as browser.mailTabs.MailTab[]);
  if (tabs.length === 0) return null;
  const active = tabs.find((t) => t.active);
  const ordered = active ? [active, ...tabs.filter((t) => t.tabId !== active!.tabId)] : tabs;
  // Prefer the first mail tab that is actually showing a message.
  for (const t of ordered) {
    try {
      const list = await browser.messageDisplay.getDisplayedMessages(t.tabId);
      if (list && Array.isArray(list.messages) && list.messages.length > 0) {
        return { tab: { tabId: t.tabId, type: "mail" }, tabId: t.tabId };
      }
    } catch {
      /* keep looking */
    }
  }
  const t = ordered[0];
  return { tab: { tabId: t.tabId, type: "mail" }, tabId: t.tabId };
}

/** Resolve a tab id, defaulting to the current mail tab; throw if there is none. */
async function resolveTabId(explicit: number | undefined): Promise<number> {
  if (explicit !== undefined) return explicit;
  const resolved = await resolveContextTab();
  if (resolved) return resolved.tabId;
  throw new PiBrowserProtocolError(
    PI_BROWSER_ERROR.MAIL_NO_CONTEXT,
    "no mail tab is open; select a folder or message first",
  );
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function mailGetContext(): Promise<MailToolResult> {
  const resolved = await resolveContextTab();
  const tab = resolved?.tab ?? null;
  const tabId = resolved?.tabId;

  const [selectedFolders, selectedMessages, displayedMessages] = await Promise.all([
    (async () => {
      if (tabId === undefined) return [];
      try {
        const folders = await browser.mailTabs.getSelectedFolders(tabId);
        return folders.filter((f): f is browser.folders.MailFolder => f != null).map(normFolderRef);
      } catch {
        return [];
      }
    })(),
    (async () => {
      if (tabId === undefined) return [];
      try {
        const list = await browser.mailTabs.getSelectedMessages(tabId);
        const headers = await drainMessageList(list, DEFAULT_LIST_LIMIT);
        return headers.map(normalizeHeader);
      } catch {
        return [];
      }
    })(),
    (async () => {
      if (tabId === undefined) return [];
      try {
        const list = await browser.messageDisplay.getDisplayedMessages(tabId);
        const headers = await drainMessageList(list, DEFAULT_LIST_LIMIT);
        return headers.map(normalizeHeader);
      } catch {
        return [];
      }
    })(),
  ]);

  const context: ThunderbirdContext = {
    tab,
    selectedFolders,
    selectedMessages,
    displayedMessages,
  };
  return { context };
}

async function mailGetSelectedMessages(args: Record<string, unknown>): Promise<MailToolResult> {
  const tabId = await resolveTabId(optNum(args.tabId));
  const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const list = await browser.mailTabs.getSelectedMessages(tabId);
  const headers = await drainMessageList(list, limit);
  return { messages: headers.map(normalizeHeader) };
}

async function mailGetDisplayedMessages(args: Record<string, unknown>): Promise<MailToolResult> {
  const tabId = await resolveTabId(optNum(args.tabId));
  const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const list = await browser.messageDisplay.getDisplayedMessages(tabId);
  const headers = await drainMessageList(list, limit);
  return { messages: headers.map(normalizeHeader) };
}

/** Map Thunderbird's "Message not found" error to our structured code. */
function rethrowNotFound(err: unknown, messageId: number): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|no longer/i.test(msg)) {
    throw new PiBrowserProtocolError(
      PI_BROWSER_ERROR.MAIL_MESSAGE_NOT_FOUND,
      `message ${messageId} not found (numeric ids are transient — refresh the context)`,
    );
  }
  if (err instanceof PiBrowserProtocolError) throw err;
  throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, msg);
}

async function mailGetMessage(args: Record<string, unknown>): Promise<MailMessageRef> {
  const id = reqInt(args, "messageId");
  try {
    const header = await browser.messages.get(id);
    return normalizeHeader(header);
  } catch (err) {
    rethrowNotFound(err, id);
  }
}

/** Recursively collect decoded text/plain and text/html part bodies. */
function collectTextParts(part: browser.mailTypes.MessagePart, out: { plain: string[]; html: string[] }): void {
  const ct = (part.contentType || "").toLowerCase();
  if (part.body) {
    if (ct.startsWith("text/plain")) out.plain.push(part.body);
    else if (ct.startsWith("text/html")) out.html.push(part.body);
  }
  for (const child of part.parts ?? []) collectTextParts(child, out);
}

/** Minimal HTML → text (strip tags/comments, collapse whitespace, decode a few entities). */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*!(?:\[CDATA\[)?[\s\S]*?(?:\]\]|\s*)>/g, " ")
    .replace(/<\s*head[\s\S]*?<\s*\/\s*head\s*>/gi, " ")
    .replace(/<\s*style[\s\S]*?<\s*\/\s*style\s*>/gi, " ")
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/?\s*(?:p|div|tr|li|h[1-6])\s*[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function mailGetMessageBody(args: Record<string, unknown>): Promise<MailToolResult> {
  const id = reqInt(args, "messageId");
  const preferRaw = args.prefer;
  const prefer: "text" | "html" | "auto" = preferRaw === "text" || preferRaw === "html" ? preferRaw : "auto";
  const maxChars = clampInt(args.maxChars, DEFAULT_BODY_CHARS, MAX_BODY_CHARS);

  let root: browser.mailTypes.MessagePart;
  try {
    root = await browser.messages.getFull(id, { decodeContent: true, decodeHeaders: true });
  } catch (err) {
    rethrowNotFound(err, id);
  }

  const parts = { plain: [] as string[], html: [] as string[] };
  collectTextParts(root, parts);

  let body: string | undefined;
  if (prefer === "text") {
    body = parts.plain.join("\n");
  } else if (prefer === "html") {
    body = parts.html.length ? htmlToText(parts.html.join("\n")) : undefined;
  } else {
    // auto: plain text first, else HTML-as-text
    body = parts.plain.join("\n") || (parts.html.length ? htmlToText(parts.html.join("\n")) : undefined);
  }

  if (!body || body.length === 0) {
    return { bodyText: "", truncated: false, note: "No readable text body for this message." };
  }
  const truncated = body.length > maxChars;
  return { bodyText: truncated ? body.slice(0, maxChars) : body, truncated };
}

async function mailSearch(args: Record<string, unknown>): Promise<MailToolResult> {
  const limit = clampInt(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const cursor = optStr(args.cursor);

  // Continuation: resume a previously returned list id.
  if (cursor) {
    const list = await browser.messages.continueList(cursor);
    const messages = (list && Array.isArray(list.messages) ? list.messages : []).map(normalizeHeader);
    return { messages, nextCursor: list && list.id && messages.length > 0 ? list.id : null };
  }

  const queryInfo: Record<string, unknown> = {
    messagesPerPage: limit,
    // Do NOT set returnMessageListId: true — that makes messages.query() return
    // just the list-id string (no messages array). We want the first page:
    // { id (continuation cursor, null when done), messages }.
  };
  const text = optStr(args.text);
  if (text) queryInfo.fullText = text;
  const from = optStr(args.from);
  if (from) queryInfo.author = from;
  const to = optStr(args.to);
  if (to) queryInfo.recipients = to;
  const subject = optStr(args.subject);
  if (subject) queryInfo.subject = subject;
  const accountId = optStr(args.accountId);
  if (accountId) queryInfo.accountId = accountId;
  const folderId = optStr(args.folderId);
  if (folderId) queryInfo.folderId = folderId;
  // fromDate/toDate must be Date objects (the API calls .getTime() on them); the
  // tool input is an ISO string, so convert.
  const after = optStr(args.after);
  if (after) {
    const d = new Date(after);
    if (!Number.isNaN(d.getTime())) queryInfo.fromDate = d;
  }
  const before = optStr(args.before);
  if (before) {
    const d = new Date(before);
    if (!Number.isNaN(d.getTime())) queryInfo.toDate = d;
  }
  const hasAttachments = boolOf(args.hasAttachments);
  if (hasAttachments !== undefined) queryInfo.attachment = hasAttachments;
  const unread = boolOf(args.unread);
  if (unread !== undefined) queryInfo.unread = unread;

  const list = await browser.messages.query(queryInfo);
  const messages = (list && Array.isArray(list.messages) ? list.messages : []).map(normalizeHeader);
  return { messages, nextCursor: list && list.id ? list.id : null };
}

async function mailListAttachments(args: Record<string, unknown>): Promise<MailToolResult> {
  const id = reqInt(args, "messageId");
  let attachments: browser.mailTypes.MessageAttachment[];
  try {
    attachments = await browser.messages.listAttachments(id);
  } catch (err) {
    rethrowNotFound(err, id);
  }
  const list = attachments.map((a) => {
    const out: Record<string, unknown> = {
      partName: a.partName,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
    };
    if (a.contentDisposition) out.contentDisposition = a.contentDisposition;
    if (a.type) out.type = a.type;
    if (a.linkUrl) out.linkUrl = a.linkUrl;
    return out;
  });
  return { attachments: list };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function mailGetAttachment(args: Record<string, unknown>): Promise<MailToolResult> {
  const id = reqInt(args, "messageId");
  const partName = reqStr(args, "partName");
  const maxBytes = clampInt(args.maxBytes, DEFAULT_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);

  let file: File;
  try {
    file = await browser.messages.getAttachmentFile(id, partName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|no longer/i.test(msg)) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.MAIL_ATTACHMENT_NOT_FOUND,
        `attachment ${partName} not found on message ${id}`,
      );
    }
    if (err instanceof PiBrowserProtocolError) throw err;
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, msg);
  }

  const truncated = file.size > maxBytes;
  const blob = file.slice(0, maxBytes);
  const buf = await blob.arrayBuffer();
  return {
    name: file.name || partName,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    data: arrayBufferToBase64(buf),
    truncated,
    ...(truncated ? { note: `Truncated to ${maxBytes} bytes; the full file is ${file.size} bytes.` } : {}),
  };
}

async function mailListAccounts(): Promise<MailToolResult> {
  const accounts = await browser.accounts.list(false);
  const list = accounts.map((a) => {
    const out: Record<string, unknown> = { id: a.id, name: a.name };
    if (a.type) out.type = a.type;
    const identities = (a.identities ?? []).map((i, idx) => {
      const entry: Record<string, unknown> = { identityId: i.id };
      if (i.name) entry.name = i.name;
      if (i.email) entry.email = i.email;
      if (i.label) entry.label = i.label;
      // The default identity is listed first.
      if (idx === 0) entry.isDefault = true;
      return entry;
    });
    out.identities = identities;
    return out;
  });
  return { accounts: list };
}

async function mailListFolders(args: Record<string, unknown>): Promise<MailToolResult> {
  const accountId = optStr(args.accountId);
  const folders = await browser.folders.query(accountId ? { accountId } : {});
  return { folders: folders.filter((f): f is browser.folders.MailFolder => f != null).map(normFolderRef) };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Dispatch one mail tool call to the matching implementation. */
export async function dispatchMailTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "mail_get_context":
      return mailGetContext();
    case "mail_get_selected_messages":
      return mailGetSelectedMessages(args);
    case "mail_get_displayed_messages":
      return mailGetDisplayedMessages(args);
    case "mail_get_message":
      return mailGetMessage(args);
    case "mail_get_message_body":
      return mailGetMessageBody(args);
    case "mail_search":
      return mailSearch(args);
    case "mail_list_attachments":
      return mailListAttachments(args);
    case "mail_get_attachment":
      return mailGetAttachment(args);
    case "mail_list_accounts":
      return mailListAccounts();
    case "mail_list_folders":
      return mailListFolders(args);
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown mail tool: ${tool}`);
  }
}
