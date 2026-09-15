/**
 * LIVE verification + timing for incremental mail_search (m00001 plan):
 *
 *   ACP prompt (probe, mock backend)
 *     → broker routes mail_search to the LIVE Thunderbird client
 *       → real WDAPI scan of the real mailbox
 *         → x-pi-browser/tool_update batches → session/update → probe
 *
 * What it measures (the "where is the latency" question):
 *   - prompt → tool_call → FIRST batch (time-to-first-result)
 *   - every batch/progress update (deltas + cumulative)
 *   - final result (complete/sortComplete/scanned) + total
 *   - host-side `mail_search: tool round-trip Nms` and per-update ages
 *   - TB-side engine page timings (elapsedMs/pageMs on progress updates)
 *
 * How it works (reuses live-repl.mjs patterns; no Xvfb/xdotool needed):
 *   1. Swap ~/.mozilla/native-messaging-hosts/com.matbee.agent.json to a
 *      probe launcher (mock backend + PI_BROWSER_AUTO_APPROVE seam +
 *      probe-owned log file). Always restored, even on crash.
 *   2. SIGTERM the current host. The LIVE Thunderbird add-on auto-reconnects
 *      (~3 s) and re-launches the host — now the probe broker. TB itself is
 *      never touched (its temp add-on load does not survive a restart).
 *   3. The probe attaches to the broker as a relay client (main.js child
 *      with stdio pipes) and speaks ACP directly: initialize, session/new,
 *      session/prompt "mail-search-probe" → the mock backend fires the
 *      scripted mail_search.
 *   4. Cleanup: kill the probe broker, restore the manifest; Thunderbird
 *      reconnects to the real host on its next relaunch (verified).
 *
 * Run: node .probe/live-mail-search.mjs
 * Env:
 *   PI_MAIL_PROBE_TEXT        search text            (default "addon")
 *   PI_MAIL_PROBE_LIMIT       page size              (default 25)
 *   PI_MAIL_PROBE_PAGE_SIZE   engine messagesPerPage (default: engine's 25)
 *   PI_MAIL_PROBE_RUNS        consecutive runs       (default 1)
 *   PI_MAIL_PROBE_TIMEOUT_MS  per-run model/tool budget (default 600000)
 */
import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const TEXT = process.env.PI_MAIL_PROBE_TEXT ?? "addon";
const LIMIT = Number(process.env.PI_MAIL_PROBE_LIMIT ?? 25);
const PAGE_SIZE = process.env.PI_MAIL_PROBE_PAGE_SIZE ? Number(process.env.PI_MAIL_PROBE_PAGE_SIZE) : undefined;
const RUNS = Number(process.env.PI_MAIL_PROBE_RUNS ?? 1);
const TIMEOUT_MS = Number(process.env.PI_MAIL_PROBE_TIMEOUT_MS ?? 600_000);
if (!Number.isInteger(LIMIT) || LIMIT <= 0 || LIMIT > 100) throw new Error("PI_MAIL_PROBE_LIMIT must be 1..100");
if (!Number.isInteger(RUNS) || RUNS <= 0 || RUNS > 5) throw new Error("PI_MAIL_PROBE_RUNS must be 1..5");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeRead = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const safeReaddir = (d) => { try { return readdirSync(d); } catch { return []; } };

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const tbRunning = () => {
  try {
    // The main process cmdline is exactly ".../thunderbird/thunderbird";
    // content processes carry -contentproc and must not count.
    return execSync("pgrep -f 'thunderbird/thunderbird$' >/dev/null && echo yes", { encoding: "utf8" }).trim() === "yes";
  } catch { return false; }
};
const hostPids = () => {
  try {
    const out = execSync(
      `pgrep -f "packages/pi-agent/dist/native-host/main.js" || true`,
      { encoding: "utf8" },
    );
    return out.trim().split("\n").filter(Boolean).map(Number);
  } catch { return []; }
};
const hostPidsWithEnv = (envNeedle) => {
  const pids = hostPids();
  const hit = [];
  for (const pid of pids) {
    const env = safeRead(`/proc/${pid}/environ`).split("\0");
    if (env.includes(envNeedle)) hit.push(pid);
  }
  return hit;
};

// Retry: a prior probe's restore can be mid-flight when we start (old host
// SIGTERM'd, TB's 3 s relaunch not done) — the socket is briefly absent.
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

// ---------------------------------------------------------------------------
// Work + evidence layout
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const work = path.join(tmpdir(), `pi-mail-probe-${Date.now()}`);
mkdirSync(work, { recursive: true });
const root = path.join(REPO, "VERIFICATION-evidence", `mail-search-${stamp}`);
mkdirSync(root, { recursive: true });
const evidence = (name) => path.join(root, name);
const hostLog = path.join(work, "host.log");
const mockScript = path.join(work, "mock-script.json");
const launcher = path.join(work, "host-launcher.sh");
mkdirSync(path.join(work, "agent"), { recursive: true });
mkdirSync(path.join(work, "broker"), { recursive: true });
mkdirSync(path.join(work, "repl"), { recursive: true });
mkdirSync(path.join(work, "proj"), { recursive: true });

writeFileSync(
  mockScript,
  JSON.stringify([
    {
      match: "mail-search-probe",
      toolCalls: [
        { toolName: "mail_search", args: { text: TEXT, limit: LIMIT, scope: "all", sort: "date", order: "desc", ...(PAGE_SIZE ? { messagesPerPage: PAGE_SIZE } : {}) } },
      ],
    },
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
    "export PI_BROWSER_AUTO_APPROVE=mail_search",
    `export PI_BROWSER_AGENT_DIR=${path.join(work, "agent")}`,
    `export PI_CODING_AGENT_DIR=${path.join(work, "agent")}`,
    `export PI_BROWSER_BROKER_DIR=${path.join(work, "broker")}`,
    `export PI_BROWSER_REPL_DIR=${path.join(work, "repl")}`,
    "exec " + JSON.stringify(NODE) + " " + JSON.stringify(path.join(REPO, "packages/pi-agent/dist/native-host/main.js")) + " \"$@\"",
    "",
  ].join("\n"),
);
chmodSync(launcher, 0o755);
console.log(`work: ${work}\nevidence: ${root}\nprobe host log: ${hostLog}`);

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
  // 1. Relay child (our ACP client).
  for (const child of relayChildren) {
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  }
  // 2. Probe broker (env marker; never the user's host).
  for (const pid of hostPidsWithEnv(`PI_BROWSER_LOG_FILE=${hostLog}`)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
  // 3. Manifest restore.
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
      // Same broker dir as the probe launcher → attach to the PROBE broker,
      // never the stale production socket in ~/.pi/run.
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

async function runProbe(client, runIndex) {
  const timeline = [];
  const t0 = Date.now();
  const rel = (at) => at - t0;

  // Notifications from before this prompt (previous runs) are ignored.
  const notifsBefore = client.notifications.length;

  const prompt = client.request("session/prompt", {
    sessionId: client.sessionId,
    prompt: [{ type: "text", text: "mail-search-probe" }],
  }, TIMEOUT_MS);

  // Wait for the prompt to settle or the budget to expire.
  const promptDone = await Promise.race([
    prompt.then(
      (res) => ({ ok: true, res }),
      (err) => ({ ok: false, err }),
    ),
    sleep(TIMEOUT_MS).then(() => ({ ok: false, err: new Error(`probe budget ${TIMEOUT_MS}ms expired`) })),
  ]);

  // Ingest notifications.
  let firstUpdateMs = undefined;
  let batchCount = 0;
  let progressCount = 0;
  let finalUpdate = undefined;
  let toolCallAt = undefined;
  for (const n of client.notifications.slice(notifsBefore)) {
    const p = n.msg.params ?? {};
    const u = p.update ?? {};
    const at = rel(n.at);
    if (u.sessionUpdate === "tool_call" && u.status === "in_progress") {
      toolCallAt = at;
      timeline.push({ t: at, type: "tool_call", title: u.title });
    } else if (u.sessionUpdate === "tool_call_update") {
      if (u.status === "completed" || u.status === "failed") {
        finalUpdate = { at, status: u.status, rawOutput: u.rawOutput, raw: u };
        timeline.push({ t: at, type: "final", status: u.status, rawOutputKeys: u.rawOutput ? Object.keys(u.rawOutput) : undefined });
      } else {
        const text = u.content?.[0]?.content?.text ?? "";
        if (text.startsWith("mail_search: scanned")) {
          progressCount++;
          timeline.push({ t: at, type: "progress", text });
        } else {
          batchCount++;
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = undefined; }
          timeline.push({
            t: at,
            type: "batch",
            messages: parsed?.messages?.length ?? 0,
            complete: parsed?.complete,
            scanned: parsed?.scanned,
            nextCursor: parsed?.nextCursor ? "yes" : "no",
          });
        }
      }
      if (firstUpdateMs === undefined) firstUpdateMs = at;
    }
  }
  const totalMs = rel(Date.now());
  return {
    runIndex,
    ok: promptDone.ok,
    stopReason: promptDone.res?.stopReason,
    promptError: promptDone.err ? String(promptDone.err?.message ?? promptDone.err) : undefined,
    totalMs,
    toolCallAt,
    firstUpdateMs,
    batchCount,
    progressCount,
    finalUpdate,
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

const runReports = [];
let client = null;
try {
  // 1. Swap manifest BEFORE killing the host (TB's reconnect must see it).
  writeFileSync(
    nmManifest,
    JSON.stringify({
      name: "com.matbee.agent",
      description: "Pi Browser host (mail-search probe)",
      path: launcher,
      type: "stdio",
      allowed_extensions: ["pi-agent-thunderbird@matbee.com"],
    }),
  );

  // 2. Kill the user's host(s); TB auto-reconnects → probe broker.
  for (const pid of userHostPids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
  console.log(`killed host pid(s) ${userHostPids.join(", ")}; waiting for TB to relaunch the probe broker…`);

  // 3. Wait for the probe broker (host ready + TB registered).
  const readyDeadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < readyDeadline && !ready) {
    const log = safeRead(hostLog);
    if (log.includes("host ready") && /registry:.*connected: [1-9]/.test(log)) ready = true;
    else await sleep(500);
  }
  check("probe broker up and TB re-registered", ready, safeRead(hostLog).split("\n").slice(-6).join(" | "));
  if (!ready) throw new Error("probe broker did not come up with Thunderbird connected");

  // 4. Attach as an ACP relay client and drive the session.
  client = new AcpClient();
  const init = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "live-mail-search-probe", version: "1.0.0" },
  });
  check("ACP initialize", Boolean(init?.agentInfo), JSON.stringify(init?.agentInfo ?? {}));
  const sess = await client.request("session/new", { cwd: path.join(work, "proj"), mcpServers: [] });
  client.sessionId = sess.sessionId;
  check("session/new", Boolean(client.sessionId), client.sessionId);

  // 5. The probe turn(s).
  for (let i = 1; i <= RUNS; i++) {
    const report = await runProbe(client, i);
    runReports.push(report);
    // The search keeps scanning between runs only while a cursor is live;
    // each mock turn is a fresh search, so runs are independent samples.
    await sleep(2_000);
  }
} catch (err) {
  exitCode = 1;
  check("probe flow completed", false, String(err?.message ?? err));
} finally {
  cleanup();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const hostLogText = safeRead(hostLog);
const roundTrips = hostLogText.split("\n").filter((l) => l.includes("tool round-trip")).map((l) => l.trim());
const updateAges = hostLogText.split("\n").filter((l) => l.includes("mail_search tool_update")).map((l) => l.trim());

for (const r of runReports) {
  console.log(`\n--- run ${r.runIndex} (total ${Math.round(r.totalMs / 1000)} s) ---`);
  for (const ev of r.timeline) {
    console.log(`  ${String(ev.t).padStart(7)} ms  ${ev.type}${ev.messages !== undefined ? `  messages=${ev.messages} complete=${ev.complete} scanned=${ev.scanned} cursor=${ev.nextCursor}` : ""}${ev.text ? `  ${ev.text}` : ""}${ev.status ? `  status=${ev.status}` : ""}`);
  }
  if (r.promptError) console.log(`  prompt error: ${r.promptError}`);
}
if (roundTrips.length) console.log(`\nhost log round-trips:\n  ${roundTrips.join("\n  ")}`);

const first = runReports[0];
if (first) {
  // The mock turn fires exactly ONE mail_search call. The tool result is the
  // dispatcher's first-page result: either the whole search (small/early
  // match → complete=true) or an early page (complete=false + nextCursor).
  // Full-search completion + continuation are covered by the dispatcher unit
  // tests (thunderbird/test/mail-dispatcher.test.ts) and by the live cursor
  // walks; the probe measures first-page latency, the dominant cost.
  // The final update's rawOutput.content[0].text is the pretty-printed JSON
  // tool result.
  const raw = first.finalUpdate?.raw ?? {};
  let out = {};
  try {
    out = JSON.parse(raw.rawOutput?.content?.[0]?.text ?? raw.content?.[0]?.content?.text ?? "{}");
  } catch {
    out = {};
  }
  const msgs = Array.isArray(out?.messages) ? out.messages : [];
  check("prompt completed cleanly", first.ok && first.stopReason === "end_turn", `stopReason=${first.stopReason ?? first.promptError}`);
  // Zero-match first pages (rare queries) legitimately emit no batch — the
  // cursor carries the continuation. Batches are required only when the
  // engine produced matches.
  check("streaming: batch/progress updates on the tool_call_update path",
    first.finalUpdate !== undefined && ((first.batchCount + first.progressCount) > 0 || msgs.length === 0),
    `batches=${first.batchCount} progress=${first.progressCount} firstPageMessages=${msgs.length}`);
  check("tool result is a valid incremental result",
    typeof out?.complete === "boolean" && typeof out?.sortComplete === "boolean" && typeof out?.scanned === "number",
    `complete=${out?.complete} sortComplete=${out?.sortComplete} scanned=${out?.scanned} nextCursor=${out?.nextCursor ? "yes" : "no"}`);
  check("first-page result well-formed (messages may be empty for rare queries)",
    Array.isArray(out?.messages),
    `${msgs.length} message(s)${msgs.length ? ": " + msgs.slice(0, 3).map((m) => m.subject).join(" | ") : " — continuation fetches the rest"}`);
  const amo = msgs.filter((m) => /add-?ons|amo/i.test(String(m.subject ?? "")));
  if (amo.length) console.log(`  (known Add-ons/AMO message(s) on first page: ${amo.map((m) => m.subject).join(" | ")})`);
  check("host log has the tool round-trip timing", roundTrips.length > 0, roundTrips[0] ?? "missing");
  const ttf = first.firstUpdateMs;
  const total = first.totalMs;
  console.log(`\ntiming summary (run 1): time-to-first-batch ${ttf ?? "n/a"} ms / total ${total} ms${ttf ? ` (first batch at ${Math.round((ttf / total) * 100)}% of the run)` : ""}`);
}

writeFileSync(evidence("results.json"), JSON.stringify({ text: TEXT, limit: LIMIT, runs: runReports, roundTrips, updateAges }, null, 2));
writeFileSync(evidence("host.log"), hostLogText);
writeFileSync(evidence("task.json"), JSON.stringify({ text: TEXT, limit: LIMIT, runs: RUNS, timeoutMs: TIMEOUT_MS }, null, 2));
console.log(`\nevidence: ${root}`);

// ---------------------------------------------------------------------------
// Restore verification
// ---------------------------------------------------------------------------

(async () => {
  const deadline = Date.now() + 45_000;
  let restored = false;
  while (Date.now() < deadline && !restored) {
    // The real host (no probe env marker) back, with TB connected.
    const real = hostPids().filter((pid) => !safeRead(`/proc/${pid}/environ`).includes(`PI_BROWSER_LOG_FILE=${hostLog}`));
    const probe = hostPidsWithEnv(`PI_BROWSER_LOG_FILE=${hostLog}`);
    if (probe.length === 0 && real.length > 0) restored = true;
    else await sleep(1_000);
  }
  console.log(restored ? "restore: real host relaunched, Thunderbird back on it" : "restore: WARNING — real host not observed within 45 s (TB will relaunch it on next reconnect)");
  if (!restored) exitCode = 1;
  console.log(`\n--- live mail-search probe: ${results.filter((r) => r.ok).length}/${results.length} checks passed ---`);
  process.exit(exitCode);
})();
