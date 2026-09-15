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
 *
 * mail_search is incremental: the first call returns the first backend page
 * and a continuation cursor; the scan (including the To/Cc/Bcc header phase)
 * keeps running across cursor calls. Results are globally sorted only when
 * `sortComplete` is true. `onUpdate` progress reports are best-effort and
 * never change the tool result.
 */
import {
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  type BrowserToolUpdateParams,
  type MailFolderRef,
  type MailMessageRef,
  type MailSearchResult,
  type ThunderbirdContext,
} from "@pi-browser/protocol";
import { listTags, resolveTagKeys } from "./tag-utils.js";

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

/** Context for one mail tool call (identity + optional progress channel). */
export interface MailToolContext {
  /** Session and call identity, from the host (progress routing). */
  sessionId?: string;
  toolCallId?: string;
  /**
   * Optional incremental progress reporter for long-running tools. It only
   * reports results of the already-approved call — it never authorizes
   * anything, and its absence (older client, dropped transport) does not
   * change the tool result.
   */
  onUpdate?: (update: BrowserToolUpdateParams["update"]) => void;
}

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
  if (h.tags && h.tags.length) ref.tags = h.tags;
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
 * `mailTabs.query()` lists every mail tab; we prefer an active mail tab (true
 * when using the Pi pane, where the mail tab stays active), then the first mail
 * tab that is actually showing a displayed message, else the first one.
 * (The MV2-only `getCurrent()` fast path is not used: it is not registered in an
 * MV3 add-on, and `query()` gives the same active-tab answer.)
 */
async function resolveContextTab(): Promise<{ tab: ThunderbirdContext["tab"]; tabId: number } | null> {
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

// Inbox resolution for the default search scope. The account's root folder is
// NOT its inbox for IMAP/EWS: the root is the server root, and the Inbox is
// its first child (path "/INBOX") — querying the root returns no messages.
// For POP3 the root folder IS the inbox. Local-folders and unified smart
// accounts are excluded.
async function inboxFolderIds(accountId?: string): Promise<string[]> {
  const accounts = await browser.accounts.list(false);
  const ids: string[] = [];
  for (const a of accounts) {
    if (accountId && a.id !== accountId) continue;
    if (a.type !== "imap" && a.type !== "pop3" && a.type !== "ews") continue;
    try {
      const folders = await browser.folders.query({ accountId: a.id });
      // Canonical inbox path first (IMAP "/INBOX", some backends "/inbox"),
      // then a top-level "Inbox" folder (POP3 root, EWS).
      const inbox =
        folders.find((f) => f.path === "/INBOX" || f.path === "/inbox") ??
        folders.find((f) => {
          if (f.name !== "Inbox") return false;
          if (f.isUnified || f.isVirtual || f.isTag) return false;
          const depth = f.path ? f.path.split("/").filter(Boolean).length : 0;
          return f.isRoot || depth <= 1;
        });
      if (inbox?.id) ids.push(inbox.id);
    } catch {
      /* unreadable account folders: skip this account */
    }
  }
  return ids;
}

// messages.query() returns results in unspecified (per-folder index) order —
// the live API docs guarantee no sort. For plain folder listings we therefore
// use messages.list() with sortType/sortOrder (TB 148+), which returns the
// folder's own sorted view (what the UI shows) and keeps continuation pages
// in sort order. Filtered searches must use query(); each of its pages is
// re-sorted with the caller's sort/order (default date desc; messages lacking
// the sort value sink to the bottom). Pages of a query as a whole are not
// guaranteed to be in sort order.
type SortKey = "date" | "subject" | "from";
type SortOrder = "asc" | "desc";

// mail_search sort key → messages.list sortType.
const LIST_SORT: Record<SortKey, "date" | "subject" | "author"> = {
  date: "date",
  subject: "subject",
  from: "author",
};

function parseSort(args: Record<string, unknown>): { key: SortKey; order: SortOrder } {
  const key = optStr(args.sort) ?? "date";
  if (key !== "date" && key !== "subject" && key !== "from") {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `sort must be 'date', 'subject', or 'from'`);
  }
  const order = optStr(args.order) ?? "desc";
  if (order !== "asc" && order !== "desc") {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `order must be 'asc' or 'desc'`);
  }
  return { key, order };
}

function bySort(messages: MailMessageRef[], key: SortKey, order: SortOrder): MailMessageRef[] {
  const dir = order === "asc" ? 1 : -1;
  // [missing, value]: records lacking the sort value always sink to the
  // bottom, in both directions.
  const sortValue = (m: MailMessageRef): [number, string | number] => {
    if (key === "date") {
      const t = m.date ? Date.parse(m.date) : NaN;
      return [Number.isNaN(t) ? 1 : 0, t];
    }
    const s = (key === "subject" ? m.subject : m.author) ?? "";
    return [s === "" ? 1 : 0, s];
  };
  return [...messages].sort((a, b) => {
    const [am, av] = sortValue(a);
    const [bm, bv] = sortValue(b);
    if (am !== bm) return am - bm;
    const c = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return c === 0 ? 0 : c * dir;
  });
}

// The continuation cursor is opaque to the agent and wraps Thunderbird's
// list id together with the sort settings and the not-yet-sent tail. Search
// snapshots carry all remaining sorted matches with an empty backend list id;
// messages.list() cursors carry the unsent tail of the current server page.
//
// New cursors are SHORT tokens into an in-memory registry (the background is
// a persistent event page, not a service worker, so state survives between
// tool calls). Embedding the payload in the cursor (the legacy
// "ps1." + base64(JSON) format, still decodable below) forced whole pages of
// message headers through the LLM context on every continuation, so it is no
// longer used. If a token is gone (extension reloaded) the call fails with a
// structured "cursor expired" error instead.
const SEARCH_CURSOR_PREFIX = "ps1.";
const CURSOR_TOKEN_PREFIX = "sc";
const MAX_ACTIVE_CURSORS = 64;
/** An incremental search not continued for this long is expired (its headers
 *  would otherwise be retained for the whole event-page lifetime). */
const CURSOR_TTL_MS = 30 * 60 * 1000;
/**
 * Thunderbird's WebExtension search can spend a long time decoding MIME
 * bodies before resolving a page. Keep one native tool request bounded while
 * the underlying page promise remains shareable through its cursor state.
 */
const SEARCH_PAGE_WAIT_MS = 15_000;

/**
 * The Thunderbird parent process owns the mail database and MIME parser.
 * Running several fallback WDAPI scans at once makes each scan slower and can
 * leave one request past the host deadline. Serialize only those backend page
 * fetches; Gloda searches never enter this queue.
 */
let backendPageTail: Promise<void> = Promise.resolve();

function enqueueBackendPage<T>(operation: () => Promise<T>): Promise<T> {
  const run = backendPageTail.then(operation, operation);
  backendPageTail = run.then(() => undefined, () => undefined);
  return run;
}

function waitForSearchPage<T>(page: Promise<T>): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), SEARCH_PAGE_WAIT_MS);
    page.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * In-flight mail_search that has not drained every backend page. Two phases:
 * phase 1 is the messages.query() fullText scan; phase 2 (only for text
 * queries) is the header-only scan that also covers To/Cc/Bcc partial
 * matches. `complete` is set once every phase is drained; the results are
 * globally sorted only then (`sortComplete`).
 */
interface ActiveSearch {
  query: Record<string, unknown>;
  headerQuery: Record<string, unknown> | null;
  /** Lowercased search text; phase-2 matches must hit a header field with it. */
  needle: string | null;
  phase: 1 | 2;
  listId: string | null;
  /** A page fetch already in progress; continuations share it. */
  pendingPage?: Promise<browser.mailTypes.MessageList | null>;
  seenIds: Set<number>;
  scanned: number;
  /** Matches not yet sent to the agent (deduped, normalized). */
  buffered: MailMessageRef[];
  complete: boolean;
  sortComplete: boolean;
  note?: string;
  /** Wall clock of the first call; logs report cumulative search age. */
  startedAt: number;
}

interface SearchCursorState {
  id: string;
  key: SortKey;
  order: SortOrder;
  carry?: MailMessageRef[];
  /** New-style incremental search; legacy cursors omit it. */
  active?: ActiveSearch;
  /** Last continuation time (wall clock); drives expiration. */
  lastAccessed?: number;
}

// btoa/atob only handle Latin1, but legacy cursor payloads carry whole
// messages (subjects/authors with arbitrary Unicode) — round-trip through
// UTF-8 bytes when decoding them.
function fromBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Live cursors: short token → state. Insertion order is used for eviction.
const activeCursors = new Map<string, SearchCursorState>();

function randomCursorToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return CURSOR_TOKEN_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Register a cursor state and return the short token the agent sees. */
function issueCursor(state: SearchCursorState): string {
  // Expire abandoned incremental searches before evicting anything useful:
  // a large-mailbox scan must not retain headers indefinitely.
  const now = Date.now();
  for (const [token, entry] of activeCursors) {
    if (entry.active && entry.lastAccessed !== undefined && now - entry.lastAccessed > CURSOR_TTL_MS) {
      abortActiveSearch(entry.active);
      activeCursors.delete(token);
    }
  }
  while (activeCursors.size >= MAX_ACTIVE_CURSORS) {
    const oldest = activeCursors.keys().next().value;
    if (oldest === undefined) break;
    const evicted = activeCursors.get(oldest);
    if (evicted?.active) abortActiveSearch(evicted.active);
    activeCursors.delete(oldest);
  }
  const token = randomCursorToken();
  activeCursors.set(token, state);
  return token;
}

function abortActiveSearch(state: ActiveSearch): void {
  const listId = state.listId;
  state.listId = null;
  state.pendingPage = undefined;
  if (!listId || typeof browser.messages.abortList !== "function") return;
  void browser.messages.abortList(listId).catch(() => {
    /* The list may already have completed or been evicted by Thunderbird. */
  });
}

/**
 * Stage timing log. The extension side has no file log sink — the Thunderbird
 * Web Console (devtools for the add-on background) is the only place these
 * reach — so every line is self-contained: stage, duration, counters.
 */
function mailLog(msg: string): void {
  try {
    console.info(`[pi-thunderbird:mail] ${msg}`);
  } catch {
    /* logging must never break a tool call */
  }
}

/** Append a normalized match to the buffer, deduped by message id. */
function appendActiveMatch(state: ActiveSearch, header: browser.mailTypes.MessageHeader): void {
  if (state.seenIds.has(header.id)) return;
  state.seenIds.add(header.id);
  // Phase 2 is a header-only "match everything" scan: keep only messages
  // whose header fields contain the text (this is what covers partial
  // To/Cc/Bcc addresses that fullText does not reach).
  if (state.phase === 2 && state.needle) {
    const fields = [
      header.subject,
      header.author,
      ...(header.recipients ?? []),
      ...(header.ccList ?? []),
      ...(header.bccList ?? []),
    ];
    if (!fields.some((f) => f?.toLowerCase().includes(state.needle as string))) return;
  }
  state.buffered.push(normalizeHeader(header));
}

/**
 * Pull the next backend page(s) of an in-flight search until the buffer
 * holds at least `want` matches or the search is complete. A null list id
 * ends the current phase; when phase 1 ends and a header phase is pending,
 * phase 2 starts with its own first query() page. Deliberately stops early:
 * a continuation call only drains as much as it needs to fill one page.
 */
/** Best-effort scanned-progress report (one per engine page). */
function reportProgress(
  context: MailToolContext,
  scanned: number,
  elapsedMs: number,
  pageMs: number,
): void {
  const { onUpdate } = context;
  if (!onUpdate) return;
  try {
    onUpdate({ kind: "progress", scanned, elapsedMs, pageMs });
  } catch {
    /* transport drop, closed port — the result below is authoritative */
  }
}

async function advanceActiveSearch(
  state: ActiveSearch,
  want: number,
  context: MailToolContext,
): Promise<void> {
  let pages = 0;
  for (;;) {
    if (state.buffered.length >= want) return;
    if (state.listId === null) {
      if (state.phase === 1 && state.headerQuery !== null) {
        state.phase = 2;
        mailLog(
          `phase2 start (header/To/Cc/Bcc match, needle="${state.needle}", after ${Date.now() - state.startedAt}ms, scanned=${state.scanned})`,
        );
        const t0 = Date.now();
        const pagePromise = state.pendingPage ?? enqueueBackendPage(() => browser.messages.query(state.headerQuery as Record<string, unknown>));
        state.pendingPage = pagePromise;
        const page = await waitForSearchPage(pagePromise);
        if (!page) {
          mailLog(
            `phase2 page wait exceeded ${SEARCH_PAGE_WAIT_MS}ms (scanned=${state.scanned}); returning resumable cursor`,
          );
          return;
        }
        state.pendingPage = undefined;
        const msgs = page && Array.isArray(page.messages) ? page.messages : [];
        state.scanned += msgs.length;
        for (const m of msgs) appendActiveMatch(state, m);
        state.listId = page && page.id ? page.id : null;
        mailLog(
          `phase2 page ${++pages}: ${Date.now() - t0}ms, +${msgs.length} msgs (scanned=${state.scanned}, listId=${state.listId ?? "done"}, searchAge=${Date.now() - state.startedAt}ms)`,
        );
        reportProgress(context, state.scanned, Date.now() - state.startedAt, Date.now() - t0);
        if (state.listId === null) state.complete = true;
        continue;
      }
      state.complete = true;
      return;
    }
    const t0 = Date.now();
    const pagePromise = state.pendingPage ?? enqueueBackendPage(() => browser.messages.continueList(state.listId as string));
    state.pendingPage = pagePromise;
    const page = await waitForSearchPage(pagePromise);
    if (!page) {
      mailLog(
        `page wait exceeded ${SEARCH_PAGE_WAIT_MS}ms (phase=${state.phase}, scanned=${state.scanned}, listId=${state.listId}); returning resumable cursor`,
      );
      return;
    }
    state.pendingPage = undefined;
    const msgs = page && Array.isArray(page.messages) ? page.messages : [];
    state.scanned += msgs.length;
    for (const m of msgs) appendActiveMatch(state, m);
    state.listId = page && page.id ? page.id : null;
    mailLog(
      `page ${++pages} [${state.phase === 2 ? "phase2" : "query"}]: ${Date.now() - t0}ms, +${msgs.length} msgs (scanned=${state.scanned}, listId=${state.listId ?? "done"}, searchAge=${Date.now() - state.startedAt}ms)`,
    );
    reportProgress(context, state.scanned, Date.now() - state.startedAt, Date.now() - t0);
    // A drained list ends the search unless the header phase is pending.
    if (state.listId === null && (state.phase === 2 || state.headerQuery === null)) {
      state.complete = true;
    }
  }
}

/** Best-effort progress report — never fail the tool call over reporting. */
function reportBatch(context: MailToolContext, result: MailToolResult): void {
  const { onUpdate } = context;
  if (!onUpdate) return;
  try {
    // The dispatcher builds a MailSearchResult; the loose result type is the
    // shared MailToolResult envelope.
    onUpdate({ kind: "batch", result: result as unknown as MailSearchResult });
  } catch {
    /* transport drop, closed port — the result below is authoritative */
  }
}

/** Finish one page of an in-flight search: send the next batch, or close it. */
async function continueActiveSearch(
  state: ActiveSearch,
  key: SortKey,
  order: SortOrder,
  limit: number,
  context: MailToolContext,
): Promise<MailToolResult> {
  await advanceActiveSearch(state, limit, context);
  let messages: MailMessageRef[];
  let nextCursor: string | null = null;
  if (state.complete) {
    // Every folder has been searched — the snapshot is final and can be
    // globally sorted. A page that ends in a limit keeps the remainder as a
    // snapshot carry (legacy cursor shape) so paging stays available.
    state.sortComplete = true;
    const sorted = bySort(state.buffered, key, order);
    messages = sorted.slice(0, limit);
    const carry = sorted.slice(limit);
    if (carry.length > 0) nextCursor = issueCursor({ id: "", key, order, carry });
  } else {
    // A truly early page: no global ordering promise.
    messages = state.buffered.splice(0, limit);
    nextCursor = issueCursor({ id: "", key, order, active: state, lastAccessed: Date.now() });
  }
  const result: MailToolResult = {
    messages,
    nextCursor,
    complete: state.complete,
    sortComplete: state.sortComplete,
    scanned: state.scanned,
  };
  if (state.note) result.note = state.note;
  if (messages.length > 0) reportBatch(context, result);
  if (state.complete) context.onUpdate?.({ kind: "complete" });
  return result;
}

/**
 * Resolve an inbound cursor: live token first, then legacy embedded formats.
 * Returns null when the string is a cursor we issued (token) or once
 * embedded ("ps1.") but its state is unrecoverable; anything else is treated
 * as a bare Thunderbird list id (pre-cursor legacy input), inheriting the
 * caller's sort settings.
 */
function lookupCursor(
  cursor: string,
  defaultKey: SortKey,
  defaultOrder: SortOrder,
): { state: SearchCursorState; token?: string } | null {
  if (cursor.startsWith(CURSOR_TOKEN_PREFIX)) {
    const state = activeCursors.get(cursor);
    return state ? { state, token: cursor } : null;
  }
  if (cursor.startsWith(SEARCH_CURSOR_PREFIX)) {
    const decoded = decodeSearchCursor(cursor);
    return decoded ? { state: decoded } : null;
  }
  return { state: { id: cursor, key: defaultKey, order: defaultOrder } }; // bare list id
}

function decodeSearchCursor(cursor: string): SearchCursorState | null {
  if (!cursor.startsWith(SEARCH_CURSOR_PREFIX)) return null;
  try {
    const raw: unknown = JSON.parse(fromBase64Utf8(cursor.slice(SEARCH_CURSOR_PREFIX.length)));
    if (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string") {
      const r = raw as { id: string; sort?: unknown; order?: unknown; carry?: unknown };
      return {
        id: r.id,
        key: r.sort === "subject" || r.sort === "from" ? r.sort : "date",
        order: r.order === "asc" ? "asc" : "desc",
        carry: Array.isArray(r.carry) ? (r.carry as MailMessageRef[]) : undefined,
      };
    }
  } catch {
    // fall through: not one of ours
  }
  return null;
}

async function mailSearch(args: Record<string, unknown>, context: MailToolContext = {}): Promise<MailToolResult> {
  const limit = clampInt(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const cursor = optStr(args.cursor);

  const { key: sortKey, order: sortOrder } = parseSort(args);

  // Continuation: resume a previously returned list id. The cursor carries
  // the sort settings (and, for the list() path, the unsent tail of the
  // current server page) so pages stay in the same order, nothing skipped.
  if (cursor) {
    const resolved = lookupCursor(cursor, sortKey, sortOrder);
    if (!resolved) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.MAIL_CURSOR_EXPIRED,
        "search cursor expired (the extension was reloaded or the cursor evicted); re-run mail_search for a fresh first page",
      );
    }
    const decoded = resolved.state;
    if (resolved.token) activeCursors.delete(resolved.token); // consumed

    // New-style incremental search: resume the in-flight scan.
    if (decoded.active) {
      const stale =
        decoded.lastAccessed !== undefined && Date.now() - decoded.lastAccessed > CURSOR_TTL_MS;
      if (stale) {
        abortActiveSearch(decoded.active);
        throw new PiBrowserProtocolError(
          PI_BROWSER_ERROR.MAIL_CURSOR_EXPIRED,
          "search cursor expired (the search was abandoned); re-run mail_search for a fresh first page",
        );
      }
      const resumeT0 = Date.now();
      const result = await continueActiveSearch(decoded.active, decoded.key, decoded.order, limit, context);
      mailLog(
        `mailSearch resume done: ${Date.now() - resumeT0}ms, returned=${(result.messages as unknown[]).length}, scanned=${result.scanned}, complete=${result.complete}, sortComplete=${result.sortComplete}, searchAge=${Date.now() - decoded.active.startedAt}ms`,
      );
      return result;
    }

    const key = decoded.key;
    const order = decoded.order;
    // A carry is already ordered (a search snapshot or folder-view page).
    // Legacy query cursors without carry still require per-page sorting.
    const isListPath = decoded.carry !== undefined;
    let buf: MailMessageRef[] = decoded.carry ?? [];
    let nextId: string | null = decoded.id || null;
    if (buf.length < limit && nextId) {
      const list = await browser.messages.continueList(nextId);
      buf.push(...(list && Array.isArray(list.messages) ? list.messages : []).map(normalizeHeader));
      nextId = list && list.id ? list.id : null;
    }
    const sorted = isListPath ? buf : bySort(buf, key, order);
    const messages = sorted.slice(0, limit);
    const carry = sorted.slice(limit);
    const more = carry.length > 0 || (nextId !== null && messages.length === limit);
    return {
      messages,
      nextCursor: more
        ? issueCursor({ id: nextId ?? "", key, order, carry: isListPath ? carry : undefined, lastAccessed: Date.now() })
        : null,
      complete: !more,
      // Snapshot carries contain every match and the folder view is
      // server-side sorted, so legacy pages are final-order when closed.
      sortComplete: true,
    };
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
  // Tag filter: resolve names/keys to keys, then build queryInfo.tags.
  const requestedTags = Array.isArray(args.tags)
    ? (args.tags as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (requestedTags.length > 0) {
    const all = await listTags();
    const { keys, unknown } = resolveTagKeys(all, requestedTags);
    if (unknown.length > 0) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.PI_NOT_FOUND,
        `unknown tag(s): ${unknown.join(", ")} (see mail_list_tags)`,
      );
    }
    const mode = args.tagMode === "all" ? "all" : "any";
    queryInfo.tags = { mode, tags: Object.fromEntries(keys.map((k) => [k, true])) };
  }

  // Filtered searches go through messages.query(); a plain listing of one
  // folder uses messages.list() with a server-side sort (the folder's own
  // view, what the UI shows; pages continue in sort order).
  const hasFilters = !!(
    queryInfo.fullText || queryInfo.author || queryInfo.recipients || queryInfo.subject ||
    queryInfo.fromDate || queryInfo.toDate ||
    typeof queryInfo.attachment === "boolean" || typeof queryInfo.unread === "boolean" ||
    queryInfo.tags
  );

  // Default scope: all folders for filtered searches, Inbox(es) for bare listings.
  // An explicit folderId takes precedence over scope. Default sort (date desc) matches the way
  // Thunderbird displays the Inbox, so a bare request returns the inbox as
  // the user sees it — without reading the UI.
  let note: string | undefined;
  let inboxes: string[] = [];
  if (!queryInfo.folderId && (args.scope === "inbox" || (!hasFilters && args.scope !== "all"))) {
    inboxes = await inboxFolderIds(accountId);
    if (inboxes.length === 0) {
      note = "No account inbox found; searched all folders.";
    } else if (inboxes.length === 1) {
      queryInfo.folderId = inboxes[0];
    }
  }

  if (inboxes.length > 1) queryInfo.folderId = inboxes;

  // Plain listing of a single folder: the folder's own sorted view.
  if (!hasFilters && typeof queryInfo.folderId === "string" && typeof browser.messages.list === "function") {
    const list = await browser.messages.list(queryInfo.folderId as string, {
      sortType: LIST_SORT[sortKey],
      sortOrder: sortOrder === "asc" ? "ascending" : "descending",
    });
    const buf = (list && Array.isArray(list.messages) ? list.messages : []).map(normalizeHeader);
    const nextId = list && list.id ? list.id : null;
    // Trust the server's folder-view order (it is the UI order) — no re-sort.
    const messages = buf.slice(0, limit);
    const carry = buf.slice(limit);
    const more = carry.length > 0 || (nextId !== null && messages.length === limit);
    const result: MailToolResult = {
      messages,
      // `carry` (possibly []) marks the cursor as list-path; query-path
      // cursors use `undefined`.
      nextCursor: more
        ? issueCursor({ id: nextId ?? "", key: sortKey, order: sortOrder, carry, lastAccessed: Date.now() })
        : null,
      complete: !more,
      // The folder's own sorted view: global ordering holds per page.
      sortComplete: true,
      scanned: buf.length,
    };
    if (note) result.note = note;
    return result;
  }

  // Gloda full-text path — the search bar's own engine (piSearch experiment
  // API). When the global index is enabled, a text query resolves through the
  // FTS3 index in sub-second time (vs the 45–100 s WDAPI literal-substring
  // scan) and returns the COMPLETE ranked result set at once: complete and
  // sortComplete are both true, and the WDAPI To/Cc/Bcc header phase is
  // unnecessary (author/recipient columns are indexed too).
  // Term semantics: words are AND-combined (FTS3), quoted spans are phrases.
  const piSearch = (browser as { piSearch?: { searchMessages?: (text: string, options?: { limit?: number; andTerms?: boolean }) => Promise<Array<Record<string, unknown>>> } }).piSearch;
  if (typeof queryInfo.fullText === "string" && typeof piSearch?.searchMessages === "function") {
    const gT0 = Date.now();
    const glodaLimit = Math.min(Math.max(limit, 1), 1000);
    mailLog(`mailSearch gloda start: text=${JSON.stringify(queryInfo.fullText)} limit=${glodaLimit}`);
    const hits = await piSearch.searchMessages(String(queryInfo.fullText), { limit: glodaLimit });
    mailLog(`mailSearch gloda: ${Date.now() - gT0}ms, ${hits.length} hit(s)`);
    const seen = new Set<number>();
    const refs: MailMessageRef[] = [];
    for (const h of hits) {
      const key = typeof h.messageKey === "number" ? h.messageKey : NaN;
      if (!Number.isFinite(key) || seen.has(key)) continue;
      seen.add(key);
      const ref: MailMessageRef = { messageId: key };
      if (typeof h.folderUri === "string") ref.folderId = h.folderUri;
      if (typeof h.subject === "string") ref.subject = h.subject;
      if (typeof h.date === "number") ref.date = new Date(h.date / 1000).toISOString();
      refs.push(ref);
    }
    const sorted = bySort(refs, sortKey, sortOrder);
    const messages = sorted.slice(0, limit);
    const carry = sorted.slice(limit);
    const result: MailToolResult = {
      messages,
      nextCursor: carry.length ? issueCursor({ id: "", key: sortKey, order: sortOrder, carry }) : null,
      complete: true,
      sortComplete: true,
      scanned: refs.length,
      note: "Searched the Gloda full-text index (the search-bar engine): terms are AND-combined, quoted spans match as phrases; results are relevance-ranked then sorted.",
    };
    if (note) result.note = `${result.note} ${note}`;
    if (messages.length > 0) reportBatch(context, result);
    context.onUpdate?.({ kind: "complete" });
    return result;
  }

  // Filtered search — incremental. Start the backend scan, return the first
  // available page; the rest (including the To/Cc/Bcc header phase) continues
  // across cursor calls. A scan that finishes on the first page stays as
  // fast as the old snapshot path and is globally sorted.
  const { fullText: _text, ...headerQuery } = queryInfo as Record<string, unknown>;
  const searchT0 = Date.now();
  mailLog(
    `mailSearch start: text=${JSON.stringify(queryInfo.fullText ?? null)} limit=${limit} sort=${sortKey}/${sortOrder} scope=${args.scope ?? (queryInfo.folderId ? "folder(s)" : "default")} folders=${Array.isArray(queryInfo.folderId) ? (queryInfo.folderId as string[]).length : queryInfo.folderId ?? "<all>"}`,
  );
  const firstPage = await browser.messages.query(queryInfo);
  mailLog(
    `first page from messages.query(): ${Date.now() - searchT0}ms, ${firstMsgsCount(firstPage)} msgs, listId=${firstPage && firstPage.id ? firstPage.id : "done"}`,
  );
  const firstMsgs = firstPage && Array.isArray(firstPage.messages) ? firstPage.messages : [];
  const state: ActiveSearch = {
    query: queryInfo,
    headerQuery: typeof queryInfo.fullText === "string" ? headerQuery : null,
    needle: typeof queryInfo.fullText === "string" ? String(queryInfo.fullText).toLowerCase() : null,
    phase: 1,
    listId: firstPage && firstPage.id ? firstPage.id : null,
    seenIds: new Set<number>(),
    scanned: firstMsgs.length,
    buffered: [],
    complete: false,
    sortComplete: false,
    note,
    startedAt: searchT0,
  };
  for (const m of firstMsgs) appendActiveMatch(state, m);
  if (state.listId === null && state.headerQuery === null) {
    state.complete = true;
    state.sortComplete = true;
  }
  if (state.complete) {
    const sorted = bySort(state.buffered, sortKey, sortOrder);
    const messages = sorted.slice(0, limit);
    const carry = sorted.slice(limit);
    const result: MailToolResult = {
      messages,
      // Remainder (past the page limit) keeps paging via a snapshot carry.
      nextCursor: carry.length ? issueCursor({ id: "", key: sortKey, order: sortOrder, carry }) : null,
      complete: true,
      sortComplete: true,
      scanned: state.scanned,
    };
    if (note) result.note = note;
    mailLog(
      `mailSearch first call (finished on page 1): total ${Date.now() - searchT0}ms, returned=${messages.length}, scanned=${state.scanned}`,
    );
    if (messages.length > 0) reportBatch(context, result);
    context.onUpdate?.({ kind: "complete" });
    return result;
  }
  // Early page: matches so far, not yet globally sorted.
  const early = state.buffered.splice(0, limit);
  const earlyResult: MailToolResult = {
    messages: early,
    nextCursor: issueCursor({ id: "", key: sortKey, order: sortOrder, active: state, lastAccessed: Date.now() }),
    complete: false,
    sortComplete: false,
    scanned: state.scanned,
  };
  if (note) earlyResult.note = note;
  mailLog(
    `mailSearch first call (early page): total ${Date.now() - searchT0}ms, returned=${early.length}, scanned=${state.scanned}, cursor issued`,
  );
  if (early.length > 0) reportBatch(context, earlyResult);
  return earlyResult;
}

/** Message count of a query page result (logging helper). */
function firstMsgsCount(page: { messages?: unknown } | null | undefined): number {
  return page && Array.isArray(page.messages) ? page.messages.length : 0;
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
async function mailListTags(): Promise<unknown> {
  return { tags: await listTags() };
}

/**
 * mail_debug_query — DIAGNOSTIC raw WDAPI query runner.
 *
 * Gated behind the manifest `piDebug` flag (dev builds only; the repo manifest
 * sets it, production installs would not). Runs
 * `browser.messages.query()` directly with wall-clock timing, and when the
 * query returns a messageListId (`returnMessageListId: true`) optionally
 * polls `continueList()` on an interval so a full scan can be profiled page
 * by page (time-to-first-page, per-page cadence, exhaustion).
 *
 * Input:  { query: <raw WDAPI queryInfo>, poll?: { intervalMs, maxMs } }
 * Output: { debugQuery: { kind, initialMs, polls?, total?, subjects? }, messages }
 */
const DEBUG_QUERY_KEYS = new Set([
  "fullText", "body", "subject", "author", "recipients", "folderId", "accountId",
  "fromDate", "toDate", "headerMessageId", "includeSubFolders", "flagged", "read",
  "new", "junk", "attachment", "size", "tags", "messagesPerPage",
  "autoPaginationTimeout", "returnMessageListId", "online", "fromMe", "toMe",
]);

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mailDebugQuery(args: Record<string, unknown>): Promise<MailToolResult> {
  const manifest = browser.runtime.getManifest() as unknown as Record<string, unknown>;
  if (manifest.piDebug !== true) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "mail_debug_query requires a piDebug build (manifest flag)");
  }
  const raw = (args.query ?? {}) as Record<string, unknown>;
  const query: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (DEBUG_QUERY_KEYS.has(k)) query[k] = v;
  if (Object.keys(query).length === 0) {
    throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "mail_debug_query: empty query — pass at least one WDAPI queryInfo key");
  }
  const pollReq = args.poll as { intervalMs?: number; maxMs?: number } | undefined;
  const interval = Math.max(250, Math.min(Number(pollReq?.intervalMs ?? 2000), 10_000));
  const maxMs = Math.min(Number(pollReq?.maxMs ?? 60_000), 110_000); // under the 120 s tool deadline

  mailLog(`debug_query start: ${JSON.stringify(query)} poll=${JSON.stringify({ interval, maxMs: pollReq ? maxMs : null })}`);
  const t0 = Date.now();
  const rawResult = (await browser.messages.query(query)) as browser.mailTypes.MessageList | string;
  const initialMs = Date.now() - t0;

  if (typeof rawResult === "string") {
    // returnMessageListId: poll the list for the scan-progress curve.
    const polls: Array<{ atMs: number; msgs: number; listId: string | null }> = [];
    const subjects: string[] = [];
    let listId: string | null = rawResult;
    let total = 0;
    const pollT0 = Date.now();
    while (listId && Date.now() - pollT0 < maxMs) {
      await sleepMs(interval);
      const page = await browser.messages.continueList(listId);
      const msgs = page && Array.isArray(page.messages) ? page.messages : [];
      total += msgs.length;
      for (const m of msgs) if (subjects.length < 5) subjects.push(m.subject ?? "");
      listId = page && page.id ? page.id : null;
      polls.push({ atMs: Date.now() - pollT0, msgs: msgs.length, listId });
      mailLog(`debug_query poll +${Date.now() - pollT0}ms: ${msgs.length} msgs (total=${total}) listId=${listId ?? "done"}`);
    }
    mailLog(`debug_query done: listId in ${initialMs}ms, polled ${polls.length} pages, ${total} msgs, exhausted=${listId === null}`);
    return {
      debugQuery: { kind: "listId", initialMs, polls, total, exhausted: listId === null, subjects },
      messages: [],
    };
  }

  const msgs = rawResult && Array.isArray(rawResult.messages) ? rawResult.messages : [];
  mailLog(`debug_query: ${initialMs}ms, ${msgs.length} msgs this page, listId=${rawResult?.id ?? "done"}`);
  return {
    debugQuery: { kind: "page", initialMs, pageCount: msgs.length, listId: rawResult?.id ?? null },
    messages: msgs.slice(0, 50).map((h) => normalizeHeader(h)),
  };
}

/**
 * Dispatch one mail tool call to the matching implementation.
 * `context` (optional) carries the session/call identity and the progress
 * channel for long-running tools; omit it for legacy callers.
 */
export async function dispatchMailTool(
  tool: string,
  args: Record<string, unknown>,
  context: MailToolContext = {},
): Promise<unknown> {
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
      return mailSearch(args, context);
    case "mail_list_attachments":
      return mailListAttachments(args);
    case "mail_get_attachment":
      return mailGetAttachment(args);
    case "mail_list_accounts":
      return mailListAccounts();
    case "mail_list_folders":
      return mailListFolders(args);
    case "mail_list_tags":
      return mailListTags();
    case "mail_debug_query":
      return mailDebugQuery(args);
    default:
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown mail tool: ${tool}`);
  }
}

/**
 * Test-only handles for the cursor registry (NOT part of the tool contract;
 * the registry is module state of the persistent background event page).
 */
export const __tests = {
  cursorCount: (): number => activeCursors.size,
  /** Backdate (or clear) a cursor's lastAccessed to simulate abandonment. */
  touchCursor: (token: string, ts: number | undefined): void => {
    const state = activeCursors.get(token);
    if (state) state.lastAccessed = ts;
  },
  clearCursors: (): void => {
    activeCursors.clear();
  },
};
