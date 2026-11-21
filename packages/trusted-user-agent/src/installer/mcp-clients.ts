/**
 * `mcp <install|status|uninstall> [client]` for MCP clients other than pi
 * (openspec external-mcp-callers, D7): Claude Code, Codex, Cursor, Gemini
 * CLI and VS Code each get the same stdio bridge entry, named `trusted-ua`,
 * at user (global) scope.
 *
 * | Client | Install / uninstall                         | Status (read-only)            |
 * |--------|---------------------------------------------|-------------------------------|
 * | pi     | ~/.pi/agent/mcp.json `mcpServers` (mcp.ts)   | same file                     |
 * | claude | `claude mcp add-json\|remove --scope user`   | ~/.claude.json `mcpServers`   |
 * | codex  | `codex mcp add\|remove`; TOML table edit      | ~/.codex/config.toml          |
 * | cursor | ~/.cursor/mcp.json `mcpServers`              | same file                     |
 * | gemini | ~/.gemini/settings.json `mcpServers`         | same file                     |
 * | vscode | user mcp.json `servers` (type "stdio")       | same file                     |
 *
 * Rules (spec mcp-client-installers):
 * - only the `trusted-ua` entry changes; other servers and settings stay,
 *   and keys the user added to the entry are kept;
 * - an unchanged launch is reported `current` and nothing is written;
 * - a file that can't be parsed is never written: the error is reported
 *   and the other requested clients still run;
 * - a client whose config its running app rewrites (Claude Code) is changed
 *   through its CLI only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "./common.js";
import type { CommandResult } from "./index.js";
import { LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME, isOwnEntry, mcpBridgePath, runMcpCommand, type McpSubcommand } from "./mcp.js";

export const MCP_CLIENTS = ["pi", "claude", "codex", "cursor", "gemini", "vscode"] as const;
export type McpClientId = (typeof MCP_CLIENTS)[number];
export type McpClientTarget = McpClientId | "all";

export function isMcpClientTarget(value: string): value is McpClientTarget {
  return value === "all" || (MCP_CLIENTS as readonly string[]).includes(value);
}

export interface McpClientContext {
  homeDir: string;
  platform: "linux" | "darwin" | "win32";
  exec: ExecFn;
  /** Environment for config locations (APPDATA, CODEX_HOME) and CLI lookup (PATH). */
  env: NodeJS.ProcessEnv;
  pkgRoot: string;
  /** Node binary the client launches the bridge with (default: the installer's node). */
  nodePath?: string;
}

/** The part of the entry this installer owns. */
interface Launch {
  command: string;
  args: string[];
}

type EntryState =
  | { kind: "missing" }
  | { kind: "present"; command: unknown; args: unknown }
  | { kind: "error"; message: string };

interface ClientAdapter {
  id: McpClientId;
  label: string;
  /** Where the entry lives (for reports). */
  location(ctx: McpClientContext): string;
  /** undefined when the client is present; otherwise why it is skipped. */
  detect(ctx: McpClientContext): string | undefined;
  /** Read the entry named `name` (default: MCP_SERVER_NAME). */
  read(ctx: McpClientContext, name?: string): Promise<EntryState>;
  /** Write or replace the entry. Throws with a user-facing message on failure. */
  write(ctx: McpClientContext, launch: Launch): Promise<void>;
  /** Remove the entry; false when there was nothing to remove. */
  remove(ctx: McpClientContext, name?: string): Promise<boolean>;
}

function expectedLaunch(ctx: McpClientContext): Launch {
  return { command: ctx.nodePath ?? process.execPath, args: [mcpBridgePath(ctx.pkgRoot)] };
}

function sameLaunch(state: EntryState, launch: Launch): boolean {
  return (
    state.kind === "present" &&
    state.command === launch.command &&
    JSON.stringify(state.args) === JSON.stringify(launch.args)
  );
}

function describeLaunch(command: unknown, args: unknown): string {
  return `${String(command)} ${Array.isArray(args) ? args.join(" ") : ""}`.trim();
}

// ---------------------------------------------------------------------------
// CLI lookup
// ---------------------------------------------------------------------------

/** Find an executable on PATH (Windows: .exe, then .cmd). */
export function findExecutable(name: string, ctx: Pick<McpClientContext, "env" | "platform">): string | undefined {
  const pathVar = ctx.env.PATH ?? ctx.env.Path ?? "";
  const sep = ctx.platform === "win32" ? ";" : ":";
  const exts = ctx.platform === "win32" ? [".exe", ".cmd"] : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Run a CLI found by findExecutable (.cmd shims go through cmd.exe). */
async function runCli(ctx: McpClientContext, exe: string, args: string[]): Promise<{ code: number; out: string }> {
  const res = /\.cmd$/i.test(exe)
    ? await ctx.exec(ctx.env.ComSpec ?? "cmd.exe", ["/d", "/c", exe, ...args])
    : await ctx.exec(exe, args);
  return { code: res.code, out: `${res.stdout}\n${res.stderr}`.trim() };
}

// ---------------------------------------------------------------------------
// JSON config files
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a JSON config: undefined when missing; throws a readable error when unparseable. */
function readJsonConfig(file: string): JsonObject | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — left unchanged`);
  }
  if (!isObject(parsed)) throw new Error(`${file} does not hold a JSON object — left unchanged`);
  return parsed;
}

function writeJsonConfig(file: string, config: JsonObject): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function jsonFileAdapter(spec: {
  id: McpClientId;
  label: string;
  file: (ctx: McpClientContext) => string;
  /** Directory whose presence means the client is installed. */
  marker: (ctx: McpClientContext) => string;
  cli?: string;
  serversKey: "mcpServers" | "servers";
  /** Extra managed fields (e.g. VS Code's type: "stdio"). */
  extra?: JsonObject;
}): ClientAdapter {
  return {
    id: spec.id,
    label: spec.label,
    location: (ctx) => spec.file(ctx),
    detect: (ctx) =>
      existsSync(spec.marker(ctx)) || (spec.cli && findExecutable(spec.cli, ctx))
        ? undefined
        : `${spec.label} not found (no ${spec.marker(ctx)})`,
    async read(ctx, name = MCP_SERVER_NAME) {
      let config: JsonObject | undefined;
      try {
        config = readJsonConfig(spec.file(ctx));
      } catch (err) {
        return { kind: "error", message: (err as Error).message };
      }
      const servers = config?.[spec.serversKey];
      const entry = isObject(servers) ? servers[name] : undefined;
      if (!isObject(entry)) return { kind: "missing" };
      return { kind: "present", command: entry.command, args: entry.args };
    },
    async write(ctx, launch) {
      const file = spec.file(ctx);
      const config = readJsonConfig(file) ?? {};
      const servers = isObject(config[spec.serversKey]) ? (config[spec.serversKey] as JsonObject) : {};
      const existing = isObject(servers[MCP_SERVER_NAME]) ? (servers[MCP_SERVER_NAME] as JsonObject) : {};
      servers[MCP_SERVER_NAME] = { ...existing, ...(spec.extra ?? {}), command: launch.command, args: launch.args };
      config[spec.serversKey] = servers;
      writeJsonConfig(file, config);
    },
    async remove(ctx, name = MCP_SERVER_NAME) {
      const file = spec.file(ctx);
      const config = readJsonConfig(file);
      const servers = config?.[spec.serversKey];
      if (!config || !isObject(servers) || !(name in servers)) return false;
      delete servers[name];
      writeJsonConfig(file, config);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/config.toml [mcp_servers.trusted-ua]
// ---------------------------------------------------------------------------

export function codexConfigPath(ctx: Pick<McpClientContext, "env" | "homeDir">): string {
  return path.join(ctx.env.CODEX_HOME || path.join(ctx.homeDir, ".codex"), "config.toml");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function codexHeader(name: string): RegExp {
  const n = escapeRe(name);
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${n}|"${n}")\\s*\\]\\s*(?:#.*)?$`);
}
function codexSubtable(name: string): RegExp {
  const n = escapeRe(name);
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${n}|"${n}")\\s*\\.`);
}
const TABLE_HEADER = /^\s*\[/;

/** Line range [start, end) of the [mcp_servers.trusted-ua] table body (header included). */
function codexTableRange(lines: string[], name: string = MCP_SERVER_NAME): { start: number; end: number } | undefined {
  const header = codexHeader(name);
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !TABLE_HEADER.test(lines[end])) end++;
  return { start, end };
}

/** A TOML basic string (JSON escapes are valid TOML escapes). */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

/** Parse `key = value` for a string or a (possibly multi-line) string array. */
function codexValue(body: string[], key: string): { value: unknown; from: number; to: number } | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (let i = 0; i < body.length; i++) {
    const m = re.exec(body[i]);
    if (!m) continue;
    let text = m[1];
    let to = i + 1;
    let parsed = parseTomlValue(text);
    // A multi-line array continues on the following lines.
    while (parsed.incomplete && to < body.length) {
      text += `\n${body[to++]}`;
      parsed = parseTomlValue(text);
    }
    return { value: parsed.ok ? parsed.value : Symbol.for("unparsed"), from: i, to };
  }
  return undefined;
}

/**
 * Parse a TOML value that is a string or an array of strings: basic
 * ("…", with escapes) or literal ('…', none) strings, comments, newlines and
 * trailing commas. Codex's own CLI writes literal strings for Windows paths.
 * `incomplete` means the text ended inside an array or string.
 */
export function parseTomlValue(text: string): { ok: boolean; value?: unknown; incomplete?: boolean } {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (text[i] === "#") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      return;
    }
  };
  const str = (): { ok: boolean; value?: string; incomplete?: boolean } => {
    const quote = text[i++];
    let out = "";
    while (i < text.length) {
      const c = text[i++];
      if (c === quote) return { ok: true, value: out };
      if (c === "\n") return { ok: false };
      if (quote === '"' && c === "\\") {
        const e = text[i++];
        const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (e in simple) out += simple[e];
        else if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          out += String.fromCodePoint(parseInt(text.slice(i, i + len), 16));
          i += len;
        } else return { ok: false };
      } else out += c;
    }
    return { ok: false, incomplete: true };
  };
  skip();
  if (text[i] === '"' || text[i] === "'") {
    const s = str();
    if (!s.ok) return s;
    skip();
    return i >= text.length ? s : { ok: false };
  }
  if (text[i] !== "[") return { ok: false };
  i++;
  const items: string[] = [];
  for (;;) {
    skip();
    if (i >= text.length) return { ok: false, incomplete: true };
    if (text[i] === "]") {
      i++;
      skip();
      return i >= text.length ? { ok: true, value: items } : { ok: false };
    }
    if (text[i] !== '"' && text[i] !== "'") return { ok: false };
    const s = str();
    if (!s.ok) return s;
    items.push(s.value as string);
  }
}

/** Insert or replace the managed keys of [mcp_servers.trusted-ua]; other text is untouched. */
export function upsertCodexToml(text: string, launch: Launch, name: string = MCP_SERVER_NAME): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const commandLine = `command = ${tomlString(launch.command)}`;
  const argsLine = `args = [${launch.args.map(tomlString).join(", ")}]`;
  const range = codexTableRange(lines, name);
  if (!range) {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    if (out.length > 0) out.push("");
    out.push(`[mcp_servers.${name}]`, commandLine, argsLine, "");
    return out.join(eol);
  }
  const body = lines.slice(range.start + 1, range.end);
  for (const [key, line] of [["command", commandLine], ["args", argsLine]] as const) {
    const found = codexValue(body, key);
    if (found) body.splice(found.from, found.to - found.from, line);
    else body.splice(key === "command" ? 0 : Math.min(1, body.length), 0, line);
  }
  return [...lines.slice(0, range.start + 1), ...body, ...lines.slice(range.end)].join(eol);
}

/** Remove [mcp_servers.trusted-ua] and its sub-tables; other text is untouched. */
export function removeCodexToml(text: string, name: string = MCP_SERVER_NAME): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const range = codexTableRange(lines, name);
  const subtable = codexSubtable(name);
  if (!range) return undefined;
  let end = range.end;
  // Sub-tables ([mcp_servers.pi-browser.env], ...) belong to the entry.
  while (end < lines.length && subtable.test(lines[end])) {
    end++;
    while (end < lines.length && !TABLE_HEADER.test(lines[end])) end++;
  }
  // Blank lines after the table separate it from the next one: keep them.
  while (end > range.start + 1 && lines[end - 1].trim() === "") end--;
  const out = [...lines.slice(0, range.start), ...lines.slice(end)];
  // Collapse the double blank line the removal leaves behind.
  if (range.start > 0 && out[range.start - 1] === "" && (range.start >= out.length || out[range.start] === "")) {
    out.splice(range.start - 1, 1);
  }
  return out.join(eol);
}

export function readCodexEntry(text: string, name: string = MCP_SERVER_NAME): EntryState {
  const lines = text.split(/\r?\n/);
  const inline = new RegExp(`^\\s*"?${escapeRe(name)}"?\\s*=\\s*\\{`);
  if (lines.some((l) => inline.test(l))) {
    return { kind: "error", message: `${name} is an inline table in config.toml — edit it by hand or remove it, then retry` };
  }
  const range = codexTableRange(lines, name);
  if (!range) return { kind: "missing" };
  const body = lines.slice(range.start + 1, range.end);
  return {
    kind: "present",
    command: codexValue(body, "command")?.value,
    args: codexValue(body, "args")?.value,
  };
}

const codexAdapter: ClientAdapter = {
  id: "codex",
  label: "Codex",
  location: (ctx) => codexConfigPath(ctx),
  detect: (ctx) =>
    existsSync(path.dirname(codexConfigPath(ctx))) || findExecutable("codex", ctx)
      ? undefined
      : `Codex not found (no ${path.dirname(codexConfigPath(ctx))})`,
  async read(ctx, name = MCP_SERVER_NAME) {
    const file = codexConfigPath(ctx);
    if (!existsSync(file)) return { kind: "missing" };
    return readCodexEntry(readFileSync(file, "utf8"), name);
  },
  async write(ctx, launch) {
    const file = codexConfigPath(ctx);
    const exe = findExecutable("codex", ctx);
    if (exe) {
      // The CLI edits config.toml itself (format-preserving).
      await runCli(ctx, exe, ["mcp", "remove", MCP_SERVER_NAME]);
      const res = await runCli(ctx, exe, ["mcp", "add", MCP_SERVER_NAME, "--", launch.command, ...launch.args]);
      if (res.code !== 0) throw new Error(`codex mcp add failed (exit ${res.code}): ${res.out}`);
      return;
    }
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const state = readCodexEntry(text);
    if (state.kind === "error") throw new Error(state.message);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, upsertCodexToml(text, launch));
  },
  async remove(ctx, name = MCP_SERVER_NAME) {
    const file = codexConfigPath(ctx);
    if (!existsSync(file)) return false;
    const exe = findExecutable("codex", ctx);
    if (exe) {
      if ((await this.read(ctx, name)).kind === "missing") return false;
      const res = await runCli(ctx, exe, ["mcp", "remove", name]);
      if (res.code !== 0) throw new Error(`codex mcp remove failed (exit ${res.code}): ${res.out}`);
      return true;
    }
    const next = removeCodexToml(readFileSync(file, "utf8"), name);
    if (next === undefined) return false;
    writeFileSync(file, next);
    return true;
  },
};

// ---------------------------------------------------------------------------
// Claude Code: user scope through its CLI; status from ~/.claude.json

/** Claude Code's user config (inside CLAUDE_CONFIG_DIR when that is set). */
export function claudeConfigPath(ctx: Pick<McpClientContext, "env" | "homeDir">): string {
  return path.join(ctx.env.CLAUDE_CONFIG_DIR || ctx.homeDir, ".claude.json");
}
// ---------------------------------------------------------------------------

const claudeAdapter: ClientAdapter = {
  id: "claude",
  label: "Claude Code",
  location: (ctx) => `${claudeConfigPath(ctx)} (user scope, via the claude CLI)`,
  detect: (ctx) => (findExecutable("claude", ctx) ? undefined : "Claude Code CLI (claude) not found on PATH"),
  async read(ctx, name = MCP_SERVER_NAME) {
    // Read-only: Claude Code rewrites this file while it runs.
    try {
      const config = readJsonConfig(claudeConfigPath(ctx));
      const servers = config?.mcpServers;
      const entry = isObject(servers) ? servers[name] : undefined;
      if (!isObject(entry)) return { kind: "missing" };
      return { kind: "present", command: entry.command, args: entry.args };
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }
  },
  async write(ctx, launch) {
    const exe = findExecutable("claude", ctx);
    if (!exe) throw new Error("Claude Code CLI (claude) not found on PATH");
    await runCli(ctx, exe, ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME]);
    const json = JSON.stringify({ type: "stdio", command: launch.command, args: launch.args });
    const res = await runCli(ctx, exe, ["mcp", "add-json", "--scope", "user", MCP_SERVER_NAME, json]);
    if (res.code !== 0) throw new Error(`claude mcp add-json failed (exit ${res.code}): ${res.out}`);
  },
  async remove(ctx, name = MCP_SERVER_NAME) {
    if ((await this.read(ctx, name)).kind === "missing") return false;
    const exe = findExecutable("claude", ctx);
    if (!exe) throw new Error("Claude Code CLI (claude) not found on PATH");
    const res = await runCli(ctx, exe, ["mcp", "remove", "--scope", "user", name]);
    if (res.code !== 0) throw new Error(`claude mcp remove failed (exit ${res.code}): ${res.out}`);
    return true;
  },
};

// ---------------------------------------------------------------------------
// VS Code user mcp.json
// ---------------------------------------------------------------------------

export function vscodeUserDir(ctx: Pick<McpClientContext, "env" | "homeDir" | "platform">): string {
  if (ctx.platform === "win32") return path.join(ctx.env.APPDATA || path.join(ctx.homeDir, "AppData", "Roaming"), "Code", "User");
  if (ctx.platform === "darwin") return path.join(ctx.homeDir, "Library", "Application Support", "Code", "User");
  return path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.homeDir, ".config"), "Code", "User");
}

const ADAPTERS: Record<Exclude<McpClientId, "pi">, ClientAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: jsonFileAdapter({
    id: "cursor",
    label: "Cursor",
    file: (ctx) => path.join(ctx.homeDir, ".cursor", "mcp.json"),
    marker: (ctx) => path.join(ctx.homeDir, ".cursor"),
    cli: "cursor",
    serversKey: "mcpServers",
  }),
  gemini: jsonFileAdapter({
    id: "gemini",
    label: "Gemini CLI",
    file: (ctx) => path.join(ctx.homeDir, ".gemini", "settings.json"),
    marker: (ctx) => path.join(ctx.homeDir, ".gemini"),
    cli: "gemini",
    serversKey: "mcpServers",
  }),
  vscode: jsonFileAdapter({
    id: "vscode",
    label: "VS Code",
    file: (ctx) => path.join(vscodeUserDir(ctx), "mcp.json"),
    marker: (ctx) => vscodeUserDir(ctx),
    serversKey: "servers",
    extra: { type: "stdio" },
  }),
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type ClientOutcome = "installed" | "current" | "stale" | "missing" | "removed" | "absent" | "skipped" | "error";

async function runForAdapter(
  sub: McpSubcommand,
  adapter: ClientAdapter,
  ctx: McpClientContext,
  skipMissingClient: boolean,
): Promise<{ outcome: ClientOutcome; lines: string[] }> {
  const where = adapter.location(ctx);
  const tag = `mcp ${adapter.id}:`;
  const notFound = adapter.detect(ctx);
  if (notFound && (skipMissingClient || sub === "install")) {
    return { outcome: "skipped", lines: [`${tag} skipped — ${notFound}`] };
  }
  const launch = expectedLaunch(ctx);
  const state = await adapter.read(ctx);
  // A v0.4.0 entry of this package under the old name (openspec rename-trusted-user-agent D3).
  const legacyState = await adapter.read(ctx, LEGACY_MCP_SERVER_NAME);
  const legacy = legacyState.kind === "present" && isOwnEntry({ command: legacyState.command, args: legacyState.args });
  try {
    switch (sub) {
      case "install": {
        if (state.kind === "error") return { outcome: "error", lines: [`${tag} error — ${state.message}`] };
        const lines: string[] = [];
        let outcome: ClientOutcome = "current";
        if (sameLaunch(state, launch)) {
          lines.push(`${tag} already current in ${where}`);
        } else {
          await adapter.write(ctx, launch);
          outcome = "installed";
          lines.push(`${tag} ${state.kind === "present" ? "updated" : "installed"} ${MCP_SERVER_NAME} in ${where}`);
        }
        if (legacy) {
          await adapter.remove(ctx, LEGACY_MCP_SERVER_NAME);
          outcome = "installed";
          lines.push(`${tag} removed the old ${LEGACY_MCP_SERVER_NAME} entry`);
        }
        return { outcome, lines };
      }
      case "status": {
        if (state.kind === "error") return { outcome: "error", lines: [`${tag} error — ${state.message}`] };
        if (state.kind === "missing" && legacy) {
          return {
            outcome: "stale",
            lines: [`${tag} stale (${where}) — old name ${LEGACY_MCP_SERVER_NAME}; run trusted-ua mcp install ${adapter.id} to rename it to ${MCP_SERVER_NAME}`],
          };
        }
        if (state.kind === "missing") return { outcome: "missing", lines: [`${tag} missing (${where})`] };
        if (sameLaunch(state, launch)) return { outcome: "current", lines: [`${tag} current (${where})`] };
        return {
          outcome: "stale",
          lines: [
            `${tag} stale (${where})`,
            `  configured: ${describeLaunch(state.command, state.args)}`,
            `  expected:   ${describeLaunch(launch.command, launch.args)}`,
          ],
        };
      }
      case "uninstall": {
        if (state.kind === "error") return { outcome: "error", lines: [`${tag} error — ${state.message}`] };
        const removedLegacy = legacy ? await adapter.remove(ctx, LEGACY_MCP_SERVER_NAME) : false;
        const removed = (await adapter.remove(ctx)) || removedLegacy;
        return removed
          ? { outcome: "removed", lines: [`${tag} removed ${MCP_SERVER_NAME} from ${where}`] }
          : { outcome: "absent", lines: [`${tag} nothing to remove`] };
      }
    }
  } catch (err) {
    return { outcome: "error", lines: [`${tag} error — ${err instanceof Error ? err.message : String(err)}`] };
  }
  return { outcome: "error", lines: [`${tag} unknown sub-command ${String(sub)}`] };
}

/** pi through the original installer (unchanged output), mapped to an outcome. */
function runPi(sub: McpSubcommand, ctx: McpClientContext): { outcome: ClientOutcome; lines: string[]; result: CommandResult } {
  const result = runMcpCommand(sub, ctx.homeDir, { pkgRoot: ctx.pkgRoot, ...(ctx.nodePath ? { nodePath: ctx.nodePath } : {}) });
  const first = result.lines[0] ?? "";
  let outcome: ClientOutcome;
  if (sub === "install") outcome = !result.ok ? "error" : first.includes("already configured") ? "current" : "installed";
  else if (sub === "status") outcome = result.ok ? "current" : first.includes("STALE") ? "stale" : first.includes("not valid JSON") ? "error" : "missing";
  else outcome = first.includes("nothing to remove") ? "absent" : "removed";
  return { outcome, lines: result.lines, result };
}

/**
 * Run an mcp sub-command for one client or `all`. `pi` alone keeps the
 * original output; `all` reports one block per client and is ok unless a
 * client failed (or, for status, is not current).
 */
export async function runMcpClients(sub: McpSubcommand, target: McpClientTarget, ctx: McpClientContext): Promise<CommandResult> {
  if (target === "pi") return runPi(sub, ctx).result;
  if (target !== "all") {
    const r = await runForAdapter(sub, ADAPTERS[target], ctx, false);
    return { ok: isOk(sub, r.outcome), lines: r.lines };
  }
  const lines: string[] = [];
  let ok = true;
  const summary: string[] = [];
  for (const id of MCP_CLIENTS) {
    const r = id === "pi" ? runPi(sub, ctx) : await runForAdapter(sub, ADAPTERS[id], ctx, true);
    lines.push(...(id === "pi" ? r.lines.map((l, i) => (i === 0 ? `mcp pi: ${l.replace(/^mcp: /, "")}` : l)) : r.lines));
    summary.push(`${id}=${r.outcome}`);
    if (r.outcome !== "skipped" && !isOk(sub, r.outcome)) ok = false;
  }
  lines.push(`mcp: ${summary.join(" ")}`);
  return { ok, lines };
}

function isOk(sub: McpSubcommand, outcome: ClientOutcome): boolean {
  if (outcome === "error") return false;
  if (sub === "status") return outcome === "current";
  return true;
}
