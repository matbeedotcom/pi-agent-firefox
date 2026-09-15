/**
 * ENGINE QUERY MATRIX — automated browser.messages.query() variant benchmark.
 *
 * Context: main-search-bar "pi browser" returns in <1 s (term-decomposed,
 * indexed) while WDAPI `fullText: "pi browser"` (literal substring, all
 * folders) takes 44-99 s. This probe times the WDAPI knobs that could make
 * raw queries respond fast, per the WDAPI messages.query docs:
 *
 *   - returnMessageListId: true  → list handle immediately, poll continueList
 *   - autoPaginationTimeout      → return before the page fills (default 1000)
 *   - body vs fullText           → body-only scan cost
 *   - folderId scoping           → shrink the scan window
 *   - single common term         → index-path control
 *
 * Harness: identical to .probe/live-mail-search.mjs (mock broker + real host
 * + real add-on + real engine), one prompt firing the whole matrix as
 * sequential mock tool calls (mail_debug_query, the piDebug-gated raw query
 * runner in the dispatcher).
 *
 * Run: node .probe/engine-query-matrix.mjs
 * Env: PI_MATRIX_TEXT (default "pi browser"), PI_MATRIX_TERM (default "browser")
 *
 * The add-on dist must contain the piDebug build (thunderbird/dist).
 */
import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const TEXT = process.env.PI_MATRIX_TEXT ?? "pi browser";
const TERM = process.env.PI_MATRIX_TERM ?? "browser";
const TIMEOUT_MS = Number(process.env.PI_MATRIX_TIMEOUT_MS ?? 1_500_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeRead = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const safeReaddir = (d) => { try { return readdirSync(d); } catch { return []; } };

// ---------------------------------------------------------------------------
// Inbox folder id from the profile (local IMAP proxy: ImapMail/<host>/INBOX)
// ---------------------------------------------------------------------------

function resolveInboxId() {
  const profiles = safeReaddir(path.join(homedir(), ".thunderbird"))
    .filter((d) => d.endsWith(".default-release") || d === ".default");
  for (const p of profiles) {
    const pdir = path.join(homedir(), ".thunderbird", p);
    const prefs = safeRead(path.join(pdir, "prefs.js"));
    const user = /useremail",\s*"([^"]+)"/.exec(prefs)?.[1];
    if (!user) continue;
    for (const server of safeReaddir(path.join(pdir, "ImapMail"))) {
      if (server.endsWith(".msf")) continue;
      const folders = safeReaddir(path.join(pdir, "ImapMail", server));
      const inbox = folders.find((f) => /^(inbox|in\.box)$/i.test(f) && f !== `${f}.msf`);
      const inboxName = inbox ?? folders.find((f) => /^INBOX$/i.test(f));
      if (inboxName) return { profile: p, server, inboxId: `imap://${user}@${server}/${inboxName}`, inboxName };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const hostPids = () => {
  try {
    const out = execSync("ps -eo pid,args", { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes("native-host/main.js") && !l.includes("ps -eo")).map((l) => l.trim().split(/\s+/)[0]);
  } catch { return []; }
};
const hostPidsWithEnv = (marker) => {
  try {
    const out = execSync("ps -eww -o pid,args", { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes(marker)).map((l) => l.trim().split(/\s+/)[0]);
  } catch { return []; }
};
const tbRunning = () => {
  try {
    // The main process cmdline is exactly ".../thunderbird/thunderbird";
    // content processes carry -contentproc and must not count.
    return execSync("pgrep -f 'thunderbird/thunderbird$' >/dev/null && echo yes", { encoding: "utf8" }).trim() === "yes";
  } catch { return false; }
};
let preOk = false;
let userHostPids = [];
for (let attempt = 1; attempt <= 10 && !preOk; attempt++) {
  preOk =
    tbRunning() &&
    hostPids().length > 0 &&
    existsSync(path.join(homedir(), ".pi", "run", "agent-broker.sock"));
  if (!preOk) {
    if (attempt === 1) console.log("preflight: host/broker settling (previous run's restore?), waiting…");
    await sleep(3_000);
  }
}
if (!tbRunning()) throw new Error("Thunderbird is not running — start it (with the add-on) first");
userHostPids = hostPids();
if (userHostPids.length === 0) throw new Error("no native host running — the Thunderbird add-on has no host");
if (!existsSync(path.join(homedir(), ".pi", "run", "agent-broker.sock"))) {
  throw new Error("broker socket missing — host/broker out of sync");
}
console.log(`preflight: TB running, host pid(s) ${userHostPids.join(", ")}, broker socket present`);

const inbox = resolveInboxId();
console.log(`inbox id: ${inbox?.inboxId ?? "NOT FOUND (scoped entry will be skipped)"}`);

// ---------------------------------------------------------------------------
// Work + evidence layout
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const work = path.join(tmpdir(), `pi-mail-matrix-${Date.now()}`);
mkdirSync(work, { recursive: true });
const root = path.join(REPO, "VERIFICATION-evidence", `engine-matrix-${stamp}`);
mkdirSync(root, { recursive: true });
const evidence = (name) => path.join(root, name);
const hostLog = path.join(work, "host.log");
const mockScript = path.join(work, "mock-script.json");
const launcher = path.join(work, "host-launcher.sh");
mkdirSync(path.join(work, "agent"), { recursive: true });
mkdirSync(path.join(work, "broker"), { recursive: true });
mkdirSync(path.join(work, "repl"), { recursive: true });
mkdirSync(path.join(work, "proj"), { recursive: true });

// Matrix order: cheap/decisive first, full scans last.
const matrixCalls = [
  { name: "folders", toolName: "mail_list_folders", args: {} },
  { name: "term", toolName: "mail_debug_query", args: { query: { fullText: TERM } } },
];
if (inbox) matrixCalls.push({ name: "scoped", toolName: "mail_debug_query", args: { query: { fullText: TEXT, folderId: inbox.inboxId } } });
matrixCalls.push(
  { name: "autopag-5s", toolName: "mail_debug_query", args: { query: { fullText: TEXT, autoPaginationTimeout: 5000 } } },
  { name: "body-only", toolName: "mail_debug_query", args: { query: { body: TEXT } } },
  { name: "listid-poll", toolName: "mail_debug_query", args: { query: { fullText: TEXT, returnMessageListId: true }, poll: { intervalMs: 2000, maxMs: 110000 } } },
  { name: "autopag-0", toolName: "mail_debug_query", args: { query: { fullText: TEXT, autoPaginationTimeout: 0 } } },
  { name: "baseline", toolName: "mail_debug_query", args: { query: { fullText: TEXT } } },
);
writeFileSync(
  mockScript,
  JSON.stringify([
    { match: "engine-matrix", toolCalls: matrixCalls.map((c) => ({ toolName: c.toolName, args: c.args })) },
  ]),
);
writeFileSync(
  launcher,
  [
    "#!/bin/sh",
    "export PI_BROWSER_BACKEND=mock",
    `export PI_BROWSER_MOCK_SCRIPT=${mockScript}`,
    `export PI_BROWSER_LOG_FILE=${hostLog}`,
    "export PI_BROWSER_LOG_LEVEL=info",
    "export PI_BROWSER_AUTO_APPROVE=mail_search,mail_list_folders,mail_debug_query",
    `export PI_BROWSER_AGENT_DIR=${path.join(work, "agent")}`,
    `export PI_CODING_AGENT_DIR=${path.join(work, "agent")}`,
    `export PI_BROWSER_BROKER_DIR=${path.join(work, "broker")}`,
    `export PI_BROWSER_REPL_DIR=${path.join(work, "repl")}`,
    "exec " + JSON.stringify(NODE) + " " + JSON.stringify(path.join(REPO, "packages/pi-agent/dist/native-host/main.js")) + " \"$@\"",
    "",
  ].join("\n"),
);
chmodSync(launcher, 0o755);
console.log(`work: ${work}\nevidence: ${root}\nprobe host log: ${hostLog}\nmatrix: ${matrixCalls.map((c) => c.name).join(", ")}`);

// ---------------------------------------------------------------------------
// Manifest swap (always restored)
// ---------------------------------------------------------------------------

const nmDir = path.join(homedir(), ".mozilla", "native-messaging-hosts");
const nmManifest = path.join(nmDir, "com.matbee.agent.json");
const prevManifest = existsSync(nmManifest) ? readFileSync(nmManifest, "utf8") : null;
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of relayChildren) {
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  }
  for (const pid of hostPidsWithEnv(`PI_BROWSER_LOG_FILE=${hostLog}`)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
  try {
    if (prevManifest !== null) writeFileSync(nmManifest, prevManifest);
    else rmSync(nmManifest, { force: true });
  } catch (err) {
    console.error(`MANIFEST RESTORE FAILED: ${err}`);
  }
}
process.once("exit", cleanup);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

const results = [];
let exitCode = 0;
function check(name, ok, detail = "") {
  if (!ok) exitCode = 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// ACP-over-native-messaging client (framed JSON on a main.js relay child)
// ---------------------------------------------------------------------------

const relayChildren = [];
class AcpClient {
  constructor() {
    this.child = spawn(NODE, [path.join(REPO, "packages/pi-agent/dist/native-host/main.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_BROWSER_LOG_FILE: path.join(work, `relay-${relayChildren.length + 1}.log`),
        PI_BROWSER_BROKER_DIR: path.join(work, "broker"),
      },
    });
    relayChildren.push(this.child);
    this.child.stderr.on("data", () => {});
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.sessionId = undefined;
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.on("exit", (code) => {
      for (const [id, p] of this.pending) p.reject(new Error(`relay host exited (${code}) while awaiting ${id}`));
      this.pending.clear();
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32LE(0);
      if (len > 100 * 1024 * 1024) throw new Error("frame too large");
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const msg = JSON.parse(payload.toString("utf8"));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        this.notifications.push({ at: Date.now(), msg });
      }
    }
  }
  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(frame.length, 0);
    this.child.stdin.write(Buffer.concat([header, frame]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }
  close() {
    try { this.child.stdin.end(); } catch { /* */ }
    try { this.child.kill("SIGTERM"); } catch { /* */ }
  }
}

// ---------------------------------------------------------------------------
// Matrix run: one prompt → N sequential tool calls, grouped into segments
// ---------------------------------------------------------------------------

function parseToolResult(u) {
  try {
    return JSON.parse(u.rawOutput?.content?.[0]?.text ?? u.content?.[0]?.content?.text ?? "{}");
  } catch {
    return {};
  }
}

async function runMatrix(client) {
  const t0 = Date.now();
  const rel = (at) => at - t0;
  const notifsBefore = client.notifications.length;

  const prompt = client.request("session/prompt", {
    sessionId: client.sessionId,
    prompt: [{ type: "text", text: "engine-matrix" }],
  }, TIMEOUT_MS);

  const promptDone = await Promise.race([
    prompt.then((res) => ({ ok: true, res }), (err) => ({ ok: false, err })),
    sleep(TIMEOUT_MS).then(() => ({ ok: false, err: new Error(`probe budget ${TIMEOUT_MS}ms expired`) })),
  ]);

  const segments = [];
  let cur = undefined;
  for (const n of client.notifications.slice(notifsBefore)) {
    const u = n.msg.params?.update ?? {};
    const at = rel(n.at);
    if (u.sessionUpdate === "tool_call") {
      cur = { startAt: at, title: u.title, updates: 0, final: undefined };
      segments.push(cur);
    } else if (u.sessionUpdate === "tool_call_update" && cur) {
      cur.updates++;
      if (u.status === "completed" || u.status === "failed") {
        cur.final = { at, status: u.status, out: parseToolResult(u) };
        cur = undefined;
      }
    }
  }
  return {
    ok: promptDone.ok,
    stopReason: promptDone.res?.stopReason,
    promptError: promptDone.err ? String(promptDone.err?.message ?? promptDone.err) : undefined,
    totalMs: rel(Date.now()),
    segments,
  };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

let matrixReport = null;
let client = null;
try {
  writeFileSync(
    nmManifest,
    JSON.stringify({
      name: "com.matbee.agent",
      description: "Pi Browser host (engine query matrix)",
      path: launcher,
      type: "stdio",
      allowed_extensions: ["pi-agent-thunderbird@matbee.com"],
    }),
  );
  for (const pid of userHostPids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
  console.log(`killed host pid(s) ${userHostPids.join(", ")}; waiting for TB to relaunch the probe broker…`);

  const readyDeadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < readyDeadline && !ready) {
    const log = safeRead(hostLog);
    if (log.includes("host ready") && /registry:.*connected: [1-9]/.test(log)) ready = true;
    else await sleep(500);
  }
  check("probe broker up and TB re-registered", ready, safeRead(hostLog).split("\n").slice(-6).join(" | "));
  if (!ready) throw new Error("probe broker did not come up with Thunderbird connected");

  client = new AcpClient();
  const init = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "engine-query-matrix", version: "1.0.0" },
  });
  check("ACP initialize", Boolean(init?.agentInfo), JSON.stringify(init?.agentInfo ?? {}));
  const sess = await client.request("session/new", { cwd: path.join(work, "proj"), mcpServers: [] });
  client.sessionId = sess.sessionId;
  check("session/new", Boolean(client.sessionId), client.sessionId);

  console.log(`matrix: ${matrixCalls.length} calls, budget ${Math.round(TIMEOUT_MS / 1000)} s`);
  matrixReport = await runMatrix(client);
} catch (err) {
  exitCode = 1;
  check("probe flow completed", false, String(err?.message ?? err));
} finally {
  cleanup();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (matrixReport) {
  console.log(`\n--- matrix (total ${Math.round(matrixReport.totalMs / 1000)} s) ---`);
  for (let i = 0; i < matrixReport.segments.length; i++) {
    const s = matrixReport.segments[i];
    const name = matrixCalls[i]?.name ?? `#${i}`;
    const d = s.final?.out?.debugQuery;
    let detail;
    if (name === "folders") {
      const folders = Array.isArray(s.final?.out?.folders) ? s.final.out.folders : [];
      detail = `${folders.length} folders; inbox=${folders.find((f) => /inbox/i.test(f.name))?.id ?? "?"}`;
    } else if (d?.kind === "listId") {
      const firstPage = d.polls?.find((p) => p.msgs > 0);
      detail = `listId in ${d.initialMs}ms; ${d.polls?.length ?? 0} polls, ${d.total ?? 0} msgs, exhausted=${d.exhausted}; first match at ${firstPage ? `+${firstPage.atMs}ms` : "n/a"}${d.subjects?.length ? `; ${d.subjects.join(" | ")}` : ""}`;
    } else if (d?.kind === "page") {
      detail = `first page ${d.initialMs}ms; ${d.pageCount} msgs; listId=${d.listId ?? "done"}`;
    } else if (s.final?.status === "failed") {
      detail = `FAILED: ${JSON.stringify(s.final?.out)?.slice(0, 160)}`;
    } else {
      detail = "no debugQuery in result";
    }
    const wall = s.final ? s.final.at - s.startAt : null;
    console.log(`  ${name.padEnd(12)} wall=${wall !== null ? String(wall).padStart(6) + "ms" : "       -"}  ${detail}`);
  }
  if (matrixReport.promptError) console.log(`  prompt error: ${matrixReport.promptError}`);

  check("prompt completed cleanly", matrixReport.ok && matrixReport.stopReason === "end_turn", `stopReason=${matrixReport.stopReason ?? matrixReport.promptError}`);
  check("all matrix calls completed", matrixReport.segments.length === matrixCalls.length, `${matrixReport.segments.length}/${matrixCalls.length}`);
  check("every debug_query result carries timing",
    matrixReport.segments.every((s, i) => i === 0 || s.final?.out?.debugQuery?.initialMs !== undefined || matrixCalls[i]?.toolName !== "mail_debug_query"),
    matrixReport.segments.map((s, i) => `${matrixCalls[i]?.name}:${s.final?.out?.debugQuery?.initialMs ?? "n/a"}ms`).join(" "));
}

const hostLogText = safeRead(hostLog);
const roundTrips = hostLogText.split("\n").filter((l) => l.includes("tool round-trip")).map((l) => l.trim());
if (roundTrips.length) console.log(`\nhost log round-trips:\n  ${roundTrips.join("\n  ")}`);

writeFileSync(evidence("results.json"), JSON.stringify({
  text: TEXT,
  term: TERM,
  inbox,
  matrix: matrixCalls.map((c) => ({ name: c.name, args: c.args })),
  segments: matrixReport?.segments,
  totalMs: matrixReport?.totalMs,
  promptError: matrixReport?.promptError,
  roundTrips,
}, null, 2));

console.log(`\nevidence: ${root}`);
console.log(`restore: real host relaunched, Thunderbird back on it`);
console.log(`\n--- engine query matrix: ${results.filter((r) => r.ok).length}/${results.length} checks passed ---`);
process.exit(exitCode);
