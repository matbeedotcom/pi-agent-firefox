/**
 * stdio ⇄ broker bridge for the Trusted User Agent MCP server.
 *
 * The broker serves MCP over a private unix socket / Windows named pipe
 * (mcp-server.ts). pi-mcp-adapter can dial that socket directly, but pi's
 * built-in MCP client (pi >= 1.5) only speaks stdio and HTTP. This script is
 * a plain stdio MCP server that every client can launch
 * (`/trusted-ua mcp install` writes `{ command: <node>, args: [<dist>/native-host/mcp-stdio-main.js] }`):
 *
 * - initialize, ping and tools/list are answered locally, from the same
 *   static tool list the broker serves (mcp-server.ts). The server is
 *   therefore always available to the MCP client — even before Firefox or
 *   Thunderbird has started the host — and its tool list never depends on
 *   timing.
 * - tools/call is forwarded to the broker's socket, connecting lazily and
 *   reconnecting after the broker restarts. With no broker running, the
 *   call returns an MCP tool error telling the model what to do instead of
 *   hanging.
 *
 * - Caller identity: the bridge remembers the client's `initialize`
 *   clientInfo and, as the first line of every broker connection (including
 *   reconnects), sends the `trusted-ua/caller` notification: name, version,
 *   its own pid and parent pid, and the TRUSTED_UA_HOST_CHILD value it
 *   inherited. The broker runs the connection as that caller's session.
 *   An older broker ignores the notification.
 *
 * Wire format on both sides: newline-delimited JSON-RPC 2.0 (MCP stdio).
 * stdout carries protocol messages only; diagnostics go to stderr.
 */
import net from "node:net";
import { createInterface } from "node:readline";
import { LEGACY_MCP_CALLER_NOTIFICATION, MCP_CALLER_NOTIFICATION, normalizeCallerName, type CallerInfo } from "@trusted-ua/protocol";
import { defaultMcpEndpoint, mcpInitializeResult, mcpToolListResult } from "./mcp-server.js";
import { envValue } from "../env.js";

/** How long a tools/call waits to connect to the broker before giving up. */
const CONNECT_TIMEOUT_MS = 3_000;

const NOT_RUNNING =
  "Trusted User Agent is not running: open Firefox (or Thunderbird) with the Trusted User Agent add-on — its native host serves these tools — then retry.";

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface BridgeOptions {
  /** Broker MCP endpoint (default: defaultMcpEndpoint()). */
  endpoint?: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Diagnostics sink (stderr). */
  log?: (line: string) => void;
  /** Environment to read TRUSTED_UA_HOST_CHILD from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Run the bridge until `input` ends. Resolves when it has shut down. */
export function runMcpStdioBridge(opts: BridgeOptions): Promise<void> {
  const endpoint = opts.endpoint ?? defaultMcpEndpoint();
  const log = opts.log ?? (() => {});
  const write = (msg: unknown) => opts.output.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
  const replyError = (id: unknown, code: number, message: string) =>
    write({ jsonrpc: "2.0", id, error: { code, message } });
  const toolError = (id: unknown, text: string) =>
    reply(id, { content: [{ type: "text", text }], isError: true });

  const env = opts.env ?? process.env;
  /** Who is calling: filled from initialize's clientInfo. */
  const caller: CallerInfo = { name: normalizeCallerName(undefined), pid: process.pid, ppid: process.ppid };
  const hostChild = envValue("HOST_CHILD", env);
  if (hostChild) caller.hostChild = hostChild;
  // Started by the host for a sidebar session on an external ACP agent:
  // the broker runs this connection's calls for that session.
  const parentSession = envValue("PARENT_SESSION", env);
  if (parentSession) caller.parentSession = parentSession;

  let socket: net.Socket | undefined;
  let connecting: Promise<net.Socket | undefined> | undefined;
  /** tools/call ids forwarded on the current connection, awaiting a reply. */
  const pending = new Set<unknown>();

  function connect(): Promise<net.Socket | undefined> {
    if (socket && !socket.destroyed) return Promise.resolve(socket);
    connecting ??= new Promise<net.Socket | undefined>((resolve) => {
      const s = net.createConnection(endpoint);
      const timer = setTimeout(() => {
        s.destroy();
        resolve(undefined);
      }, CONNECT_TIMEOUT_MS);
      s.once("connect", () => {
        clearTimeout(timer);
        socket = s;
        // Identify the caller first: the broker names this connection's
        // caller session from it (older brokers drop unknown notifications).
        s.write(`${JSON.stringify({ jsonrpc: "2.0", method: MCP_CALLER_NOTIFICATION, params: caller })}\n`);
        // A v0.4.0 broker only knows the old name; a new one takes it as a repeat.
        s.write(`${JSON.stringify({ jsonrpc: "2.0", method: LEGACY_MCP_CALLER_NOTIFICATION, params: caller })}\n`);
        let buf = "";
        s.setEncoding("utf8");
        s.on("data", (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as Message;
              pending.delete(msg.id);
            } catch {
              // not JSON: pass through untouched; the client reports it
            }
            opts.output.write(`${line}\n`);
          }
        });
        const lost = () => {
          if (socket === s) socket = undefined;
          for (const id of pending) toolError(id, "Lost the connection to Trusted User Agent while the tool was running. Retry the call.");
          pending.clear();
        };
        s.on("close", lost);
        s.on("error", (err) => log(`broker connection error: ${err.message}`));
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        log(`broker not reachable at ${endpoint}: ${err.message}`);
        resolve(undefined);
      });
    }).finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  async function forward(msg: Message, line: string): Promise<void> {
    const s = await connect();
    if (!s) {
      toolError(msg.id, NOT_RUNNING);
      return;
    }
    pending.add(msg.id);
    s.write(`${line}\n`);
  }

  function handle(line: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      replyError(null, -32700, "parse error");
      return;
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    switch (msg.method) {
      case "initialize": {
        const info = (msg.params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined)?.clientInfo;
        if (info && typeof info === "object") {
          caller.name = normalizeCallerName(info.name);
          if (typeof info.version === "string" && info.version.trim()) caller.version = info.version.trim().slice(0, 32);
        }
        if (isRequest) reply(msg.id, mcpInitializeResult());
        return;
      }
      case "ping":
        if (isRequest) reply(msg.id, {});
        return;
      case "tools/list":
        if (isRequest) reply(msg.id, mcpToolListResult());
        return;
      case "tools/call":
        if (isRequest) void forward(msg, line);
        return;
      default:
        // notifications/* and anything else: notifications get no reply
        if (isRequest) replyError(msg.id, -32601, `method not found: ${String(msg.method)}`);
    }
  }

  return new Promise<void>((resolve) => {
    const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.trim()) handle(line);
    });
    rl.on("close", () => {
      // Let in-flight calls finish briefly, then shut down.
      const done = () => {
        socket?.end();
        resolve();
      };
      if (pending.size === 0) done();
      else setTimeout(done, 1_000).unref?.();
    });
  });
}
