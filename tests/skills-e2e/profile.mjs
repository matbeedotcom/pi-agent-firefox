/**
 * Fake-host preparation for the skills e2e matrix (tests/skills-e2e/run.mjs).
 *
 * Registers packages/pi-agent/test/skills-host/fake-host.mjs as the
 * com.matbee.agent native-messaging host for ONE scenario run, using the
 * GLOBAL manifest dir (~/.mozilla/native-messaging-hosts) — the production
 * install path, visible to every profile including web-ext's managed one.
 *
 * The user's existing manifest (if any) is backed up to
 * `<manifest>.real` on DISK before the swap and restored from disk on
 * cleanup() — a run that crashes mid-way leaves the real registration
 * recoverable via `node tests/skills-e2e/mock-host.mjs restore` (the
 * earlier in-memory-only backup was lost by one interrupted run).
 *
 * The wrapper script exists because native-messaging manifests carry no
 * env field; the fake host needs FAKE_HOST_SCENARIO + PI_BROWSER_* envs.
 */
import { installMockHost, restoreRealHost } from "./mock-host.mjs";
import path from "node:path";

export const HOST_NAME = "com.matbee.agent";
export const ADDON_ID = "pi-agent-firefox@matbee.com";

export async function prepareFakeHost({ wrapperDir, fakeHostScript, scenarioPath, skillRoots, dataRoot, brokerDir, hostLog, autoApproveTools }) {
  const installed = await installMockHost({
    wrapperDir,
    fakeHostScript,
    scenarioPath,
    skillRoots,
    dataRoot,
    brokerDir,
    hostLog,
    autoApproveTools,
  });

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    // "remove": no backup ⇔ the user had no host registration before the
    // run — restore exactly that state (never install one on their behalf).
    await restoreRealHost({ fallback: "remove" });
  };

  return { wrapper: installed.wrapper, manifestPath: installed.manifestPath, cleanup };
}
