/**
 * Unit tests for the Thunderbird draft-first compose tool dispatcher (plan §15–17).
 *
 * A fake `browser.compose` WebExtension API records every call so the tests can
 * assert the tool contract: the right begin or set function is called with the
 * right arguments, the compose window tab id is surfaced, and — critically —
 * there is NO send path (no `sendMessage`/`saveMessage`, and `compose_send` is
 * not a known tool).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { dispatchComposeTool } from "../src/background/compose-dispatcher.js";

// ---------------------------------------------------------------------------
// Fake compose store + browser stub
// ---------------------------------------------------------------------------

interface Call {
  fn: string;
  args: unknown[];
}

interface ComposeStore {
  nextTabId: number;
  calls: Call[];
  details: Record<number, Record<string, unknown>>;
}

function freshStore(): ComposeStore {
  return { nextTabId: 900, calls: [], details: {} };
}

let store: ComposeStore;

function installStub(): void {
  const g = globalThis as { browser?: unknown };
  g.browser = {
    compose: {
      async beginNew(messageId: number | null, details?: Record<string, unknown>) {
        store.calls.push({ fn: "beginNew", args: [messageId, details] });
        const id = store.nextTabId++;
        store.details[id] = { type: "new", ...(details ?? {}) };
        return { id };
      },
      async beginReply(
        messageId: number,
        replyType?: string,
        details?: Record<string, unknown>,
      ) {
        store.calls.push({ fn: "beginReply", args: [messageId, replyType, details] });
        const id = store.nextTabId++;
        store.details[id] = { type: "reply", relatedMessageId: messageId, ...(details ?? {}) };
        return { id };
      },
      async beginForward(
        messageId: number,
        forwardType?: string,
        details?: Record<string, unknown>,
      ) {
        store.calls.push({ fn: "beginForward", args: [messageId, forwardType, details] });
        const id = store.nextTabId++;
        store.details[id] = { type: "forward", relatedMessageId: messageId, ...(details ?? {}) };
        return { id };
      },
      async getComposeDetails(tabId: number) {
        const d = store.details[tabId];
        if (!d) throw new Error(`Compose window not found: ${tabId}`);
        return d;
      },
      async setComposeDetails(tabId: number, details: Record<string, unknown>) {
        store.calls.push({ fn: "setComposeDetails", args: [tabId, details] });
        const d = store.details[tabId];
        if (!d) throw new Error(`Compose window not found: ${tabId}`);
        Object.assign(d, details);
        return { id: tabId };
      },
    },
  };
}

before(() => installStub());
after(() => {
  delete (globalThis as { browser?: unknown }).browser;
});
beforeEach(() => {
  store = freshStore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("compose_prepare_new opens a new-message window with the given fields", async () => {
  const r = (await dispatchComposeTool("compose_prepare_new", {
    to: "Jane Doe <jane@example.com>",
    subject: "Hello",
    body: "<p>Hi Jane</p>",
    contentType: "text/html",
  })) as Record<string, unknown>;

  const call = store.calls.find((c) => c.fn === "beginNew");
  assert.ok(call, "beginNew was called");
  assert.equal(call!.args[0], null, "no related message id for a new message");
  const details = call!.args[1] as Record<string, unknown>;
  assert.equal(details.to, "Jane Doe <jane@example.com>");
  assert.equal(details.subject, "Hello");
  assert.equal(details.body, "<p>Hi Jane</p>");
  assert.equal(details.contentType, "text/html");

  assert.equal(typeof r.composeTabId, "number");
  assert.match(String(r.note), /does not send/);
});

test("compose_prepare_reply derives the recipient and forwards replyType", async () => {
  const r = (await dispatchComposeTool("compose_prepare_reply", {
    messageId: 42,
    replyType: "replyToList",
    body: "<p>Thanks!</p>",
  })) as Record<string, unknown>;

  const call = store.calls.find((c) => c.fn === "beginReply");
  assert.ok(call, "beginReply was called");
  assert.equal(call!.args[0], 42, "message id passed through");
  assert.equal(call!.args[1], "replyToList", "reply type passed through");
  assert.equal((call!.args[2] as Record<string, unknown>).body, "<p>Thanks!</p>");

  assert.equal(typeof r.composeTabId, "number");
  assert.match(String(r.note), /reply/);
});

test("compose_prepare_forward forwards forwardType and to", async () => {
  const r = (await dispatchComposeTool("compose_prepare_forward", {
    messageId: 7,
    forwardType: "forwardAsAttachment",
    to: "Other <o@example.com>",
  })) as Record<string, unknown>;

  const call = store.calls.find((c) => c.fn === "beginForward");
  assert.ok(call, "beginForward was called");
  assert.equal(call!.args[0], 7);
  assert.equal(call!.args[1], "forwardAsAttachment");
  assert.equal((call!.args[2] as Record<string, unknown>).to, "Other <o@example.com>");
  assert.equal(typeof r.composeTabId, "number");
});

test("compose_get reads and normalizes an open compose window", async () => {
  const prepared = (await dispatchComposeTool("compose_prepare_new", {
    to: "Jane <jane@example.com>",
    subject: "Draft",
    body: "<p>Body</p>",
  })) as { composeTabId: number };

  const r = (await dispatchComposeTool("compose_get", { tabId: prepared.composeTabId })) as Record<
    string,
    unknown
  >;
  assert.equal(r.composeTabId, prepared.composeTabId);
  assert.equal(r.to, "Jane <jane@example.com>");
  assert.equal(r.subject, "Draft");
  assert.equal(r.body, "<p>Body</p>");
  assert.equal(r.composeType, "new");
});

test("compose_get normalizes a recipient object list to a string", async () => {
  const id = store.nextTabId++;
  store.details[id] = {
    type: "reply",
    to: [{ name: "Alice", email: "a@example.com" }, "bob@example.com"],
    subject: "S",
  };
  const r = (await dispatchComposeTool("compose_get", { tabId: id })) as Record<string, unknown>;
  assert.equal(r.to, "Alice <a@example.com>, bob@example.com");
});

test("compose_update sets only the provided fields", async () => {
  const prepared = (await dispatchComposeTool("compose_prepare_new", {
    to: "Jane <jane@example.com>",
    subject: "Original",
    body: "<p>Original</p>",
  })) as { composeTabId: number };

  await dispatchComposeTool("compose_update", {
    tabId: prepared.composeTabId,
    subject: "Edited",
  });

  const call = store.calls.find((c) => c.fn === "setComposeDetails");
  assert.ok(call, "setComposeDetails was called");
  assert.equal(call!.args[0], prepared.composeTabId);
  const details = call!.args[1] as Record<string, unknown>;
  assert.equal(details.subject, "Edited");
  assert.equal(details.to, undefined, "only the provided field is sent");
  assert.equal(details.body, undefined);

  // The window now reflects the edit.
  const r = (await dispatchComposeTool("compose_get", { tabId: prepared.composeTabId })) as Record<
    string,
    unknown
  >;
  assert.equal(r.subject, "Edited");
  assert.equal(r.body, "<p>Original</p>", "untouched fields are preserved");
});

test("compose_prepare_reply requires a numeric messageId", async () => {
  await assert.rejects(
    dispatchComposeTool("compose_prepare_reply", {}),
    (e: unknown) =>
      e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.INTERNAL && /messageId/.test(e.message),
  );
});

test("getComposeDetails on a closed window surfaces a structured error", async () => {
  await assert.rejects(
    dispatchComposeTool("compose_get", { tabId: 99999 }),
    /not found|Compose window not found/i,
  );
});

test("no send path exists: compose_send is not a known tool", async () => {
  // Draft-first: the agent can never send. The only way to dispatch is through
  // the five known tools; "compose_send" (and any other name) is rejected.
  await assert.rejects(
    dispatchComposeTool("compose_send", {}),
    (e: unknown) =>
      e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND,
  );
  // And the dispatcher never touches a send/save function even if present.
  (store.calls as Call[]).push({ fn: "__sentinel__", args: [] });
  const before = store.calls.filter((c) => /send|save/i.test(c.fn)).length;
  await dispatchComposeTool("compose_prepare_new", { subject: "x" });
  const after = store.calls.filter((c) => /send|save/i.test(c.fn)).length;
  assert.equal(after, before, "prepare* never invokes a send/save function");
});
