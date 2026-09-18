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
  if (!(await exists(AGENT_HOST))) needed.push("@pi-browser/agent");
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
    const res = spawnSync("npm", ["run", "build", "-w", workspace], { cwd: REPO, stdio: "inherit" });
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
    const which = spawnSync("which", [name], { encoding: "utf8" });
    const found = (which.stdout || "").trim().split("\n")[0];
    if (found) candidates.push(found);
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

function webExtBinary() {
  const candidates = [];
  if (process.env.SKILLS_E2E_WEBEXT) candidates.push(process.env.SKILLS_E2E_WEBEXT);
  const which = spawnSync("which", ["web-ext"], { encoding: "utf8" });
  const found = (which.stdout || "").trim().split("\n")[0];
  if (found) candidates.push(found);
  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
      if (res.status === 0 && /web-ext/i.test(res.stdout ?? "")) return bin;
    } catch { /* try next */ }
  }
  const nvm = path.join(homedir(), ".nvm", "versions", "node");
  try {
    for (const v of readdirSync(nvm).sort().reverse()) {
      const bin = path.join(nvm, v, "bin", "web-ext");
      if (existsSync(bin)) return bin;
    }
  } catch { /* no nvm */ }
  throw new Error("web-ext not found (set SKILLS_E2E_WEBEXT)");
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
 * needs a user-clicked browser prompt (firefox/src/page-evaluation-permission.ts:
 * "A sidebar response alone cannot grant a browser permission"). Firefox 155
 * gives temp add-ons no other grant path (extension-preferences.json grants
 * are ignored for them, verified), so the harness pre-grants the permission
 * the only way that works: a PROFILE-SCOPE enterprise policy
 * (policies/policies.json, ExtensionSettings.permissions — verified in
 * /tmp/probe-addon against the real 155.0.1 build: permissions.contains
 * flips to true and userScripts.execute works).
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

  // Pre-grant the optional "userScripts" permission (see above).
  const policyDir = path.join(seed, "policies");
  await mkdir(policyDir, { recursive: true });
  await writeFile(
    path.join(policyDir, "policies.json"),
    JSON.stringify(
      {
        policies: {
          ExtensionSettings: {
            [ADDON_ID]: {
              installation_state: "allowed",
              active: true,
              permissions: ["userScripts"],
            },
          },
        },
      },
      null,
      2,
    ),
  );
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

async function killTree(pid) {
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
  let server, host, webext;
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
    const webExt = webExtBinary();
    const seedProfile = await prepareSeedProfile();
    phase("fake host prepared (seed profile done)");
    const logStream = await open(webextLog, "a");
    // NB: NOT detached — detached children fail to open the remote-debugger
    // port on this box (verified); kill the whole tree on exit instead.
    webext = spawn(
      webExt,
      [
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
      ],
      { cwd: tmp, stdio: ["ignore", logStream.fd, logStream.fd] },
    );

    // Host readiness: the real host logs "backend: mock" once the fake host
    // boots the real native-host main.js with the scripted backend. Poll the
    // PI_BROWSER_LOG_FILE the wrapper pointed at.
    phase("web-ext spawned; waiting for host handshake");
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
    if (webext) await killTree(webext.pid); // web-ext has no SIGTERM handler
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
