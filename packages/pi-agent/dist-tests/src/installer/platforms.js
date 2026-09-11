/**
 * Per-platform install targets. Each implements the same operations over
 * an injected environment so every platform is unit-testable.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm, chmod, stat } from "node:fs/promises";
import path from "node:path";
import { buildManifest, cmdLauncherContent, linuxManifestPath, macosManifestPath, NATIVE_HOST_NAME, shLauncherContent, WINDOWS_REGISTRY_KEY, } from "./common.js";
const NATIVE_HOST_FILE = NATIVE_HOST_NAME.replace(/\./g, "_");
export const LINUX = {
    id: "linux",
    manifestPath: (homeDir) => linuxManifestPath(homeDir),
    launcherPath: (pkgRoot) => path.join(pkgRoot, "native", "pi-browser-host"),
    launcherContent: shLauncherContent,
    needsChmod: true,
};
export const MACOS = {
    id: "macos",
    manifestPath: (homeDir) => macosManifestPath(homeDir),
    launcherPath: (pkgRoot) => path.join(pkgRoot, "native", "pi-browser-host"),
    launcherContent: shLauncherContent,
    needsChmod: true,
};
export const WINDOWS = {
    id: "windows",
    manifestPath: (_homeDir, pkgRoot) => path.join(pkgRoot, "native", `${NATIVE_HOST_FILE}.json`),
    launcherPath: (pkgRoot) => path.join(pkgRoot, "native", "pi-browser-host.cmd"),
    launcherContent: cmdLauncherContent,
    needsChmod: false,
};
export async function installHost(opts, targets) {
    const { env, pkgRoot } = opts;
    const nodePath = opts.nodePath ?? process.execPath;
    const mainJs = opts.mainJs;
    const launcherPath = targets.launcherPath(pkgRoot);
    const manifestPath = targets.manifestPath(env.homeDir, pkgRoot);
    const lines = [];
    // Launcher
    await mkdir(path.dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, targets.launcherContent(nodePath, mainJs), "utf8");
    if (targets.needsChmod)
        await chmod(launcherPath, 0o755);
    lines.push(`launcher: ${launcherPath}`);
    // Manifest
    const manifest = buildManifest(launcherPath);
    if (targets.id === "windows") {
        await mkdir(path.dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
        lines.push(`manifest: ${manifestPath}`);
        const add = await env.exec("reg", [
            "add",
            `HKCU\\${WINDOWS_REGISTRY_KEY}`,
            "/ve",
            "/d",
            manifestPath,
            "/f",
        ]);
        if (add.code !== 0)
            throw new Error(`registry update failed: ${add.stderr || add.stdout}`);
        lines.push(`registry: HKCU\\${WINDOWS_REGISTRY_KEY} -> ${manifestPath}`);
    }
    else {
        await mkdir(path.dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
        lines.push(`manifest: ${manifestPath}`);
    }
    return { ok: true, lines, manifestPath, launcherPath };
}
export async function statusHost(env, pkgRoot, targets) {
    const manifestPath = targets.manifestPath(env.homeDir, pkgRoot);
    const launcherPath = targets.launcherPath(pkgRoot);
    const issues = [];
    const lines = [];
    let manifest;
    if (targets.id === "windows") {
        const q = await env.exec("reg", ["query", `HKCU\\${WINDOWS_REGISTRY_KEY}`]);
        if (q.code !== 0) {
            return { installed: false, lines: ["not installed (registry key missing)"], issues: ["registry key missing"], manifestPath, launcherPath };
        }
        // Parse "(Default)" value
        const match = q.stdout.split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
        const regValue = match?.split(/\s{2,}/).pop() ?? "";
        if (!regValue) {
            return { installed: false, lines: ["not installed (registry default value empty)"], issues: ["registry default value empty"], manifestPath, launcherPath };
        }
        lines.push(`registry: HKCU\\${WINDOWS_REGISTRY_KEY} -> ${regValue}`);
        manifest = await readJsonFile(regValue);
        if (!manifest) {
            issues.push(`manifest not found at registry path: ${regValue}`);
            return { installed: false, lines, issues, manifestPath: regValue, launcherPath };
        }
    }
    else {
        manifest = await readJsonFile(manifestPath);
        if (!manifest) {
            return { installed: false, lines: ["not installed (manifest missing)"], issues: ["manifest missing"], manifestPath, launcherPath };
        }
        lines.push(`manifest: ${manifestPath}`);
    }
    lines.push(`host name: ${manifest.name}`);
    lines.push(`allowed_extensions: ${manifest.allowed_extensions.join(", ")}`);
    if (manifest.name !== NATIVE_HOST_NAME)
        issues.push(`unexpected host name: ${manifest.name}`);
    if (!manifest.allowed_extensions.includes("pi-browser@pi.dev")) {
        issues.push("allowed_extensions does not include pi-browser@pi.dev");
    }
    if (manifest.type !== "stdio")
        issues.push(`unexpected manifest type: ${manifest.type}`);
    const targetLauncher = manifest.path;
    const launcherExists = await fileExists(targetLauncher);
    lines.push(`launcher: ${targetLauncher} (${launcherExists ? "ok" : "MISSING"})`);
    if (!launcherExists)
        issues.push(`launcher missing: ${targetLauncher}`);
    if (manifest.path !== launcherPath) {
        lines.push(`note: launcher differs from current package location (${launcherPath}); run install to repair`);
        issues.push("stale launcher path (package moved?)");
    }
    return { installed: issues.length === 0, lines, issues, manifestPath, launcherPath };
}
export async function uninstallHost(env, pkgRoot, targets) {
    const lines = [];
    if (targets.id === "windows") {
        const del = await env.exec("reg", ["delete", `HKCU\\${WINDOWS_REGISTRY_KEY}`, "/f"]);
        if (del.code === 0)
            lines.push("removed registry key");
        else
            lines.push(`registry delete reported: ${del.stderr || del.stdout || "already absent"}`);
        const manifestPath = targets.manifestPath(env.homeDir, pkgRoot);
        await rm(manifestPath, { force: true });
        lines.push(`removed manifest: ${manifestPath}`);
    }
    else {
        const manifestPath = targets.manifestPath(env.homeDir, pkgRoot);
        await rm(manifestPath, { force: true });
        lines.push(`removed manifest: ${manifestPath}`);
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