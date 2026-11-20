/**
 * stdio MCP bridge (dist/native-host/mcp-stdio-main.js) — the command
 * `/pi-browser mcp install` registers, so pi's built-in MCP client (stdio /
 * HTTP only) can reach the broker's socket/pipe MCP server.
 *
 * Runs the real built entry point as a child process, exactly as an MCP
 * client launches it, against a real broker MCP server (fake tool bridge).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logger.js";
import { startMcpBrowserServer, MCP_TOOL_SCHEMAS, type McpBrowserServerHandle } from "../src/native-host/mcp-server.js";
import type { BrowserToolBridge } from "../src/tool-bridge.js";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });
// dist-tests/test/ → package root → dist/native-host/mcp-stdio-main.js
const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "native-host", "mcp-stdio-main.js");

let tmp: string;
const savedBrokerDir = process.env.PI_BROWSER_BROKER_DIR;

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "pi-mcp-bridge-test-"));
  // Both the bridge child and startMcpBrowserServer resolve the endpoint from this.
  process.env.PI_BROWSER_BROKER_DIR = path.join(tmp, "run");
});

after(() => {
  if (savedBrokerDir === undefined) delete process.env.PI_BROWSER_BROKER_DIR;
  else process.env.PI_BROWSER_BROKER_DIR = savedBrokerDir;
  rmSync(tmp, { recursive: true, force: true });
});

function fakeBridge(): BrowserToolBridge {
  return {
    registerSession: () => undefined,
    touchSession: () => undefined,
    closeSession: () => undefined,
    call: async (o) => ({ content: [{ type: "text", text: `ok:${o.tool}:${JSON.stringify(o.args)}` }] }),
  };
}

/** Line-delimited JSON-RPC client over the bridge's stdio. */
class StdioClient {
  private buf = "";
  private nextId = 1;
  private waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  readonly child: ChildProcess;

  constructor(extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    // The test runner itself may run under a host (PI_BROWSER_HOST_CHILD set).
    if (!("PI_BROWSER_HOST_CHILD" in extraEnv)) delete env.PI_BROWSER_HOST_CHILD;
    this.child = spawn(process.execPath, [BRIDGE], { stdio: ["pipe", "pipe", "pipe"], env });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        const w = this.waiters.get(msg.id as number);
        if (w) {
          this.waiters.delete(msg.id as number);
          w(msg);
        }
      }
    });
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiters.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000).unref();
    });
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    return p;
  }

  notify(method: string): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async close(): Promise<number | null> {
    this.child.stdin!.end();
    return new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
  }
}

const callText = (msg: Record<string, unknown>) =>
  ((msg.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "") as string;

test("bridge: initialize + tools/list answer locally — no broker running", async () => {
  const client = new StdioClient();
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, "pi-browser");
    client.notify("notifications/initialized");
    const list = await client.request("tools/list");
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.deepEqual(names, MCP_TOOL_SCHEMAS.map((t) => t.name), "same tool list as the broker serves");
    assert.ok(names.includes("browser_get_page") && names.includes("mail_search"));
    assert.deepEqual((await client.request("ping")).result, {});

    // tools/call without a broker: a tool error that tells the model what to do (no hang).
    const call = await client.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.equal((call.result as { isError?: boolean }).isError, true);
    assert.match(callText(call), /Pi Browser is not running/);

    const unknown = await client.request("bogus/method");
    assert.equal((unknown.error as { code: number }).code, -32601);
    assert.equal(await client.close(), 0, "exits cleanly when stdin closes");
  } finally {
    client.child.kill();
  }
});

test("bridge: tools/call is forwarded to the broker, and reconnects after a broker restart", async () => {
  let server: McpBrowserServerHandle | undefined = await startMcpBrowserServer({ log: quiet, bridge: fakeBridge() });
  const client = new StdioClient();
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    const ok = await client.request("tools/call", { name: "mail_search", arguments: { subject: "invoice" } });
    assert.equal((ok.result as { isError?: boolean }).isError, undefined);
    assert.equal(callText(ok), 'ok:mail_search:{"subject":"invoice"}', "routed through the broker's tool bridge");

    // Broker-side protocol errors pass through unchanged.
    const bad = await client.request("tools/call", { name: "nope", arguments: {} });
    assert.match(String((bad.error as { message?: string })?.message), /unknown tool: nope/);

    // Broker goes away: the next call reports it instead of hanging.
    await server.close();
    server = undefined;
    const down = await client.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.equal((down.result as { isError?: boolean }).isError, true);
    assert.match(callText(down), /Pi Browser is not running|Lost the connection/);

    // Broker comes back (e.g. Firefox restarted): the bridge reconnects on the next call.
    server = await startMcpBrowserServer({ log: quiet, bridge: fakeBridge() });
    const again = await client.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.equal(callText(again), "ok:browser_get_page:{}");
  } finally {
    await client.close().catch(() => undefined);
    client.child.kill();
    await server?.close();
  }
});

test("bridge: names the caller to the broker on every connect, including reconnects", async () => {
  const seen: Array<{ sessionId?: string; caller?: { name: string; version?: string; pid?: number; hostChild?: string } }> = [];
  const recording = (): BrowserToolBridge => ({
    ...fakeBridge(),
    call: async (o) => {
      seen.push({
        ...(o.sessionId ? { sessionId: o.sessionId } : {}),
        ...(o.caller ? { caller: o.caller } : {}),
      });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  let server: McpBrowserServerHandle | undefined = await startMcpBrowserServer({ log: quiet, bridge: recording(), instanceId: "broker-A", brokerPid: -1 });
  // A client that is NOT a host child: a stale marker from another broker.
  const client = new StdioClient({ PI_BROWSER_HOST_CHILD: "broker-OLD" });
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
    await client.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].caller?.name, "claude-code", "the broker sees the MCP client's name");
    assert.equal(seen[0].caller?.version, "2.1.0");
    assert.equal(seen[0].caller?.pid, client.child.pid, "the bridge reports its own pid");
    assert.match(String(seen[0].sessionId), /^mcp:/, "runs as a caller session");

    // Broker restart: the reconnect announces the caller again.
    await server.close();
    server = await startMcpBrowserServer({ log: quiet, bridge: recording(), instanceId: "broker-B", brokerPid: -1 });
    await client.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].caller?.name, "claude-code");
    assert.notEqual(seen[1].sessionId, seen[0].sessionId, "a new connection is a new caller session");
  } finally {
    await client.close().catch(() => undefined);
    client.child.kill();
    await server?.close();
  }
});

test("bridge: a host child (marker matches the broker) keeps the old session routing", async () => {
  const seen: Array<{ sessionId?: string; caller?: unknown }> = [];
  const server = await startMcpBrowserServer({
    log: quiet,
    instanceId: "broker-C",
    bridge: {
      ...fakeBridge(),
      call: async (o) => {
        seen.push({ sessionId: o.sessionId, caller: o.caller });
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  });
  const client = new StdioClient({ PI_BROWSER_HOST_CHILD: "broker-C" });
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "1.5.2" } });
    await client.request("tools/call", { name: "mail_search", arguments: {} });
    assert.deepEqual(seen, [{ sessionId: undefined, caller: undefined }], "no caller session: last-active routing");
  } finally {
    await client.close().catch(() => undefined);
    client.child.kill();
    await server.close();
  }
});

test("bridge: an older broker that ignores pi-browser/caller still serves calls", async () => {
  // v0.2.5's dispatch: unknown notifications are dropped, tools/call answered.
  const { defaultMcpEndpoint } = await import("../src/native-host/mcp-server.js");
  const { mkdirSync } = await import("node:fs");
  const net = await import("node:net");
  mkdirSync(path.join(tmp, "run"), { recursive: true });
  const lines: string[] = [];
  const old = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines.push(line);
        const msg = JSON.parse(line) as { id?: unknown; method?: string };
        if (msg.id === undefined) continue; // notification: dropped
        s.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "old-ok" }] } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => old.listen(defaultMcpEndpoint(), resolve));
  const client = new StdioClient();
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gemini-cli" } });
    const res = await client.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.equal(callText(res), "old-ok");
    assert.match(lines[0], /"method":"pi-browser\/caller"/, "the caller notification goes first");
  } finally {
    await client.close().catch(() => undefined);
    client.child.kill();
    await new Promise<void>((resolve) => old.close(() => resolve()));
  }
});
