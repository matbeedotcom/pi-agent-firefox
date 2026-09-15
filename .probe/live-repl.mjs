/**
 * LIVE verification (BROWSER-USE-REPL-PLAN.md Phase 2 DoD):
 *
 * "using the javascript tool, walk my current tab: snapshot, read a value by
 * evaluate, click a control, screenshot, and save a checkpoint."
 *
 * Real Firefox (155.0.1) + real built add-on (firefox/dist) + real native
 * host (packages/pi-agent/dist) + real REPL worker. The agent backend is the
 * deterministic mock (scripted `javascript` cell) so the test needs no model
 * API; the BROWSER side (DOM, content scripts, tabs, screenshots) is all real.
 * PI_LIVE_REAL=1 instead uses the configured real Pi model, without a script.
 * PI_LIVE_TIMEOUT_MS controls its model budget (default 12 minutes).
 *
 * The sidebar UI is driven with xdotool on a private Xvfb display. Evidence
 * (screenshots of the display, host log, workspace files) lands in
 * VERIFICATION-evidence/<timestamp>/ and the results are printed as a table.
 *
 * Run: node .probe/live-repl.mjs
 */
import { execSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, statSync, writeFileSync } from "node:fs";
function syncSymlinkSync(target, linkPath) {
  try {
    rmSync(linkPath);
  } catch { /* noop */ }
  symlinkSync(target, linkPath);
}
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const real = process.env.PI_LIVE_REAL === "1";
const modelTimeoutMs = Number(process.env.PI_LIVE_TIMEOUT_MS ?? 720_000);
if (!Number.isFinite(modelTimeoutMs) || modelTimeoutMs <= 0) throw new Error("Invalid PI_LIVE_TIMEOUT_MS");
const task = real
  ? "Using the javascript tool, walk my current bound tab in ONE cell: take a snapshot, evaluate document.title and print it, print the first heading text, click the Go button and print the resulting state, take a screenshot, then save a checkpoint named live-walk.json containing the title, the resulting state, and the ref of the clicked button. Report what you observed."
  : "live-repl-walk";
const NODE = process.env.PI_LIVE_NODE ?? "/home/acidhax/.nvm/versions/node/v23.10.0/bin/node";
const FIREFOX = "/home/acidhax/Downloads/firefox-155.0.1/firefox/firefox";
// -displayfd allocates a free display and reports it ONLY after this server
// is ready. Never use xdpyinfo as proof our Xvfb started: it also succeeds
// against an old server whose overlapping windows split click/key targets.
const requestedDisplay = process.env.PI_LIVE_DISPLAY;
if (requestedDisplay !== undefined && !/^\d+$/.test(requestedDisplay)) {
  throw new Error("PI_LIVE_DISPLAY must be a display number");
}
const xvfb = spawn("Xvfb", [
  ...(requestedDisplay === undefined ? [] : [`:${requestedDisplay}`]),
  "-displayfd", "3", "-screen", "0", "1400x900x24",
], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
let ff;
let restoreManifest = () => {};
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  // web-ext's Firefox is a grandchild; killing just web-ext leaves it alive.
  if (ff?.pid) {
    try { process.kill(-ff.pid, "SIGTERM"); } catch { /* already exited */ }
  }
  xvfb.kill();
  restoreManifest();
}
process.once("exit", cleanup);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
let xvfbLog = "";
xvfb.stderr.on("data", (data) => { xvfbLog += data; });
const DISPLAY = `:${await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Xvfb readiness timed out")), 10_000);
  const fail = (err) => { clearTimeout(timer); reject(err); };
  xvfb.once("error", fail);
  xvfb.once("exit", (code) => fail(new Error(`Xvfb exited (${code}): ${xvfbLog.trim()}`)));
  let ready = "";
  xvfb.stdio[3].on("data", (data) => {
    ready += data;
    if (/^\d+\n$/.test(ready)) {
      clearTimeout(timer);
      resolve(ready.trim());
    }
  });
})}`;
console.log(`owned Xvfb pid=${xvfb.pid} display=${DISPLAY}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = path.join(process.cwd(), "VERIFICATION-evidence", `live-${stamp}`);
mkdirSync(root, { recursive: true });
const evidence = (name) => path.join(root, name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", env: { ...process.env, DISPLAY } }).trim();
}
function xdotool(args) {
  execSync(`xdotool ${args}`, { env: { ...process.env, DISPLAY }, stdio: "pipe", timeout: 10_000 });
}
function shot(name) {
  execSync(`import -window root "${evidence(name)}"`, { env: { ...process.env, DISPLAY }, stdio: "pipe" });
}
async function waitForFile(file, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await sleep(intervalMs);
  }
  return false;
}
function logLine(file, needle) {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Setup: Xvfb, profile, native host manifest, mock script, test page
// ---------------------------------------------------------------------------

const work = path.join(tmpdir(), `pi-live-${Date.now()}`);
mkdirSync(work, { recursive: true });
// Global native-messaging host dir (Linux): any profile sees it. This is the
// same location the pi installer writes, so it is the production path.
const nmHostDir = path.join(homedir(), ".mozilla", "native-messaging-hosts");
mkdirSync(nmHostDir, { recursive: true });
const nmManifest = path.join(nmHostDir, "com.matbee.agent.json");
const pageDir = path.join(work, "page");
mkdirSync(pageDir);
const hostLog = path.join(work, "host.log");
const replDir = path.join(work, "repl");
const brokerDir = path.join(work, "broker");
const agentDir = path.join(work, "agent");
mkdirSync(brokerDir, { recursive: true });
mkdirSync(replDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

// Stale hosts from previous probe runs survive as BROKERS (plan §26 relay
// mode: a starting host adopts the first living broker at
// ~/.pi/run/agent-broker.*). The stale broker serves old code and its
// sessions get auto-resumed by the sidebar, so the probe's prompt can hit a
// session with a different (pre-fix) tool surface. Kill only probe-family
// hosts — identified by the probe-only env marker PI_BROWSER_LOG_FILE under
// /tmp/pi-live-* (the launcher exec's, so the marker lives in /proc/<pid>/
// environ, never in cmdline). A user's own host (installed manifest, no
// probe env) never matches.
{
  const stale = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline = "";
    try { cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8"); } catch { continue; }
    if (!cmdline.includes("packages/pi-agent/dist/native-host/main.js")) continue;
    let env = "";
    try { env = readFileSync(`/proc/${entry}/environ`, "utf8"); } catch { continue; }
    if (env.includes("PI_BROWSER_LOG_FILE=/tmp/pi-live-")) stale.push(entry);
  }
  for (const pid of stale) {
    try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ }
  }
  if (stale.length) {
    console.log(`killed stale probe host(s): ${stale.join(", ")}`);
    // Let them release the broker socket; the next host reclaims it once the
    // pid in ~/.pi/run/agent-broker.json is dead.
    await sleep(1_500);
  }
}

// The test page: one Go button that rewrites #state when clicked.
// Served over http:// (not file://): the add-on's host permissions cover
// http(s) — the real usage — and content scripts cannot be injected into
// file:// tabs without extra (product-changing) permissions.
writeFileSync(
  path.join(pageDir, "live-walk.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><title>Live REPL Walk</title>
<style>
  #dbg{position:fixed;right:8px;bottom:8px;width:340px;max-height:220px;overflow:hidden;
       background:rgba(10,10,16,.9);color:#9fe89f;font:11px/1.5 ui-monospace,monospace;
       padding:6px 8px;border:1px solid #444;white-space:pre;z-index:99999}
</style>
</head>
<body>
  <h1>Live REPL Walk</h1>
  <p id="intro">The javascript tool walks this tab: snapshot, evaluate, click, screenshot, checkpoint.</p>
  <button id="go" type="button" onclick="document.getElementById('state').textContent='clicked:' + Date.now()">Go</button>
  <div id="state" aria-live="polite">initial</div>
  <pre id="dbg"></pre>
  <script>
    // PROBE-ONLY: log where real clicks land + live element rects.
    const dbg = document.getElementById('dbg');
    const clicks = [];
    document.addEventListener('click', (e) => {
      const t = e.target;
      const label = t.id ? '#' + t.id : (t.className ? '.' + String(t.className).split(' ')[0] : t.tagName);
      clicks.push(e.clientX + ',' + e.clientY + ' ' + label);
      if (clicks.length > 8) clicks.shift();
      refresh();
    }, true);
    function refresh() {
      const lines = ['vw=' + innerWidth + 'x' + innerHeight + ' dpr=' + devicePixelRatio];
      for (const c of clicks) lines.push('click ' + c);
      for (const s of ['#go', '#state']) {
        const r = document.querySelector(s).getBoundingClientRect();
        lines.push('rect ' + s + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      dbg.textContent = lines.join('\\n');
    }
    setInterval(refresh, 500); refresh();
  </script>
</body></html>`,
);

// The scripted cell — the DoD walkthrough in one persistent realm cell.
const cellCode = [
  "const snap = await page.snapshot();",
  "const go = snap.nodes.find((n) => n.role === 'button' && n.name === 'Go');",
  "if (!go) throw new Error('Go button not found in snapshot: ' + JSON.stringify(snap.nodes.map((n) => n.role)));",
  "await page.click(go.ref);",
  "const state = await page.evaluate(\"() => document.getElementById('state').textContent\");",
  "if (!String(state).startsWith('clicked:')) throw new Error('click had no effect: ' + state);",
  "const info = await page.info();",
  "const screenshotResult = await screenshot();",
  "if (screenshotResult !== 'Screenshot captured.') throw new Error(screenshotResult);",
  "await artifact('walk.txt', 'title=' + info.title + '\\nstate=' + state);",
  "await checkpoint('live-walk.json', { title: info.title, state, ref: go.ref, screenshotResult });",
  "JSON.stringify({ title: info.title, state, ref: go.ref })",
].join("\n");

writeFileSync(
  path.join(work, "mock-script.json"),
  JSON.stringify([{ match: "live-repl-walk", toolCalls: [{ toolName: "javascript", args: { code: cellCode, timeoutMs: 60_000 } }] }]),
);

// Native messaging host manifest (profile-scoped).
const launcher = path.join(work, "host-launcher.sh");
writeFileSync(
  launcher,
  [
    "#!/bin/sh",
    ...(real ? ["unset PI_BROWSER_BACKEND PI_BROWSER_MOCK_SCRIPT"] : [
      "export PI_BROWSER_BACKEND=mock",
      `export PI_BROWSER_MOCK_SCRIPT=${path.join(work, "mock-script.json")}`,
    ]),
    `export PI_BROWSER_REPL_DIR=${replDir}`,
    `export PI_BROWSER_BROKER_DIR=${brokerDir}`,
    `export PI_BROWSER_AGENT_DIR=${agentDir}`,
    `export PI_BROWSER_LOG_FILE=${hostLog}`,
    `export PI_BROWSER_LOG_LEVEL=${real ? "debug" : "info"}`,
    `touch ${path.join(work, "host-launched")} 2>/dev/null || true`,
    `exec ${NODE} ${path.join(REPO, "packages/pi-agent/dist/native-host/main.js")} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(launcher, 0o755);
const prevManifest = existsSync(nmManifest) ? readFileSync(nmManifest, "utf8") : null;
restoreManifest = () => {
  if (prevManifest !== null) writeFileSync(nmManifest, prevManifest);
  else rmSync(nmManifest, { force: true });
  restoreManifest = () => {};
};
writeFileSync(
  nmManifest,
  JSON.stringify({
    name: "com.matbee.agent",
    description: "Pi Browser host (live test)",
    path: launcher,
    type: "stdio",
    allowed_extensions: ["pi-agent-firefox@matbee.com"],
  }),
);

// Small static server for the test page (http is what the add-on supports).
const httpServer = createServer((req, res) => {
  const file = path.join(pageDir, req.url === "/" ? "live-walk.html" : req.url);
  if (existsSync(file)) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(readFileSync(file));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${httpServer.address().port}/live-walk.html`;

// ---------------------------------------------------------------------------
// 2. Launch Xvfb + Firefox (via web-ext: temporary add-on, release-safe)
// ---------------------------------------------------------------------------

sh("xdpyinfo");

// web-ext loads the built add-on as a TEMPORARY add-on (release-safe, no
// signature) into its own managed profile, and opens the start URL.
// web-ext resolves the browser via PATH: shim the real Firefox binary.
const binShim = path.join(work, "bin");
mkdirSync(binShim, { recursive: true });
syncSymlinkSync(FIREFOX, path.join(binShim, "firefox"));
const webExtCwd = path.join(work, "webext");
mkdirSync(webExtCwd, { recursive: true });
ff = spawn(
  "web-ext",
  [
    "run",
    "--source-dir", path.join(REPO, "firefox/dist"),
    "--start-url", pageUrl,
    "--no-reload",
    "--args=--width=1400",
    "--args=--height=900",
  ],
  { detached: true, cwd: webExtCwd, env: { ...process.env, DISPLAY, PATH: `${binShim}:/home/acidhax/.nvm/versions/node/v23.10.0/bin:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] },
);
let webExtLog = "";
ff.stdout.on("data", (d) => (webExtLog += d));
ff.stderr.on("data", (d) => (webExtLog += d));

const results = [];
function check(name, ok, detail = "") {
  if (!ok) exitCode = 1;
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}
let exitCode = 0;
const cpFiles = [];

try {
  // Wait for the Firefox window.
  let win = "";
  for (let i = 0; i < 60 && !win; i++) {
    await sleep(1_000);
    try {
      win = sh(`xdotool search --onlyvisible --name "Live REPL Walk" | head -1`);
    } catch { /* not up yet */ }
  }
  if (!win) {
    check("firefox window appears", false, webExtLog.slice(-500));
    throw new Error("no firefox window");
  }
  const matchingWindows = sh('xdotool search --onlyvisible --name "Live REPL Walk"').split("\n");
  check("exactly one live Firefox window on owned display", matchingWindows.length === 1, matchingWindows.join(", "));
  if (matchingWindows.length !== 1) throw new Error("ambiguous Firefox window target");
  writeFileSync(evidence("windows.txt"), sh("xwininfo -root -tree"));
  check("firefox window appears", true, `window ${win}`);
  const geom = sh(`xdotool getwindowgeometry --shell ${win}`).replace(/\r/g, "");
  const wx = Number(geom.match(/X=(\d+)/)?.[1] ?? 0);
  const wy = Number(geom.match(/Y=(\d+)/)?.[1] ?? 0);
  const ww = Number(geom.match(/WIDTH=(\d+)/)?.[1] ?? 1400);
  const wh = Number(geom.match(/HEIGHT=(\d+)/)?.[1] ?? 900);
  process.stdout.write(`window at ${wx},${wy} ${ww}x${wh}\n`);
  await sleep(1_500);
  shot("01-firefox.png");

  // The add-on's background connects to the native host (keepalive, ~10 s).
  let connected = false;
  {
    const launchedMarker = path.join(work, "host-launched");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !connected) {
      if (logLine(hostLog, "connected") || logLine(hostLog, "initialize")) connected = true;
      else await sleep(500);
    }
    check("add-on connects to the native host", connected, connected ? "host log shows the ACP handshake" : existsSync(launchedMarker) ? `host launched but no connect; log:\n${safeRead(hostLog).slice(-800)}` : `native host never launched (manifest rejected?); web-ext log tail:\n${webExtLog.slice(-400)}`);
    if (!connected) throw new Error("add-on never connected");
  }

  // --- UI automation (coordinates relative to the window origin; the
  // sidebar auto-opens on connect and sits on the LEFT, ~250 px wide) ----
  const W = ww, H = wh;
  const click = (x, y, label) => {
    xdotool(`mousemove ${wx + x} ${wy + y} click 1`);
    process.stdout.write(`  click ${label} @ ${wx + x},${wy + y}\n`);
  };
  // Type via XTEST (Firefox ignores synthetic XSendEvent keys). Bare Xvfb has
  // no WM: set X input focus explicitly, then XTEST keystrokes reach the page.
  const getFocus = () => {
    try { return sh("xdotool getwindowfocus -f"); } catch { return "?"; }
  };
  const typeInto = (label, text) => {
    const f0 = getFocus();
    xdotool(`windowfocus --sync ${win}`);
    const f1 = getFocus();
    if (f1 !== win) throw new Error(`X focus ${f1} does not match typing target ${win}`);
    // Single-quote for /bin/sh; embedded ' becomes '\'' (task text is arbitrary).
    const quoted = `'${String(text).replaceAll(`'`, `'\\''`)}'`;
    xdotool(`type --clearmodifiers --delay 25 ${quoted}`);
    const f2 = getFocus();
    process.stdout.write(`  [focus] ${label}: before=${f0} afterFocus=${f1} afterType=${f2} (win=${win})\n`);
  };

  // 1) The sidebar opened itself on connect (onInstalled flow).
  await sleep(2_000);
  shot("02-sidebar.png");

  // 2) New session: "+ New" (right side of the sidebar topbar).
  click(207, 157, "+ New");
  await sleep(700);
  shot("03-new-panel.png");

  // 3) cwd input + "Create session" (panel replaces the topbar area).
  click(127, 229, "cwd input");
  await sleep(500);
  typeInto("cwd", `${work}/proj`);
  await sleep(500);
  shot("03b-cwd-typed.png");
  click(67, 262, "Create session");
  const sessionDeadline = Date.now() + (real ? 120_000 : 1_500);
  while (Date.now() < sessionDeadline && !logLine(hostLog, "session/new ->")) await sleep(500);
  await sleep(1_500);
  shot("04-session-created.png");
  const cwdReceived = safeRead(hostLog).split("\n").some((line) => line.includes("session/new") && line.endsWith(`cwd=${work}/proj`));
  check("typed cwd reached session/new", cwdReceived);
  if (!cwdReceived) throw new Error("typed cwd did not reach the current host");

  // 4) The new session is auto-selected; its row is at y≈195. Click it to be sure.
  click(127, 195, "session item");
  await sleep(1_200);
  shot("05-active-pane.png");

  // 5) Bind the current tab (binding row: "No tab bound" + button, y≈340).
  click(180, 340, "Bind current tab");
  await sleep(1_500);
  shot("06-bound.png");

  // 6) Prompt: type the trigger, click Send (bottom-left). Verify the host
  //    actually received the prompt; retry the typing if X focus raced.
  let promptSent = false;
  for (let attempt = 1; attempt <= 3 && !promptSent; attempt++) {
    click(127, 830, `composer (attempt ${attempt})`);
    await sleep(500);
    typeInto(`composer#${attempt}`, task);
    await sleep(600);
    shot(`06b-composer-typed-${attempt}.png`);
    click(46, 891, "Send");
    process.stdout.write("  prompt sent\n");
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (logLine(hostLog, "session/prompt")) { promptSent = true; break; }
      await sleep(250);
    }
    if (!promptSent) process.stdout.write("  (prompt not received by host, retrying)\n");
  }
  await sleep(2_000);
  shot("07-prompt-sent.png");
  check("prompt reached the host (session/prompt)", promptSent, "");

  // 7) The screenshot inside the cell requests permission — the host logs
  //    "requesting user permission" when the overlay appears. Click
  //    "Allow once" (primary, first option) and confirm from the host log.
  const allowAt = (dx, dy) => xdotool(`mousemove ${wx + dx} ${wy + dy} click 1`);
  let promptSeen = false;
  const promptDeadline = Date.now() + (real ? modelTimeoutMs : 30_000);
  while (Date.now() < promptDeadline && !promptSeen) {
    if (logLine(hostLog, "browser_screenshot: requesting user permission")) promptSeen = true;
    else await sleep(500);
  }
  let allowed = false;
  if (promptSeen) {
    await sleep(500); // let the overlay render
    shot("07b-permission-overlay.png");
    // At this viewport the card starts at y=366; y=380 is its heading,
    // not a button. The first option spans y=529..555 (see overlay shot).
    allowAt(90, 541);
    process.stdout.write("  permission: clicked Allow once\n");
    const allowDeadline = Date.now() + 15_000;
    while (Date.now() < allowDeadline && !allowed) {
      if (logLine(hostLog, "browser_screenshot: user chose Allow once")) allowed = true;
      else await sleep(500);
    }
  }
  process.stdout.write(promptSeen ? (allowed ? "  permission: granted\n" : "  permission: NOT granted (click missed?)\n") : "  (no permission prompt observed)\n");
  await sleep(1_500);
  shot("08-after-permission.png");
  check("screenshot permission prompt shown + allowed", promptSeen && allowed, "");

  if (real) {
    const deadline = Date.now() + modelTimeoutMs;
    while (Date.now() < deadline && !realToolEvidence(safeRead(hostLog)).finished) await sleep(1_000);
    const log = safeRead(hostLog);
    const actual = realToolEvidence(log);
    // Exact: the log may contain 'mock' in unrelated strings; the actual
    // backend is the one logged at connect.
    check("real Pi backend selected (not mock)", log.match(/backend: (\S+)/)?.[1] === "pi", `backend: ${log.match(/backend: (\S+)/)?.[1] ?? "not logged"}`);
    check("typed natural-language task recorded", log.includes(`text=${JSON.stringify(task)}`));
    check("configured real model resolved", /model=[^\s]+\//.test(log), log.match(/model=[^\n]+/)?.[0] ?? "missing");
    check("model authored non-trivial javascript cell", actual.calls.length > 0, actual.calls.join("\n"));
    check("javascript result returned with page observations and screenshot", actual.finished, actual.ends.join("\n"));
    // Keep the actual browser screenshot returned to the model, not just Xvfb screenshots.
    const sessionId = log.match(/session\/new -> ([^ ]+)/)?.[1];
    // Per-run agent dir (PI_BROWSER_AGENT_DIR) — sessions live there now.
    const sessionsRoot = path.join(agentDir, "sessions");
    let imageCount = 0;
    for (const dir of safeReaddir(sessionsRoot).filter((d) => d.includes(path.basename(work)))) {
      for (const file of safeReaddir(path.join(sessionsRoot, dir)).filter((f) => f.includes(sessionId) && f.endsWith(".jsonl"))) {
        const transcript = safeRead(path.join(sessionsRoot, dir, file));
        writeFileSync(evidence("session.jsonl"), transcript, { mode: 0o600 });
        for (const line of transcript.trim().split("\n")) {
          const message = JSON.parse(line).message;
          if (message?.role !== "toolResult" || message.toolName !== "javascript") continue;
          for (const part of message.content ?? []) {
            if (part.type === "image" && part.mimeType === "image/png") {
              writeFileSync(evidence(`browser-screenshot-${++imageCount}.png`), Buffer.from(part.data, "base64"), { mode: 0o600 });
            }
          }
        }
      }
    }
    check("actual browser screenshot PNG returned to real model", imageCount > 0, `${imageCount} PNG(s)`);
    // DoD checkpoint: the model must have saved live-walk.json in the session
    // workspace (replDir/<sessionId>/live-walk.json) with 0600 permissions.
    const cpDeadline = Date.now() + modelTimeoutMs;
    while (Date.now() < cpDeadline && cpFiles.length === 0) {
      for (const dir of safeReaddir(replDir)) {
        const cp = path.join(replDir, dir, "live-walk.json");
        if (existsSync(cp)) cpFiles.push(cp);
      }
      if (cpFiles.length) break;
      await sleep(500);
    }
    check("checkpoint saved by the real model (live-walk.json)", cpFiles.length > 0, cpFiles[0] ? path.basename(path.dirname(cpFiles[0])) : "no live-walk.json under " + replDir);
    const realCpStat = cpFiles[0] ? statSync(cpFiles[0]) : undefined;
    check("checkpoint file is 0600", realCpStat ? (realCpStat.mode & 0o777) === 0o600 : false, realCpStat ? `mode ${realCpStat.mode & 0o777}` : "");
  } else {
  // 8) Wait for the cell to finish: the checkpoint file lands in the
  //    session workspace (replDir/<sessionId>/live-walk.json).
  const cpDeadline = Date.now() + 90_000;
  while (Date.now() < cpDeadline) {
    for (const dir of safeReaddir(replDir)) {
      const cp = path.join(replDir, dir, "live-walk.json");
      if (existsSync(cp)) cpFiles.push(cp);
    }
    if (cpFiles.length) break;
    await sleep(500);
  }
  const checkpointOk = cpFiles.length > 0;
  check("checkpoint saved (live cell finished)", checkpointOk, checkpointOk ? path.basename(path.dirname(cpFiles[0])) : "no live-walk.json under " + replDir);

  // 9) Verify the evidence files.
  let walkText = "";
  let cpJson = null;
  if (checkpointOk) {
    const sessDir = path.dirname(cpFiles[0]);
    cpJson = JSON.parse(readFileSync(cpFiles[0], "utf8"));
    walkText = safeRead(path.join(sessDir, "walk.txt"));
  }
  check("snapshot found the Go button by role+name", Boolean(cpJson?.ref?.startsWith("el-")), cpJson?.ref ?? "");
  check("click had a real effect on the live DOM", typeof cpJson?.state === "string" && cpJson.state.startsWith("clicked:"), String(cpJson?.state));
  check("evaluate read the page value", cpJson?.state?.includes("clicked:") === true, "");
  check("info() carries the live title", cpJson?.title === "Live REPL Walk", String(cpJson?.title));
  check("artifact written to the session workspace", walkText.includes("title=Live REPL Walk") && walkText.includes("state=clicked:"), walkText.replace(/\n/g, " | "));
  const cpStat = checkpointOk ? statSync(cpFiles[0]) : undefined;
  check("checkpoint file is 0600", cpStat ? (cpStat.mode & 0o777) === 0o600 : false, cpStat ? `mode ${cpStat.mode & 0o777}` : "");

  // 10) Screenshot evidence: the cell's browser_screenshot went through the
  //     permission gate (host log) and the add-on captured the REAL tab.
  check("in-cell screenshot passed the permission gate", allowed && cpJson?.screenshotResult === "Screenshot captured.", cpJson?.screenshotResult ?? "");
  }
  await sleep(1_000);
  shot("09-final.png");
} catch (err) {
  exitCode = 1;
  check("live flow completed", false, String(err?.message ?? err));
  shot("99-failure.png");
} finally {
  // Tear down only this run's process group/display (never a stale window).
  cleanup();
  httpServer.close();
  writeFileSync(evidence("xvfb.log"), xvfbLog);
  writeFileSync(evidence("host.log"), safeRead(hostLog));
  writeFileSync(evidence("web-ext.log"), webExtLog);
  writeFileSync(evidence("results.json"), JSON.stringify(results, null, 2));
  // Preserve checkpoint confidentiality in the evidence copy too (0600).
  writeFileSync(evidence("checkpoint.json"), safeRead(cpFiles[0] ?? "/nonexistent") || "null", { mode: 0o600 });
  // Faithful evidence: preserve the original checkpoint's mode (0600), not the umask default.
  const cpMode = cpFiles[0] ? statSync(cpFiles[0]).mode & 0o777 : 0o600;
  chmodSync(evidence("checkpoint.json"), cpMode);
}

// (safeRead/safeReaddir helpers)
function unused() {}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n--- live verification: ${results.filter((r) => r.ok).length}/${results.length} checks passed ---`);
console.log(`evidence: ${root}\n`);
if (exitCode === 0) {
  console.log("LIVE VERIFICATION PASSED");
} else {
  console.log("LIVE VERIFICATION FAILED");
}
process.exit(exitCode);

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function realToolEvidence(log) {
  const calls = log.split("\n").filter((line) => line.includes("session/tool_start") && /javascript .*"code":".{20}/.test(line));
  const ends = log.split("\n").filter((line) => line.includes("session/tool_end") && line.includes("javascript isError=false"));
  return { calls, ends, finished: calls.length > 0 && ends.some((line) => line.includes('"type":"image"')) && ends.some((line) => line.includes("Live REPL Walk")) };
}
