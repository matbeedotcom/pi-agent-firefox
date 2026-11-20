import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import { createLogger } from "../src/logger.js";
import { startMcpBrowserServer, type McpBrowserServerHandle } from "../src/native-host/mcp-server.js";
import { ipcEndpoint } from "../src/native-host/broker-ipc.js";
import type { BrowserToolBridge } from "../src/tool-bridge.js";
import { waitFor } from "./helpers.js";
import { BROWSER_TOOL_SCHEMAS, REPL_TOOL_SCHEMAS } from "../src/browser/schemas.js";
import { MAIL_TOOL_SCHEMAS } from "../src/mail/schemas.js";
import { COMPOSE_TOOL_SCHEMAS } from "../src/compose/schemas.js";
import { MAIL_MUTATION_TOOL_SCHEMAS } from "../src/mutation/schemas.js";
import { CONTACTS_TOOL_SCHEMAS } from "../src/contacts/schemas.js";

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
  server = await startMcpBrowserServer({ log: quiet, bridge: makeBridge(), socketPath: ipcEndpoint(tmp, "mcp.sock") });
});

after(async () => {
  await server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
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

  notify(method: string, params?: unknown): void {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
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
  // Firefox browser tools + the host-side `javascript` REPL + every
  // Thunderbird tool family (mail, compose, mail organization, contacts).
  const expected = [
    ...BROWSER_TOOL_SCHEMAS,
    ...REPL_TOOL_SCHEMAS,
    ...MAIL_TOOL_SCHEMAS,
    ...COMPOSE_TOOL_SCHEMAS,
    ...MAIL_MUTATION_TOOL_SCHEMAS,
    ...CONTACTS_TOOL_SCHEMAS,
  ].map((t) => t.name).sort();
  assert.deepEqual(names, expected);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const name of ["javascript", "browser_get_page", "mail_search", "compose_prepare_new", "mail_move", "contacts_search"]) {
    assert.ok(names.includes(name), `tools/list is missing ${name}`);
  }
  client.close();
});

test("mcp server: Thunderbird tools route through the bridge like browser tools", async () => {
  calls = [];
  const client = new MiniMcpClient(server!.socketPath);
  await client.ready();
  await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const res = (await client.request("tools/call", {
    name: "mail_search",
    arguments: { subject: "invoice" },
  })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.content, [{ type: "text", text: "ok:mail_search" }]);
  assert.deepEqual(calls, [{ tool: "mail_search", args: { subject: "invoice" } }]);
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
  const s2 = await startMcpBrowserServer({ log: quiet, bridge: makeBridge(), socketPath: ipcEndpoint(tmp, "mcp2.sock") });
  assert.ok(server && s2.socketPath === ipcEndpoint(tmp, "mcp2.sock"));
  await s2.close();
  assert.equal(existsSync(s2.socketPath), false);
});

// ---------------------------------------------------------------------------
// Caller sessions (openspec external-mcp-callers)
// ---------------------------------------------------------------------------

interface RecordedCall {
  tool: string;
  sessionId?: string;
  caller?: { name: string; version?: string };
}

async function callerServer(
  extra: { instanceId?: string; brokerPid?: number } = {},
): Promise<{ handle: McpBrowserServerHandle; seen: RecordedCall[]; closed: string[] }> {
  const seen: RecordedCall[] = [];
  const closed: string[] = [];
  const handle = await startMcpBrowserServer({
    log: quiet,
    socketPath: ipcEndpoint(tmp, `caller-${Math.random().toString(36).slice(2)}.sock`),
    // The test process is not a broker: no parent-pid matches by accident.
    brokerPid: -1,
    ...extra,
    bridge: {
      registerSession: () => undefined,
      touchSession: () => undefined,
      closeSession: (id) => closed.push(id),
      call: async (o) => {
        seen.push({
          tool: o.tool,
          ...(o.sessionId ? { sessionId: o.sessionId } : {}),
          ...(o.caller ? { caller: { name: o.caller.name, ...(o.caller.version ? { version: o.caller.version } : {}) } } : {}),
        });
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  });
  return { handle, seen, closed };
}

test("mcp server: each connection is its own caller session, named by pi-browser/caller", async () => {
  const { handle, seen, closed } = await callerServer({ instanceId: "inst-1" });
  const a = new MiniMcpClient(handle.socketPath);
  const b = new MiniMcpClient(handle.socketPath);
  try {
    await Promise.all([a.ready(), b.ready()]);
    a.notify("pi-browser/caller", { name: "codex", version: "0.9", pid: 4242 });
    b.notify("pi-browser/caller", { name: "claude-code" });
    await a.request("tools/call", { name: "browser_get_page", arguments: {} });
    await b.request("tools/call", { name: "mail_search", arguments: {} });
    await a.request("tools/call", { name: "browser_get_dom", arguments: {} });
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[0].caller, { name: "codex", version: "0.9" });
    assert.deepEqual(seen[1].caller, { name: "claude-code" });
    assert.match(String(seen[0].sessionId), /^mcp:/);
    assert.equal(seen[0].sessionId, seen[2].sessionId, "one session per connection");
    assert.notEqual(seen[0].sessionId, seen[1].sessionId, "connections never share a session");

    a.close();
    await waitFor(() => closed.length === 1);
    assert.deepEqual(closed, [seen[0].sessionId], "closing the connection ends its caller session");
  } finally {
    a.close();
    b.close();
    await handle.close();
  }
});

test("mcp server: a direct client is named from initialize; no name means unknown MCP client", async () => {
  const { handle, seen } = await callerServer();
  const named = new MiniMcpClient(handle.socketPath);
  const anon = new MiniMcpClient(handle.socketPath);
  try {
    await Promise.all([named.ready(), anon.ready()]);
    await named.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor", version: "1.2" } });
    await named.request("tools/call", { name: "browser_get_page", arguments: {} });
    await anon.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.deepEqual(seen[0].caller, { name: "cursor", version: "1.2" });
    assert.deepEqual(seen[1].caller, { name: "unknown MCP client" });
  } finally {
    named.close();
    anon.close();
    await handle.close();
  }
});

test("mcp server: host children (matching marker or broker parent pid) keep last-active routing", async () => {
  const { handle, seen, closed } = await callerServer({ instanceId: "inst-2", brokerPid: 777 });
  const marker = new MiniMcpClient(handle.socketPath);
  const child = new MiniMcpClient(handle.socketPath);
  const stale = new MiniMcpClient(handle.socketPath);
  try {
    await Promise.all([marker.ready(), child.ready(), stale.ready()]);
    marker.notify("pi-browser/caller", { name: "pi", hostChild: "inst-2" });
    child.notify("pi-browser/caller", { name: "pi", ppid: 777 });
    stale.notify("pi-browser/caller", { name: "pi", hostChild: "inst-OLD" });
    await marker.request("tools/call", { name: "browser_get_page", arguments: {} });
    await child.request("tools/call", { name: "browser_get_page", arguments: {} });
    await stale.request("tools/call", { name: "browser_get_page", arguments: {} });
    assert.equal(seen[0].sessionId, undefined, "marker match: no caller session");
    assert.equal(seen[1].sessionId, undefined, "spawned by the broker: no caller session");
    assert.match(String(seen[2].sessionId), /^mcp:/, "a stale marker is an external caller");
    marker.close();
    child.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(closed, [], "host children have no caller session to close");
  } finally {
    marker.close();
    child.close();
    stale.close();
    await handle.close();
  }
});
