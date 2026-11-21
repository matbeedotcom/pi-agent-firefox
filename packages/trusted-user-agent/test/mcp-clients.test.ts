/**
 * `mcp <install|status|uninstall> [client]` adapters (openspec
 * external-mcp-callers, spec mcp-client-installers): temp homes, fake CLIs
 * on PATH, and a fake exec — nothing touches the real user configs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  removeCodexToml,
  readCodexEntry,
  parseTomlValue,
  runMcpClients,
  upsertCodexToml,
  vscodeUserDir,
  type McpClientContext,
} from "../src/installer/mcp-clients.js";
import { temporaryRootReason, runCommand } from "../src/installer/index.js";
import type { ExecResult } from "../src/installer/common.js";

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const exeName = (n: string) => (platform === "win32" ? `${n}.exe` : n);

interface Rig {
  ctx: McpClientContext;
  home: string;
  execs: Array<{ cmd: string; args: string[] }>;
  bridge: string;
}

/** A temp home; `clis` get fake executables on PATH; `exec` records calls. */
function rig(opts: { clis?: string[]; execResult?: (cmd: string, args: string[]) => ExecResult } = {}): Rig {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-clients-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const c of opts.clis ?? []) writeFileSync(path.join(bin, exeName(c)), "");
  const execs: Rig["execs"] = [];
  const pkgRoot = path.join(root, "pkg");
  const ctx: McpClientContext = {
    homeDir: home,
    platform,
    pkgRoot,
    nodePath: "/opt/node/bin/node",
    env: { PATH: bin, APPDATA: path.join(home, "AppData", "Roaming") },
    exec: async (cmd, args) => {
      execs.push({ cmd, args });
      return opts.execResult?.(cmd, args) ?? { code: 0, stdout: "", stderr: "" };
    },
  };
  return { ctx, home, execs, bridge: path.join(pkgRoot, "dist", "native-host", "mcp-stdio-main.js") };
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;

test("cursor: install keeps other servers, is idempotent, status and uninstall", async () => {
  const r = rig();
  const file = path.join(r.home, ".cursor", "mcp.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: "x" }, b: { url: "http://y" } }, other: 1 }, null, 2));

  let res = await runMcpClients("status", "cursor", r.ctx);
  assert.equal(res.ok, false);
  assert.match(res.lines[0], /missing/);

  res = await runMcpClients("install", "cursor", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  let config = readJson(file);
  assert.deepEqual(config.mcpServers.a, { command: "x" });
  assert.deepEqual(config.mcpServers.b, { url: "http://y" });
  assert.deepEqual(config.mcpServers["trusted-ua"], { command: "/opt/node/bin/node", args: [r.bridge] });
  assert.equal((config as unknown as { other: number }).other, 1);

  // Second install: reported current, file untouched.
  const before = readFileSync(file, "utf8");
  res = await runMcpClients("install", "cursor", r.ctx);
  assert.match(res.lines[0], /already current/);
  assert.equal(readFileSync(file, "utf8"), before);

  res = await runMcpClients("status", "cursor", r.ctx);
  assert.equal(res.ok, true);
  assert.match(res.lines[0], /current/);

  // A key the user added to the entry survives an update.
  config.mcpServers["trusted-ua"] = { ...config.mcpServers["trusted-ua"], args: ["/old/bridge.js"], env: { X: "1" } };
  writeFileSync(file, JSON.stringify(config));
  res = await runMcpClients("status", "cursor", r.ctx);
  assert.match(res.lines.join("\n"), /stale[\s\S]*configured: \/opt\/node\/bin\/node \/old\/bridge.js[\s\S]*expected:/);
  await runMcpClients("install", "cursor", r.ctx);
  config = readJson(file);
  assert.deepEqual(config.mcpServers["trusted-ua"], { command: "/opt/node/bin/node", args: [r.bridge], env: { X: "1" } });

  res = await runMcpClients("uninstall", "cursor", r.ctx);
  assert.equal(res.ok, true);
  config = readJson(file);
  assert.equal(config.mcpServers["trusted-ua"], undefined);
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["a", "b"]);
});

test("gemini: an unparseable settings.json is left untouched and reported; other clients still install", async () => {
  const r = rig();
  const gemini = path.join(r.home, ".gemini", "settings.json");
  mkdirSync(path.dirname(gemini), { recursive: true });
  writeFileSync(gemini, "{ not json");
  mkdirSync(path.join(r.home, ".cursor"), { recursive: true });

  const res = await runMcpClients("install", "all", r.ctx);
  assert.equal(res.ok, false, "an error makes the run fail");
  assert.equal(readFileSync(gemini, "utf8"), "{ not json", "never rewritten");
  const text = res.lines.join("\n");
  assert.match(text, /mcp gemini: error — .*settings\.json is not valid JSON/);
  assert.match(text, /mcp cursor: installed/);
  assert.ok(existsSync(path.join(r.home, ".cursor", "mcp.json")));
  assert.ok(existsSync(path.join(r.home, ".pi", "agent", "mcp.json")), "pi is part of all");
  assert.match(text, /mcp: pi=installed claude=skipped codex=skipped cursor=installed gemini=error vscode=skipped/);
});

test("vscode: servers map with type stdio in the user mcp.json", async () => {
  const r = rig();
  const dir = vscodeUserDir(r.ctx);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers: { other: { type: "http", url: "u" } }, inputs: [] }));
  const res = await runMcpClients("install", "vscode", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  const config = readJson(path.join(dir, "mcp.json"));
  assert.deepEqual(config.servers["trusted-ua"], { type: "stdio", command: "/opt/node/bin/node", args: [r.bridge] });
  assert.deepEqual(config.servers.other, { type: "http", url: "u" });
  assert.deepEqual((config as unknown as { inputs: unknown[] }).inputs, []);
});

test("claude: install and uninstall go through the claude CLI at user scope; status reads ~/.claude.json", async () => {
  const r = rig({ clis: ["claude"] });
  let res = await runMcpClients("install", "claude", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  const add = r.execs.find((e) => e.args.includes("add-json"));
  assert.ok(add, JSON.stringify(r.execs));
  assert.deepEqual(add.args.slice(0, 5), ["mcp", "add-json", "--scope", "user", "trusted-ua"]);
  assert.deepEqual(JSON.parse(add.args[5]), { type: "stdio", command: "/opt/node/bin/node", args: [r.bridge] });
  assert.equal(existsSync(path.join(r.home, ".claude.json")), false, "the installer never writes Claude's file");

  // Claude wrote its file: status reads it, second install is a no-op.
  writeFileSync(
    path.join(r.home, ".claude.json"),
    JSON.stringify({ mcpServers: { "trusted-ua": { type: "stdio", command: "/opt/node/bin/node", args: [r.bridge] } } }),
  );
  res = await runMcpClients("status", "claude", r.ctx);
  assert.match(res.lines[0], /current/);
  const n = r.execs.length;
  res = await runMcpClients("install", "claude", r.ctx);
  assert.match(res.lines[0], /already current/);
  assert.equal(r.execs.length, n, "no CLI call when current");

  res = await runMcpClients("uninstall", "claude", r.ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(r.execs.at(-1)?.args, ["mcp", "remove", "--scope", "user", "trusted-ua"]);
});

test("claude: a CLI failure is reported as an error", async () => {
  const r = rig({
    clis: ["claude"],
    execResult: (_c, args) => (args.includes("add-json") ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" }),
  });
  const res = await runMcpClients("install", "claude", r.ctx);
  assert.equal(res.ok, false);
  assert.match(res.lines[0], /claude mcp add-json failed \(exit 1\): boom/);
});

test("codex: the TOML table writer keeps comments and formatting", () => {
  const original = [
    "# my codex config",
    'model = "o3"  # favourite',
    "",
    "[mcp_servers.github]",
    'command = "npx"',
    'args = ["-y", "gh-mcp"]',
    "",
    '[projects."C:\\\\work"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const launch = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\pkg\\mcp-stdio-main.js"] };
  const added = upsertCodexToml(original, launch);
  assert.equal(
    added,
    original.trimEnd() +
      "\n\n[mcp_servers.trusted-ua]\n" +
      'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"\n' +
      'args = ["C:\\\\pkg\\\\mcp-stdio-main.js"]\n',
  );
  const entry = readCodexEntry(added);
  assert.deepEqual(entry, { kind: "present", command: launch.command, args: launch.args });

  // Update in place: user keys and a multi-line args array are handled.
  const tableAt = added.indexOf("[mcp_servers.trusted-ua]");
  const tuned =
    added.slice(0, tableAt) +
    added.slice(tableAt).replace(/args = \[.*\]/, 'args = [\n  "/old/bridge.js",\n]\nstartup_timeout_sec = 20 # mine');
  const updated = upsertCodexToml(tuned, launch);
  assert.match(updated, /startup_timeout_sec = 20 # mine/);
  assert.deepEqual(readCodexEntry(updated), { kind: "present", command: launch.command, args: launch.args });
  assert.ok(updated.startsWith(original.trimEnd()), "everything before the table is byte-for-byte unchanged");

  // Remove: the table (and its sub-tables) go, everything else stays.
  const withEnv = `${updated}[mcp_servers.trusted-ua.env]\nX = "1"\n\n[after]\nk = 1\n`;
  const removed = removeCodexToml(withEnv);
  assert.equal(removed, `${original}\n[after]\nk = 1\n`);
  assert.equal(removeCodexToml(original), undefined);
});

test("codex: file-backed install/status/uninstall without the CLI; CRLF files keep CRLF", async () => {
  const r = rig();
  const file = path.join(r.home, ".codex", "config.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'model = "o3"\r\n');
  let res = await runMcpClients("install", "codex", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith('model = "o3"\r\n\r\n[mcp_servers.trusted-ua]\r\n'), JSON.stringify(text));
  res = await runMcpClients("status", "codex", r.ctx);
  assert.match(res.lines[0], /current/);
  res = await runMcpClients("install", "codex", r.ctx);
  assert.match(res.lines[0], /already current/);
  res = await runMcpClients("uninstall", "codex", r.ctx);
  assert.equal(readFileSync(file, "utf8"), 'model = "o3"\r\n');
});

test("codex: uses the codex CLI when it is on PATH", async () => {
  const r = rig({ clis: ["codex"] });
  mkdirSync(path.join(r.home, ".codex"), { recursive: true });
  const res = await runMcpClients("install", "codex", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  const add = r.execs.find((e) => e.args[1] === "add");
  assert.deepEqual(add?.args, ["mcp", "add", "trusted-ua", "--", "/opt/node/bin/node", r.bridge]);
});

test("all: uninstall removes every trusted-ua entry and nothing else", async () => {
  const r = rig();
  mkdirSync(path.join(r.home, ".cursor"), { recursive: true });
  mkdirSync(path.join(r.home, ".gemini"), { recursive: true });
  writeFileSync(path.join(r.home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));
  await runMcpClients("install", "all", r.ctx);
  const res = await runMcpClients("uninstall", "all", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  assert.deepEqual(readJson(path.join(r.home, ".cursor", "mcp.json")).mcpServers, {});
  assert.deepEqual(readJson(path.join(r.home, ".gemini", "settings.json")), { theme: "dark", mcpServers: {} } as never);
});

test("temporary package roots are refused for install and mcp install", async () => {
  assert.match(String(temporaryRootReason(path.join("C:", "Users", "u", "AppData", "Local", "npm-cache", "_npx", "abc", "node_modules", "trusted-user-agent"))), /npx cache/);
  assert.match(String(temporaryRootReason(path.join(tmpdir(), "x", "pkg"))), /temporary directory/);
  assert.equal(temporaryRootReason(path.join(path.parse(tmpdir()).root, "opt", "lib", "node_modules", "trusted-user-agent"), tmpdir()), undefined);

  const saved = process.env.PI_BROWSER_ALLOW_TEMPORARY_ROOT;
  delete process.env.PI_BROWSER_ALLOW_TEMPORARY_ROOT;
  try {
    const pkgRoot = mkdtempSync(path.join(tmpdir(), "pi-npx-"));
    const home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    for (const [cmd, sub] of [["install", undefined], ["mcp", "install"]] as const) {
      const res = await runCommand(cmd, { pkgRoot, homeDir: home, exec: async () => ({ code: 0, stdout: "", stderr: "" }) }, sub);
      assert.equal(res.ok, false);
      assert.ok(res.lines.some((l) => l.includes("npm i -g trusted-user-agent")), res.lines.join("\n"));
    }
    assert.equal(existsSync(path.join(home, ".pi", "agent", "mcp.json")), false, "nothing written");
    // Status still works from anywhere.
    const status = await runCommand("mcp", { pkgRoot, homeDir: home }, "status");
    assert.ok(status.lines.some((l) => l.startsWith("mcp: not configured")));
    // The test override.
    const allowed = await runCommand("mcp", { pkgRoot, homeDir: home, allowTemporary: true }, "install");
    assert.equal(allowed.ok, true);
  } finally {
    if (saved !== undefined) process.env.PI_BROWSER_ALLOW_TEMPORARY_ROOT = saved;
  }
});

test("codex: reads the literal-string TOML that `codex mcp add` writes", () => {
  const text = [
    "[mcp_servers.trusted-ua]",
    String.raw`command = 'C:\Program Files\nodejs\node.exe'`,
    String.raw`args = ['C:\Users\u\pkg\mcp-stdio-main.js']`,
    "",
  ].join("\n");
  assert.deepEqual(readCodexEntry(text), {
    kind: "present",
    command: String.raw`C:\Program Files\nodejs\node.exe`,
    args: [String.raw`C:\Users\u\pkg\mcp-stdio-main.js`],
  });
  assert.deepEqual(parseTomlValue("[ \"a\", # note\n  'b', ]").value, ["a", "b"]);
  assert.equal(parseTomlValue(String.raw`"tab\there"`).value, "tab\there");
  assert.equal(parseTomlValue('["open"').incomplete, true);
  assert.equal(parseTomlValue("nope").ok, false);
});

test("claude: status honours CLAUDE_CONFIG_DIR", async () => {
  const r = rig({ clis: ["claude"] });
  const dir = path.join(r.home, "claude-config");
  mkdirSync(dir, { recursive: true });
  r.ctx.env.CLAUDE_CONFIG_DIR = dir;
  writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify({ mcpServers: { "trusted-ua": { type: "stdio", command: "/opt/node/bin/node", args: [r.bridge] } } }),
  );
  const res = await runMcpClients("status", "claude", r.ctx);
  assert.match(res.lines[0], /current/);
  assert.equal(r.execs.length, 0);
});

// ---------------------------------------------------------------------------
// v0.4.0 entries named pi-browser (openspec rename-trusted-user-agent D3)
// ---------------------------------------------------------------------------

test("upgrade: a pi-browser entry is reported as old, and install renames it to trusted-ua (json, pi, codex)", async () => {
  const r = rig();
  // Cursor (JSON file adapter).
  const cursor = path.join(r.home, ".cursor", "mcp.json");
  mkdirSync(path.dirname(cursor), { recursive: true });
  writeFileSync(cursor, JSON.stringify({ mcpServers: { "pi-browser": { command: "/old/node", args: ["/old/pkg/dist/native-host/mcp-stdio-main.js"] }, other: { command: "x" } } }));
  let res = await runMcpClients("status", "cursor", r.ctx);
  assert.equal(res.ok, false);
  assert.match(res.lines.join("\n"), /old name pi-browser/);
  res = await runMcpClients("install", "cursor", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  assert.match(res.lines.join("\n"), /removed the old pi-browser entry/);
  let config = readJson(cursor);
  assert.equal(config.mcpServers["pi-browser"], undefined);
  assert.deepEqual(config.mcpServers["trusted-ua"], { command: "/opt/node/bin/node", args: [r.bridge] });
  assert.deepEqual(config.mcpServers.other, { command: "x" }, "other servers untouched");

  // An unrelated server that happens to be named pi-browser is left alone.
  writeFileSync(cursor, JSON.stringify({ mcpServers: { "pi-browser": { url: "http://elsewhere" } } }));
  await runMcpClients("install", "cursor", r.ctx);
  config = readJson(cursor);
  assert.deepEqual(config.mcpServers["pi-browser"], { url: "http://elsewhere" });

  // pi's own mcp.json keeps the user's exposure choice.
  const piFile = path.join(r.home, ".pi", "agent", "mcp.json");
  mkdirSync(path.dirname(piFile), { recursive: true });
  writeFileSync(piFile, JSON.stringify({ mcpServers: { "pi-browser": { command: "/old/node", args: ["/old/dist/native-host/mcp-stdio-main.js"], exposure: "direct" } } }));
  res = await runMcpClients("status", "pi", r.ctx);
  assert.equal(res.ok, false);
  assert.match(res.lines[0], /old name pi-browser/);
  res = await runMcpClients("install", "pi", r.ctx);
  assert.match(res.lines.join("\n"), /replaced the old pi-browser entry/);
  const pi = readJson(piFile);
  assert.equal(pi.mcpServers["pi-browser"], undefined);
  assert.equal(pi.mcpServers["trusted-ua"].exposure, "direct", "user's exposure carried over");

  // Codex TOML (no CLI on PATH): table renamed, other text kept.
  const codex = path.join(r.home, ".codex", "config.toml");
  mkdirSync(path.dirname(codex), { recursive: true });
  writeFileSync(codex, 'model = "o3"\n\n[mcp_servers.pi-browser]\ncommand = "/old/node"\nargs = ["/old/dist/native-host/mcp-stdio-main.js"]\n\n[after]\nk = 1\n');
  res = await runMcpClients("install", "codex", r.ctx);
  assert.equal(res.ok, true, res.lines.join("\n"));
  const text = readFileSync(codex, "utf8");
  assert.ok(!text.includes("[mcp_servers.pi-browser]"), text);
  assert.ok(text.includes("[mcp_servers.trusted-ua]"), text);
  assert.ok(text.startsWith('model = "o3"') && text.includes("[after]\nk = 1"), text);

  // uninstall removes both names.
  writeFileSync(cursor, JSON.stringify({ mcpServers: { "pi-browser": { command: "n", args: ["/x/mcp-stdio-main.js"] }, "trusted-ua": { command: "n", args: [r.bridge] } } }));
  res = await runMcpClients("uninstall", "cursor", r.ctx);
  config = readJson(cursor);
  assert.deepEqual(config.mcpServers, {});
});
