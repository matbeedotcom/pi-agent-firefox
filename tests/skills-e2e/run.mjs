#!/usr/bin/env node
/**
 * Skills e2e scenario runner (controlled test matrix, design §8/§9).
 *
 *   node tests/skills-e2e/run.mjs [scenario-name ...] [--list] [--keep-tmp]
 *
 * One scenario = one fresh world:
 *   - tests/fixtures/skills/ served on 127.0.0.1 (recorder beacons land on
 *     POST /__report — the observation channel),
 *   - Firefox launched through web-ext (release-safe: the BUILT add-on
 *     loads as a TEMPORARY add-on into web-ext's managed profile — the
 *     only install path that works on unsigned release builds) with the
 *     FAKE native host (real dist/native-host/main.js + scripted mock
 *     backend, packages/pi-agent/test/skills-host/fake-host.mjs)
 *     registered in the global ~/.mozilla/native-messaging-hosts dir
 *     (the production install path; the user's manifest is backed up and
 *     restored on exit),
 *   - Firefox opens the fixture page with ?skills_test=1 — the
 *     recorder's guarded auto-driver opens a session, binds the tab and
 *     sends the scripted prompt; the fake host's scripted turn then drives
 *     the real page through the real add-on's browser tools (auto-approved
 *     via the PI_BROWSER_AUTO_APPROVE test seam),
 *   - assertions run against the beaconed fixture state (window.__fixture
 *     log, body[data-submitted], #receipt).
 *
 * The scenario JSON is the shared matrix contract: agent-side steps are
 * consumed by fake-host.mjs; "fixture"/"prompt"/"expect" are read here.
 * Exit code 0 = all selected scenarios passed.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, readFile, stat, writeFile, open, readdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureServer } from "./serve.mjs";
import { prepareFakeHost, ADDON_ID } from "./profile.mjs";
import { grantOptionalPermission } from "./rdp-grant.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FIXTURES = path.resolve(REPO, "tests/fixtures/skills");
const SCENARIOS = path.resolve(HERE, "scenarios");
const SKILL_ROOTS = path.resolve(REPO, "tests/skills-packages");
const ADDON_DIST = path.resolve(REPO, "firefox/dist");
const AGENT_HOST = path.resolve(REPO, "packages/pi-agent/dist/native-host/main.js");
const FAKE_HOST = path.resolve(REPO, "packages/pi-agent/test/skills-host/fake-host.mjs");
const AUTO_APPROVE_TOOLS = ["browser_navigate", "browser_type", "browser_click", "browser_evaluate", "browser_get_page", "browser_get_dom", "browser_wait_for", "browser_reload"];

const HANDSHAKE_TIMEOUT_MS = 60_000;
// A healthy scenario settles in ~1.5s (fixture pacing is trimmed: 50ms
// autoDrive + 100ms post-action sleeps + 250ms debounce). 3s is a small
// margin above that floor; a broken run now reports in ~3s, not ~90s.
// A healthy scenario settles in a few seconds; the polling steps carry 5s
// windows, so the total can reach ~15s on a slow box. 25s is generous.
const SCENARIO_TIMEOUT_MS = Number(process.env.SKILLS_E2E_SCENARIO_TIMEOUT_MS ?? 25_000);

const IS_WIN = process.platform === "win32";

/** Windows refuses to spawn .cmd/.bat directly (EINVAL since Node's
 *  CVE-2024-27980 fix): route non-.exe tools through cmd.exe. */
function platformCommand(cmd, args) {
  if (!IS_WIN || /\.exe$/i.test(cmd)) return { cmd, args, opts: {} };
  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const line = [cmd, ...args].map(quote).join(" ");
  return { cmd: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], opts: { windowsVerbatimArguments: true } };
}

/** `which` (POSIX) / `where` (Windows): first match or "". */
function whichFirst(name) {
  const res = spawnSync(IS_WIN ? "where" : "which", [name], { encoding: "utf8" });
  return (res.stdout || "").trim().split(/\r?\n/)[0] ?? "";
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function newestMtime(dir, pattern) {
  let newest = 0;
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (pattern.test(entry.name)) newest = Math.max(newest, (await stat(p)).mtimeMs);
    }
  };
  await walk(dir);
  return newest;
}

/**
 * Build when missing OR stale: a dist that predates the newest source file
 * silently runs an old add-on (learned the hard way — the harness ran
 * several "current" scenarios against a build that predated the test
 * bridge).
 */
async function ensureBuilt() {
  const needed = [];
  if (!(await exists(AGENT_HOST))) needed.push("trusted-user-agent");
  let addonStale = !(await exists(path.join(ADDON_DIST, "manifest.json")));
  if (!addonStale) {
    const srcRoot = path.resolve(REPO, "firefox/src");
    const webextDist = path.resolve(REPO, "packages/webext/dist");
    const [srcNewest, webextNewest] = await Promise.all([
      newestMtime(srcRoot, /\.(ts|js|json|html|css)$/),
      newestMtime(webextDist, /\.js$/),
    ]);
    const distNewest = await newestMtime(ADDON_DIST, /\.js$/);
    if (Math.max(srcNewest, webextNewest) > distNewest) {
      process.stderr.write("[run] firefox add-on dist is stale — rebuilding\n");
      addonStale = true;
    }
  }
  if (addonStale) needed.push("@pi-browser/firefox");
  if (!needed.length) return;
  for (const workspace of needed) {
    process.stderr.write(`[run] building ${workspace}\n`);
    const npm = platformCommand("npm", ["run", "build", "-w", workspace]);
    const res = spawnSync(npm.cmd, npm.args, { cwd: REPO, stdio: "inherit", ...npm.opts });
    if (res.status !== 0) throw new Error(`build failed for ${workspace}`);
  }
}

/** A binary is usable only if `--version` reports a real version string
 *  (the snap wrapper at /usr/bin/firefox answers with an error that
 *  mentions "firefox" — so the version number is the discriminator). */
function usableFirefox(bin) {
  try {
    const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return /Mozilla Firefox \d/i.test(`${res.stdout ?? ""}${res.stderr ?? ""}`) ? bin : false;
  } catch { return false; }
}

function firefoxBinary() {
  const candidates = [];
  if (process.env.SKILLS_E2E_FIREFOX) candidates.push(process.env.SKILLS_E2E_FIREFOX);
  for (const name of ["firefox", "firefox-esr"]) {
    const found = whichFirst(name);
    if (found) candidates.push(found);
  }
  if (IS_WIN) {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      for (const dir of ["Mozilla Firefox", "Firefox Developer Edition", "Firefox Nightly"]) {
        const bin = path.join(base, dir, "firefox.exe");
        if (existsSync(bin)) candidates.push(bin);
      }
    }
  }
  // Untarred release builds (the box's Firefox lives in Downloads, not on
  // PATH — /usr/bin/firefox is a dead snap shim).
  try {
    const downloads = path.join(homedir(), "Downloads");
    for (const dir of readdirSyncSafe(downloads).filter((d) => /^firefox-\d/.test(d)).sort().reverse()) {
      const bin = path.join(downloads, dir, "firefox", "firefox");
      if (existsSync(bin)) candidates.push(bin);
    }
  } catch { /* no Downloads dir */ }
  for (const bin of candidates) {
    const ok = usableFirefox(bin);
    if (ok) return ok;
  }
  throw new Error("no working firefox binary found (set SKILLS_E2E_FIREFOX to a real Firefox executable)");
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/** web-ext launcher as a spawnable command prefix: { cmd, args, opts }. */
function webExtCommand() {
  const candidates = [];
  if (process.env.SKILLS_E2E_WEBEXT) candidates.push(process.env.SKILLS_E2E_WEBEXT);
  const found = whichFirst("web-ext");
  if (found) candidates.push(found);
  const nvm = path.join(homedir(), ".nvm", "versions", "node");
  try {
    for (const v of readdirSync(nvm).sort().reverse()) {
      const bin = path.join(nvm, v, "bin", "web-ext");
      if (existsSync(bin)) candidates.push(bin);
    }
  } catch { /* no nvm */ }
  for (const bin of candidates) {
    const probe = platformCommand(bin, ["--version"]);
    try {
      const res = spawnSync(probe.cmd, probe.args, { encoding: "utf8", timeout: 30_000, ...probe.opts });
      if (res.status === 0 && /\d+\.\d+/.test(res.stdout ?? "")) return { bin, prefix: [] };
    } catch { /* try next */ }
  }
  // Last resort: a pinned web-ext installed once into a harness cache dir,
  // run as `node web-ext.js` — no shell in the path, so the start URL's
  // `&`/`%` survive intact (cmd.exe mangles both on Windows).
  const prefix = path.join(homedir(), ".cache", "skills-e2e", "web-ext");
  const entry = path.join(prefix, "node_modules", "web-ext", "bin", "web-ext.js");
  if (!existsSync(entry)) {
    process.stderr.write(`[run] installing web-ext@8 into ${prefix}\n`);
    const npm = platformCommand("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", prefix, "web-ext@8"]);
    spawnSync(npm.cmd, npm.args, { stdio: ["ignore", 2, 2], timeout: 300_000, ...npm.opts }); // keep stdout = JSON report
  }
  if (existsSync(entry)) return { bin: process.execPath, prefix: [entry] };
  throw new Error("web-ext not found (set SKILLS_E2E_WEBEXT, or install web-ext)");
}

/**
 * Persistent Firefox profile for web-ext runs.
 *
 * Firefox 156 shows a one-time "enable automation" consent prompt when the
 * web-ext remote client first connects; the consent only sticks in a
 * profile that is REUSED, so the harness runs every scenario on this seed
 * profile (--firefox-profile + --keep-profile-changes). The first run on a
 * fresh machine may need a human to approve the prompt on the display;
 * later runs are prompt-free.
 *
 * Add-on state is wiped before each scenario (storage.local lives under
 * storage/<flavor>/mozilla/native-extension/<id>/) so scenarios stay isolated.
 *
 * The page-evaluation path (browser.userScripts.execute, Firefox 153+)
 * requires the add-on's OPTIONAL "userScripts" permission, which normally
 * needs a user-clicked browser prompt. The harness grants it per scenario
 * over web-ext's debugger server instead (rdp-grant.mjs): the profile-scope
 * policies.json pre-grant it used to write relied on an
 * ExtensionSettings.permissions key that Firefox 160 does not have.
 */
async function prepareSeedProfile() {
  const seed = process.env.SKILLS_E2E_SEED_PROFILE ?? path.join(homedir(), ".cache", "skills-e2e", "seed-profile");
  await mkdir(seed, { recursive: true });
  for (const flavor of ["default", "permanent"]) {
    const extDir = path.join(seed, "storage", flavor, "mozilla", "native-extension", ADDON_ID);
    await rm(extDir, { recursive: true, force: true });
  }
  // The profile PERSISTS across runs (--keep-profile-changes). Clear session
  // state so Firefox does NOT restore previous tabs (stale fixture URLs from
  // earlier runs) alongside the start-url — restoring them re-loads the
  // fixture N times and resets the gate mid-scenario.
  for (const name of [
    "sessionCheckpoints.json",
    "sessionstore.jsonlz4",
    "sessionstore-backups/previous.jsonlz4",
    "sessionstore-backups/recovery.jsonlz4",
    "sessionstore-backups/recovery.baklz4",
  ]) {
    await rm(path.join(seed, name), { force: true });
  }

  // A hard-crashed run leaves the profile lock behind (and occasionally a
  // live browser); every later launch then dies with ECONNREFUSED. Detect
  // live holders explicitly, then clear the stale lock.
  const holders = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        if (cmd.includes("firefox") && cmd.includes(seed)) holders.push(Number(entry));
      } catch { /* process gone */ }
    }
  } catch { /* no /proc */ }
  if (holders.length > 0) {
    throw new Error(`Firefox is already using the e2e seed profile ${seed} (pids ${holders.join(", ")}); close it and re-run`);
  }
  await rm(path.join(seed, ".parentlock"), { force: true }); // stale lock from a crash
  // Windows lock file; rm fails (EBUSY) while a live Firefox holds it.
  if (IS_WIN) {
    try {
      await rm(path.join(seed, "parent.lock"), { force: true });
    } catch {
      throw new Error(`Firefox is already using the e2e seed profile ${seed}; close it and re-run`);
    }
  }

  // Drop the policies.json older harness versions wrote (now ignored by
  // Firefox; see rdp-grant.mjs).
  await rm(path.join(seed, "policies"), { recursive: true, force: true });
  return seed;
}

/**
 * Kill pid and its whole descendant tree (web-ext spawns Firefox, which
 * spawns zygotes/content processes; web-ext itself has no signal handler,
 * so SIGTERM alone would orphan the browser).
 */
function collectTree(pid, depth = 0, out = []) {
  if (depth > 12) return out;
  out.push(pid);
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fields = (readFileSync(`/proc/${entry}/stat`, "utf8").split(")").pop() ?? "").trimStart().split(" ");
      if (Number(fields[1]) === pid) collectTree(Number(entry), depth + 1, out);
    } catch { /* process vanished */ }
  }
  return out;
}

async function killTree(pid, profileDir) {
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    // Backstop: Firefox's Windows launcher process can re-parent the real
    // browser out of web-ext's tree (-wait-for-browser normally prevents
    // that). Any firefox.exe still running on the e2e profile is ours.
    if (profileDir) {
      const needle = profileDir.replace(/'/g, "''");
      spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: "ignore", timeout: 30_000 });
    }
    await new Promise((r) => setTimeout(r, 1500)); // let Firefox release the profile lock
    return;
  }
  const tree = collectTree(pid);
  for (const p of [...tree].reverse()) {
    try { process.kill(p, "SIGTERM"); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 4000));
  for (const p of tree) {
    try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
  }
}

/** Poll fn() until truthy or timeout. Returns the last value. */
async function pollUntil(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

function checkExpect(expect, beacons) {
  const failures = [];
  const allLogs = beacons.flatMap((b) => (Array.isArray(b.log) ? b.log : []));
  const latest = beacons[beacons.length - 1];
  if (expect.submitted === true && (!latest || latest.submitted !== "1")) failures.push("expected body[data-submitted=1] (no post)");
  if (expect.submitted === false && latest?.submitted === "1") failures.push("expected NO post, but the fixture recorded a submit");
  for (const type of expect.logIncludes ?? []) {
    if (!allLogs.some((e) => e?.type === type)) failures.push(`expected log entry type "${type}"`);
  }
  for (const type of expect.logExcludes ?? []) {
    if (allLogs.some((e) => e?.type === type)) failures.push(`forbidden log entry type "${type}" present`);
  }
  if (expect.receiptIncludes) {
    const receipts = beacons.map((b) => b.receipt ?? "").filter(Boolean).join("\n");
    if (!receipts.includes(expect.receiptIncludes)) failures.push(`receipt missing "${expect.receiptIncludes}"`);
  }
  return failures;
}

async function runScenario(file, keepTmp, basePort) {
  const scenario = JSON.parse(await readFile(file, "utf8"));
  const name = path.basename(file, ".json");
  const tmp = await mkdtemp(path.join(tmpdir(), `skills-e2e-${name}-`));
  const port = basePort + (parseInt(name, 36) % 97) * 3;
  const result = { name, file, passed: false, failures: [], beacons: 0, ms: 0, tmp };
  const started = Date.now();
  // Phase timing (stderr): where does a scenario's wall-clock go?
  const phase = (label) => {
    const ms = Date.now() - started;
    process.stderr.write(`[timing] ${name}: ${String(ms).padStart(5)}ms  ${label}\n`);
  };
  let server, host, webext, seedProfile, logStream;
  const hostLog = path.join(tmp, "host.log");
  const webextLog = path.join(tmp, "webext.log");
  try {
    server = await createFixtureServer(FIXTURES, port);
    phase("fixture server up");
    const fixtureUrl = `${server.url}/${scenario.fixture}?skills_test=1&skills_test_prompt=${encodeURIComponent(scenario.prompt ?? "")}`;
    // Materialize the resolved scenario (the fake host substitutes
    // {{page_url}} from pageUrl — which only the harness knows at runtime).
    const resolvedScenario = { ...scenario, pageUrl: fixtureUrl };
    const resolvedPath = path.join(tmp, "scenario-resolved.json");
    await writeFile(resolvedPath, JSON.stringify(resolvedScenario, null, 2));
    host = await prepareFakeHost({
      wrapperDir: tmp,
      fakeHostScript: FAKE_HOST,
      scenarioPath: resolvedPath,
      skillRoots: SKILL_ROOTS,
      dataRoot: path.join(tmp, "data"),
      brokerDir: path.join(tmp, "run"),
      hostLog,
      autoApproveTools: AUTO_APPROVE_TOOLS.join(","),
    });

    // Firefox via web-ext: the BUILT add-on loads as a TEMPORARY add-on
    // (the only release-safe install path for unsigned builds). web-ext
    // spawns and owns the Firefox process, so killing web-ext tears the
    // browser down. The profile is the persistent seed (see
    // prepareSeedProfile) so the one-time automation consent sticks.
    const ffBin = firefoxBinary();
    const webExt = webExtCommand();
    seedProfile = await prepareSeedProfile();
    phase("fake host prepared (seed profile done)");
    logStream = await open(webextLog, "a");
    // NB: NOT detached — detached children fail to open the remote-debugger
    // port on this box (verified); kill the whole tree on exit instead.
    const webExtSpawn = platformCommand(webExt.bin, [
        ...webExt.prefix,
        "run",
        "--source-dir", ADDON_DIST,
        "--firefox", ffBin,
        "--start-url", fixtureUrl,
        "--no-reload",
        "--no-input", "--verbose",
        "--firefox-profile", seedProfile,
        "--keep-profile-changes",
        "--args=--width=1400",
        "--args=--height=900",
        // Windows: keep the launcher process alive until the browser exits,
        // so the browser stays inside web-ext's process tree (killTree).
        ...(IS_WIN ? ["--args=-wait-for-browser"] : []),
    ]);
    webext = spawn(webExtSpawn.cmd, webExtSpawn.args, { cwd: tmp, stdio: ["ignore", logStream.fd, logStream.fd], ...webExtSpawn.opts });

    // Grant the optional "userScripts" permission (page evaluation) the way
    // a user's click on Firefox's prompt would — over web-ext's debugger
    // server, as soon as the temporary add-on is installed (rdp-grant.mjs
    // explains why the policies.json pre-grant no longer works).
    phase("web-ext spawned; waiting for add-on install");
    const installed = await pollUntil(
      async () => {
        const log = await readFile(webextLog, "utf8").catch(() => "");
        const port = /-start-debugger-server (\d+)/.exec(log)?.[1];
        return port && /Installed .* as a temporary add-on/.test(log) ? Number(port) : false;
      },
      HANDSHAKE_TIMEOUT_MS,
      250,
    );
    if (!installed) {
      const tail = (await readFile(webextLog, "utf8").catch(() => "")).slice(-800);
      throw new Error(`web-ext never installed the add-on (webext tail:
${tail})`);
    }
    await grantOptionalPermission({ port: installed, addonId: ADDON_ID, permission: "userScripts" });
    phase("userScripts granted; waiting for host handshake");

    // Host readiness: the real host logs "backend: mock" once the fake host
    // boots the real native-host main.js with the scripted backend. Poll the
    // PI_BROWSER_LOG_FILE the wrapper pointed at.
    const hostReady = await pollUntil(
      async () => {
        try {
          const log = await readFile(hostLog, "utf8");
          // The page opens at Firefox start (--start-url), before the add-on
          // reaches the host (~2.5s): require BOTH the mock backend up AND
          // the add-on initialize (port established), so the scenario clock
          // starts connected.
          return log.includes("backend: mock") && log.includes("initialize: client=pi-browser-firefox") ? log : false;
        } catch { return false; }
      },
      HANDSHAKE_TIMEOUT_MS,
      500,
    );
    if (!hostReady) {
      const tail = (await readFile(webextLog, "utf8").catch(() => "")) .slice(-800);
      throw new Error(`fake host never became ready (host.log: ${hostLog}; webext tail:\n${tail})`);
    }

    phase(`host ready (handshake took ${Date.now() - started}ms total)`);
    // Scenario completion: beaconed fixture state satisfies the expect block.
    const outcome = await pollUntil(
      async () => {
        const beacons = server.parsedReports();
        result.beacons = beacons.length;
        const failures = checkExpect(scenario.expect ?? {}, beacons);
        // Require at least one post-state beacon so "submitted:false" is not
        // vacuously true before the page loaded.
        const settled = beacons.some((b) => b.url && Array.isArray(b.log) && b.log.length > 0);
        if (settled && failures.length === 0) return { beacons, failures };
        return false;
      },
      SCENARIO_TIMEOUT_MS,
      500,
    );
    phase(`scenario settled after ${Date.now() - started}ms total`);
    if (!outcome) {
      const beacons = server.parsedReports();
      result.failures = checkExpect(scenario.expect ?? {}, beacons);
      if (!result.failures.length) result.failures.push("scenario timed out before any beacon settled");
    } else {
      result.failures = outcome.failures;
    }
    // Keep the beacon payloads on the report so a failure is diagnosable
    // without a re-run (driver steps, fixture log, gate state).
    result.beaconDetail = server.parsedReports().slice(-3);
    result.passed = result.failures.length === 0;
  } catch (err) {
    result.failures = [String(err?.message ?? err)];
  } finally {
    result.ms = Date.now() - started;
    if (webext) await killTree(webext.pid, seedProfile); // web-ext has no SIGTERM handler
    // Node 26 makes a GC-closed FileHandle a fatal ERR_INVALID_STATE.
    await logStream?.close().catch(() => {});
    await host?.cleanup().catch(() => {}); // restore the user's manifest
    server?.close().catch(() => {});
    if (!keepTmp) await rm(tmp, { recursive: true, force: true });
    else result.tmpKept = tmp;
  }
  return result;
}

const argv = process.argv.slice(2);
const list = argv.includes("--list");
const keepTmp = argv.includes("--keep-tmp");
const names = argv.filter((a) => !a.startsWith("--"));
const all = (await readdir(SCENARIOS).then((f) => f.filter((f) => f.endsWith(".json")).sort()));
if (list) {
  for (const f of all) {
    const s = JSON.parse(await readFile(path.join(SCENARIOS, f), "utf8"));
    console.log(`${path.basename(f, ".json").padEnd(24)} ${s.fixture ?? "-"}  ${s.note ?? ""}`);
  }
  process.exit(0);
}
const selected = names.length ? names.map((n) => (all.includes(`${n}.json`) ? `${n}.json` : n)) : all;

await ensureBuilt();
const basePort = 46_000 + (Date.now() % 500);
const results = [];
for (const file of selected) {
  process.stderr.write(`[run] ${path.basename(file)}\n`);
  results.push(await runScenario(path.join(SCENARIOS, file), keepTmp, basePort));
}

const report = { matrix: "skills-e2e", at: new Date().toISOString(), results };
console.log(JSON.stringify(report, null, 1));
const failed = results.filter((r) => !r.passed);
process.stderr.write(`[run] ${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
