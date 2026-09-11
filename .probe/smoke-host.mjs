/**
 * Live smoke: spawn the built native host, frame real messages over stdio,
 * exercise ping + ACP initialize + a negative protocol-version check.
 * Phase 1 acceptance: "Firefox sends JSON -> Node host -> Firefox receives response".
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const host = path.resolve(here, "../packages/pi-agent/dist/native-host/main.js");

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

const child = spawn(process.execPath, [host], {
  env: { ...process.env, PI_BROWSER_LOG_LEVEL: "debug" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = Buffer.alloc(0);
const responses = new Map();
const notifications = [];

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) break;
    const text = buffer.subarray(4, 4 + len).toString("utf8");
    buffer = buffer.subarray(4 + len);
    const msg = JSON.parse(text);
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      responses.get(msg.id)?.(msg);
      responses.delete(msg.id);
    } else if (msg.method) {
      notifications.push(msg);
    }
  }
});

let nextId = 0;
function request(method, params, timeoutMs = 20000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    responses.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
try {
  await sleep(1500); // let the host boot (model runtime init)

  const ping = await request("x-pi-browser/ping", {});
  console.log("PING:", JSON.stringify(ping.result));
  if (ping.result?.pong !== true) throw new Error("pong missing");
  if (ping.result.meta?.protocolVersion !== 1) throw new Error("protocolVersion mismatch");

  const init = await request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  console.log("INIT capabilities:", JSON.stringify(init.result?.agentCapabilities));
  console.log("INIT _meta:", JSON.stringify(init.result?._meta));
  if (init.result?.agentCapabilities?.mcpCapabilities?.acp !== true) throw new Error("mcpCapabilities.acp missing");
  if (init.result?._meta?.piBrowser?.version !== "0.1.0") throw new Error("piBrowser meta missing");

  // Wrong protocol version must be rejected with a structured code.
  const bad = await request("initialize", { protocolVersion: 42 }).catch((e) => e);
  console.log("BAD-PROTO error:", JSON.stringify(bad?.error));
  if (bad?.error?.data?.piBrowserError !== "PROTOCOL_VERSION_MISMATCH") throw new Error("expected PROTOCOL_VERSION_MISMATCH");

  // session/new with the REAL Pi SDK backend (no LLM prompt; just session creation).
  const tmpCwd = "/tmp/pi-browser-smoke-cwd";
  await import("node:fs").then((fs) => fs.mkdirSync(tmpCwd, { recursive: true }));
  const news = await request("session/new", { cwd: tmpCwd, mcpServers: [] }, 30000);
  if (news.error) throw new Error("session/new failed: " + JSON.stringify(news.error));
  console.log("SESSION/NEW:", news.result?.sessionId, "configOptions:", news.result?.configOptions?.length);
  const sessionId = news.result.sessionId;
  if (!sessionId) throw new Error("no sessionId");
  if (!Array.isArray(news.result.configOptions) || news.result.configOptions.length < 2) {
    throw new Error("configOptions missing (model+thinking expected)");
  }

  // session/list: Pi writes session files lazily (first persisted entry), so a
  // brand-new empty session may not be listed yet. Verify the list path against
  // real pre-existing sessions instead.
  const list = await request("session/list", { cwd: null }, 30000);
  console.log("SESSION/LIST count:", list.result?.sessions?.length);
  if (!Array.isArray(list.result?.sessions) || list.result.sessions.length === 0) {
    throw new Error("session/list returned no sessions (expected pre-existing ones)");
  }
  // Prefer a session from this repo's cwd (known-safe project) for the resume test.
  const repoCwd = path.resolve(here, "..");
  const sample = list.result.sessions.find((s) => s.cwd === repoCwd) ?? list.result.sessions[0];
  console.log("SESSION/LIST sample:", sample.sessionId, sample.cwd);

  // session/resume against that real session (no history replay, no LLM call).
  const resume = await request(
    "session/resume",
    { sessionId: sample.sessionId, cwd: sample.cwd, mcpServers: [] },
    30000,
  );
  if (resume.error) throw new Error("session/resume failed: " + JSON.stringify(resume.error));
  if (!Array.isArray(resume.result?.configOptions)) throw new Error("resume missing configOptions");
  console.log("SESSION/RESUME ok (configOptions:", resume.result.configOptions.length, ")");

  // session/close the new empty session
  const close = await request("session/close", { sessionId });
  if (close.error) throw new Error("session/close failed: " + JSON.stringify(close.error));
  console.log("SESSION/CLOSE ok");

  console.log("SMOKE OK");
  child.kill("SIGTERM");
  process.exit(0);
} catch (err) {
  failed = true;
  console.error("SMOKE FAILED:", err);
  child.kill("SIGTERM");
  process.exit(1);
}
process.on("exit", () => {
  if (failed) child.kill("SIGKILL");
});
