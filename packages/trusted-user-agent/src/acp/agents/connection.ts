/**
 * One external ACP agent process and the host's ACP *client* connection to
 * it (openspec sidebar-acp-agents D2).
 *
 * The host speaks newline-delimited JSON-RPC 2.0 over the agent's stdio, the
 * ACP stdio transport. It does not go through the SDK's typed client: the
 * relay forwards the agent's `session/update` notifications to the add-on
 * as they are, and a schema-validating client would drop fields it doesn't
 * know (newer update kinds, `_meta`).
 *
 * - initialize once per start, with no client file system or terminal;
 * - every message in either direction counts as activity (idle stop, D2a);
 * - the agent's stderr goes to the host log, prefixed with its id;
 * - when the process exits, every pending request rejects with
 *   "<Agent> stopped (exit code N)" and `onExit` fires.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, PI_BROWSER_META } from "@trusted-ua/protocol";
import type { Logger } from "../../logger.js";
import type { AgentSpec } from "./registry.js";

/** A JSON-RPC error the agent returned. */
export class AgentRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AgentRpcError";
  }
}

/** The agent process ended while a request was waiting. */
export class AgentStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStoppedError";
  }
}

/** What the agent reported in its initialize response. */
export interface AgentInitInfo {
  loadSession: boolean;
  closeSession: boolean;
  resumeSession: boolean;
  authMethods: unknown[];
  agentInfo?: { name?: string; version?: string };
}

export interface AgentConnectionHandlers {
  /** A notification from the agent (session/update, ...). */
  onNotification(method: string, params: unknown): void;
  /** A request from the agent (session/request_permission, ...). Resolve with the result or throw. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** The process exited (expected or not). */
  onExit(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void;
}

export interface AgentConnectionOptions {
  spec: AgentSpec;
  executable: string;
  log: Logger;
  handlers: AgentConnectionHandlers;
  /** Clock (tests). */
  now?: () => number;
  /** Grace period between closing stdin and killing the process. */
  stopGraceMs?: number;
  /** Timeout for initialize. */
  initializeTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: NodeJS.Timeout;
}

/** Quote one argument for cmd.exe /s /c "<line>". */
function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^%()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export class AgentConnection {
  readonly spec: AgentSpec;
  private readonly log: Logger;
  private readonly handlers: AgentConnectionHandlers;
  private readonly now: () => number;
  private readonly stopGraceMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly executable: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stopping = false;
  private exited = false;
  /** Last message in either direction (ms). */
  lastActivity: number;
  /** Turns running + permission requests waiting (D2a: not idle while > 0). */
  private holds = 0;
  init: AgentInitInfo | undefined;

  constructor(opts: AgentConnectionOptions) {
    this.spec = opts.spec;
    this.executable = opts.executable;
    this.log = opts.log;
    this.handlers = opts.handlers;
    this.now = opts.now ?? Date.now;
    this.stopGraceMs = opts.stopGraceMs ?? 3_000;
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? 60_000;
    this.lastActivity = this.now();
  }

  get alive(): boolean {
    return this.child !== undefined && !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Busy (a turn or a permission request): never idle-stopped. */
  get busy(): boolean {
    return this.holds > 0;
  }

  /** Mark a turn or a waiting permission request; call the returned function when it ends. */
  hold(): () => void {
    this.holds++;
    this.touch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      this.touch();
    };
  }

  touch(): void {
    this.lastActivity = this.now();
  }

  /** Spawn the process and initialize it. Rejects with a readable error. */
  async start(): Promise<AgentInitInfo> {
    const { spec } = this;
    const env = { ...process.env, ...spec.env };
    const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.executable);
    // Node refuses to spawn .cmd/.bat directly; go through cmd.exe with a
    // fully quoted line. windowsHide: never flash a console window.
    const child = isCmd
      ? spawn(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[this.executable, ...spec.args].map(quoteForCmd).join(" ")}"`], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(this.executable, spec.args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.log.info(`agent ${spec.id}: started ${this.executable}${spec.args.length ? ` ${spec.args.join(" ")}` : ""} (pid ${child.pid ?? "?"})`);

    const spawnError = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        this.exited = true;
        reject(new AgentStoppedError(`${spec.name} could not start: ${err.message}`));
      });
    });
    spawnError.catch(() => undefined);

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
      if (line.trim()) this.log.debug(`[agent ${spec.id}] ${line.slice(0, 2000)}`);
    });
    child.stdin.on("error", (err) => this.log.debug(`agent ${spec.id}: stdin error: ${err.message}`));
    child.once("exit", (code, signal) => {
      this.exited = true;
      const expected = this.stopping;
      const what = code !== null ? `exit code ${code}` : `signal ${signal ?? "?"}`;
      this.log[expected ? "info" : "warn"](`agent ${spec.id}: process ${child.pid ?? "?"} exited (${what})${expected ? "" : " unexpectedly"}`);
      const err = new AgentStoppedError(`${spec.name} stopped (${what})`);
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.handlers.onExit({ code, signal, expected });
    });

    const result = (await Promise.race([
      this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "pi-browser", title: "Pi Browser", version: PI_BROWSER_META.version },
      }, this.initializeTimeoutMs),
      spawnError,
    ])) as {
      protocolVersion?: unknown;
      agentCapabilities?: { loadSession?: unknown; sessionCapabilities?: { close?: unknown; resume?: unknown } };
      authMethods?: unknown;
      agentInfo?: { name?: string; version?: string };
    };
    const caps = result?.agentCapabilities ?? {};
    this.init = {
      loadSession: caps.loadSession === true,
      closeSession: !!caps.sessionCapabilities?.close,
      resumeSession: !!caps.sessionCapabilities?.resume,
      authMethods: Array.isArray(result?.authMethods) ? result.authMethods : [],
      ...(result?.agentInfo ? { agentInfo: result.agentInfo } : {}),
    };
    this.log.info(
      `agent ${spec.id}: initialized ${result?.agentInfo?.name ?? "?"} ${result?.agentInfo?.version ?? ""} ` +
        `(loadSession=${this.init.loadSession} close=${this.init.closeSession})`,
    );
    return this.init;
  }

  private write(msg: unknown): void {
    if (!this.child || this.exited) throw new AgentStoppedError(`${this.spec.name} is not running`);
    this.touch();
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const entry: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AgentRpcError(-32603, `${this.spec.name} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (err) {
      this.log.debug(`agent ${this.spec.id}: ${method} not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    this.touch();
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.debug(`[agent ${this.spec.id}] non-JSON stdout: ${line.slice(0, 300)}`);
      return;
    }
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) {
        const id = msg.id;
        void Promise.resolve()
          .then(() => this.handlers.onRequest(msg.method as string, msg.params))
          .then(
            (result) => this.safeWrite({ jsonrpc: "2.0", id, result: result ?? null }),
            (err: unknown) => {
              const e = err as { code?: unknown; message?: unknown };
              this.safeWrite({
                jsonrpc: "2.0",
                id,
                error: { code: typeof e?.code === "number" ? e.code : -32603, message: typeof e?.message === "string" ? e.message : String(err) },
              });
            },
          );
      } else {
        try {
          this.handlers.onNotification(msg.method, msg.params);
        } catch (err) {
          this.log.warn(`agent ${this.spec.id}: ${msg.method} handler failed`, err);
        }
      }
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new AgentRpcError(
          typeof msg.error.code === "number" ? msg.error.code : -32603,
          typeof msg.error.message === "string" ? msg.error.message : `${p.method} failed`,
          msg.error.data,
        ));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private safeWrite(msg: unknown): void {
    try {
      this.write(msg);
    } catch {
      /* agent gone */
    }
  }

  /** Stop the process: close stdin, then kill after the grace period. Resolves when it exited. */
  stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.resolve();
    this.stopping = true;
    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (!this.exited) {
          this.log.info(`agent ${this.spec.id}: killing process ${child.pid ?? "?"} after the grace period`);
          killTree(child);
        }
      }, this.stopGraceMs);
      killTimer.unref?.();
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
    });
  }
}

/** Kill a process and, on Windows, its children (cmd.exe shims). */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
      return;
    } catch {
      /* fall through */
    }
  }
  child.kill("SIGKILL");
}
