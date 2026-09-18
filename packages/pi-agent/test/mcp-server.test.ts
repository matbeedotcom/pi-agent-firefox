import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import { createLogger } from "../src/logger.js";
import { startMcpBrowserServer, type McpBrowserServerHandle } from "../src/native-host/mcp-server.js";
import type { BrowserToolBridge } from "../src/tool-bridge.js";
import { BROWSER_TOOL_SCHEMAS, REPL_TOOL_SCHEMAS } from "../src/browser/schemas.js";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });

let tmp: string;
let server: McpBrowserServerHandle | undefined;
let calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

/** Record tool calls; succeed with a canned text result, fail for the "boom" tool. */
function makeBridge(): BrowserToolBridge {
  return {
    registerSession: () => undefined,
    touchSession: () => undefined,
    closeSession: () => undefined,
    call: async (o) => {
      calls.push({ tool: o.tool, args: o.args });
      if (o.tool === "browser_navigate") {
        throw new Error("boom");
      }
      return { content: [{ type: "text", text: `ok:${o.tool}` }] };
    },
  };
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "pi-mcp-server-test-"));
  server = await startMcpBrowserServer({ log: quiet, bridge: makeBridge(), socketPath: path.join(tmp, "mcp.sock") });
});

after(async () => {
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Minimal JSONL MCP client for the tests. */
class MiniMcpClient {
  private socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(socketPath: string) {
    this.socket = net.createConnection(socketPath);
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id === undefined) continue;
        const w = this.waiters.get(msg.id);
        if (!w) continue;
        this.waiters.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
    });
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    return p;
  }

  notify(method: string): void {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    this.socket.destroy();
  }
}

test("mcp server: initialize handshake + tools/list surface", async () => {
  const client = new MiniMcpClient(server!.socketPath);
  await client.ready();
  const init = (await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  })) as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(init.serverInfo.name, "pi-browser");
  assert.equal(typeof init.protocolVersion, "string");
  client.notify("notifications/initialized");

  const list = (await client.request("tools/list")) as { tools: Array<{ name: string }> };
  const names = list.tools.map((t) => t.name).sort();
  // Browser tools (add-on-routed) + the host-side `javascript` REPL.
  const expected = [...BROWSER_TOOL_SCHEMAS, ...REPL_TOOL_SCHEMAS].map((t) => t.name).sort();
  assert.deepEqual(names, expected);
  assert.ok(names.includes("javascript"));
  assert.equal(names.length, 25);
  client.close();
});

test("mcp server: tools/call routes through the bridge and returns MCP result", async () => {
  calls = [];
  const client = new MiniMcpClient(server!.socketPath);
  await client.ready();
  await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const res = (await client.request("tools/call", {
    name: "browser_get_page",
    arguments: {},
  })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.content, [{ type: "text", text: "ok:browser_get_page" }]);
  assert.deepEqual(calls, [{ tool: "browser_get_page", args: {} }]);
  client.close();
});

test("mcp server: bridge failure surfaces as tools/call isError result", async () => {
  const client = new MiniMcpClient(server!.socketPath);
  await client.ready();
  await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const res = (await client.request("tools/call", {
    name: "browser_navigate",
    arguments: { url: "https://example.com" },
  })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
  client.close();
});

test("mcp server: unknown tool → JSON-RPC error; unknown method → -32601", async () => {
  const client = new MiniMcpClient(server!.socketPath);
  await client.ready();
  await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  await assert.rejects(
    client.request("tools/call", { name: "nope", arguments: {} }),
    /unknown tool: nope/,
  );
  await assert.rejects(client.request("bogus/method"), /method not found/);
  // Connection is still usable after protocol-level errors.
  const ping = await client.request("ping");
  assert.deepEqual(ping, {});
  client.close();
});

test("mcp server: ping + notifications do not break the stream", async () => {
  const client = new MiniMcpClient(server!.socketPath);
  await client.ready();
  assert.deepEqual(await client.request("ping"), {});
  client.notify("notifications/initialized");
  assert.deepEqual(await client.request("ping"), {});
  client.close();
});

test("mcp server: close removes the socket", async () => {
  const s2 = await startMcpBrowserServer({ log: quiet, bridge: makeBridge(), socketPath: path.join(tmp, "mcp2.sock") });
  assert.ok(server && s2.socketPath.endsWith("mcp2.sock"));
  await s2.close();
  assert.equal(existsSync(s2.socketPath), false);
});
