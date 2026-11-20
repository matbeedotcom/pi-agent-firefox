// `pi install git:...` runs `npm install --omit=dev --legacy-peer-deps` in the
// cloned repo. --legacy-peer-deps never installs peer dependencies, so a
// runtime package that is in the lockfile ONLY as a peer is missing after a
// real pi install, even though every dev checkout has it. v0.2.0 shipped
// that way: zod (a peer of @agentclientprotocol/sdk) was absent, and both pi
// extensions failed to load with "Cannot find module 'zod/v4'".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));

test("pi install: no runtime package is present only as a peer dependency", () => {
  const peerOnly = Object.entries(lock.packages)
    .filter(([key, entry]) => key.includes("node_modules/") && entry.peer === true && entry.dev !== true)
    .map(([key, entry]) => `${key.slice(key.lastIndexOf("node_modules/") + 13)}@${entry.version}`);
  assert.deepEqual(
    peerOnly,
    [],
    `pi installs with --legacy-peer-deps, which skips these: ${peerOnly.join(", ")}. ` +
      "Declare each as a direct dependency of the workspace that needs it.",
  );
});
