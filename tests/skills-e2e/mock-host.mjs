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
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.matbee.agent";
export const ADDON_ID = "pi-agent-firefox@matbee.com";
/** Description field that identifies a mock manifest (never a real one). */
export const MOCK_MARKER = "Skills e2e fake host (scripted Pi backend)";

export function globalHostsDir() {
  return path.join(homedir(), ".mozilla", "native-messaging-hosts");
}

export function mockManifestPath() {
  return path.join(globalHostsDir(), `${HOST_NAME}.json`);
}

export function mockBackupPath() {
  return `${mockManifestPath()}.real`;
}

export async function readMockManifest() {
  try {
    return JSON.parse(await readFile(mockManifestPath(), "utf8"));
  } catch {
    return null;
  }
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
  const wrapper = path.join(wrapperDir, "fake-host-wrapper.sh");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      "# e2e fake-host wrapper: native manifests carry no env field.",
      ...(scenarioPath ? [`export FAKE_HOST_SCENARIO=${JSON.stringify(scenarioPath)}`] : []),
      ...(skillRoots ? [`export PI_BROWSER_SKILL_ROOTS=${JSON.stringify(skillRoots)}`] : []),
      ...(dataRoot ? [`export PI_BROWSER_DATA_ROOT=${JSON.stringify(dataRoot)}`] : []),
      ...(brokerDir ? [`export PI_BROWSER_BROKER_DIR=${JSON.stringify(brokerDir)}`] : []),
      ...(hostLog ? [`export PI_BROWSER_LOG_FILE=${JSON.stringify(hostLog)}`] : []),
      // Test-only approval seam (host browser/provider.ts): the e2e runs
      // have no sidebar UI to click, so gated browser tools are
      // auto-approved by the host instead of prompting a user.
      ...(autoApproveTools ? [`export PI_BROWSER_AUTO_APPROVE=${JSON.stringify(autoApproveTools)}`] : []),
      // Log the full request/response of every scripted browser tool call to
      // host.log (test seam; see host browser/provider.ts logToolIo).
      ...(hostLog ? [`export PI_BROWSER_LOG_TOOL_IO=${JSON.stringify("1")}`] : []),
      ...(stub ? ["export PI_BROWSER_FAKE_HOST_STUB=1"] : []),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeHostScript)} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(wrapper, 0o755);

  const hostsDir = globalHostsDir();
  await mkdir(hostsDir, { recursive: true });
  const manifestPath = mockManifestPath();
  const backupPath = mockBackupPath();
  const current = await readMockManifest();

  let backedUp = false;
  if (!isMockManifest(current) && !existsSync(backupPath)) {
    // Persist the REAL manifest before the swap (crash-safety).
    if (current) await writeFile(backupPath, JSON.stringify(current, null, 2) + "\n");
    else await rm(backupPath, { force: true });
    backedUp = Boolean(current);
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
    await copyFile(backupPath, manifestPath);
    await rm(backupPath);
    return { state: "restored-from-backup", manifestPath };
  }

  if (fallback === "remove") {
    await rm(manifestPath, { force: true });
    return { state: "removed-no-real-backup", manifestPath };
  }

  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/pi-agent/dist/installer/cli.js");
  if (existsSync(cli)) {
    execFileSync(process.execPath, [cli, "install"], { stdio: "pipe" });
    return { state: "reinstalled-via-installer", manifestPath };
  }
  await rm(manifestPath, { force: true });
  return { state: "removed-no-real-backup", hint: `run: node packages/pi-agent/dist/installer/cli.js install` };
}

/** Report the registration state (JSON). */
export async function mockHostStatus() {
  const manifest = await readMockManifest();
  return {
    manifestPath: mockManifestPath(),
    state: manifest === null ? "absent" : isMockManifest(manifest) ? "mock" : "real",
    ...(manifest?.path ? { path: manifest.path } : {}),
    backup: existsSync(mockBackupPath()) ? mockBackupPath() : null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , cmd, ...rest] = process.argv;
  const flag = (name, fallback = undefined) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : fallback;
  };
  const has = (name) => rest.includes(name);

  const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const DEFAULT_FAKE_HOST = path.join(REPO_ROOT, "packages/pi-agent/test/skills-host/fake-host.mjs");

  if (cmd === "status") {
    console.log(JSON.stringify(await mockHostStatus(), null, 2));
  } else if (cmd === "install") {
    const tmpdir = path.join("/tmp", `skills-mock-${Date.now()}`);
    await mkdir(tmpdir, { recursive: true });
    const result = await installMockHost({
      wrapperDir: tmpdir,
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
    console.log("restore with: npm run skills:mock:restore");
  } else if (cmd === "restore") {
    console.log(JSON.stringify(await restoreRealHost(), null, 2));
  } else {
    console.error("usage: mock-host.mjs [install [--scenario <json>] [--stub] [opts] | status | restore]");
    process.exit(2);
  }
}
