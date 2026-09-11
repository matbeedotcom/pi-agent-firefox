import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCommand, type InstallerCommand } from "../src/installer/index.js";
import type { ExecResult } from "../src/installer/common.js";

/**
 * Cross-platform installer tests. Linux and macOS run against real temp
 * directories; Windows uses a mocked `reg` exec capturing commands and a
 * simulated registry state.
 */

async function makePkg(root: string): Promise<string> {
  const pkgRoot = path.join(root, "pkg");
  await mkdir(path.join(pkgRoot, "dist", "native-host"), { recursive: true });
  await writeFile(path.join(pkgRoot, "dist", "native-host", "main.js"), "console.log('host');\n");
  await writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@pi-browser/agent", version: "0.1.0" }));
  return pkgRoot;
}

interface FakeReg {
  state: Map<string, string>;
  calls: Array<{ cmd: string; args: string[] }>;
}

function fakeReg() {
  const state = new Map<string, string>();
  const calls: FakeReg["calls"] = [];
  return {
    state,
    calls,
    exec: async (cmd: string, args: string[]): Promise<ExecResult> => {
      calls.push({ cmd, args });
      if (cmd !== "reg") return { code: 1, stdout: "", stderr: `unexpected cmd ${cmd}` };
      if (args[0] === "add") {
        const key = args[1]!;
        const dIdx = args.indexOf("/d");
        const value = dIdx >= 0 ? args[dIdx + 1]! : "";
        state.set(key, value);
        return { code: 0, stdout: "The operation completed successfully.", stderr: "" };
      }
      if (args[0] === "query") {
        const key = args[1]!;
        if (!state.has(key)) return { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key" };
        return { code: 0, stdout: `HKEY_CURRENT_USER\\${key}\n    (Default)    REG_SZ    ${state.get(key)}\n`, stderr: "" };
      }
      if (args[0] === "delete") {
        const key = args[1]!;
        state.delete(key);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unknown reg verb ${args[0]}` };
    },
  };
}

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: install -> status -> repair -> uninstall lifecycle`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `pi-browser-${platform}-`));
    try {
      const pkgRoot = await makePkg(root);
      const home = path.join(root, "home");
      const ctx = { pkgRoot, platform, homeDir: home };

      // 1. status before install
      const before = await runCommand("status", ctx);
      assert.equal(before.ok, false);

      // 2. install
      const install = await runCommand("install", ctx);
      assert.equal(install.ok, true);
      const manifestPath =
        platform === "linux"
          ? path.join(home, ".mozilla/native-messaging-hosts/dev.pi.browser.json")
          : path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/dev.pi.browser.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name: string;
        path: string;
        type: string;
        allowed_extensions: string[];
      };
      assert.equal(manifest.name, "dev.pi.browser");
      assert.equal(manifest.type, "stdio");
      assert.deepEqual(manifest.allowed_extensions, ["pi-browser@pi.dev"]);
      assert.ok(manifest.path.endsWith("native/pi-browser-host"));
      const launcher = await readFile(manifest.path, "utf8");
      assert.ok(launcher.startsWith("#!/bin/sh"));
      assert.ok(
        launcher.includes(path.join(pkgRoot, "dist", "native-host", "main.js")),
        `launcher should point at the built host:\n${launcher}`,
      );
      // launcher is executable
      const { stat } = await import("node:fs/promises");
      const st = await stat(manifest.path);
      assert.ok(st.mode & 0o100, "launcher should be executable");

      // 3. status after install (fresh temp home -> no add-on heartbeat yet)
      const after = await runCommand("status", ctx);
      assert.equal(after.ok, true);
      assert.ok(
        after.lines.some((l) => l.includes("status: HOST OK — add-on not detected")),
        `host-ok + add-on detection line: ${JSON.stringify(after.lines)}`,
      );

      // 4. package moved -> stale path detected
      const movedRoot = await makePkg(path.join(root, "moved"));
      const stale = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
      assert.equal(stale.ok, false);
      assert.ok(stale.lines.some((l) => l.includes("stale launcher path")));

      // 5. repair (reinstall from the moved location)
      const repair = await runCommand("install", { ...ctx, pkgRoot: movedRoot });
      assert.equal(repair.ok, true);
      const manifest2 = JSON.parse(await readFile(manifestPath, "utf8")) as { path: string };
      assert.ok(manifest2.path.startsWith(movedRoot));
      const healed = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
      assert.equal(healed.ok, true);

      // 6. uninstall
      const uninstall = await runCommand("uninstall", { ...ctx, pkgRoot: movedRoot });
      assert.equal(uninstall.ok, true);
      let gone = true;
      try {
        await stat2(manifestPath);
      } catch {
        gone = true;
      }
      assert.ok(gone);
      const finalStatus = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
      assert.equal(finalStatus.ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function stat2(p: string) {
  const { stat } = await import("node:fs/promises");
  return stat(p);
}

test("windows: registry-based install/status/uninstall (mocked reg)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-win-"));
  try {
    const pkgRoot = await makePkg(root);
    const reg = fakeReg();
    const ctx = {
      pkgRoot,
      platform: "win32" as const,
      homeDir: path.join(root, "home"),
      exec: reg.exec,
    };

    const before = await runCommand("status", ctx);
    assert.equal(before.ok, false);

    const install = await runCommand("install", ctx);
    assert.equal(install.ok, true);
    // reg add called with the manifest path
    const addCall = reg.calls.find((c) => c.args[0] === "add");
    assert.ok(addCall);
    assert.ok(addCall.args.includes("HKCU\\SOFTWARE\\Mozilla\\NativeMessagingHosts\\dev.pi.browser"));
    // manifest file written inside the package
    const manifestFile = path.join(pkgRoot, "native", "dev_pi_browser.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { path: string; allowed_extensions: string[] };
    assert.ok(manifest.path.endsWith("pi-browser-host.cmd"));
    const launcher = await readFile(manifest.path, "utf8");
    assert.ok(launcher.startsWith("@echo off"));
    assert.ok(manifest.allowed_extensions.includes("pi-browser@pi.dev"));

    const after = await runCommand("status", ctx);
    assert.equal(after.ok, true);

    const uninstall = await runCommand("uninstall", ctx);
    assert.equal(uninstall.ok, true);
    assert.ok(reg.calls.some((c) => c.args[0] === "delete"));
    const finalStatus = await runCommand("status", ctx);
    assert.equal(finalStatus.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status reports add-on auto-detection via heartbeat (missing / fresh / stale)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-install-addon-"));
  try {
    const pkgRoot = await makePkg(root);
    const home = path.join(root, "home");
    const ctx = { pkgRoot, platform: "linux" as const, homeDir: home };
    const install = await runCommand("install", ctx);
    assert.ok(install.ok);
    assert.ok(
      install.lines.some((l) => l.includes("auto-detects the host within ~10s")),
      `install hint mentions auto-detection: ${JSON.stringify(install.lines)}`,
    );
    assert.ok(
      install.lines.some((l) => l.includes("firefox/dist/manifest.json") && l.includes("about:debugging")),
      `install next-steps point at the loadable dist manifest: ${JSON.stringify(install.lines)}`,
    );

    // Host installed, add-on not yet seen -> step-by-step onboarding guide.
    let status = await runCommand("status", ctx);
    assert.ok(status.lines.some((l) => l.includes("add-on: not detected")), `missing heartbeat -> not detected: ${JSON.stringify(status.lines)}`);
    assert.ok(status.lines.some((l) => l.includes("HOST OK — add-on not detected")));
    assert.ok(status.lines.some((l) => l.includes("npm run build -w @pi-browser/firefox")), `step 1 build: ${JSON.stringify(status.lines)}`);
    assert.ok(status.lines.some((l) => l.includes("about:debugging") && l.includes("firefox/dist/manifest.json")), `step 2 load temp add-on: ${JSON.stringify(status.lines)}`);
    assert.ok(status.lines.some((l) => l.includes("auto-connects") && l.includes("/pi-browser status")), `step 3 proceed: ${JSON.stringify(status.lines)}`);

    // A fresh add-on heartbeat flips status to connected.
    const hbDir = path.join(home, ".pi-browser");
    await mkdir(hbDir, { recursive: true });
    await writeFile(path.join(hbDir, "client.heartbeat"), JSON.stringify({ ts: Date.now(), client: "pi-browser-firefox", version: "0.1.0", pid: 1 }));
    status = await runCommand("status", ctx);
    assert.ok(status.lines.some((l) => l.startsWith("add-on: detected")), `fresh heartbeat -> detected: ${JSON.stringify(status.lines)}`);
    assert.ok(status.lines.some((l) => l.includes("OK (host + add-on connected)")));

    // A stale heartbeat is reported as stale (add-on disconnected/reloading).
    await writeFile(path.join(hbDir, "client.heartbeat"), JSON.stringify({ ts: Date.now() - 10 * 60_000, client: "pi-browser-firefox", pid: 1 }));
    status = await runCommand("status", ctx);
    assert.ok(status.lines.some((l) => l.includes("add-on: last heartbeat") && l.includes("stale")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install fails clearly when the host build is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-browser-nobuild-"));
  try {
    const pkgRoot = await makePkg(root);
    await rm(path.join(pkgRoot, "dist"), { recursive: true, force: true });
    await assert.rejects(
      runCommand("install" as InstallerCommand, {
        pkgRoot,
        platform: "linux",
        homeDir: path.join(root, "home"),
      }),
      /host entrypoint missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
