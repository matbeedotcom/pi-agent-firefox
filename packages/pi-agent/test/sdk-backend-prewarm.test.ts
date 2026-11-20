/**
 * Workspace prewarm on the real pi SDK backend.
 *
 * Building a session's services loads every pi extension the user has
 * installed — ~8 s with a real package set, all of it blocking the event
 * loop. The backend prewarms ONE fresh workspace shortly after the first
 * client initializes, so the first "new workspace" session starts instantly.
 * These tests pin the contract with an empty, isolated pi config (fast).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/logger.js";

const quiet = createLogger({ level: "error", stderr: { write: () => true } });
let tmp: string;
let PiSdkBackend: typeof import("../src/acp/sdk-backend.js").PiSdkBackend;
const savedEnv = { ...process.env };

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "pi-prewarm-test-"));
  // Isolated pi config + session store: never the developer's real ~/.pi.
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmp, "sessions");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  ({ PiSdkBackend } = await import("../src/acp/sdk-backend.js"));
});

after(() => {
  process.env = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

function workspaceFactory(counter: { n: number }) {
  return async () => {
    counter.n++;
    const dir = path.join(tmp, "workspaces", `ws-${counter.n}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
}

async function waitFor<T>(fn: () => T | undefined, ms = 60_000): Promise<T | undefined> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined || Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("prewarm: builds one workspace once; it is claimed exactly once and opens a session", async () => {
  delete process.env.PI_BROWSER_PREWARM;
  const backend = new PiSdkBackend({ log: quiet, agentDir: process.env.PI_CODING_AGENT_DIR });
  try {
    await backend.ready;
    assert.equal(backend.takePrewarmedWorkspace(), undefined, "nothing to claim before a prewarm");

    const counter = { n: 0 };
    backend.prewarmWorkspace(workspaceFactory(counter));
    backend.prewarmWorkspace(workspaceFactory(counter)); // repeats are ignored (once per host)

    const cwd = await waitFor(() => backend.takePrewarmedWorkspace());
    assert.ok(cwd, "the prewarmed workspace becomes claimable once its services are built");
    assert.equal(counter.n, 1, "exactly one workspace directory was provisioned");
    assert.equal(backend.takePrewarmedWorkspace(), undefined, "a prewarmed workspace is handed out only once");

    const session = await backend.createSession({ cwd: cwd! });
    assert.equal(session.cwd, cwd, "the session runs in the prewarmed workspace");
  } finally {
    backend.dispose();
  }
});

test("prewarm: PI_BROWSER_PREWARM=0 disables it", async () => {
  process.env.PI_BROWSER_PREWARM = "0";
  const backend = new PiSdkBackend({ log: quiet, agentDir: process.env.PI_CODING_AGENT_DIR });
  try {
    await backend.ready;
    const counter = { n: 0 };
    backend.prewarmWorkspace(workspaceFactory(counter));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(counter.n, 0, "no workspace provisioned");
    assert.equal(backend.takePrewarmedWorkspace(), undefined);
  } finally {
    delete process.env.PI_BROWSER_PREWARM;
    backend.dispose();
  }
});
