/**
 * External ACP agents a sidebar session can run on (openspec
 * sidebar-acp-agents D1).
 *
 * Built in: pi (in-process, not described here), Claude Code and Codex
 * through their ACP adapters. The user adds agents, or overrides a built-in
 * one's command, arguments, environment and idle timeout, in
 * `<data root>/agents.json`:
 *
 *   { "agents": { "my-agent": { "name": "My agent", "command": "my-agent", "args": ["--acp"] } } }
 *
 * The file is re-read on every lookup (it is tiny), so edits apply to the
 * next session without a host restart. Availability means the command
 * resolves on PATH (or exists, for an absolute path); nothing is launched.
 *
 * Adapter facts (checked 2026-11-20, task 1.1):
 * - Claude Code: npm `@agentclientprotocol/claude-agent-acp`, binary
 *   `claude-agent-acp` (was `@zed-industries/claude-code-acp`). Supports
 *   loadSession, resume, close, list; reports configOptions and modes.
 * - Codex: npm `@agentclientprotocol/codex-acp`, binary `codex-acp` (was
 *   `@zed-industries/codex-acp`). Same session methods; reports
 *   configOptions, models and modes; advertises authMethods.
 * - Google: Antigravity CLI (`agy`) has no ACP mode, so it isn't built in.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PI_AGENT_ID, type AgentInfo, type AgentsResult } from "@trusted-ua/protocol";
import { readableDataFile } from "../../paths.js";

/** Default idle timeout before an agent process is stopped (D2a). */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

export interface AgentSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Minutes of inactivity before the process stops; 0 = never. */
  idleTimeoutMinutes: number;
  /** How to log in, shown when the agent reports that authentication is required. */
  loginHint: string;
  /** How to install the adapter, shown when the command is missing. */
  installHint?: string;
}

export const BUILTIN_AGENTS: readonly AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude-agent-acp",
    args: [],
    env: {},
    idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
    loginHint: "run `claude` in a terminal and log in",
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    env: {},
    idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
    loginHint: "run `codex login` in a terminal",
    installHint: "npm install -g @agentclientprotocol/codex-acp",
  },
];

const GENERIC_LOGIN_HINT = "log in with the agent's own CLI";

/**
 * Where agents.json is read from (TRUSTED_UA_AGENTS_FILE overrides): the data
 * root, else the v0.4.0 file in ~/.pi/browser.
 */
export function agentsFilePath(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  return readableDataFile("agents.json", "AGENTS_FILE", env, homeDir);
}

export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** agents.json path (default agentsFilePath(env)). */
  file?: string;
}

export interface LoadedAgents {
  specs: AgentSpec[];
  /** Problem reading agents.json; the built-in agents are still returned. */
  error?: string;
}

export type ResolvedAgent =
  | { ok: true; spec: AgentSpec; executable: string }
  | { ok: false; spec?: AgentSpec; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Find a command on PATH (Windows: .exe, .cmd, .bat). Absolute paths must exist. */
export function findCommand(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (path.isAbsolute(command) || command.includes("/") || (platform === "win32" && command.includes("\\"))) {
    return existsSync(command) ? command : undefined;
  }
  const pathVar = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : ":";
  const exts = platform === "win32"
    ? (path.extname(command) ? [""] : [".exe", ".cmd", ".bat"])
    : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export class AgentRegistry {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly file: string;

  constructor(opts: RegistryOptions = {}) {
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.file = opts.file ?? agentsFilePath(this.env);
  }

  get configFile(): string {
    return this.file;
  }

  /** Built-in specs merged with agents.json. */
  load(): LoadedAgents {
    const specs = new Map<string, AgentSpec>(BUILTIN_AGENTS.map((s) => [s.id, { ...s, args: [...s.args], env: { ...s.env } }]));
    let error: string | undefined;
    if (existsSync(this.file)) {
      try {
        const text = readFileSync(this.file, "utf8");
        const parsed: unknown = text.trim() ? JSON.parse(text) : {};
        if (!isObject(parsed)) throw new Error("the file must contain a JSON object");
        const agents = parsed.agents ?? {};
        if (!isObject(agents)) throw new Error('"agents" must be an object keyed by agent id');
        const problems: string[] = [];
        for (const [id, raw] of Object.entries(agents)) {
          const problem = this.merge(specs, id, raw);
          if (problem) problems.push(problem);
        }
        if (problems.length) error = `${this.file}: ${problems.join("; ")}`;
      } catch (err) {
        error = `${this.file}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return { specs: [...specs.values()], ...(error ? { error } : {}) };
  }

  private merge(specs: Map<string, AgentSpec>, id: string, raw: unknown): string | undefined {
    if (id === PI_AGENT_ID) return `"${PI_AGENT_ID}" is the built-in agent and can't be configured here`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return `agent id "${id}" must be letters, digits, ".", "_" or "-"`;
    if (!isObject(raw)) return `agent "${id}" must be an object`;
    if (raw.disabled === true) {
      specs.delete(id);
      return undefined;
    }
    const base = specs.get(id);
    const command = typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : base?.command;
    if (!command) return `agent "${id}" needs a "command"`;
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string"))) {
      return `agent "${id}": "args" must be an array of strings`;
    }
    if (raw.env !== undefined && (!isObject(raw.env) || Object.values(raw.env).some((v) => typeof v !== "string"))) {
      return `agent "${id}": "env" must map names to strings`;
    }
    const idle = raw.idleTimeoutMinutes;
    if (idle !== undefined && (typeof idle !== "number" || !Number.isFinite(idle) || idle < 0)) {
      return `agent "${id}": "idleTimeoutMinutes" must be a number ≥ 0`;
    }
    specs.set(id, {
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 64) : (base?.name ?? id),
      command,
      args: (raw.args as string[] | undefined) ?? base?.args ?? [],
      env: { ...(base?.env ?? {}), ...((raw.env as Record<string, string> | undefined) ?? {}) },
      idleTimeoutMinutes: typeof idle === "number" ? idle : (base?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES),
      loginHint: typeof raw.loginHint === "string" && raw.loginHint.trim() ? raw.loginHint.trim() : (base?.loginHint ?? GENERIC_LOGIN_HINT),
      ...(base?.installHint && command === base.command ? { installHint: base.installHint } : {}),
    });
    return undefined;
  }

  /** The spec and executable for an agent id, or why it can't start. */
  resolve(id: string): ResolvedAgent {
    const { specs } = this.load();
    const spec = specs.find((s) => s.id === id);
    if (!spec) return { ok: false, reason: `unknown agent "${id}"` };
    const executable = findCommand(spec.command, { ...this.env }, this.platform);
    if (!executable) {
      return {
        ok: false,
        spec,
        reason: `not found (${spec.command})${spec.installHint ? ` — install it with \`${spec.installHint}\`` : ""}, or set its command in ${this.file}`,
      };
    }
    return { ok: true, spec, executable };
  }

  /** Display name of an agent id (the id itself when unknown). */
  nameOf(id: string): string {
    if (id === PI_AGENT_ID) return "pi";
    return this.load().specs.find((s) => s.id === id)?.name ?? id;
  }

  /** Answer for x-trusted-ua/agents: pi first, then the external agents. */
  list(): AgentsResult {
    const { specs, error } = this.load();
    const agents: AgentInfo[] = [{ id: PI_AGENT_ID, name: "pi", available: true }];
    for (const spec of specs) {
      const executable = findCommand(spec.command, this.env, this.platform);
      agents.push({
        id: spec.id,
        name: spec.name,
        available: executable !== undefined,
        ...(executable ? {} : { reason: `not found (${spec.command})` }),
      });
    }
    return { agents, defaultAgent: PI_AGENT_ID, ...(error ? { configError: error } : {}) };
  }
}
