/**
 * Mock (fake-host) native-messaging registration management.
 *
 * The skills e2e matrix swaps the GLOBAL com.matbee.agent native-messaging
 * manifest (~/.mozilla/native-messaging-hosts) to a fake host (real
 * dist/native-host/main.js + scripted mock backend). Because that manifest
 * is shared with the user's real installation, every swap MUST be
 * crash-safe: the real manifest is persisted to `<manifest>.real` BEFORE
 * the mock is written, and `restore` puts it back from disk — an
 * interrupted run can therefore never leave the real registration lost
 * (the failure mode this module replaces: in-memory backup only).
 *
 * CLI:
 *   node tests/skills-e2e/mock-host.mjs install
 *     [--scenario <json>]   scenario for the scripted mock model (optional
 *                           with --stub; required by the fake host itself
 *                           unless PI_BROWSER_FAKE_HOST_STUB is set)
 *     [--skill-roots <a>:<b>]
 *     [--data-root <dir>] [--broker-dir <dir>] [--host-log <file>]
 *     [--auto-approve]      auto-approve gated browser tools (no sidebar UI)
 *     [--stub]              register a plain mock stub (no scenario)
 *   node tests/skills-e2e/mock-host.mjs status
 *   node tests/skills-e2e/mock-host.mjs restore
 *
 * Invariants:
 *   - a mock manifest is recognizable by its description (MOCK_MARKER);
 *   - the `.real` backup is only ever written from a NON-mock manifest;
 *   - `restore` is idempotent and never deletes the backup it restores from
 *     until the copy is confirmed.
 */
import { chmod, copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOST_NAME = "com.matbee.agent";
export const ADDON_ID = "pi-agent-firefox@matbee.com";
/** Description field that identifies a mock manifest (never a real one). */
export const MOCK_MARKER = "Skills e2e fake host (scripted Pi backend)";

const IS_WIN = process.platform === "win32";

/**
 * Windows: Firefox resolves native hosts through the registry
 * (HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\<name> -> manifest path),
 * not a well-known directory. The swap there is a REGISTRY swap: the mock
 * manifest lives in a harness-owned dir, the key is pointed at it, and the
 * backup records the previous key value (the real manifest file itself is
 * never touched).
 */
export const WIN_REGISTRY_KEY = `HKCU\\SOFTWARE\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;

function winHarnessDir() {
  return path.join(homedir(), ".cache", "skills-e2e", "native-host");
}

/** Current registry value (manifest path) or null when the key is absent. */
export function readRegistryManifestPath() {
  try {
    const out = execFileSync("reg", ["query", WIN_REGISTRY_KEY, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = out.split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
    const value = line?.split(/REG_SZ/i)[1]?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeRegistryManifestPath(value) {
  execFileSync("reg", ["add", WIN_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
}

function deleteRegistryKey() {
  try {
    execFileSync("reg", ["delete", WIN_REGISTRY_KEY, "/f"], { stdio: "ignore" });
  } catch { /* already absent */ }
}

export function globalHostsDir() {
  return IS_WIN ? winHarnessDir() : path.join(homedir(), ".mozilla", "native-messaging-hosts");
}

/** Where the MOCK manifest is written (Windows: harness dir + registry). */
export function mockManifestPath() {
  return path.join(globalHostsDir(), `${HOST_NAME}.json`);
}

/** Linux/macOS: copy of the real manifest. Windows: {registryValue} JSON. */
export function mockBackupPath() {
  return IS_WIN ? path.join(winHarnessDir(), "registry.real.json") : `${mockManifestPath()}.real`;
}

/** The manifest Firefox would load right now (Windows: via the registry). */
function activeManifestPath() {
  return IS_WIN ? readRegistryManifestPath() : mockManifestPath();
}

export async function readMockManifest() {
  const file = activeManifestPath();
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Native-messaging manifests carry no env field: a launcher script sets it. */
async function writeWrapper(wrapperDir, env, fakeHostScript) {
  if (IS_WIN) {
    const wrapper = path.join(wrapperDir, "fake-host-wrapper.cmd");
    const lines = ["@echo off", "rem e2e fake-host wrapper: native manifests carry no env field."];
    for (const [k, v] of Object.entries(env)) lines.push(`set "${k}=${v}"`);
    lines.push(`"${process.execPath}" "${fakeHostScript}" %*`, "");
    await writeFile(wrapper, lines.join("\r\n"));
    return wrapper;
  }
  const wrapper = path.join(wrapperDir, "fake-host-wrapper.sh");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      "# e2e fake-host wrapper: native manifests carry no env field.",
      ...Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeHostScript)} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(wrapper, 0o755);
  return wrapper;
}

export function isMockManifest(manifest) {
  return Boolean(manifest) && manifest.description === MOCK_MARKER;
}

/**
 * Install the mock registration. Backs up the current REAL manifest to
 * `<manifest>.real` first (persistent, so an interrupted run stays
 * restorable). Re-installing over an existing mock only refreshes the
 * wrapper; the real backup is never clobbered.
 */
export async function installMockHost({
  wrapperDir,
  fakeHostScript,
  scenarioPath,
  skillRoots,
  dataRoot,
  brokerDir,
  hostLog,
  autoApproveTools,
  stub = false,
} = {}) {
  if (!wrapperDir || !fakeHostScript) throw new Error("wrapperDir and fakeHostScript are required");
  const env = {
    ...(scenarioPath ? { FAKE_HOST_SCENARIO: scenarioPath } : {}),
    ...(skillRoots ? { PI_BROWSER_SKILL_ROOTS: skillRoots } : {}),
    ...(dataRoot ? { PI_BROWSER_DATA_ROOT: dataRoot } : {}),
    ...(brokerDir ? { PI_BROWSER_BROKER_DIR: brokerDir } : {}),
    ...(hostLog ? { PI_BROWSER_LOG_FILE: hostLog } : {}),
    // Test-only approval seam (host browser/provider.ts): the e2e runs
    // have no sidebar UI to click, so gated browser tools are
    // auto-approved by the host instead of prompting a user.
    ...(autoApproveTools ? { PI_BROWSER_AUTO_APPROVE: autoApproveTools } : {}),
    // Log the full request/response of every scripted browser tool call to
    // host.log (test seam; see host browser/provider.ts logToolIo).
    ...(hostLog ? { PI_BROWSER_LOG_TOOL_IO: "1" } : {}),
    ...(stub ? { PI_BROWSER_FAKE_HOST_STUB: "1" } : {}),
  };
  const wrapper = await writeWrapper(wrapperDir, env, fakeHostScript);

  const hostsDir = globalHostsDir();
  await mkdir(hostsDir, { recursive: true });
  const manifestPath = mockManifestPath();
  const backupPath = mockBackupPath();
  const current = await readMockManifest();

  let backedUp = false;
  if (!isMockManifest(current) && !existsSync(backupPath)) {
    // Persist the REAL registration before the swap (crash-safety).
    if (IS_WIN) {
      const registryValue = readRegistryManifestPath();
      if (registryValue) await writeFile(backupPath, JSON.stringify({ registryValue }, null, 2) + "\n");
      backedUp = Boolean(registryValue);
    } else {
      if (current) await writeFile(backupPath, JSON.stringify(current, null, 2) + "\n");
      else await rm(backupPath, { force: true });
      backedUp = Boolean(current);
    }
  }
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: MOCK_MARKER,
        path: wrapper,
        type: "stdio",
        allowed_extensions: [ADDON_ID],
      },
      null,
      2,
    ),
  );
  if (IS_WIN) writeRegistryManifestPath(manifestPath);
  return { wrapper, manifestPath, backupPath, backedUp, hadReal: Boolean(current) };
}

/**
 * Restore the real registration. From the `.real` backup when present;
 * otherwise (backup missing, e.g. pre-module interruptions) fall back to
 * the canonical installer, and as a last resort remove the mock manifest
 * so Firefox reports "no host" instead of a dead stub.
 */
/**
 * @param {object} [opts]
 * @param {"installer"|"remove"} [opts.fallback="installer"] behavior when the
 *   mock is active but no `.real` backup exists: run the canonical installer
 *   (CLI default) or remove the manifest entirely (harness: restores the
 *   "user had no host" state).
 */
export async function restoreRealHost({ fallback = "installer" } = {}) {
  const manifestPath = mockManifestPath();
  const backupPath = mockBackupPath();
  const current = await readMockManifest();
  if (!isMockManifest(current)) return { state: "already-real" };

  if (existsSync(backupPath)) {
    if (IS_WIN) {
      const { registryValue } = JSON.parse(await readFile(backupPath, "utf8"));
      writeRegistryManifestPath(registryValue);
      await rm(backupPath);
      await rm(manifestPath, { force: true });
      return { state: "restored-from-backup", registry: registryValue };
    }
    await copyFile(backupPath, manifestPath);
    await rm(backupPath);
    return { state: "restored-from-backup", manifestPath };
  }

  if (fallback === "remove") {
    if (IS_WIN) deleteRegistryKey();
    await rm(manifestPath, { force: true });
    return { state: "removed-no-real-backup", manifestPath };
  }

  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/trusted-user-agent/dist/installer/cli.js");
  if (existsSync(cli)) {
    execFileSync(process.execPath, [cli, "install"], { stdio: "pipe" });
    return { state: "reinstalled-via-installer", manifestPath };
  }
  if (IS_WIN) deleteRegistryKey();
  await rm(manifestPath, { force: true });
  return { state: "removed-no-real-backup", hint: `run: node packages/trusted-user-agent/dist/installer/cli.js install` };
}

/** Report the registration state (JSON). */
export async function mockHostStatus() {
  const manifest = await readMockManifest();
  return {
    manifestPath: activeManifestPath() ?? mockManifestPath(),
    ...(IS_WIN ? { registryKey: WIN_REGISTRY_KEY } : {}),
    state: manifest === null ? "absent" : isMockManifest(manifest) ? "mock" : "real",
    ...(manifest?.path ? { path: manifest.path } : {}),
    backup: existsSync(mockBackupPath()) ? mockBackupPath() : null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , cmd, ...rest] = process.argv;
  const flag = (name, fallback = undefined) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : fallback;
  };
  const has = (name) => rest.includes(name);

  const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const DEFAULT_FAKE_HOST = path.join(REPO_ROOT, "packages/trusted-user-agent/test/skills-host/fake-host.mjs");

  if (cmd === "status") {
    console.log(JSON.stringify(await mockHostStatus(), null, 2));
  } else if (cmd === "install") {
    const wrapperDir = path.join(tmpdir(), `skills-mock-${Date.now()}`);
    await mkdir(wrapperDir, { recursive: true });
    const result = await installMockHost({
      wrapperDir,
      fakeHostScript: DEFAULT_FAKE_HOST,
      scenarioPath: flag("--scenario"),
      skillRoots: flag("--skill-roots"),
      dataRoot: flag("--data-root"),
      brokerDir: flag("--broker-dir"),
      hostLog: flag("--host-log"),
      autoApproveTools: has("--auto-approve"),
      stub: has("--stub"),
    });
    console.log(JSON.stringify(result, null, 2));
    console.log("restore with: node tests/skills-e2e/mock-host.mjs restore");
  } else if (cmd === "restore") {
    console.log(JSON.stringify(await restoreRealHost(), null, 2));
  } else {
    console.error("usage: mock-host.mjs [install [--scenario <json>] [--stub] [opts] | status | restore]");
    process.exit(2);
  }
}
