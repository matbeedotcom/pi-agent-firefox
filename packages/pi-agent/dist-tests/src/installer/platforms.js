/**
 * Per-platform install targets. Each implements the same operations over
 * an injected environment so every platform is unit-testable.
 *
 * The host is application-neutral (dev.pi.agent). Manifest locations are
 * per-app (plan §23); on Linux/Windows both apps share one location.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm, chmod, stat } from "node:fs/promises";
import path from "node:path";
import { buildManifest, cmdLauncherContent, distinctManifestLocations, legacyManifestPath, NATIVE_HOST_NAME, shLauncherContent, WINDOWS_LEGACY_REGISTRY_KEY, WINDOWS_REGISTRY_KEY, } from "./common.js";
const NATIVE_HOST_FILE = NATIVE_HOST_NAME.replace(/\./g, "_");
const BASE = {
    launcherPath: (pkgRoot) => path.join(pkgRoot, "native", "pi-agent-host"),
    windowsManifestPath: (pkgRoot) => path.join(pkgRoot, "native", `${NATIVE_HOST_FILE}.json`),
};
export const LINUX = {
    id: "linux",
    ...BASE,
    launcherContent: shLauncherContent,
    needsChmod: true,
};
export const MACOS = {
    id: "macos",
    ...BASE,
    launcherContent: shLauncherContent,
    needsChmod: true,
};
export const WINDOWS = {
    id: "windows",
    ...BASE,
    launcherPath: (pkgRoot) => path.join(pkgRoot, "native", "pi-agent-host.cmd"),
    launcherContent: cmdLauncherContent,
    needsChmod: false,
};
/** Resolve where each requested app's manifest lives on this platform. */
function appManifestPaths(targets, env, pkgRoot, apps) {
    if (targets.id === "windows") {
        const file = targets.windowsManifestPath(pkgRoot);
        const out = {};
        for (const app of apps)
            out[app] = file;
        return out;
    }
    const perApp = {};
    for (const loc of distinctManifestLocations(apps, env.homeDir, env.platform)) {
        for (const app of loc.apps)
            perApp[app] = loc.path;
    }
    return perApp;
}
export async function installHost(opts, targets) {
    const { env, pkgRoot } = opts;
    const nodePath = opts.nodePath ?? process.execPath;
    const mainJs = opts.mainJs;
    const launcherPath = targets.launcherPath(pkgRoot);
    const lines = [];
    // Launcher (shared by all apps — one host implementation).
    await mkdir(path.dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, targets.launcherContent(nodePath, mainJs), "utf8");
    if (targets.needsChmod)
        await chmod(launcherPath, 0o755);
    lines.push(`launcher: ${launcherPath}`);
    // Manifest(s)
    const manifest = buildManifest(launcherPath);
    const manifestPaths = appManifestPaths(targets, env, pkgRoot, opts.apps);
    if (targets.id === "windows") {
        const winManifestFile = targets.windowsManifestPath(pkgRoot);
        await mkdir(path.dirname(winManifestFile), { recursive: true });
        await writeFile(winManifestFile, JSON.stringify(manifest, null, 2), "utf8");
        lines.push(`manifest: ${winManifestFile}`);
        const add = await env.exec("reg", [
            "add",
            `HKCU\\${WINDOWS_REGISTRY_KEY}`,
            "/ve",
            "/d",
            winManifestFile,
            "/f",
        ]);
        if (add.code !== 0)
            throw new Error(`registry update failed: ${add.stderr || add.stdout}`);
        lines.push(`registry: HKCU\\${WINDOWS_REGISTRY_KEY} -> ${winManifestFile} (apps: ${opts.apps.join(", ")})`);
    }
    else {
        for (const loc of distinctManifestLocations(opts.apps, env.homeDir, env.platform)) {
            await mkdir(path.dirname(loc.path), { recursive: true });
            await writeFile(loc.path, JSON.stringify(manifest, null, 2), "utf8");
            lines.push(`manifest: ${loc.path} (apps: ${loc.apps.join(", ")})`);
        }
    }
    return { ok: true, lines, manifestPaths, launcherPath };
}
async function checkManifest(manifest, launcherPath, lines, issues) {
    lines.push(`host name: ${manifest.name}`);
    lines.push(`allowed_extensions: ${manifest.allowed_extensions.join(", ")}`);
    if (manifest.name !== NATIVE_HOST_NAME)
        issues.push(`unexpected host name: ${manifest.name}`);
    if (!manifest.allowed_extensions.includes("pi-browser@pi.dev")) {
        issues.push("allowed_extensions does not include pi-browser@pi.dev (Firefox)");
    }
    if (!manifest.allowed_extensions.includes("pi-thunderbird@pi.dev")) {
        issues.push("allowed_extensions does not include pi-thunderbird@pi.dev (Thunderbird)");
    }
    if (manifest.type !== "stdio")
        issues.push(`unexpected manifest type: ${manifest.type}`);
    const targetLauncher = manifest.path;
    const launcherExists = await fileExists(targetLauncher);
    lines.push(`launcher: ${targetLauncher} (${launcherExists ? "ok" : "MISSING"})`);
    if (!launcherExists)
        issues.push(`launcher missing: ${targetLauncher}`);
    if (launcherPath && manifest.path !== launcherPath) {
        lines.push(`note: launcher differs from current package location (${launcherPath}); run install to repair`);
        issues.push("stale launcher path (package moved?)");
    }
    return issues.length === 0;
}
async function readManifestFile(file) {
    const manifest = await readJsonFile(file);
    return manifest;
}
export async function statusHost(env, pkgRoot, targets, apps) {
    const launcherPath = targets.launcherPath(pkgRoot);
    const lines = [];
    const issues = [];
    const perApp = {};
    const isWin = targets.id === "windows";
    let registryValue;
    if (isWin) {
        const q = await env.exec("reg", ["query", `HKCU\\${WINDOWS_REGISTRY_KEY}`]);
        if (q.code === 0) {
            const match = q.stdout.split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
            registryValue = match?.split(/\s{2,}/).pop() ?? "";
        }
    }
    for (const app of apps) {
        const appLines = [];
        const appIssues = [];
        let manifest;
        if (isWin) {
            const manifestPath = targets.windowsManifestPath(pkgRoot);
            if (!registryValue) {
                appIssues.push("registry key missing");
            }
            else {
                appLines.push(`registry: HKCU\\${WINDOWS_REGISTRY_KEY} -> ${registryValue}`);
                manifest = await readJsonFile(registryValue);
                if (!manifest)
                    appIssues.push(`manifest not found at registry path: ${registryValue}`);
            }
            perApp[app] = { installed: false, manifestPath: registryValue ?? manifestPath, issues: appIssues };
        }
        else {
            const manifestPath = distinctManifestLocations([app], env.homeDir, env.platform)[0].path;
            manifest = await readManifestFile(manifestPath);
            if (!manifest) {
                appIssues.push("manifest missing");
            }
            else {
                appLines.push(`manifest: ${manifestPath}`);
            }
            perApp[app] = { installed: false, manifestPath, issues: appIssues };
        }
        if (manifest) {
            // Check shared fields once per distinct file; per-app lines are short.
            await checkManifest(manifest, isWin ? "" : launcherPath, appLines, appIssues);
            perApp[app].installed = appIssues.length === 0;
            perApp[app].issues = appIssues;
        }
        lines.push(`[${app}] ${perApp[app].installed ? "installed" : "NOT installed"}`);
        for (const l of appLines)
            lines.push(`  ${l}`);
        for (const i of appIssues) {
            lines.push(`  issue: ${i}`);
            issues.push(`${app}: ${i}`);
        }
    }
    return {
        installed: apps.every((a) => perApp[a].installed),
        lines,
        perApp,
        manifestPath: perApp[apps[0]]?.manifestPath,
        launcherPath,
        issues,
    };
}
export async function uninstallHost(env, pkgRoot, targets, apps) {
    const lines = [];
    if (targets.id === "windows") {
        const del = await env.exec("reg", ["delete", `HKCU\\${WINDOWS_REGISTRY_KEY}`, "/f"]);
        if (del.code === 0)
            lines.push("removed registry key");
        else
            lines.push(`registry delete reported: ${del.stderr || del.stdout || "already absent"}`);
        const legacyDel = await env.exec("reg", ["delete", `HKCU\\${WINDOWS_LEGACY_REGISTRY_KEY}`, "/f"]);
        if (legacyDel.code === 0)
            lines.push("removed legacy registry key (dev.pi.browser)");
        const manifestFile = targets.windowsManifestPath(pkgRoot);
        await rm(manifestFile, { force: true });
        lines.push(`removed manifest: ${manifestFile}`);
    }
    else {
        const allApps = ["firefox", "thunderbird"];
        for (const loc of distinctManifestLocations(allApps, env.homeDir, env.platform)) {
            await rm(loc.path, { force: true });
            lines.push(`removed manifest: ${loc.path}`);
        }
        for (const app of allApps) {
            const legacy = legacyManifestPath(app, env.homeDir, env.platform);
            if (legacy) {
                await rm(legacy, { force: true });
                lines.push(`removed legacy manifest: ${legacy}`);
            }
        }
    }
    return lines;
}
export function defaultExec() {
    return (cmd, args) => new Promise((resolve) => {
        execFile(cmd, args, { timeout: 30_000 }, (error, stdout, stderr) => {
            let code = 0;
            if (error) {
                code = typeof error.code === "number" ? error.code : 1;
            }
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    });
}
export function detectTargets(platform) {
    if (platform === "darwin")
        return MACOS;
    if (platform === "win32")
        return WINDOWS;
    return LINUX;
}
async function readJsonFile(file) {
    try {
        const raw = await readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed?.path !== "string" || typeof parsed?.name !== "string")
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
async function fileExists(file) {
    try {
        const s = await stat(file);
        return s.isFile();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=platforms.js.map