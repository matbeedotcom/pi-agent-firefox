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

test("PermissionStore (default paths): reads the v0.4.0 ~/.pi/browser file, saves to ~/.trusted-ua", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const home = mkdtempSync(pathMod.join(os.tmpdir(), "tua-perm-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, P: process.env.PI_BROWSER_PERMISSIONS_FILE, T: process.env.TRUSTED_UA_PERMISSIONS_FILE, D: process.env.PI_BROWSER_DATA_ROOT, TD: process.env.TRUSTED_UA_DATA_ROOT };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const k of ["PI_BROWSER_PERMISSIONS_FILE", "TRUSTED_UA_PERMISSIONS_FILE", "PI_BROWSER_DATA_ROOT", "TRUSTED_UA_DATA_ROOT"]) delete process.env[k];
    const legacyDir = pathMod.join(home, ".pi", "browser");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(pathMod.join(legacyDir, "permissions.json"), JSON.stringify({ version: 2, tools: { browser_screenshot: "allow" } }));
    const store = new PermissionStore();
    assert.equal(store.getState("browser_screenshot"), "allow", "v0.4.0 decision carried over");
    store.setState("browser_get_dom", "deny");
    const written = JSON.parse(readFileSync(pathMod.join(home, ".trusted-ua", "permissions.json"), "utf8"));
    assert.equal(written.tools.browser_screenshot, "allow", "migrated on first write");
    assert.equal(written.tools.browser_get_dom, "deny");
    assert.ok(JSON.parse(readFileSync(pathMod.join(legacyDir, "permissions.json"), "utf8")).tools.browser_screenshot, "old file kept");
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["USERPROFILE", saved.USERPROFILE], ["PI_BROWSER_PERMISSIONS_FILE", saved.P], ["TRUSTED_UA_PERMISSIONS_FILE", saved.T], ["PI_BROWSER_DATA_ROOT", saved.D], ["TRUSTED_UA_DATA_ROOT", saved.TD]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("defaultPermissionFilePath: ~/.trusted-ua/permissions.json, env override wins (new or old name)", () => {
  const prev = process.env.PI_BROWSER_PERMISSIONS_FILE;
  const prevNew = process.env.TRUSTED_UA_PERMISSIONS_FILE;
  try {
    delete process.env.PI_BROWSER_PERMISSIONS_FILE;
    delete process.env.TRUSTED_UA_PERMISSIONS_FILE;
    const def = defaultPermissionFilePath();
    assert.match(def, /permissions\.json$/);
    assert.match(def, /\.trusted-ua[\\/]/);

    process.env.TRUSTED_UA_PERMISSIONS_FILE = "/tmp/new-perms.json";
    process.env.PI_BROWSER_PERMISSIONS_FILE = "/tmp/old-perms.json";
    assert.equal(defaultPermissionFilePath(), "/tmp/new-perms.json", "the new name wins");
    delete process.env.TRUSTED_UA_PERMISSIONS_FILE;

    process.env.PI_BROWSER_PERMISSIONS_FILE = "/tmp/custom-perms.json";
    assert.equal(defaultPermissionFilePath(), "/tmp/custom-perms.json");
  } finally {
    if (prev === undefined) delete process.env.PI_BROWSER_PERMISSIONS_FILE;
    else process.env.PI_BROWSER_PERMISSIONS_FILE = prev;
    if (prevNew === undefined) delete process.env.TRUSTED_UA_PERMISSIONS_FILE;
    else process.env.TRUSTED_UA_PERMISSIONS_FILE = prevNew;
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
