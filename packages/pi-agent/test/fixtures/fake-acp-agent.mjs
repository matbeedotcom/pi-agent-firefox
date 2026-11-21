#!/usr/bin/env node
/**
 * A small ACP agent over stdio, for tests of the host's external-agent relay
 * (openspec sidebar-acp-agents). It behaves like the Claude Code / Codex
 * adapters in the ways the relay cares about, scripted by the prompt text:
 *
 *   "diff"          streams text, a plan, and an edit tool call with a diff
 *   "perm"          asks session/request_permission, then reports the choice
 *   "slow"          runs until session/cancel (stopReason "cancelled")
 *   "crash"         exits with code 3 mid-turn
 *   "env"           replies with the env of the pi-browser mcpServers entry
 *   "tool <name> <json args>"
 *                   starts the session's pi-browser MCP server (the stdio
 *                   bridge), calls the tool, and replies with its text
 *   anything else   replies "echo: <text>"
 *
 * Environment:
 *   FAKE_ACP_STATE  directory for sessions.json (sessions survive a restart)
 *   FAKE_ACP_LOG    file that gets one JSON line per received message
 *   FAKE_ACP_LOAD=0 don't advertise loadSession
 *   FAKE_ACP_AUTH=1 refuse session/new with "Authentication required"
 *   FAKE_ACP_MODES=1 report models + modes instead of configOptions
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const STATE = process.env.FAKE_ACP_STATE;
const LOG = process.env.FAKE_ACP_LOG;
const LOAD = process.env.FAKE_ACP_LOAD !== "0";
const AUTH = process.env.FAKE_ACP_AUTH === "1";
const MODES = process.env.FAKE_ACP_MODES === "1";

/** sessionId → { cwd, mcpServers, history: [{role, text}], model, mode } */
const sessions = new Map();
const cancelled = new Set();
let nextId = 1;
const waiting = new Map();

function log(entry) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function loadState() {
  if (!STATE) return;
  const file = path.join(STATE, "sessions.json");
  if (!existsSync(file)) return;
  for (const [id, s] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) sessions.set(id, s);
}
function saveState() {
  if (!STATE) return;
  mkdirSync(STATE, { recursive: true });
  writeFileSync(path.join(STATE, "sessions.json"), JSON.stringify(Object.fromEntries(sessions)));
}

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `a${nextId++}`;
    waiting.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });

function settings(s) {
  if (MODES) {
    return {
      models: { currentModelId: s.model, availableModels: [{ modelId: "fast", name: "Fast" }, { modelId: "smart", name: "Smart" }] },
      modes: { currentModeId: s.mode, availableModes: [{ id: "ask", name: "Ask" }, { id: "auto", name: "Auto" }] },
    };
  }
  return {
    configOptions: [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }] },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Auto" }] },
    ],
  };
}

/** Call one tool on the session's pi-browser MCP server (the host's stdio bridge). */
function callMcpTool(server, name, args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const e of server.env ?? []) env[e.name] = e.value;
    const child = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const rl = createInterface({ input: child.stdout });
    const done = (text) => {
      child.stdin.end();
      setTimeout(() => child.kill(), 500).unref();
      resolve(text);
    };
    rl.on("line", (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id === 1) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`);
      } else if (m.id === 2) {
        const text = (m.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        done(`${m.result?.isError ? "tool error: " : "tool result: "}${text || JSON.stringify(m.error ?? m.result)}`);
      }
    });
    child.on("error", (err) => resolve(`tool error: ${err.message}`));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "1" } } })}\n`);
  });
}

async function prompt(params) {
  const s = sessions.get(params.sessionId);
  if (!s) throw { code: -32602, message: `unknown session ${params.sessionId}` };
  const text = (params.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  s.history.push({ role: "user", text });
  cancelled.delete(params.sessionId);
  const id = params.sessionId;
  let reply;
  if (text.startsWith("crash")) {
    say(id, "crashing");
    process.exit(3);
  } else if (text.startsWith("slow")) {
    say(id, "working");
    const t0 = Date.now();
    while (!cancelled.has(id) && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 20));
    if (cancelled.has(id)) return { stopReason: "cancelled" };
    reply = "slow done";
  } else if (text.startsWith("diff")) {
    say(id, "Editing the file.");
    update(id, { sessionUpdate: "plan", entries: [{ content: "Edit file.txt", priority: "high", status: "in_progress" }] });
    update(id, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit file.txt",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: path.join(s.cwd, "file.txt") }],
      content: [{ type: "diff", path: path.join(s.cwd, "file.txt"), oldText: "old line\n", newText: "new line\n" }],
    });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" });
    update(id, { sessionUpdate: "plan", entries: [{ content: "Edit file.txt", priority: "high", status: "completed" }] });
    reply = " Done.";
  } else if (text.startsWith("perm")) {
    const res = await request("session/request_permission", {
      sessionId: id,
      toolCall: {
        toolCallId: `perm-${Date.now()}`,
        title: "Run npm test",
        kind: "execute",
        status: "pending",
        rawInput: { command: "npm test" },
        content: [{ type: "content", content: { type: "text", text: "npm test" } }],
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const o = res?.outcome;
    reply = `permission: ${o?.outcome === "selected" ? o.optionId : o?.outcome ?? "?"}`;
  } else if (text.startsWith("env")) {
    const server = (s.mcpServers ?? []).find((m) => m.name === "pi-browser");
    reply = `env: ${JSON.stringify(Object.fromEntries((server?.env ?? []).map((e) => [e.name, e.value])))}`;
  } else if (text.startsWith("tool ")) {
    const [, name, ...rest] = text.split(" ");
    const server = (s.mcpServers ?? []).find((m) => m.name === "pi-browser");
    reply = server ? await callMcpTool(server, name, rest.length ? JSON.parse(rest.join(" ")) : {}) : "no pi-browser server";
  } else {
    reply = `echo: ${text}`;
  }
  say(id, reply);
  s.history.push({ role: "agent", text: reply });
  saveState();
  return { stopReason: "end_turn" };
}

async function handle(m) {
  switch (m.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: LOAD, promptCapabilities: { image: true }, sessionCapabilities: { close: {} } },
        agentInfo: { name: "fake-acp", version: "1.0.0" },
        authMethods: AUTH ? [{ id: "login", name: "Log in" }] : [],
      };
    case "session/new": {
      if (AUTH) throw { code: -32000, message: "Authentication required" };
      const id = randomUUID();
      const s = { cwd: m.params.cwd, mcpServers: m.params.mcpServers ?? [], history: [], model: "fast", mode: "ask" };
      sessions.set(id, s);
      saveState();
      setTimeout(() => update(id, { sessionUpdate: "available_commands_update", availableCommands: [] }), 5);
      return { sessionId: id, ...settings(s) };
    }
    case "session/load": {
      if (!LOAD) throw { code: -32601, message: "session/load not supported" };
      loadState();
      const s = sessions.get(m.params.sessionId);
      if (!s) throw { code: -32602, message: `unknown session ${m.params.sessionId}` };
      s.mcpServers = m.params.mcpServers ?? [];
      for (const h of s.history) {
        update(m.params.sessionId, {
          sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: h.text },
        });
      }
      return settings(s);
    }
    case "session/prompt":
      return prompt(m.params);
    case "session/set_config_option": {
      const s = sessions.get(m.params.sessionId);
      if (m.params.configId === "model") s.model = m.params.value;
      if (m.params.configId === "mode") s.mode = m.params.value;
      saveState();
      return settings(s);
    }
    case "session/set_model":
      sessions.get(m.params.sessionId).model = m.params.modelId;
      return {};
    case "session/set_mode":
      sessions.get(m.params.sessionId).mode = m.params.modeId;
      return {};
    case "session/close":
      return {};
    default:
      throw { code: -32601, message: `method not found: ${m.method}` };
  }
}

loadState();
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  log({
    method: m.method ?? null,
    id: m.id ?? null,
    sessionId: m.params?.sessionId ?? null,
    ...(m.result?.outcome ? { outcome: m.result.outcome } : {}),
  });
  if (m.method === undefined) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (w) m.error ? w.reject(m.error) : w.resolve(m.result);
    return;
  }
  if (m.method === "session/cancel") {
    cancelled.add(m.params?.sessionId);
    return;
  }
  if (m.id === undefined) return;
  Promise.resolve()
    .then(() => handle(m))
    .then(
      (result) => send({ jsonrpc: "2.0", id: m.id, result }),
      (err) => send({ jsonrpc: "2.0", id: m.id, error: { code: err?.code ?? -32603, message: err?.message ?? String(err) } }),
    );
}).on("close", () => process.exit(0));
