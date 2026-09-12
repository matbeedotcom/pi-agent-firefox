/**
 * Unit tests for the Thunderbird mail-organization (T4) dispatcher (plan §39).
 *
 * A fake `browser.messages` records every mutation call. These prove the contract:
 * the right update/move/archive call with the right arguments, additive vs
 * replace tagging, and — critically — NO delete / permanent-delete path exists.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { PI_BROWSER_ERROR, PiBrowserProtocolError } from "@pi-browser/protocol";
import { dispatchMutationTool } from "../src/background/mutation-dispatcher.js";
import { keyForName } from "../src/background/tag-utils.js";

interface Call {
  fn: string;
  args: unknown[];
}

interface Store {
  calls: Call[];
  tags: Record<number, string[]>;
  read: Record<number, boolean>;
  definedTags: Array<{ key: string; tag: string; color?: string }>;
}

let store: Store;
function freshStore(): Store {
  return { calls: [], tags: {}, read: {}, definedTags: [] };
}

function installStub(): void {
  const g = globalThis as { browser?: unknown };
  g.browser = {
    messages: {
      async update(messageId: number, newProperties: Record<string, unknown>) {
        store.calls.push({ fn: "update", args: [messageId, newProperties] });
        if (newProperties.tags) store.tags[messageId] = newProperties.tags as string[];
        if (typeof newProperties.read === "boolean") store.read[messageId] = newProperties.read;
      },
      async get(messageId: number) {
        return { id: messageId, tags: store.tags[messageId] ?? [], read: store.read[messageId] ?? false };
      },
      async archive(messageIds: number[]) {
        store.calls.push({ fn: "archive", args: [messageIds] });
      },
      async move(messageIds: number[], folderId: string) {
        store.calls.push({ fn: "move", args: [messageIds, folderId] });
      },
      tags: {
        async list() {
          return store.definedTags;
        },
        async create(key: string, tag: string, _color?: string) {
          const k = key.toLowerCase();
          store.definedTags.push({ key: k, tag });
          store.calls.push({ fn: "tags.create", args: [key, tag] });
          return k;
        },
      },
    },
  };
}

before(installStub);
after(() => {
  delete (globalThis as { browser?: unknown }).browser;
});
beforeEach(() => {
  store = freshStore();
});

test("mail_mark_read updates each selected message", async () => {
  const r = (await dispatchMutationTool("mail_mark_read", { messageIds: [1, 2, 3], read: false })) as Record<
    string,
    unknown
  >;
  assert.equal(r.count, 3);
  const updates = store.calls.filter((c) => c.fn === "update");
  assert.equal(updates.length, 3);
  assert.ok(updates.every((c) => (c.args[1] as Record<string, unknown>).read === false));
});

test("mail_set_tags is additive by default (resolves names to keys, merges)", async () => {
  store.definedTags = [
    { key: "work", tag: "Work" },
    { key: "finance", tag: "Finance" },
  ];
  store.tags[5] = ["work"]; // existing tags on the message (keys)
  const r = (await dispatchMutationTool("mail_set_tags", { messageIds: [5], tags: ["Finance"] })) as Record<string, unknown>;
  const upd = store.calls.find((c) => c.fn === "update");
  assert.ok(upd);
  // "Finance" resolved to key "finance"; additive union with existing "work".
  assert.deepEqual(new Set((upd!.args[1] as { tags: string[] }).tags), new Set(["work", "finance"]));
  assert.deepEqual(r.created, []);
});

test("mail_set_tags with additive=false replaces tags", async () => {
  store.definedTags = [
    { key: "work", tag: "Work" },
    { key: "urgent", tag: "Urgent" },
    { key: "finance", tag: "Finance" },
  ];
  store.tags[5] = ["work", "urgent"];
  await dispatchMutationTool("mail_set_tags", { messageIds: [5], tags: ["Finance"], additive: false });
  const upd = store.calls.find((c) => c.fn === "update");
  assert.deepEqual((upd!.args[1] as { tags: string[] }).tags, ["finance"]);
});

test("mail_set_tags creates a tag that does not exist yet", async () => {
  store.definedTags = [];
  store.tags[5] = [];
  const r = (await dispatchMutationTool("mail_set_tags", { messageIds: [5], tags: ["NewProj"] })) as Record<string, unknown>;
  const upd = store.calls.find((c) => c.fn === "update");
  // "NewProj" was created (key "newproj") and applied.
  assert.deepEqual((upd!.args[1] as { tags: string[] }).tags, ["newproj"]);
  assert.deepEqual(r.created, ["NewProj"]);
  assert.ok(store.definedTags.some((t) => t.key === "newproj"));
});

test("keyForName derives a valid key and avoids collisions", () => {
  assert.equal(keyForName("Finance", []), "finance");
  assert.equal(keyForName("My Project", []), "my-project");
  assert.equal(keyForName("Finance", ["finance"]), "finance-2");
  assert.equal(keyForName("Finance", ["finance", "finance-2"]), "finance-3");
  assert.equal(keyForName("", []), "tag");
});

test("mail_archive calls messages.archive with the selected ids", async () => {
  const r = (await dispatchMutationTool("mail_archive", { messageIds: [1, 2] })) as Record<string, unknown>;
  assert.equal(r.count, 2);
  const arch = store.calls.find((c) => c.fn === "archive");
  assert.deepEqual(arch!.args[0], [1, 2]);
  assert.match(String(r.note), /reversible/i);
});

test("mail_move calls messages.move with ids + folderId", async () => {
  await dispatchMutationTool("mail_move", { messageIds: [7], folderId: "folder-xyz" });
  const mv = store.calls.find((c) => c.fn === "move");
  assert.deepEqual(mv!.args[0], [7]);
  assert.equal(mv!.args[1], "folder-xyz");
});

test("messageIds must be a non-empty array of numbers", async () => {
  await assert.rejects(
    dispatchMutationTool("mail_archive", { messageIds: [] }),
    (e: unknown) =>
      e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.INTERNAL && /messageIds/.test(e.message),
  );
});

test("no delete / permanent-delete path exists", async () => {
  await dispatchMutationTool("mail_archive", { messageIds: [1] });
  await dispatchMutationTool("mail_set_tags", { messageIds: [1], tags: ["x"] });
  const fns = store.calls.map((c) => c.fn);
  assert.ok(!fns.some((f) => /delete/i.test(f)), "no delete function was called");
  // mail_delete is not a known mutation tool.
  await assert.rejects(
    dispatchMutationTool("mail_delete", { messageIds: [1] }),
    (e: unknown) => e instanceof PiBrowserProtocolError && e.code === PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND,
  );
});
