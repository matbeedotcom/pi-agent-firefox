/**
 * Fake-host preparation for the skills e2e matrix (tests/skills-e2e/run.mjs).
 *
 * Registers packages/pi-agent/test/skills-host/fake-host.mjs as the
 * com.matbee.agent native-messaging host for ONE scenario run, using the
 * GLOBAL manifest dir (~/.mozilla/native-messaging-hosts) — the production
 * install path, visible to every profile including web-ext's managed one.
 *
 * The user's existing manifest (if any) is backed up and restored on
 * cleanup(); a run that crashes mid-way leaves at most a stale manifest
 * pointing at a dead wrapper (harmless: the next installer overwrites it,
 * and Firefox rejects hosts whose binary is gone).
 *
 * The wrapper script exists because native-messaging manifests carry no
 * env field; the fake host needs FAKE_HOST_SCENARIO + PI_BROWSER_* envs.
 */
import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const HOST_NAME = "com.matbee.agent";
export const ADDON_ID = "pi-agent-firefox@matbee.com";

export function globalHostsDir() {
  return path.join(homedir(), ".mozilla", "native-messaging-hosts");
}

export async function prepareFakeHost({ wrapperDir, fakeHostScript, scenarioPath, skillRoots, dataRoot, brokerDir, hostLog, autoApproveTools }) {
  const wrapper = path.join(wrapperDir, "fake-host-wrapper.sh");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      "# e2e fake-host wrapper: native manifests carry no env field.",
      `export FAKE_HOST_SCENARIO=${JSON.stringify(scenarioPath)}`,
      `export PI_BROWSER_SKILL_ROOTS=${JSON.stringify(skillRoots)}`,
      `export PI_BROWSER_DATA_ROOT=${JSON.stringify(dataRoot)}`,
      `export PI_BROWSER_BROKER_DIR=${JSON.stringify(brokerDir)}`,
      `export PI_BROWSER_LOG_FILE=${JSON.stringify(hostLog)}`,
      // Test-only approval seam (host browser/provider.ts): the e2e runs
      // have no sidebar UI to click, so gated browser tools are
      // auto-approved by the host instead of prompting a user.
      `export PI_BROWSER_AUTO_APPROVE=${JSON.stringify(autoApproveTools)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeHostScript)} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(wrapper, 0o755);

  const hostsDir = globalHostsDir();
  await mkdir(hostsDir, { recursive: true });
  const manifestPath = path.join(hostsDir, `${HOST_NAME}.json`);
  const hadExisting = existsSync(manifestPath);
  const backup = hadExisting ? await readFile(manifestPath, "utf8") : null;
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "Skills e2e fake host (scripted Pi backend)",
        path: wrapper,
        type: "stdio",
        allowed_extensions: [ADDON_ID],
      },
      null,
      2,
    ),
  );

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (backup !== null) await writeFile(manifestPath, backup);
    else await rm(manifestPath, { force: true });
  };

  return { wrapper, manifestPath, cleanup };
}
