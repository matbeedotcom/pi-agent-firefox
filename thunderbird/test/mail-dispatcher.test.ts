/**
 * Unit tests for the Thunderbird mail tool dispatcher (plan §9–14).
 *
 * A fake `browser` global supplies the WebExtension mail APIs (mailTabs,
 * messageDisplay, messages, folders, accounts). These prove the tool
 * contract: normalized output shapes, the transient/durable id split, HTML→text
 * fallback, pagination, attachment truncation, and structured errors.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { dispatchMailTool } from "../src/background/mail-dispatcher.js";

// ---------------------------------------------------------------------------
// Fake mail store + browser stub
// ---------------------------------------------------------------------------

interface MsgHeader {
  id: number;
  headerMessageId?: string;
  subject?: string;
  author?: string;
  recipients?: string[];
  ccList?: string[];
  date?: string | number;
  read?: boolean;
  flagged?: boolean;
  tags?: string[];
  size?: number;
  folder?: { id?: string; name?: string };
}

interface Part {
  contentType?: string;
  partName?: string;
  body?: string;
  parts?: Part[];
}

interface Store {
  currentTab?: { tabId: number };
  selectedFolders?: Array<{ id?: string; name?: string; isUnified?: boolean; isVirtual?: boolean; isTag?: boolean }>;
  selectedMessages?: MsgHeader[];
  displayedMessages?: MsgHeader[];
  headers: Record<number, MsgHeader>;
  parts: Record<number, Part>;
  attachments: Record<number, Array<Record<string, unknown>>>;
  files: Record<string, { name: string; type: string; bytes: Uint8Array }>;
  accounts: Array<{
    id: string;
    name: string;
    type?: string;
    identities: Array<Record<string, unknown>>;
    rootFolder?: { id?: string };
  }>;
  folders: Array<{ id?: string; name?: string; path?: string; accountId?: string; isRoot?: boolean; isUnified?: boolean; isVirtual?: boolean; isTag?: boolean }>;
  lastList?: { folderId: string; options?: Record<string, unknown> };
  tags: Array<{ key: string; tag: string; color?: string }>;
  lastQuery?: Record<string, unknown>;
  search: MsgHeader[];
  searchByFolder?: Record<string, MsgHeader[]>;
  searchCursor?: MsgHeader | MsgHeader[];
  searchCursorId?: string | null;
}

function freshStore(): Store {
  return {
    headers: {},
    parts: {},
    attachments: {},
    files: {},
    accounts: [],
    folders: [],
    tags: [],
    search: [],
  };
}

let store: Store;

function installStub(): void {
  const g = globalThis as { browser?: unknown };
  g.browser = {
    mailTabs: {
      async getCurrent() {
        if (!store.currentTab) throw new Error("no current mail tab");
        return store.currentTab;
      },
      async query() {
        return store.currentTab ? [store.currentTab] : [];
      },
      async getSelectedFolders() {
        return store.selectedFolders ?? [];
      },
      async getSelectedMessages() {
        return { id: null, messages: store.selectedMessages ?? [] };
      },
    },
    messageDisplay: {
      async getDisplayedMessages() {
        return { id: null, messages: store.displayedMessages ?? [] };
      },
    },
    messages: {
      async get(id: number) {
        const h = store.headers[id];
        if (!h) throw new Error(`Message not found: ${id}.`);
        return h;
      },
      async getFull(id: number) {
        const p = store.parts[id];
        if (!p) throw new Error(`Message not found: ${id}.`);
        return p;
      },
      async listAttachments(id: number) {
        return store.attachments[id] ?? [];
      },
      async getAttachmentFile(id: number, partName: string) {
        const key = `${id}:${partName}`;
        const f = store.files[key];
        if (!f) throw new Error(`Attachment not found: ${partName}`);
        // File accepts a byte view at runtime; cast to satisfy the DOM lib.
        return new File([f.bytes as unknown as BlobPart], f.name, { type: f.type });
      },
      async query(queryInfo?: Record<string, unknown>) {
        store.lastQuery = queryInfo;
        const fid = queryInfo?.folderId as string | undefined;
        const pool = fid && store.searchByFolder?.[fid] ? store.searchByFolder[fid] : store.search;
        return { id: "list-1", messages: pool };
      },
      // Emulates messages.list(): a server-side SORTED folder view.
      async list(folderId: string, options?: Record<string, unknown>) {
        store.lastList = { folderId, options };
        const pool = (store.searchByFolder?.[folderId] ?? store.search).slice();
        const st = typeof options?.sortType === "string" ? options.sortType : "date";
        const dir = options?.sortOrder === "ascending" ? 1 : -1;
        const val = (h: MsgHeader): string | number =>
          st === "date"
            ? (h.date ? Date.parse(String(h.date)) : Number.NaN)
            : st === "author"
              ? (h.author ?? "")
              : (h.subject ?? "");
        pool.sort((a, b) => {
          const av = val(a);
          const bv = val(b);
          const c = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
          return c === 0 ? 0 : c * dir;
        });
        return { id: "list-1", messages: pool as never[] };
      },
      async continueList(listId: string) {
        assert.equal(listId, "list-1");
        const cur = store.searchCursor;
        const msgs: MsgHeader[] = cur ? (Array.isArray(cur) ? cur : [cur]) : [];
        return { id: store.searchCursorId ?? null, messages: msgs as never[] };
      },
      tags: {
        async list() {
          return store.tags ?? [];
        },
        async create(_key: string | null, tag: string) {
          // Mirror Thunderbird: return the (auto) key for the created tag.
          return tag.toLowerCase();
        },
      },
    },
    folders: {
      async query(queryInfo?: { accountId?: string }) {
        const all = store.folders;
        return queryInfo?.accountId ? all.filter((f) => f.accountId === queryInfo.accountId) : all;
      },
    },
    accounts: {
      async list() {
        return store.accounts;
      },
    },
  };
}

before(() => installStub());
after(() => delete (globalThis as { browser?: unknown }).browser);
beforeEach(() => {
  store = freshStore();
});

async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  return (await dispatchMailTool(tool, args)) as any;
}

// ---------------------------------------------------------------------------
// mail_get_context
// ---------------------------------------------------------------------------

test("mail_get_context: normalizes the tab, folders, selected and displayed messages", async () => {
  store.currentTab = { tabId: 7 };
  store.selectedFolders = [{ id: "f1", name: "Inbox" }];
  store.selectedMessages = [
    { id: 42, headerMessageId: "<abc@x>", subject: "Hi", author: "A <a@x>", recipients: ["b@x"], date: "2024-01-01T00:00:00Z", read: false, flagged: true, size: 123, folder: { id: "f1", name: "Inbox" } },
  ];
  store.displayedMessages = [{ id: 43, subject: "Other", author: "C <c@x>" }];

  const { context } = await call("mail_get_context");
  assert.deepEqual(context.tab, { tabId: 7, type: "mail" });
  assert.deepEqual(context.selectedFolders, [{ id: "f1", name: "Inbox" }]);
  assert.equal(context.selectedMessages.length, 1);
  const sel = context.selectedMessages[0];
  assert.equal(sel.messageId, 42);
  assert.equal(sel.headerMessageId, "<abc@x>");
  assert.equal(sel.subject, "Hi");
  assert.equal(sel.author, "A <a@x>");
  assert.deepEqual(sel.recipients, ["b@x"]);
  assert.equal(sel.date, "2024-01-01T00:00:00Z");
  assert.equal(sel.read, false);
  assert.equal(sel.flagged, true);
  assert.equal(sel.size, 123);
  assert.equal(sel.folder, "Inbox");
  assert.equal(sel.folderId, "f1");
  assert.equal(context.displayedMessages[0].messageId, 43);
});

test("mail_get_context: no mail tab yields a null tab and empty lists", async () => {
  const { context } = await call("mail_get_context");
  assert.equal(context.tab, null);
  assert.deepEqual(context.selectedFolders, []);
  assert.deepEqual(context.selectedMessages, []);
  assert.deepEqual(context.displayedMessages, []);
});

// ---------------------------------------------------------------------------
// mail_get_selected_messages / displayed
// ---------------------------------------------------------------------------

test("mail_get_selected_messages: defaults to the current tab", async () => {
  store.currentTab = { tabId: 5 };
  store.selectedMessages = [{ id: 1, subject: "One" }, { id: 2, subject: "Two" }];
  const { messages } = await call("mail_get_selected_messages");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((m: { messageId: number }) => m.messageId), [1, 2]);
});

test("mail_get_selected_messages: no mail tab -> MAIL_NO_CONTEXT", async () => {
  await assert.rejects(
    call("mail_get_selected_messages"),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MAIL_NO_CONTEXT,
  );
});

// ---------------------------------------------------------------------------
// mail_get_message
// ---------------------------------------------------------------------------

test("mail_get_message: returns normalized metadata", async () => {
  store.headers[9] = { id: 9, headerMessageId: "<9@x>", subject: "S", author: "A <a@x>", date: 1700000000000, read: true, tags: ["finance", "work"] };
  const res = await call("mail_get_message", { messageId: 9 });
  assert.equal(res.messageId, 9);
  assert.equal(res.headerMessageId, "<9@x>");
  assert.equal(res.subject, "S");
  assert.equal(res.read, true);
  // tags are exposed for read-back (T4 verification)
  assert.deepEqual(res.tags, ["finance", "work"]);
  // numeric date normalized to ISO
  assert.match(String(res.date), /^\d{4}-\d{2}-\d{2}T/);
});

test("mail_get_message: missing message -> MAIL_MESSAGE_NOT_FOUND", async () => {
  await assert.rejects(
    call("mail_get_message", { messageId: 999 }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MAIL_MESSAGE_NOT_FOUND,
  );
});

test("mail_get_message: requires messageId", async () => {
  await assert.rejects(call("mail_get_message"), (err: unknown) => err instanceof PiBrowserProtocolError);
});

// ---------------------------------------------------------------------------
// mail_get_message_body
// ---------------------------------------------------------------------------

test("mail_get_message_body: prefers plain text (auto)", async () => {
  store.parts[1] = {
    contentType: "multipart/alternative",
    partName: "0",
    parts: [
      { contentType: "text/plain", partName: "0.1", body: "plain body here" },
      { contentType: "text/html", partName: "0.2", body: "<html><body><p>html</p></body></html>" },
    ],
  };
  const { bodyText, truncated } = await call("mail_get_message_body", { messageId: 1 });
  assert.equal(bodyText, "plain body here");
  assert.equal(truncated, false);
});

test("mail_get_message_body: falls back to HTML-as-text when no plain part", async () => {
  store.parts[2] = { contentType: "text/html", partName: "0", body: "<html><body><p>Hello <b>world</b></p><br><p>second</p></body></html>" };
  const { bodyText } = await call("mail_get_message_body", { messageId: 2 });
  assert.match(String(bodyText), /Hello world/);
  assert.match(String(bodyText), /second/);
  assert.ok(!String(bodyText).includes("<"), "tags stripped");
});

test("mail_get_message_body: prefer=html converts HTML; prefer=text ignores HTML", async () => {
  store.parts[3] = {
    contentType: "multipart/alternative",
    partName: "0",
    parts: [
      { contentType: "text/plain", partName: "0.1", body: "PLAIN" },
      { contentType: "text/html", partName: "0.2", body: "<p>HTML-BODY</p>" },
    ],
  };
  const html = await call("mail_get_message_body", { messageId: 3, prefer: "html" });
  assert.equal(html.bodyText, "HTML-BODY");
  const text = await call("mail_get_message_body", { messageId: 3, prefer: "text" });
  assert.equal(text.bodyText, "PLAIN");
});

test("mail_get_message_body: truncates to maxChars", async () => {
  store.parts[4] = { contentType: "text/plain", partName: "0", body: "A".repeat(1000) };
  const { bodyText, truncated } = await call("mail_get_message_body", { messageId: 4, maxChars: 100 });
  assert.equal((bodyText as string).length, 100);
  assert.equal(truncated, true);
});

test("mail_get_message_body: no text part yields empty note", async () => {
  store.parts[5] = { contentType: "application/pdf", partName: "0", body: undefined };
  const { bodyText, note } = await call("mail_get_message_body", { messageId: 5 });
  assert.equal(bodyText, "");
  assert.ok(note);
});

// ---------------------------------------------------------------------------
// mail_search
// ---------------------------------------------------------------------------

test("mail_search: returns a page + an opaque continuation cursor", async () => {
  store.search = [
    { id: 11, subject: "old", date: "2024-01-01T00:00:00Z" },
    { id: 10, subject: "new", date: "2024-06-01T00:00:00Z" },
  ];
  const res = await call("mail_search", { text: "match" });
  // Each page is date-desc by default, even when the backend returns another order.
  assert.deepEqual(res.messages.map((m: any) => m.messageId), [10, 11]);
  // The cursor is a short opaque registry token, not the raw list id and
  // not an embedded payload (no more multi-KB base64 blobs in the LLM context).
  assert.match(res.nextCursor, /^sc[0-9a-f]{16}$/);
  assert.notEqual(res.nextCursor, "list-1");

  // Continuing with the returned cursor resumes the same underlying list…
  store.searchCursor = { id: 12, subject: "older", date: "2023-06-01T00:00:00Z" };
  const cont = await call("mail_search", { cursor: res.nextCursor });
  assert.equal(cont.messages.length, 1);
  assert.equal(cont.messages[0].messageId, 12);
  assert.equal(cont.nextCursor, null); // fake reports end of list
});

test("mail_search: sort settings are carried through the continuation cursor", async () => {
  store.search = [{ id: 10, subject: "banana" }];
  const res = await call("mail_search", { sort: "subject", order: "asc" });

  store.searchCursor = [{ id: 12, subject: "cherry" }, { id: 13, subject: "avocado" }];
  const cont = await call("mail_search", { cursor: res.nextCursor });
  // The continuation page is sorted with the SAME settings, not the defaults.
  assert.deepEqual(cont.messages.map((m: any) => m.messageId), [13, 12]);
});

test("mail_search: sort=subject orders by subject, missing subjects sink to the bottom", async () => {
  store.search = [
    { id: 10, subject: "banana" },
    { id: 11, subject: "apple" },
    { id: 12 },
  ];
  const res = await call("mail_search", { sort: "subject" });
  // desc (default): reverse-alphabetical, the subject-less message last.
  assert.deepEqual(res.messages.map((m: any) => m.messageId), [10, 11, 12]);

  const asc = await call("mail_search", { sort: "subject", order: "asc" });
  assert.deepEqual(asc.messages.map((m: any) => m.messageId), [11, 10, 12]);
});

test("mail_search: sort=from orders by author", async () => {
  store.search = [
    { id: 10, author: "Zed <zed@x>" },
    { id: 11, author: "Ann <ann@x>" },
  ];
  const res = await call("mail_search", { sort: "from", order: "asc" });
  assert.deepEqual(res.messages.map((m: any) => m.messageId), [11, 10]);
});

test("mail_search: invalid sort/order values are rejected", async () => {
  store.search = [{ id: 10 }];
  await assert.rejects(
    call("mail_search", { sort: "size" }),
    (e: unknown) => e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.INTERNAL,
  );
  await assert.rejects(
    call("mail_search", { order: "upwards" }),
    (e: unknown) => e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.INTERNAL,
  );
});

test("mail_search: a bare (pre-sort) cursor still works with default ordering", async () => {
  store.searchCursor = [{ id: 12, date: "2023-01-01T00:00:00Z" }, { id: 13, date: "2023-05-01T00:00:00Z" }];
  const cont = await call("mail_search", { cursor: "list-1" });
  assert.deepEqual(cont.messages.map((m: any) => m.messageId), [13, 12]);
});

test("mail_search: a legacy embedded (ps1.) cursor still decodes and continues", async () => {
  store.search = [{ id: 10, subject: "banana" }];
  const legacy = "ps1." + Buffer.from(
    JSON.stringify({ id: "list-1", sort: "subject", order: "asc" }),
  ).toString("base64");
  store.searchCursor = [{ id: 12, subject: "cherry" }, { id: 13, subject: "avocado" }];
  const cont = await call("mail_search", { cursor: legacy });
  assert.deepEqual(cont.messages.map((m: any) => m.messageId), [13, 12]);
});

test("mail_search: an unknown/evicted registry token fails with a structured cursor-expired error", async () => {
  await assert.rejects(
    call("mail_search", { cursor: "scdeadbeefdeadbeef" }),
    (e: unknown) =>
      e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.MAIL_CURSOR_EXPIRED,
  );
});

test("mail_search: unknown tool is rejected; empty store yields empty page", async () => {
  const res = await call("mail_search", {});
  assert.deepEqual(res.messages, []);
  await assert.rejects(call("mail_definitely_not_a_tool"), (e: unknown) => e instanceof PiBrowserProtocolError);
});

test("mail_search: filters by tag, resolving names to keys (mode any by default)", async () => {
  store.tags = [{ key: "finance", tag: "Finance", color: "#A00000" }];
  store.search = [{ id: 10, subject: "invoice", tags: ["finance"] }];
  const res = await call("mail_search", { tags: ["Finance"] });
  assert.equal(res.messages.length, 1);
  // The query is built with the KEY (not the name) and the default OR mode.
  assert.deepEqual(store.lastQuery?.tags, { mode: "any", tags: { finance: true } });
});

test("mail_search: multiple tags with tagMode=all build an AND filter", async () => {
  store.tags = [
    { key: "finance", tag: "Finance" },
    { key: "work", tag: "Work" },
  ];
  store.search = [];
  await call("mail_search", { tags: ["finance", "work"], tagMode: "all" });
  assert.deepEqual(store.lastQuery?.tags, { mode: "all", tags: { finance: true, work: true } });
});

test("mail_search: unknown tag name -> PI_NOT_FOUND", async () => {
  store.tags = [{ key: "finance", tag: "Finance" }];
  await assert.rejects(
    call("mail_search", { tags: ["nonexistent"] }),
    (e: unknown) => e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.PI_NOT_FOUND,
  );
});

test("mail_search: defaults to the account Inbox when no folderId is given", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  store.folders = [
    { id: "acct1-inbox", name: "Inbox", path: "/INBOX", accountId: "a1" },
  ];
  store.search = [{ id: 10 }];
  await call("mail_search", { text: "x" });
  assert.equal(store.lastQuery?.folderId, "acct1-inbox");
});

test("mail_search: the IMAP inbox is the /INBOX child, not the server root", async () => {
  // Regression: resolving the account root as "the inbox" made default
  // searches return [] for IMAP accounts, whose messages live in /INBOX.
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1://imap.work.example" } },
  ];
  store.folders = [
    { id: "acct1://imap.work.example", name: "work.example", path: "/", accountId: "a1", isRoot: true },
    { id: "acct1://INBOX", name: "Inbox", path: "/INBOX", accountId: "a1" },
    { id: "acct1://Sent Messages", name: "Sent Messages", path: "/Sent Messages", accountId: "a1" },
  ];
  store.searchByFolder = { "acct1://INBOX": [{ id: 10, subject: "in the inbox" }] };
  const res = await call("mail_search", {});
  // A bare listing uses the folder's own sorted view (messages.list), not query.
  assert.equal(store.lastList?.folderId, "acct1://INBOX");
  assert.equal(store.lastQuery, undefined);
  assert.deepEqual(store.lastList?.options, { sortType: "date", sortOrder: "descending" });
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].messageId, 10);
});

test("mail_search: an open mail tab does not change the default Inbox scope", async () => {
  store.currentTab = { tabId: 7 };
  store.selectedFolders = [{ id: "sent-1", name: "Sent" }];
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  store.folders = [
    { id: "acct1-inbox", name: "Inbox", path: "/INBOX", accountId: "a1" },
  ];
  store.search = [{ id: 10 }];
  await call("mail_search", {});
  // The default is always the account Inbox — never the selected/on-screen folder.
  assert.equal(store.lastList?.folderId, "acct1-inbox");
});

test("mail_search: scope:'all' searches every folder", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  await call("mail_search", { scope: "all" });
  assert.equal(store.lastQuery?.folderId, undefined);
});

test("mail_search: explicit folderId overrides scope", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  await call("mail_search", { folderId: "archive-99", scope: "all" });
  assert.equal(store.lastList?.folderId, "archive-99");
});

test("mail_search: unfiltered sort=from order=asc maps to list sortType=author ascending", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  store.folders = [
    { id: "acct1-inbox", name: "Inbox", path: "/INBOX", accountId: "a1" },
  ];
  store.searchByFolder = {
    "acct1-inbox": [
      { id: 10, author: "Zed <z@x>", date: "2024-01-01T00:00:00Z" },
      { id: 11, author: "Ann <a@x>", date: "2024-06-01T00:00:00Z" },
    ],
  };
  const res = await call("mail_search", { sort: "from", order: "asc" });
  assert.deepEqual(store.lastList?.options, { sortType: "author", sortOrder: "ascending" });
  assert.deepEqual(res.messages.map((m: any) => m.messageId), [11, 10]);
});

test("mail_search: a filtered search still uses messages.query with per-page sort", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  store.folders = [
    { id: "acct1-inbox", name: "Inbox", path: "/INBOX", accountId: "a1" },
  ];
  store.search = [
    { id: 11, date: "2024-01-01T00:00:00Z" },
    { id: 10, date: "2024-06-01T00:00:00Z" },
  ];
  const res = await call("mail_search", { text: "x" });
  assert.equal(store.lastList, undefined);
  assert.equal(store.lastQuery?.fullText, "x");
  assert.deepEqual(res.messages.map((m: any) => m.messageId), [10, 11]);
});

test("mail_search: list() continuation keeps the folder-view order via the cursor carry", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  store.folders = [
    { id: "acct1-inbox", name: "Inbox", path: "/INBOX", accountId: "a1" },
  ];
  const d = (n: number) => `2024-01-0${n}T00:00:00Z`;
  store.searchByFolder = {
    "acct1-inbox": [1, 2, 3, 4, 5].map((n) => ({ id: n, date: d(n) })),
  };
  const p1 = await call("mail_search", { limit: 2 });
  assert.deepEqual(p1.messages.map((m: any) => m.messageId), [5, 4]);
  assert.ok(p1.nextCursor);
  const p2 = await call("mail_search", { cursor: p1.nextCursor, limit: 2 });
  // Served from the cursor carry — no continueList round-trip yet.
  assert.deepEqual(p2.messages.map((m: any) => m.messageId), [3, 2]);
  assert.ok(p2.nextCursor);
  const p3 = await call("mail_search", { cursor: p2.nextCursor, limit: 2 });
  // The carry ran out: the next server page is fetched (empty) and the last
  // message is returned.
  assert.deepEqual(p3.messages.map((m: any) => m.messageId), [1]);
  assert.equal(p3.nextCursor, null);
});

test("mail_search: non-Latin1 message data round-trips through the cursor", async () => {
  // btoa() throws on characters above Latin1; the cursor carry holds whole
  // messages (subjects/authors with arbitrary Unicode).
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  store.folders = [
    { id: "acct1-inbox", name: "Inbox", path: "/INBOX", accountId: "a1" },
  ];
  store.searchByFolder = {
    "acct1-inbox": [
      { id: 1, subject: "café ☕ 日本語", author: "José Müller <j@x>", date: "2024-03-01T00:00:00Z" },
      { id: 2, subject: "plain", date: "2024-02-01T00:00:00Z" },
      { id: 3, subject: "émoji 👋", date: "2024-01-01T00:00:00Z" },
    ],
  };
  const p1 = await call("mail_search", { limit: 2 });
  assert.deepEqual(p1.messages.map((m: any) => m.messageId), [1, 2]);
  assert.ok(p1.nextCursor);
  const p2 = await call("mail_search", { cursor: p1.nextCursor, limit: 2 });
  assert.equal(p2.messages.length, 1);
  assert.equal(p2.messages[0].messageId, 3);
  // The carried message survives the base64 round-trip intact.
  assert.equal(p2.messages[0].subject, "émoji 👋");
  assert.equal(p2.nextCursor, null);
});

test("mail_search: falls back to messages.query when list() is unavailable", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "acct1-inbox" } },
  ];
  store.folders = [
    { id: "acct1-inbox", name: "Inbox", path: "/INBOX", accountId: "a1" },
  ];
  store.search = [
    { id: 11, date: "2024-01-01T00:00:00Z" },
    { id: 10, date: "2024-06-01T00:00:00Z" },
  ];
  const msgs = (globalThis as { browser?: { messages?: Record<string, unknown> } }).browser!.messages!;
  const saved = msgs.list;
  delete msgs.list;
  try {
    const res = await call("mail_search", {});
    assert.equal(store.lastList, undefined);
    assert.equal(store.lastQuery?.folderId, "acct1-inbox");
    assert.deepEqual(res.messages.map((m: any) => m.messageId), [10, 11]); // client-side sorted
  } finally {
    if (saved) msgs.list = saved;
  }
});

test("mail_search: multiple inboxes are merged date-desc and not paginated", async () => {
  store.accounts = [
    { id: "a1", name: "Work", type: "imap", identities: [], rootFolder: { id: "in1" } },
    { id: "a2", name: "Home", type: "pop3", identities: [], rootFolder: { id: "in2" } },
  ];
  store.folders = [
    { id: "in1", name: "Inbox", path: "/INBOX", accountId: "a1" },
    { id: "in2", name: "Inbox", accountId: "a2", isRoot: true },
  ];
  store.searchByFolder = {
    in1: [{ id: 1, subject: "old work", date: "2024-01-01T00:00:00Z" }],
    in2: [{ id: 2, subject: "new home", date: "2024-06-01T00:00:00Z" }],
  };
  const res = await call("mail_search", { text: "x" });
  assert.deepEqual(res.messages.map((m: any) => m.messageId), [2, 1]);
  assert.equal(res.nextCursor, null);
  assert.match(res.note, /2 inboxes/);
});

test("mail_search: no real mail account falls back to all folders with a note", async () => {
  store.accounts = [{ id: "a1", name: "Local Folders", type: "none", identities: [] }];
  store.search = [{ id: 10 }];
  const res = await call("mail_search", { text: "x" });
  assert.equal(store.lastQuery?.folderId, undefined);
  assert.equal(res.messages.length, 1);
  assert.match(res.note, /searched all folders/);
});

test("mail_list_tags: returns normalized { key, name, color }", async () => {
  store.tags = [{ key: "finance", tag: "Finance", color: "#A00000" }, { key: "work", tag: "Work" }];
  const { tags } = await call("mail_list_tags");
  assert.deepEqual(tags, [
    { key: "finance", name: "Finance", color: "#A00000" },
    { key: "work", name: "Work" },
  ]);
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

test("mail_list_attachments: normalizes attachment metadata", async () => {
  store.attachments[20] = [
    { partName: "1", name: "report.pdf", contentType: "application/pdf", size: 2048, contentDisposition: "attachment", type: "attachment" },
  ];
  const { attachments } = await call("mail_list_attachments", { messageId: 20 });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].partName, "1");
  assert.equal(attachments[0].name, "report.pdf");
  assert.equal(attachments[0].size, 2048);
});

test("mail_get_attachment: returns base64 and truncates large files", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  store.files["30:1"] = { name: "data.bin", type: "application/octet-stream", bytes };
  const full = await call("mail_get_attachment", { messageId: 30, partName: "1" });
  assert.equal(full.name, "data.bin");
  assert.equal(full.size, 8);
  assert.equal(full.truncated, false);
  assert.equal(Buffer.from(full.data as string, "base64").length, 8);

  const trunc = await call("mail_get_attachment", { messageId: 30, partName: "1", maxBytes: 3 });
  assert.equal(trunc.truncated, true);
  assert.equal(Buffer.from(trunc.data as string, "base64").length, 3);
});

test("mail_get_attachment: missing file -> MAIL_ATTACHMENT_NOT_FOUND", async () => {
  await assert.rejects(
    call("mail_get_attachment", { messageId: 31, partName: "x" }),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MAIL_ATTACHMENT_NOT_FOUND,
  );
});

// ---------------------------------------------------------------------------
// accounts + folders
// ---------------------------------------------------------------------------

test("mail_list_accounts: normalizes accounts and marks the first identity default", async () => {
  store.accounts = [
    { id: "acc1", name: "Work", type: "imap", identities: [{ id: "id1", name: "Me", email: "me@work" }, { id: "id2", email: "alt@work" }] },
  ];
  const { accounts } = await call("mail_list_accounts");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "acc1");
  assert.equal(accounts[0].identities.length, 2);
  assert.equal(accounts[0].identities[0].isDefault, true);
  assert.equal(accounts[0].identities[0].email, "me@work");
  assert.equal(accounts[0].identities[1].isDefault, undefined);
});

test("mail_list_folders: normalizes folders", async () => {
  store.folders = [
    { id: "f1", name: "Inbox", path: "INBOX", accountId: "acc1" },
    { id: "f2", name: "Sent", isRoot: true },
  ];
  const { folders } = await call("mail_list_folders");
  assert.equal(folders.length, 2);
  assert.equal(folders[0].name, "Inbox");
  assert.equal(folders[1].isRoot, true);
});
