import { mcpSocketPath } from "../src/installer/mcp.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCommand, expandAppTarget } from "../src/installer/index.js";
import { manifestPathsForApps, distinctManifestLocations, legacyManifestPath, WINDOWS_REGISTRY_KEY } from "../src/installer/common.js";
import { SKILL_INSTALL_PATH, SKILL_SOURCE_PATH } from "../src/installer/platforms.js";
import type { ExecResult } from "../src/installer/common.js";

// Test packages live under the OS temp dir; the installer refuses those
// roots for real users (npx cache / temp), so opt out for this suite.
process.env.PI_BROWSER_ALLOW_TEMPORARY_ROOT = "1";

/**
 * Cross-platform installer tests for the application-neutral com.matbee.agent
 * host (plan §2, §23). Linux and macOS run against real temp directories;
 * Windows uses a mocked `reg` exec capturing commands and a simulated
 * registry state.
 */

const EXPECTED_ALLOWED = ["pi-agent-firefox@matbee.com", "pi-firefox@matbee.com", "pi-agent-thunderbird@matbee.com"];

/** Mirror of installer normalizePlatform (buildEnv normalizes before use). */
function norm(p: string): string {
  if (p === "macos") return "darwin";
  if (p === "windows") return "win32";
  return p;
}

const SKILL_FIXTURE =
  "---\nname: browser-walk\ndescription: Multi-step work on the Firefox tab bound to this session.\n---\n\n# Browser-walk (fixture)\n";

async function makePkg(root: string): Promise<string> {
  const pkgRoot = path.join(root, "pkg");
  await mkdir(path.join(pkgRoot, "dist", "native-host"), { recursive: true });
  await writeFile(path.join(pkgRoot, "dist", "native-host", "main.js"), "console.log('host');\n");
  await writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "trusted-user-agent", version: "0.1.1" }));
  // Skill shipped with the package (WS1/T1.3): the installer copies it to
  // ~/.agents/skills/browser-walk/SKILL.md.
  await mkdir(path.join(pkgRoot, "skills", "browser-walk"), { recursive: true });
  await writeFile(SKILL_SOURCE_PATH(pkgRoot), SKILL_FIXTURE, "utf8");
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

test("expandAppTarget: firefox | thunderbird | mozilla | default", () => {
  assert.deepEqual(expandAppTarget("firefox"), ["firefox"]);
  assert.deepEqual(expandAppTarget("thunderbird"), ["thunderbird"]);
  assert.deepEqual(expandAppTarget("mozilla"), ["firefox", "thunderbird"]);
  assert.deepEqual(expandAppTarget(undefined), ["firefox", "thunderbird"]);
});

test("manifest path table: shared on linux/windows, split on macOS (plan §23)", () => {
  const home = "/home/u";
  // Linux: one shared directory for both apps.
  const linux = manifestPathsForApps(["firefox", "thunderbird"], home, "linux");
  assert.equal(linux.firefox, `${home}/.mozilla/native-messaging-hosts/com.matbee.agent.json`);
  assert.equal(linux.thunderbird, linux.firefox);
  assert.equal(distinctManifestLocations(["firefox", "thunderbird"], home, "linux").length, 1);

  // macOS: Firefox under Application Support, Thunderbird under Library/Mozilla.
  const mac = manifestPathsForApps(["firefox", "thunderbird"], home, "darwin");
  assert.equal(mac.firefox, `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/com.matbee.agent.json`);
  assert.equal(mac.thunderbird, `${home}/Library/Mozilla/NativeMessagingHosts/com.matbee.agent.json`);
  assert.equal(distinctManifestLocations(["firefox", "thunderbird"], home, "darwin").length, 2);

  // Legacy cleanup paths.
  assert.equal(legacyManifestPath("firefox", home, "darwin"), `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/dev.pi.browser.json`);
  assert.equal(legacyManifestPath("thunderbird", home, "linux"), `${home}/.mozilla/native-messaging-hosts/dev.pi.browser.json`);
  assert.equal(legacyManifestPath("thunderbird", home, "win32"), undefined);

  // Windows registry key is shared by both apps.
  assert.equal(WINDOWS_REGISTRY_KEY, `SOFTWARE\\Mozilla\\NativeMessagingHosts\\com.matbee.agent`);
});

for (const platform of ["linux", "macos"] as const) {
  // Real file writes with POSIX semantics (sh launcher, exec bit, "/" paths):
  // only meaningful on a POSIX host.
  test(`${platform}: install (mozilla) -> status -> repair -> uninstall lifecycle`, { skip: process.platform === "win32" && "simulates a POSIX host" }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `pi-agent-${platform}-`));
    try {
      const pkgRoot = await makePkg(root);
      const home = path.join(root, "home");
      const ctx = { pkgRoot, platform, homeDir: home };

      // 1. status before install (default target = both apps)
      const before = await runCommand("status", ctx);
      assert.equal(before.ok, false);
      assert.ok(before.lines.some((l) => l.includes("[firefox] NOT installed")));
      assert.ok(before.lines.some((l) => l.includes("[thunderbird] NOT installed")));

      // 2. install for both apps
      const install = await runCommand("install", ctx);
      assert.equal(install.ok, true);
      const paths = manifestPathsForApps(["firefox", "thunderbird"], home, norm(platform));
      for (const app of ["firefox", "thunderbird"] as const) {
        const manifest = JSON.parse(await readFile(paths[app], "utf8")) as {
          name: string;
          path: string;
          type: string;
          allowed_extensions: string[];
        };
        assert.equal(manifest.name, "com.matbee.agent", `${app} manifest host name`);
        assert.equal(manifest.type, "stdio");
        assert.deepEqual(manifest.allowed_extensions, EXPECTED_ALLOWED);
        assert.ok(manifest.path.endsWith("native/pi-agent-host"));
        const launcher = await readFile(manifest.path, "utf8");
        assert.ok(launcher.startsWith("#!/bin/sh"));
        assert.ok(launcher.includes(path.join(pkgRoot, "dist", "native-host", "main.js")));
        const st = await stat(manifest.path);
        assert.ok(st.mode & 0o100, "launcher should be executable");
      }

      // 2b. skill copied to the user skills dir (WS1/T1.3)
      const skillTarget = SKILL_INSTALL_PATH(home);
      assert.equal(await readFile(skillTarget, "utf8"), SKILL_FIXTURE, "skill copied on install");

      // 3. status after install (fresh temp home -> no add-on heartbeat yet)
      const after = await runCommand("status", ctx);
      assert.equal(after.ok, true);
      assert.ok(after.lines.some((l) => l.includes("[firefox] installed")));
      assert.ok(after.lines.some((l) => l.includes("[thunderbird] installed")));
      assert.ok(after.lines.some((l) => l.includes("status: HOST OK — add-on not detected")));

      // 4. thunderbird-only status also reports just that app
      const tbOnly = await runCommand("status", { ...ctx, apps: "thunderbird" });
      assert.equal(tbOnly.ok, true);
      assert.ok(tbOnly.lines.some((l) => l.includes("[thunderbird] installed")));
      assert.ok(!tbOnly.lines.some((l) => l.startsWith("[firefox]")));

      // 5. package moved -> stale path detected
      const movedRoot = await makePkg(path.join(root, "moved"));
      const stale = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
      assert.equal(stale.ok, false);
      assert.ok(stale.lines.some((l) => l.includes("stale launcher path")));

      // 6. repair (reinstall from the moved location)
      const repair = await runCommand("install", { ...ctx, pkgRoot: movedRoot });
      assert.equal(repair.ok, true);
      const manifest2 = JSON.parse(await readFile(paths.firefox, "utf8")) as { path: string };
      assert.ok(manifest2.path.startsWith(movedRoot));
      const healed = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
      assert.equal(healed.ok, true);

      // 7. uninstall removes the manifest(s) + legacy dev.pi.browser files
      const legacyFire = legacyManifestPath("firefox", home, norm(platform))!;
      await mkdir(path.dirname(legacyFire), { recursive: true });
      await writeFile(legacyFire, JSON.stringify({ name: "dev.pi.browser" }));
      const uninstall = await runCommand("uninstall", { ...ctx, pkgRoot: movedRoot });
      assert.equal(uninstall.ok, true);
      // Each removal is proven by stat REJECTING (a surviving file must fail
      // the test — the old `let x = true` pattern never could).
      let firefoxStat: unknown;
      try {
        firefoxStat = await stat(paths.firefox);
      } catch (err) {
        firefoxStat = err;
      }
      assert.ok(firefoxStat instanceof Error && (firefoxStat as NodeJS.ErrnoException).code === "ENOENT", "manifest removed");
      let legacyStat: unknown;
      try {
        legacyStat = await stat(legacyFire);
      } catch (err) {
        legacyStat = err;
      }
      assert.ok(legacyStat instanceof Error && (legacyStat as NodeJS.ErrnoException).code === "ENOENT", "legacy dev.pi.browser manifest removed");
      let skillStat: unknown;
      try {
        skillStat = await stat(skillTarget);
      } catch (err) {
        skillStat = err;
      }
      assert.ok(skillStat instanceof Error && (skillStat as NodeJS.ErrnoException).code === "ENOENT", "skill removed on uninstall");
      const finalStatus = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
      assert.equal(finalStatus.ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${platform}: install copies the browser-walk skill into ~/.agents/skills`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `pi-agent-skill-${platform}-`));
    try {
      const pkgRoot = await makePkg(root);
      const home = path.join(root, "home");
      const install = await runCommand("install", { pkgRoot, platform, homeDir: home, apps: "firefox" });
      assert.equal(install.ok, true);
      assert.ok(install.lines.some((l) => l.includes("skill: ")));
      const skillTarget = SKILL_INSTALL_PATH(home);
      const content = await readFile(skillTarget, "utf8");
      // Frontmatter must be valid: name + non-empty description (pi skill rule).
      const match = content.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(match, "skill frontmatter present");
      assert.equal(match![1].includes("name: browser-walk"), true, "frontmatter name");
      assert.equal(match![1].includes("description:"), true, "frontmatter description");
      // Reinstall over an existing skill succeeds (force).
      const again = await runCommand("install", { pkgRoot, platform, homeDir: home, apps: "firefox" });
      assert.equal(again.ok, true);
      assert.equal(await readFile(skillTarget, "utf8"), content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("macos: firefox-only install writes only the Firefox manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-mac-fx-"));
  try {
    const pkgRoot = await makePkg(root);
    const home = path.join(root, "home");
    const install = await runCommand("install", { pkgRoot, platform: "macos", homeDir: home, apps: "firefox" });
    assert.ok(install.ok);
    const fxPath = `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/com.matbee.agent.json`;
    const tbPath = `${home}/Library/Mozilla/NativeMessagingHosts/com.matbee.agent.json`;
    await stat(fxPath); // exists
    let tbExists = false;
    try {
      await stat(tbPath);
      tbExists = true;
    } catch {
      // expected absent
    }
    assert.equal(tbExists, false, "thunderbird manifest must not be written for firefox target");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("windows: registry-based install/status/uninstall for both apps (mocked reg)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-win-"));
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
    // reg add called with the shared com.matbee.agent key
    const addCall = reg.calls.find((c) => c.args[0] === "add");
    assert.ok(addCall);
    assert.ok(addCall.args.includes(`HKCU\\${WINDOWS_REGISTRY_KEY}`));
    // manifest file written inside the package
    const manifestFile = path.join(pkgRoot, "native", "com_matbee_agent.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { path: string; name: string; allowed_extensions: string[] };
    assert.equal(manifest.name, "com.matbee.agent");
    assert.ok(manifest.path.endsWith("pi-agent-host.cmd"));
    assert.deepEqual(manifest.allowed_extensions, EXPECTED_ALLOWED);
    const launcher = await readFile(manifest.path, "utf8");
    assert.ok(launcher.startsWith("@echo off"));

    const after = await runCommand("status", ctx);
    assert.equal(after.ok, true);
    assert.ok(after.lines.some((l) => l.includes("[firefox] installed")));
    assert.ok(after.lines.some((l) => l.includes("[thunderbird] installed")));

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
    const ctx = { pkgRoot, platform: "linux" as const, homeDir: home, apps: "firefox" as const };
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
    assert.ok(status.lines.some((l) => l.includes("npm run build -w @trusted-ua/firefox")), `step 1 build: ${JSON.stringify(status.lines)}`);
    assert.ok(status.lines.some((l) => l.includes("about:debugging") && l.includes("firefox/dist/manifest.json")), `step 2 load temp add-on: ${JSON.stringify(status.lines)}`);

    // A fresh Firefox add-on heartbeat flips status to connected.
    // (Legacy single-file heartbeat still works: it maps to its app.)
    const hbDir = path.join(home, ".pi-browser");
    await mkdir(hbDir, { recursive: true });
    await writeFile(path.join(hbDir, "client.heartbeat"), JSON.stringify({ ts: Date.now(), client: "pi-browser-firefox", version: "0.1.1", pid: 1 }));
    status = await runCommand("status", ctx);
    assert.ok(status.lines.some((l) => l.startsWith("add-on firefox: detected")), `fresh heartbeat -> detected: ${JSON.stringify(status.lines)}`);
    assert.ok(status.lines.some((l) => l.includes("OK (host + add-on connected)")));

    // Per-app reporting: a Thunderbird heartbeat is tracked independently —
    // with both apps' heartbeats fresh, status reports each app (mozilla target).
    await writeFile(path.join(hbDir, "client.heartbeat.thunderbird"), JSON.stringify({ ts: Date.now(), client: "pi-thunderbird", version: "0.1.1", pid: 2 }));
    status = await runCommand("status", { ...ctx, apps: "mozilla" });
    assert.ok(status.lines.some((l) => l.startsWith("add-on thunderbird: detected") && l.includes("pi-thunderbird")), `thunderbird heartbeat -> detected: ${JSON.stringify(status.lines)}`);
    assert.ok(status.lines.some((l) => l.startsWith("add-on firefox: detected")), `firefox still detected: ${JSON.stringify(status.lines)}`);

    // A stale heartbeat is reported as stale (add-on disconnected/reloading).
    await writeFile(path.join(hbDir, "client.heartbeat"), JSON.stringify({ ts: Date.now() - 10 * 60_000, client: "pi-browser-firefox", pid: 1 }));
    status = await runCommand("status", ctx);
    assert.ok(status.lines.some((l) => l.includes("add-on firefox: last heartbeat") && l.includes("stale")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install fails clearly when the host build is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-nobuild-"));
  try {
    const pkgRoot = await makePkg(root);
    await rm(path.join(pkgRoot, "dist"), { recursive: true, force: true });
    await assert.rejects(
      runCommand("install", {
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

// ── /pi-browser mcp (global ~/.pi/agent/mcp.json) ─────────────────────────

test("mcp: install → status → idempotent reinstall → uninstall lifecycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-mcp-"));
  const home = path.join(root, "home");
  const file = path.join(home, ".pi", "agent", "mcp.json");
  try {
    const ctx = { pkgRoot: root, platform: "linux" as const, homeDir: home };

    // Not configured yet.
    let result = await runCommand("mcp", ctx, "status");
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((l) => l.includes("not configured")), JSON.stringify(result.lines));

    // Install creates the config with the pi-browser entry.
    result = await runCommand("mcp", ctx); // default sub: install
    assert.equal(result.ok, true);
    type McpConfig = {
      mcpServers: Record<string, Record<string, unknown>>;
      settings?: unknown;
    };
    let config = JSON.parse(await readFile(file, "utf8")) as McpConfig;
    // A stdio entry (pi's built-in MCP client speaks stdio/HTTP only) that
    // launches the bridge to the broker's socket/pipe.
    assert.deepEqual(config.mcpServers["pi-browser"], {
      command: process.execPath,
      args: [path.join(root, "dist", "native-host", "mcp-stdio-main.js")],
      directTools: true,
      exposure: "deferred",
    });
    // The bridge dials the broker's endpoint: POSIX <home>/.pi/run/agent-broker-mcp.sock, Windows a named pipe.
    if (process.platform !== "win32") assert.equal(mcpSocketPath(home), path.join(home, ".pi", "run", "agent-broker-mcp.sock"));

    // Status reports OK.
    result = await runCommand("mcp", ctx, "status");
    assert.equal(result.ok, true);
    assert.ok(result.lines.some((l) => l.startsWith("mcp: OK")), JSON.stringify(result.lines));

    // Reinstall is idempotent (no other content mutated).
    await writeFile(file, `${JSON.stringify({ ...config, settings: { directTools: false } })}\n`);
    result = await runCommand("mcp", ctx);
    assert.equal(result.ok, true);
    assert.ok(result.lines.some((l) => l.includes("already configured")), JSON.stringify(result.lines));
    config = JSON.parse(await readFile(file, "utf8")) as McpConfig;
    assert.deepEqual(config.settings, { directTools: false }, "unrelated keys preserved");

    // The user's own tuning (e.g. exposure changed in pi's /mcp manager) is
    // kept by a reinstall and does not make status report a stale entry.
    config.mcpServers["pi-browser"] = { ...config.mcpServers["pi-browser"], exposure: "direct", enabled: false };
    await writeFile(file, `${JSON.stringify(config)}\n`);
    result = await runCommand("mcp", ctx, "status");
    assert.equal(result.ok, true, JSON.stringify(result.lines));
    result = await runCommand("mcp", ctx);
    config = JSON.parse(await readFile(file, "utf8")) as McpConfig;
    assert.equal(config.mcpServers["pi-browser"].exposure, "direct", "user's exposure kept");
    assert.equal(config.mcpServers["pi-browser"].enabled, false, "user's enabled flag kept");

    // A pre-0.2.5 socket entry (pi-mcp-adapter only) is reported stale…
    await writeFile(file, `${JSON.stringify({ mcpServers: { "pi-browser": { socket: "/old/path.sock", directTools: true } } })}\n`);
    result = await runCommand("mcp", ctx, "status");
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((l) => l.includes("STALE")), JSON.stringify(result.lines));
    // …and install replaces it with the stdio entry.
    result = await runCommand("mcp", ctx);
    config = JSON.parse(await readFile(file, "utf8")) as McpConfig;
    assert.equal(config.mcpServers["pi-browser"].socket, undefined);
    assert.equal(config.mcpServers["pi-browser"].command, process.execPath);

    // Uninstall removes the entry and the now-empty file.
    result = await runCommand("mcp", ctx); // re-configure first
    assert.equal(result.ok, true);
    result = await runCommand("mcp", ctx, "uninstall");
    assert.equal(result.ok, true);
    assert.ok(result.lines.some((l) => l.includes("removed")), JSON.stringify(result.lines));
    assert.equal((await stat(file).then(() => true).catch(() => false)), false, "empty config file removed");

    // Uninstall on a missing config is a no-op success.
    result = await runCommand("mcp", ctx, "uninstall");
    assert.equal(result.ok, true);
    assert.ok(result.lines.some((l) => l.includes("nothing to remove")), JSON.stringify(result.lines));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mcp: install merges with an existing multi-server config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-mcp-merge-"));
  const home = path.join(root, "home");
  const file = path.join(home, ".pi", "agent", "mcp.json");
  try {
    const ctx = { pkgRoot: root, platform: "linux" as const, homeDir: home };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"] } } }, null, 2),
    );

    const result = await runCommand("mcp", ctx);
    assert.equal(result.ok, true);
    const config = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    assert.deepEqual(config.mcpServers.github, { command: "npx", args: ["-y", "gh-mcp"] }, "other servers preserved");
    assert.ok(config.mcpServers["pi-browser"], "pi-browser entry added");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status lists external ACP agents and agents.json problems (sidebar-acp-agents)", async () => {
  const { agentLines } = await import("../src/installer/index.js");
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-agents-"));
  try {
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    await mkdir(bin, { recursive: true });
    // Only the Claude Code adapter is on PATH.
    const exe = process.platform === "win32" ? "claude-agent-acp.cmd" : "claude-agent-acp";
    await writeFile(path.join(bin, exe), "");
    const env = { PATH: bin } as NodeJS.ProcessEnv;
    const lines = agentLines(home, env);
    assert.ok(lines.includes("agent claude: available"), lines.join("\n"));
    assert.ok(lines.includes("agent codex: not found (codex-acp)"), lines.join("\n"));

    await mkdir(path.join(home, ".pi", "browser"), { recursive: true });
    await writeFile(path.join(home, ".pi", "browser", "agents.json"), "{ broken");
    const broken = agentLines(home, env);
    assert.ok(broken.some((l) => l.startsWith("agents.json: ")), broken.join("\n"));
    assert.ok(broken.includes("agent claude: available"), "built-ins still listed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
