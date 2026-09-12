import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand, expandAppTarget } from "../src/installer/index.js";
import { manifestPathsForApps, distinctManifestLocations, legacyManifestPath, WINDOWS_REGISTRY_KEY } from "../src/installer/common.js";
/**
 * Cross-platform installer tests for the application-neutral dev.pi.agent
 * host (plan §2, §23). Linux and macOS run against real temp directories;
 * Windows uses a mocked `reg` exec capturing commands and a simulated
 * registry state.
 */
const EXPECTED_ALLOWED = ["pi-agent-firefox@matbee.com", "pi-firefox@matbee.com", "pi-agent-thunderbird@matbee.com"];
/** Mirror of installer normalizePlatform (buildEnv normalizes before use). */
function norm(p) {
    if (p === "macos")
        return "darwin";
    if (p === "windows")
        return "win32";
    return p;
}
async function makePkg(root) {
    const pkgRoot = path.join(root, "pkg");
    await mkdir(path.join(pkgRoot, "dist", "native-host"), { recursive: true });
    await writeFile(path.join(pkgRoot, "dist", "native-host", "main.js"), "console.log('host');\n");
    await writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@pi-browser/agent", version: "0.1.0" }));
    return pkgRoot;
}
function fakeReg() {
    const state = new Map();
    const calls = [];
    return {
        state,
        calls,
        exec: async (cmd, args) => {
            calls.push({ cmd, args });
            if (cmd !== "reg")
                return { code: 1, stdout: "", stderr: `unexpected cmd ${cmd}` };
            if (args[0] === "add") {
                const key = args[1];
                const dIdx = args.indexOf("/d");
                const value = dIdx >= 0 ? args[dIdx + 1] : "";
                state.set(key, value);
                return { code: 0, stdout: "The operation completed successfully.", stderr: "" };
            }
            if (args[0] === "query") {
                const key = args[1];
                if (!state.has(key))
                    return { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key" };
                return { code: 0, stdout: `HKEY_CURRENT_USER\\${key}\n    (Default)    REG_SZ    ${state.get(key)}\n`, stderr: "" };
            }
            if (args[0] === "delete") {
                const key = args[1];
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
    assert.equal(linux.firefox, `${home}/.mozilla/native-messaging-hosts/dev.pi.agent.json`);
    assert.equal(linux.thunderbird, linux.firefox);
    assert.equal(distinctManifestLocations(["firefox", "thunderbird"], home, "linux").length, 1);
    // macOS: Firefox under Application Support, Thunderbird under Library/Mozilla.
    const mac = manifestPathsForApps(["firefox", "thunderbird"], home, "darwin");
    assert.equal(mac.firefox, `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/dev.pi.agent.json`);
    assert.equal(mac.thunderbird, `${home}/Library/Mozilla/NativeMessagingHosts/dev.pi.agent.json`);
    assert.equal(distinctManifestLocations(["firefox", "thunderbird"], home, "darwin").length, 2);
    // Legacy cleanup paths.
    assert.equal(legacyManifestPath("firefox", home, "darwin"), `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/dev.pi.browser.json`);
    assert.equal(legacyManifestPath("thunderbird", home, "linux"), `${home}/.mozilla/native-messaging-hosts/dev.pi.browser.json`);
    assert.equal(legacyManifestPath("thunderbird", home, "win32"), undefined);
    // Windows registry key is shared by both apps.
    assert.equal(WINDOWS_REGISTRY_KEY, `SOFTWARE\\Mozilla\\NativeMessagingHosts\\dev.pi.agent`);
});
for (const platform of ["linux", "macos"]) {
    test(`${platform}: install (mozilla) -> status -> repair -> uninstall lifecycle`, async () => {
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
            for (const app of ["firefox", "thunderbird"]) {
                const manifest = JSON.parse(await readFile(paths[app], "utf8"));
                assert.equal(manifest.name, "dev.pi.agent", `${app} manifest host name`);
                assert.equal(manifest.type, "stdio");
                assert.deepEqual(manifest.allowed_extensions, EXPECTED_ALLOWED);
                assert.ok(manifest.path.endsWith("native/pi-agent-host"));
                const launcher = await readFile(manifest.path, "utf8");
                assert.ok(launcher.startsWith("#!/bin/sh"));
                assert.ok(launcher.includes(path.join(pkgRoot, "dist", "native-host", "main.js")));
                const st = await stat(manifest.path);
                assert.ok(st.mode & 0o100, "launcher should be executable");
            }
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
            const manifest2 = JSON.parse(await readFile(paths.firefox, "utf8"));
            assert.ok(manifest2.path.startsWith(movedRoot));
            const healed = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
            assert.equal(healed.ok, true);
            // 7. uninstall removes the manifest(s) + legacy dev.pi.browser files
            const legacyFire = legacyManifestPath("firefox", home, norm(platform));
            await mkdir(path.dirname(legacyFire), { recursive: true });
            await writeFile(legacyFire, JSON.stringify({ name: "dev.pi.browser" }));
            const uninstall = await runCommand("uninstall", { ...ctx, pkgRoot: movedRoot });
            assert.equal(uninstall.ok, true);
            let gone = true;
            try {
                await stat(paths.firefox);
            }
            catch {
                gone = true;
            }
            assert.ok(gone);
            let legacyGone = true;
            try {
                await stat(legacyFire);
            }
            catch {
                legacyGone = true;
            }
            assert.ok(legacyGone, "legacy dev.pi.browser manifest removed");
            const finalStatus = await runCommand("status", { ...ctx, pkgRoot: movedRoot });
            assert.equal(finalStatus.ok, false);
        }
        finally {
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
        const fxPath = `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/dev.pi.agent.json`;
        const tbPath = `${home}/Library/Mozilla/NativeMessagingHosts/dev.pi.agent.json`;
        await stat(fxPath); // exists
        let tbExists = false;
        try {
            await stat(tbPath);
            tbExists = true;
        }
        catch {
            // expected absent
        }
        assert.equal(tbExists, false, "thunderbird manifest must not be written for firefox target");
    }
    finally {
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
            platform: "win32",
            homeDir: path.join(root, "home"),
            exec: reg.exec,
        };
        const before = await runCommand("status", ctx);
        assert.equal(before.ok, false);
        const install = await runCommand("install", ctx);
        assert.equal(install.ok, true);
        // reg add called with the shared dev.pi.agent key
        const addCall = reg.calls.find((c) => c.args[0] === "add");
        assert.ok(addCall);
        assert.ok(addCall.args.includes(`HKCU\\${WINDOWS_REGISTRY_KEY}`));
        // manifest file written inside the package
        const manifestFile = path.join(pkgRoot, "native", "dev_pi_agent.json");
        const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
        assert.equal(manifest.name, "dev.pi.agent");
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
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("status reports add-on auto-detection via heartbeat (missing / fresh / stale)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-install-addon-"));
    try {
        const pkgRoot = await makePkg(root);
        const home = path.join(root, "home");
        const ctx = { pkgRoot, platform: "linux", homeDir: home, apps: "firefox" };
        const install = await runCommand("install", ctx);
        assert.ok(install.ok);
        assert.ok(install.lines.some((l) => l.includes("auto-detects the host within ~10s")), `install hint mentions auto-detection: ${JSON.stringify(install.lines)}`);
        assert.ok(install.lines.some((l) => l.includes("firefox/dist/manifest.json") && l.includes("about:debugging")), `install next-steps point at the loadable dist manifest: ${JSON.stringify(install.lines)}`);
        // Host installed, add-on not yet seen -> step-by-step onboarding guide.
        let status = await runCommand("status", ctx);
        assert.ok(status.lines.some((l) => l.includes("add-on: not detected")), `missing heartbeat -> not detected: ${JSON.stringify(status.lines)}`);
        assert.ok(status.lines.some((l) => l.includes("HOST OK — add-on not detected")));
        assert.ok(status.lines.some((l) => l.includes("npm run build -w @pi-browser/firefox")), `step 1 build: ${JSON.stringify(status.lines)}`);
        assert.ok(status.lines.some((l) => l.includes("about:debugging") && l.includes("firefox/dist/manifest.json")), `step 2 load temp add-on: ${JSON.stringify(status.lines)}`);
        // A fresh Firefox add-on heartbeat flips status to connected.
        const hbDir = path.join(home, ".pi-browser");
        await mkdir(hbDir, { recursive: true });
        await writeFile(path.join(hbDir, "client.heartbeat"), JSON.stringify({ ts: Date.now(), client: "pi-browser-firefox", version: "0.1.0", pid: 1 }));
        status = await runCommand("status", ctx);
        assert.ok(status.lines.some((l) => l.startsWith("add-on: detected")), `fresh heartbeat -> detected: ${JSON.stringify(status.lines)}`);
        assert.ok(status.lines.some((l) => l.includes("OK (host + add-on connected)")));
        // A Thunderbird heartbeat is also recognized (same host, second app).
        await writeFile(path.join(hbDir, "client.heartbeat"), JSON.stringify({ ts: Date.now(), client: "pi-thunderbird", version: "0.1.0", pid: 2 }));
        status = await runCommand("status", ctx);
        assert.ok(status.lines.some((l) => l.startsWith("add-on: detected") && l.includes("pi-thunderbird")), `thunderbird heartbeat -> detected: ${JSON.stringify(status.lines)}`);
        // A stale heartbeat is reported as stale (add-on disconnected/reloading).
        await writeFile(path.join(hbDir, "client.heartbeat"), JSON.stringify({ ts: Date.now() - 10 * 60_000, client: "pi-browser-firefox", pid: 1 }));
        status = await runCommand("status", ctx);
        assert.ok(status.lines.some((l) => l.includes("add-on: last heartbeat") && l.includes("stale")));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("install fails clearly when the host build is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-agent-nobuild-"));
    try {
        const pkgRoot = await makePkg(root);
        await rm(path.join(pkgRoot, "dist"), { recursive: true, force: true });
        await assert.rejects(runCommand("install", {
            pkgRoot,
            platform: "linux",
            homeDir: path.join(root, "home"),
        }), /host entrypoint missing/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=installer.test.js.map