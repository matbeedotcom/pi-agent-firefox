/**
 * Trusted User Agent tools MCP server (MCP over unix socket / Windows named pipe).
 *
 * Pi subagent children run as separate node processes: they have no ACP
 * channel to the connected app and no in-process tool bridge (the bridge
 * module state lives only in this broker process). This server gives them
 * browser and mail access the standard way — the broker, which owns both
 * the ACP pipe and the tool bridge, exposes the add-on tools as a plain MCP
 * server on a private unix socket: Firefox's browser tools, the host-side
 * `javascript` REPL, and Thunderbird's mail / compose / mail-organization /
 * contacts tools. Calls route to whichever connected app serves the tool
 * (the broker's cross-app routing), so a subagent reaches Thunderbird even
 * when its parent session lives in Firefox, and vice versa.
 *
 * The list is static (every tool family, whether or not its app is
 * connected right now): MCP clients cache tools/list and this server
 * announces listChanged:false. A call for an app that is not connected
 * fails with "no connected client provides tool: <name>".
 *
 * Wire format: MCP JSON-RPC 2.0, newline-delimited (the same JSONL framing
 * as the MCP stdio transport; pi-mcp-adapter's UnixSocketClientTransport
 * speaks exactly this). Methods served: initialize, notifications/
 * initialized, ping, tools/list, tools/call.
 *
 * Callers (openspec external-mcp-callers): every connection is its own
 * *caller session* (`mcp:<uuid>`) named by the `trusted-ua/caller`
 * notification the stdio bridge sends first, or by the client's own
 * `initialize` clientInfo. Its calls route through the capability registry
 * with no add-on chat session, go through the caller gate (external access +
 * per-app caller approval) and keep their own grants and REPL state; the
 * session ends when the connection closes. A connection whose bridge
 * reports the broker's own TRUSTED_UA_HOST_CHILD (or whose parent process
 * is the broker) belongs to a pi session the host spawned: its calls keep
 * the old routing to the most recently active add-on session.
 *
 * Security model (mirrors broker-ipc.ts): same-user only — the socket lives
 * in the 0700 run dir under $HOME and is 0600, no localhost TCP. Any
 * same-user process (e.g. a pi-subagents child spawned by the broker) can
 * connect; tool calls are then routed through the provider's standard
 * routing + permission path, so per-tool approvals in the add-on UI still
 * apply.
 *
 * Windows: the endpoint is a named pipe (ipcEndpoint). Pipes have no file
 * mode; their default DACL gives the creating user full access and other
 * accounts READ only. A read-only handle cannot send a JSON-RPC request and
 * each connection is its own pipe instance, so another account can neither
 * call a tool nor observe this user's traffic.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MCP_CALLER_NOTIFICATION,
  LEGACY_MCP_CALLER_NOTIFICATION,
  MCP_SERVER_NAME,
  TRUSTED_UA_META,
  TRUSTED_UA_BROKER,
  UNKNOWN_CALLER_NAME,
  parseCallerInfo,
  type CallerInfo,
} from "@trusted-ua/protocol";
import { LEGACY_PIPE_PREFIX, ipcEndpoint, isNamedPipe } from "./broker-ipc.js";
import { envValue } from "../env.js";
import { BROWSER_TOOL_SCHEMAS, REPL_TOOL_SCHEMAS } from "../browser/schemas.js";
import { MAIL_TOOL_SCHEMAS } from "../mail/schemas.js";
import { COMPOSE_TOOL_SCHEMAS } from "../compose/schemas.js";
import { MAIL_MUTATION_TOOL_SCHEMAS } from "../mutation/schemas.js";
import { CONTACTS_TOOL_SCHEMAS } from "../contacts/schemas.js";
import { MCP_PROTOCOL_VERSION } from "../browser/mcp-acp-client.js";
import type { Logger } from "../logger.js";
import type { BrowserToolBridge } from "../tool-bridge.js";
import { runDir } from "../paths.js";

export interface McpBrowserServerOptions {
  log: Logger;
  /** Bridge tool calls are routed through (caller sessions; host children → last-active ACP session). */
  bridge: BrowserToolBridge;
  /** Socket path; defaults to the broker run dir (env TRUSTED_UA_BROKER_DIR honored). */
  socketPath?: string;
  /**
   * The broker instance id the host put in TRUSTED_UA_HOST_CHILD. A caller
   * reporting it (or whose parent pid is `brokerPid`) was spawned by the host.
   */
  instanceId?: string;
  /** The broker's pid (default process.pid). */
  brokerPid?: number;
}

/** Per-connection caller state. */
interface ConnectionCaller {
  /** Caller session id (`mcp:<uuid>`). */
  readonly id: string;
  info: CallerInfo;
  /** Named by `trusted-ua/caller` (takes precedence over initialize). */
  announced: boolean;
  /** A caller-session call ran (closeSession needed at disconnect). */
  used: boolean;
}

export interface McpBrowserServerHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const SERVER_INFO = { name: MCP_SERVER_NAME, version: TRUSTED_UA_META.version };

/** Every tool this server lists and accepts (see the header for why static). */
export const MCP_TOOL_SCHEMAS: ReadonlyArray<{ name: string; description?: string; parameters: unknown }> = [
  // Firefox (add-on-routed) + the host-side `javascript` REPL.
  ...BROWSER_TOOL_SCHEMAS,
  ...REPL_TOOL_SCHEMAS,
  // Thunderbird (add-on-routed).
  ...MAIL_TOOL_SCHEMAS,
  ...COMPOSE_TOOL_SCHEMAS,
  ...MAIL_MUTATION_TOOL_SCHEMAS,
  ...CONTACTS_TOOL_SCHEMAS,
];
const MCP_TOOL_NAMES = new Set(MCP_TOOL_SCHEMAS.map((t) => t.name));

/** initialize result (shared with the stdio bridge, which answers it locally). */
export function mcpInitializeResult(): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      "Trusted User Agent tools: browser_* act on the Firefox tab bound to this connection — start with " +
      "browser_list_tabs + browser_bind_tab (or browser_open_tab). mail_*, compose_*, contacts_* act on " +
      "Thunderbird. Each tool runs in the app that serves it, and the user approves each tool call there.",
  };
}

/** tools/list result (shared with the stdio bridge). */
export function mcpToolListResult(): { tools: Array<Record<string, unknown>> } {
  return {
    tools: MCP_TOOL_SCHEMAS.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.parameters,
    })),
  };
}

/** The broker's MCP endpoint (TRUSTED_UA_BROKER_DIR honored): unix socket, or a named pipe on Windows. */
export function defaultMcpEndpoint(): string {
  return ipcEndpoint(runDir(), TRUSTED_UA_BROKER.mcpSocketFile);
}

/**
 * Where a v0.4.0 broker listened: `~/.pi/run` (or the same env override) and
 * the `pi-agent-` pipe prefix on Windows.
 */
export function legacyMcpEndpoint(): string {
  const dir = envValue("BROKER_DIR")?.trim() || path.join(os.homedir(), ".pi", TRUSTED_UA_BROKER.runDir);
  return ipcEndpoint(dir, TRUSTED_UA_BROKER.mcpSocketFile, process.platform, LEGACY_PIPE_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(socket: net.Socket, id: unknown, result: unknown): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(socket: net.Socket, id: unknown, code: number, message: string): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

/**
 * Handle one line-delimited MCP request. Returns the MCP tools/call-shaped
 * result (or a JSON-RPC error reply for protocol-level failures).
 */
async function dispatch(
  socket: net.Socket,
  msg: JsonRpcMessage,
  bridge: BrowserToolBridge,
  log: Logger,
  caller: ConnectionCaller,
  isHostChild: (info: CallerInfo) => boolean,
): Promise<void> {
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  switch (method) {
    case MCP_CALLER_NOTIFICATION:
    case LEGACY_MCP_CALLER_NOTIFICATION: // a v0.4.0 bridge; new bridges send both
      caller.info = parseCallerInfo(params);
      caller.announced = true;
      log.info(
        `mcp browser: caller ${caller.id} is "${caller.info.name}"${caller.info.version ? ` ${caller.info.version}` : ""}` +
          `${caller.info.pid !== undefined ? ` (bridge pid ${caller.info.pid})` : ""}${isHostChild(caller.info) ? " [host child]" : ""}`,
      );
      return;
    case "initialize": {
      const clientInfo = isRecord(params) ? params.clientInfo : undefined;
      if (!caller.announced && isRecord(clientInfo)) {
        const parsed = parseCallerInfo(clientInfo);
        caller.info = { ...caller.info, name: parsed.name, ...(parsed.version ? { version: parsed.version } : {}) };
        log.info(`mcp browser: caller ${caller.id} is "${caller.info.name}" (from initialize)`);
      }
      reply(socket, id, mcpInitializeResult());
      return;
    }
    case "notifications/initialized":
      return; // notification: no response
    case "ping":
      reply(socket, id, {});
      return;
    case "tools/list":
      reply(socket, id, mcpToolListResult());
      return;
    case "tools/call": {
      const p = isRecord(params) ? params : {};
      const tool = typeof p.name === "string" ? p.name : "";
      const args = isRecord(p.arguments) ? p.arguments : {};
      if (!MCP_TOOL_NAMES.has(tool)) {
        if (isNotification) return;
        replyError(socket, id, -32602, `unknown tool: ${tool}`);
        return;
      }
      const hostChild = isHostChild(caller.info);
      // An external ACP agent's bridge for a sidebar session: honoured only
      // from a host child (a forged token from elsewhere is ignored and the
      // connection stays an external caller).
      const parentSession =
        hostChild && caller.info.parentSession ? bridge.resolveParentSession?.(caller.info.parentSession) : undefined;
      log.info(
        `mcp browser: tools/call ${tool} (${parentSession ? `agent session ${parentSession}` : hostChild ? "host child" : `caller ${caller.info.name}, ${caller.id}`})`,
      );
      try {
        let result;
        if (parentSession) {
          result = await bridge.call({ tool, args, sessionId: parentSession });
        } else if (hostChild && caller.info.parentSession) {
          // The agent session it belonged to is gone: don't guess another one.
          throw new Error("the sidebar session this agent was started for is closed");
        } else if (hostChild) {
          // Spawned by this host (a pi subagent's MCP client): keep the
          // routing to the most recently active add-on session.
          result = await bridge.call({ tool, args });
        } else {
          caller.used = true;
          result = await bridge.call({ tool, args, sessionId: caller.id, caller: caller.info });
        }
        reply(socket, id, {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (err) {
        // Tool-level failure → MCP tools/call result with isError (per MCP
        // spec), not a JSON-RPC error: the connection stays usable.
        const text = err instanceof Error ? err.message : String(err);
        log.warn(`mcp browser: ${tool} failed: ${text}`);
        reply(socket, id, {
          content: [{ type: "text", text: `${tool} failed: ${text}` }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (isNotification) return;
      replyError(socket, id, -32601, `method not found: ${String(method)}`);
  }
}

/**
 * Start the browser-tools MCP server on a private unix socket.
 *
 * Reclaims a stale socket only when the owning process is gone (same
 * caution as reclaimBrokerSocket: never unlink a live listener).
 */
export async function startMcpBrowserServer(opts: McpBrowserServerOptions): Promise<McpBrowserServerHandle> {
  const { log, bridge } = opts;
  const brokerPid = opts.brokerPid ?? process.pid;
  const isHostChild = (info: CallerInfo): boolean =>
    (opts.instanceId !== undefined && info.hostChild === opts.instanceId) ||
    (info.ppid !== undefined && info.ppid === brokerPid);
  const dir = runDir();
  const socketPath = opts.socketPath ?? defaultMcpEndpoint();

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700); // mkdir mode is subject to umask
  } catch {
    /* best-effort */
  }
  if (existsSync(socketPath)) {
    // Probe: a listener on the socket means a live broker (possibly ours
    // from a prior run that lost its state) owns it — do not steal it.
    const probe = net.createConnection(socketPath);
    const stale = await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        probe.destroy();
        resolve(v);
      };
      probe.once("connect", () => done(false));
      probe.once("error", () => done(true));
      setTimeout(() => done(true), 500).unref?.();
    });
    if (!stale) {
      throw new Error(`MCP socket already in use: ${socketPath}`);
    }
    if (!isNamedPipe(socketPath)) rmSync(socketPath, { force: true });
  }

  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    handleConnection(socket, bridge, log);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  if (!isNamedPipe(socketPath)) {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
  log.info(`mcp browser server: listening on ${socketPath}`);

  function handleConnection(socket: net.Socket, bridge: BrowserToolBridge, log: Logger): void {
    let buffer = "";
    const pending = new Set<Promise<void>>();
    const caller: ConnectionCaller = {
      id: `mcp:${randomUUID()}`,
      info: { name: UNKNOWN_CALLER_NAME },
      announced: false,
      used: false,
    };
    log.debug(`mcp browser: client connected (${caller.id})`);

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          replyError(socket, null, -32700, "parse error");
          continue;
        }
        const p = dispatch(socket, msg, bridge, log, caller, isHostChild);
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      connections.delete(socket);
      log.debug(`mcp browser: client disconnected (${caller.id})`);
      for (const p of pending) void p.catch(() => undefined);
      pending.clear();
      // End the caller session: grants, pending prompts, REPL worker.
      if (caller.used) {
        try {
          bridge.closeSession(caller.id);
        } catch (err) {
          log.debug(`mcp browser: closing ${caller.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    socket.on("close", cleanup);
    socket.on("error", (err) => {
      log.debug(`mcp browser: socket error: ${err.message}`);
      cleanup();
    });
  }

  return {
    socketPath,
    close: async () => {
      server.close(); // stop accepting; tracked sockets are destroyed below
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!isNamedPipe(socketPath)) rmSync(socketPath, { force: true });
    },
  };
}
