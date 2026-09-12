import { test } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../src/logger.js";
import { createMemoryTransportPair, type Dispatcher } from "../src/native-host/transport.js";
import { CapabilityToolProvider, LegacyBrowserCallbackTransport, NativeMcpOverAcpTransport } from "../src/browser/provider.js";
import {
  BROWSER_TOOLS,
  CLIENT_METHODS,
  MAIL_TOOLS,
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  X_PI_BROWSER,
  toErrorObject,
  type JsonRpcErrorObject,
} from "@pi-browser/protocol";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });

interface FakeFirefox {
  a: Dispatcher; // acts as Firefox
  provider: CapabilityToolProvider;
  toolCalls: Array<{ sessionId: string; tool: string; args: unknown }>;
  respondTool: (id: number, result?: unknown, error?: JsonRpcErrorObject) => void;
}

function setupFakeFirefox(): FakeFirefox {
  const { a, b } = createMemoryTransportPair(quiet, quiet);
  const provider = new CapabilityToolProvider(b.transport, quiet);
  const toolCalls: FakeFirefox["toolCalls"] = [];
  a.transport.onRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.tool) {
      const p = params as { sessionId: string; tool: string; arguments: unknown };
      toolCalls.push({ sessionId: p.sessionId, tool: p.tool, args: p.arguments });
      // Default: echo a page result.
      a.transport.respond(id, {
        content: [{ type: "text", text: JSON.stringify({ url: "http://localhost:5173", title: "Salvage Rush" }) }],
      });
      return;
    }
    a.transport.respondError(id, { code: -32601, message: `fake firefox: unknown ${method}` });
  };
  return {
    a,
    provider,
    toolCalls,
    respondTool: (id, result, error) => (error ? a.transport.respondError(id, error) : a.transport.respond(id, result)),
  };
}

test("selectMode: legacy by default, mcp-acp when client declares acp server", () => {
  const { provider } = setupFakeFirefox();
  assert.equal(provider.selectMode(undefined), "legacy");
  assert.equal(provider.selectMode([]), "legacy");
  assert.equal(
    provider.selectMode([{ type: "stdio", name: "x" as never } as never]),
    "legacy",
  );
  assert.equal(provider.selectMode([{ name: "firefox-browser", type: "acp", serverId: "s1" }]), "mcp-acp");
});

test("createTools: 8 MCP-compatible browser tools", () => {
  const { provider } = setupFakeFirefox();
  const tools = provider.createTools({ id: "s1" }, "legacy");
  assert.equal(tools.length, BROWSER_TOOLS.length);
  for (const tool of tools) {
    const def = BROWSER_TOOLS.find((d) => d.name === tool.name);
    assert.ok(def, `tool ${tool.name} missing from protocol registry`);
    assert.equal(tool.description, def.description);
  }
});

test("createTools: mail capability registers the read-only mail tools, no browser tools", () => {
  const { provider } = setupFakeFirefox();
  const tools = provider.createTools({ id: "s1" }, "legacy", undefined, ["mail", "attachments"]);
  assert.equal(tools.length, MAIL_TOOLS.length);
  for (const tool of tools) {
    const def = MAIL_TOOLS.find((d) => d.name === tool.name);
    assert.ok(def, `tool ${tool.name} missing from protocol mail registry`);
    assert.equal(tool.description, def.description);
  }
  assert.ok(tools.every((t) => t.name.startsWith("mail_")), "mail client gets only mail tools");
});

test("createTools: browser capability registers only browser tools (no mail)", () => {
  const { provider } = setupFakeFirefox();
  const tools = provider.createTools({ id: "s1" }, "legacy", undefined, ["browser"]);
  assert.equal(tools.length, BROWSER_TOOLS.length);
  assert.ok(tools.every((t) => t.name.startsWith("browser_")), "browser client gets no mail tools");
});

test("createTools: empty capabilities register no tools", () => {
  const { provider } = setupFakeFirefox();
  assert.equal(provider.createTools({ id: "s1" }, "legacy", undefined, []).length, 0);
});

test("createTools: both capabilities register browser + mail tools", () => {
  const { provider } = setupFakeFirefox();
  const tools = provider.createTools({ id: "s1" }, "legacy", undefined, ["browser", "mail"]);
  const names = tools.map((t) => t.name);
  assert.equal(names.length, BROWSER_TOOLS.length + MAIL_TOOLS.length);
  assert.ok(names.some((n) => n.startsWith("browser_")));
  assert.ok(names.some((n) => n.startsWith("mail_")));
});

test("legacy transport: mail tool call round-trip over x-pi-browser/tool", async () => {
  const ff = setupFakeFirefox();
  const idRef = { id: "session-mail" };
  const tools = ff.provider.createTools(idRef, "legacy", undefined, ["mail"]);
  const ctx = tools.find((t) => t.name === "mail_get_context");
  assert.ok(ctx);
  const result = await ctx.execute("tc-mail", {}, undefined);
  assert.equal(ff.toolCalls.length, 1);
  assert.equal(ff.toolCalls[0].sessionId, "session-mail");
  assert.equal(ff.toolCalls[0].tool, "mail_get_context");
  assert.equal(result.content[0].type, "text");
});

test("legacy transport: tool call round-trip over x-pi-browser/tool", async () => {
  const ff = setupFakeFirefox();
  const idRef = { id: "session-123" };
  const tools = ff.provider.createTools(idRef, "legacy");
  const getPage = tools.find((t) => t.name === "browser_get_page");
  assert.ok(getPage);
  const result = await getPage.execute("tc1", {}, undefined);
  assert.equal(ff.toolCalls.length, 1);
  assert.equal(ff.toolCalls[0].sessionId, "session-123");
  assert.equal(ff.toolCalls[0].tool, "browser_get_page");
  assert.equal(result.content[0].type, "text");
  assert.ok((result.content[0] as { text: string }).text.includes("Salvage Rush"));
  assert.ok((result.details as { piBrowser: boolean }).piBrowser);
});

test("legacy transport: structured errors from Firefox map to PiBrowser error codes", async () => {
  const ff = setupFakeFirefox();
  // Override the default responder to return BROWSER_TAB_CLOSED.
  ff.a.transport.onRequest = (method, params, id) => {
    if (method === X_PI_BROWSER.tool) {
      ff.a.transport.respondError(id, toErrorObject(PI_BROWSER_ERROR.BROWSER_TAB_CLOSED, "bound tab is gone", { tabId: 9 }));
      return;
    }
    ff.a.transport.respondError(id, { code: -32601, message: "unknown" });
  };
  const tools = ff.provider.createTools({ id: "s1" }, "legacy");
  const click = tools.find((t) => t.name === "browser_click");
  await assert.rejects(
    click!.execute("tc", { ref: "el-1" }, undefined),
    (err: unknown) =>
      err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.BROWSER_TAB_CLOSED,
  );
});

test("translateTransportError maps transport errors to structured codes", async () => {
  const { translateTransportError } = await import("../src/browser/provider.js");
  const { TransportTimeoutError, TransportClosedError } = await import("../src/native-host/transport.js");

  const timeout = translateTransportError(
    new TransportTimeoutError("x-pi-browser/tool", 40),
    "browser_get_page",
  );
  assert.equal(timeout.code, PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT);

  const closed = translateTransportError(new TransportClosedError(), "browser_get_page");
  assert.equal(closed.code, PI_BROWSER_ERROR.MCP_UNAVAILABLE);

  // Structured JSON-RPC error objects keep their Pi Browser code.
  const structured = translateTransportError(
    { jsonrpc: "2.0", code: -32010, message: "tab gone", data: { piBrowserError: "BROWSER_TAB_CLOSED" } },
    "browser_click",
  );
  assert.equal(structured.code, PI_BROWSER_ERROR.BROWSER_TAB_CLOSED);
});

test("legacy transport: real timeout over a non-responding peer", async () => {
  const { createMemoryTransportPair } = await import("../src/native-host/transport.js");
  const { a, b } = createMemoryTransportPair(quiet, quiet);
  // b has a handler that never responds -> a's request genuinely times out.
  b.transport.onRequest = () => {};
  const transport = new LegacyBrowserCallbackTransport(a.transport, { timeoutMs: () => 30, slackMs: 20 });
  const err = (await transport.call("s1", "browser_get_page", {}).catch((e) => e)) as PiBrowserProtocolError;
  assert.ok(err instanceof PiBrowserProtocolError);
  assert.equal(err.code, PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT);
});

// ---------------------------------------------------------------------------
// MCP-over-ACP transport: fake Firefox MCP server behind mcp/* methods
// ---------------------------------------------------------------------------

function setupMcpFirefox() {
  const { a, b } = createMemoryTransportPair(quiet, quiet);
  const provider = new CapabilityToolProvider(b.transport, quiet);
  const mcpSeen: Array<{ method: string; params?: unknown }> = [];
  let connectionCounter = 0;
  const connections = new Map<string, { initialized: boolean }>();

  a.transport.onRequest = (method, params, id) => {
    if (method === CLIENT_METHODS.mcp_connect) {
      const p = params as { serverId: string };
      if (p.serverId !== "browser-provider-123") {
        a.transport.respondError(id, { code: -32602, message: "unknown serverId" });
        return;
      }
      const connectionId = `conn-${++connectionCounter}`;
      connections.set(connectionId, { initialized: false });
      a.transport.respond(id, { connectionId });
      return;
    }
    if (method === CLIENT_METHODS.mcp_message) {
      const p = params as { connectionId: string; method: string; params?: Record<string, unknown> };
      mcpSeen.push({ method: p.method, params: p.params });
      const conn = connections.get(p.connectionId);
      if (!conn) {
        a.transport.respondError(id, { code: -32001, message: "unknown connection" });
        return;
      }
      switch (p.method) {
        case "initialize":
          a.transport.respond(id, {
            protocolVersion: p.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "pi-browser-firefox", version: "0.1.1" },
          });
          return;
        case "notifications/initialized":
          conn.initialized = true;
          a.transport.respond(id, {});
          return;
        case "tools/list":
          a.transport.respond(id, {
            tools: BROWSER_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          });
          return;
        case "tools/call": {
          const call = p.params as { name: string; arguments: Record<string, unknown> };
          if (!conn.initialized) {
            a.transport.respondError(id, { code: -32600, message: "not initialized" });
            return;
          }
          if (call.name === "browser_screenshot") {
            a.transport.respond(id, {
              content: [{ type: "image", data: "aWNvZQ==", mimeType: "image/png" }],
            });
            return;
          }
          if (call.name === "browser_click") {
            a.transport.respond(id, { content: [{ type: "text", text: "clicked" }] });
            return;
          }
          if (call.name === "browser_fail") {
            a.transport.respond(id, {
              content: [{ type: "text", text: "BROWSER_ELEMENT_STALE: ref el-9 not found" }],
              isError: true,
            });
            return;
          }
          a.transport.respondError(id, toErrorObject(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown tool ${call.name}`));
          return;
        }
        default:
          a.transport.respondError(id, { code: -32601, message: `mcp: unknown ${p.method}` });
      }
      return;
    }
    if (method === CLIENT_METHODS.mcp_disconnect) {
      const p = params as { connectionId: string };
      connections.delete(p.connectionId);
      a.transport.respond(id, {});
      return;
    }
    a.transport.respondError(id, { code: -32601, message: `unknown ${method}` });
  };

  return { a, b, provider, mcpSeen, connections };
}

test("mcp-acp transport: full handshake + tools/call over mcp/message", async () => {
  const ff = setupMcpFirefox();
  const transport = new NativeMcpOverAcpTransport(
    ff.b.transport,
    "browser-provider-123",
    quiet,
    "session-x",
  );

  const tools = await transport.listTools();
  assert.equal(tools.length, BROWSER_TOOLS.length);
  assert.ok(tools.every((t) => t.name.startsWith("browser_")));
  // Handshake order observed by the fake server.
  assert.deepEqual(
    ff.mcpSeen.map((m) => m.method).slice(0, 3),
    ["initialize", "notifications/initialized", "tools/list"],
  );
  assert.equal(transport.connected, true);

  const result = await transport.call("s", "browser_click", { ref: "el-1" });
  assert.equal(result.content[0].type, "text");

  const shot = await transport.call("s", "browser_screenshot", {});
  const image = shot.content[0] as { type: string; data: string; mimeType: string };
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");

  await transport.dispose();
  assert.equal(transport.connected, false);
});

test("mcp-acp transport: isError results surface as normalized isError content", async () => {
  const ff = setupMcpFirefox();
  const transport = new NativeMcpOverAcpTransport(ff.b.transport, "browser-provider-123", quiet, "s");
  const result = await transport.call("s", "browser_fail", {});
  assert.equal(result.isError, true);
  const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
  assert.match(text, /BROWSER_ELEMENT_STALE/);
  await transport.dispose();
});

test("mcp-acp transport: unknown serverId surfaces as MCP_UNAVAILABLE", async () => {
  const ff = setupMcpFirefox();
  const transport = new NativeMcpOverAcpTransport(ff.b.transport, "wrong-id", quiet, "s");
  await assert.rejects(
    transport.call("s", "browser_get_page", {}),
    (err: unknown) => err instanceof PiBrowserProtocolError && err.code === PI_BROWSER_ERROR.MCP_UNAVAILABLE,
  );
});

test("provider: mcp-acp session routes tool execution through the MCP channel", async () => {
  const ff = setupMcpFirefox();
  const idRef = { id: "session-y" };
  const tools = ff.provider.createTools(idRef, "mcp-acp", "browser-provider-123");
  const getPage = tools.find((t) => t.name === "browser_get_page");
  await assert.rejects(
    getPage!.execute("tc", {}, undefined),
    // browser_get_page is not implemented by the fake MCP server.
    /unknown tool|browser tool failed/i,
  );
  const click = tools.find((t) => t.name === "browser_click");
  const result = await click!.execute("tc", { ref: "el-7" }, undefined);
  assert.equal((result.content[0] as { text: string }).text, "clicked");
  assert.ok(ff.mcpSeen.some((m) => m.method === "tools/call"));
  await ff.provider.disposeSession("session-y");
});

test("provider: x-pi-browser/notify is accepted without error", async () => {
  const ff = setupFakeFirefox();
  ff.provider.handleNotify({ sessionId: "s1", event: "tab_closed" });
  ff.provider.handleNotify({ sessionId: "s1", event: "tab_navigated", data: { url: "http://x" } });
  // No throw, no state requirement: nothing to assert beyond survival.
  assert.ok(true);
});
