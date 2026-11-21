import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionStore, defaultPermissionFilePath } from "../src/permission-store.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-permstore-")), "permissions.json");
}

test("PermissionStore: starts at ask, tri-state set round-trips, persists atomically", () => {
  const file = tempFile();
  const store = new PermissionStore({ filePath: file });
  assert.equal(store.getState("mail_search"), "ask");
  assert.equal(existsSync(file), false, "no file until the first decision");

  store.setState("mail_search", "allow");
  assert.equal(store.isAllowed("mail_search"), true);
  assert.ok(existsSync(file), "file created on first decision");

  // Atomic write: no stray .tmp left behind.
  assert.equal(existsSync(`${file}.tmp`), false);

  store.setState("mail_move", "deny");
  assert.equal(store.isDenied("mail_move"), true);
  store.setState("mail_search", "ask"); // back to default
  assert.equal(store.getState("mail_search"), "ask");
  assert.deepEqual(store.allowedTools(), []);
  assert.equal(store.isDenied("mail_move"), true);
});

test("PermissionStore: a fresh store over the same file sees the persisted states", () => {
  const file = tempFile();
  const a = new PermissionStore({ filePath: file });
  a.setState("mail_get_message", "allow");
  a.setState("contacts_search", "deny");

  const b = new PermissionStore({ filePath: file }); // "host restart"
  assert.equal(b.getState("mail_get_message"), "allow");
  assert.equal(b.getState("contacts_search"), "deny");
  assert.equal(b.getState("mail_search"), "ask");
});

test("PermissionStore: file format is v2 JSON with a tools map of states", () => {
  const file = tempFile();
  const store = new PermissionStore({ filePath: file });
  store.setState("mail_move", "deny");
  store.setState("mail_search", "allow");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; tools: Record<string, string> };
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.tools, { mail_move: "deny", mail_search: "allow" });
});

test("PermissionStore: v1 files (booleans) migrate to v2 on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-permstore-"));
  const file = join(dir, "permissions.json");
  writeFileSync(file, JSON.stringify({ version: 1, tools: { mail_search: true, browser_click: true } }) + "\n", "utf8");
  const store = new PermissionStore({ filePath: file });
  assert.equal(store.getState("mail_search"), "allow", "v1 true → allow");
  assert.equal(store.getState("browser_click"), "allow");
  // The next write upgrades the file to v2.
  store.setState("mail_move", "deny");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; tools: Record<string, string> };
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.tools, { browser_click: "allow", mail_move: "deny", mail_search: "allow" });
});

test("PermissionStore: corrupt file degrades to an empty store (safe default)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-permstore-"));
  const file = join(dir, "permissions.json");
  writeFileSync(file, "{not json", "utf8");
  const store = new PermissionStore({ filePath: file });
  assert.equal(store.getState("mail_search"), "ask", "corrupt file → ask everything");
  // A subsequent write replaces the corrupt file cleanly.
  store.setState("mail_search", "allow");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number };
  assert.equal(raw.version, 2);
});

test("PermissionStore: clearAll returns the cleared names and empties the store", () => {
  const file = tempFile();
  const store = new PermissionStore({ filePath: file });
  store.setState("b_tool", "allow");
  store.setState("a_tool", "deny");
  assert.deepEqual(store.clearAll(), ["a_tool", "b_tool"]);
  assert.deepEqual(store.allowedTools(), []);
  assert.equal(store.getState("a_tool"), "ask");
  // clearAll on an already-empty store is a no-op.
  assert.deepEqual(store.clearAll(), []);
});

test("PermissionStore: clear() is a no-op (no rewrite) when the tool has no decision", () => {
  const file = tempFile();
  const store = new PermissionStore({ filePath: file });
  store.clear("no_decision");
  assert.equal(existsSync(file), false, "no file created for a no-op clear");
});

test("defaultPermissionFilePath: ~/.pi/browser/permissions.json, env override wins", () => {
  const prev = process.env.PI_BROWSER_PERMISSIONS_FILE;
  try {
    delete process.env.PI_BROWSER_PERMISSIONS_FILE;
    const def = defaultPermissionFilePath();
    assert.match(def, /permissions\.json$/);
    assert.match(def, /\.pi[\\/]browser[\\/]/);

    process.env.PI_BROWSER_PERMISSIONS_FILE = "/tmp/custom-perms.json";
    assert.equal(defaultPermissionFilePath(), "/tmp/custom-perms.json");
  } finally {
    if (prev === undefined) delete process.env.PI_BROWSER_PERMISSIONS_FILE;
    else process.env.PI_BROWSER_PERMISSIONS_FILE = prev;
  }
});

test("PermissionStore: caller decisions are per app, persist, and externalAccess is stored only when off", () => {
  const file = tempFile();
  const store = new PermissionStore({ filePath: file });
  assert.equal(store.getExternalAccess(), true, "on by default");
  store.setCallerState("firefox", "codex", "allow");
  store.setCallerState("thunderbird", "codex", "deny");
  store.setState("mail_search", "allow");
  let raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(raw.callers, { firefox: { codex: "allow" }, thunderbird: { codex: "deny" } });
  assert.equal("externalAccess" in raw, false);

  store.setExternalAccess(false);
  const again = new PermissionStore({ filePath: file });
  assert.equal(again.getExternalAccess(), false);
  assert.equal(again.getCallerState("firefox", "codex"), "allow");
  assert.equal(again.getCallerState("thunderbird", "codex"), "deny");
  assert.equal(again.getState("mail_search"), "allow");
  assert.deepEqual(again.listCallers(), [
    { application: "firefox", name: "codex", state: "allow" },
    { application: "thunderbird", name: "codex", state: "deny" },
  ]);

  again.setCallerState("firefox", "codex", "ask");
  again.setExternalAccess(true);
  raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(raw.callers, { thunderbird: { codex: "deny" } });
  assert.equal("externalAccess" in raw, false);
  // clearAll clears tool decisions only.
  again.clearAll();
  assert.equal(again.getCallerState("thunderbird", "codex"), "deny");
});
