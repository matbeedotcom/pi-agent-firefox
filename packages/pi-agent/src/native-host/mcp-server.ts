/**
 * Browser-tools MCP server (MCP over unix socket).
 *
 * Pi subagent children run as separate node processes: they have no ACP
 * channel to the connected app and no in-process tool bridge (the bridge
 * module state lives only in this broker process). This server gives them
 * browser access the standard way — the broker, which owns both the ACP
 * pipe and the tool bridge, exposes the browser tools + the host-side
 * `javascript` REPL as a plain MCP server on a private unix socket.
 *
 * Wire format: MCP JSON-RPC 2.0, newline-delimited (the same JSONL framing
 * as the MCP stdio transport; pi-mcp-adapter's UnixSocketClientTransport
 * speaks exactly this). Methods served: initialize, notifications/
 * initialized, ping, tools/list, tools/call.
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
import { PI_BROWSER_META, PI_BROKER } from "@pi-browser/protocol";
import { ipcEndpoint, isNamedPipe } from "./broker-ipc.js";
import { BROWSER_TOOL_SCHEMAS, REPL_TOOL_SCHEMAS } from "../browser/schemas.js";
import { MCP_PROTOCOL_VERSION } from "../browser/mcp-acp-client.js";
import type { Logger } from "../logger.js";
import type { BrowserToolBridge } from "../tool-bridge.js";

export interface McpBrowserServerOptions {
  log: Logger;
  /** Bridge tool calls are routed through (no sessionId → last-active ACP session). */
  bridge: BrowserToolBridge;
  /** Socket path; defaults to the broker run dir (env PI_BROWSER_BROKER_DIR honored). */
  socketPath?: string;
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

const SERVER_INFO = { name: "pi-browser", version: PI_BROWSER_META.version };

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
): Promise<void> {
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  switch (method) {
    case "initialize":
      reply(socket, id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Browser tools for the Firefox tab bound to the active Pi Browser session.",
      });
      return;
    case "notifications/initialized":
      return; // notification: no response
    case "ping":
      reply(socket, id, {});
      return;
    case "tools/list":
      reply(socket, id, {
        // Browser tools (add-on-routed) + the host-side `javascript` REPL.
        tools: [...BROWSER_TOOL_SCHEMAS, ...REPL_TOOL_SCHEMAS].map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.parameters,
        })),
      });
      return;
    case "tools/call": {
      const p = isRecord(params) ? params : {};
      const tool = typeof p.name === "string" ? p.name : "";
      const args = isRecord(p.arguments) ? p.arguments : {};
      const known = [...BROWSER_TOOL_SCHEMAS, ...REPL_TOOL_SCHEMAS].some((t) => t.name === tool);
      if (!known) {
        if (isNotification) return;
        replyError(socket, id, -32602, `unknown tool: ${tool}`);
        return;
      }
      log.info(`mcp browser: tools/call ${tool}`);
      try {
        const result = await bridge.call({ tool, args });
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
          content: [{ type: "text", text: `browser tool failed: ${text}` }],
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
  const dir =
    process.env.PI_BROWSER_BROKER_DIR || path.join(os.homedir(), ".pi", PI_BROKER.runDir);
  const socketPath = opts.socketPath ?? ipcEndpoint(dir, PI_BROKER.mcpSocketFile);

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
    log.debug("mcp browser: client connected");

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
        const p = dispatch(socket, msg, bridge, log);
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
    });
    const cleanup = () => {
      connections.delete(socket);
      log.debug("mcp browser: client disconnected");
      for (const p of pending) void p.catch(() => undefined);
      pending.clear();
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
