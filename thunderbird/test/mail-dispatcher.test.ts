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
  selectedFolders?: Array<{ id?: string; name?: string }>;
  selectedMessages?: MsgHeader[];
  displayedMessages?: MsgHeader[];
  headers: Record<number, MsgHeader>;
  parts: Record<number, Part>;
  attachments: Record<number, Array<Record<string, unknown>>>;
  files: Record<string, { name: string; type: string; bytes: Uint8Array }>;
  accounts: Array<{ id: string; name: string; type?: string; identities: Array<Record<string, unknown>> }>;
  folders: Array<{ id?: string; name?: string; path?: string; accountId?: string; isRoot?: boolean }>;
  search: MsgHeader[];
  searchCursor?: string | null;
}

function freshStore(): Store {
  return {
    headers: {},
    parts: {},
    attachments: {},
    files: {},
    accounts: [],
    folders: [],
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
      async query() {
        return { id: "list-1", messages: store.search };
      },
      async continueList(listId: string) {
        assert.equal(listId, "list-1");
        return { id: null, messages: store.searchCursor ? [store.searchCursor as never] : [] };
      },
    },
    folders: {
      async query() {
        return store.folders;
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
  store.headers[9] = { id: 9, headerMessageId: "<9@x>", subject: "S", author: "A <a@x>", date: 1700000000000, read: true };
  const res = await call("mail_get_message", { messageId: 9 });
  assert.equal(res.messageId, 9);
  assert.equal(res.headerMessageId, "<9@x>");
  assert.equal(res.subject, "S");
  assert.equal(res.read, true);
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

test("mail_search: returns a page + a continuation cursor", async () => {
  store.search = [{ id: 10, subject: "match one" }, { id: 11, subject: "match two" }];
  const res = await call("mail_search", { text: "match" });
  assert.equal(res.messages.length, 2);
  assert.equal(res.nextCursor, "list-1");
});

test("mail_search: unknown tool is rejected; empty store yields empty page", async () => {
  const res = await call("mail_search", {});
  assert.deepEqual(res.messages, []);
  await assert.rejects(call("mail_definitely_not_a_tool"), (e: unknown) => e instanceof PiBrowserProtocolError);
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
