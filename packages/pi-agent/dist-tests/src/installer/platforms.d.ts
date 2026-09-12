import { type AgentApp, type ExecFn, type InstallerEnv } from "./common.js";
export interface InstallTargets {
    id: "linux" | "macos" | "windows";
    /** Absolute launcher path the manifest must point at. */
    launcherPath(pkgRoot: string): string;
    /** Render the launcher script content. */
    launcherContent(nodePath: string, mainJs: string): string;
    needsChmod: boolean;
    /** Windows-only: the in-package manifest file the registry points at. */
    windowsManifestPath(pkgRoot: string): string;
}
export declare const LINUX: InstallTargets;
export declare const MACOS: InstallTargets;
export declare const WINDOWS: InstallTargets;
export interface InstallOptions {
    env: InstallerEnv;
    pkgRoot: string;
    /** Absolute path of the built host entrypoint (dist/native-host/main.js). */
    mainJs: string;
    nodePath?: string;
    /** Applications to register (plan §23: firefox | thunderbird | both). */
    apps: readonly AgentApp[];
}
export interface InstallReport {
    ok: boolean;
    lines: string[];
    /** Manifest path per requested app. */
    manifestPaths: Record<AgentApp, string>;
    launcherPath: string;
}
export declare function installHost(opts: InstallOptions, targets: InstallTargets): Promise<InstallReport>;
export interface StatusReport {
    installed: boolean;
    lines: string[];
    /** Per-app install state (apps requested via the CLI target). */
    perApp: Record<AgentApp, {
        installed: boolean;
        manifestPath: string;
        issues: string[];
    }>;
    manifestPath?: string;
    launcherPath?: string;
    issues: string[];
}
export declare function statusHost(env: InstallerEnv, pkgRoot: string, targets: InstallTargets, apps: readonly AgentApp[]): Promise<StatusReport>;
export declare function uninstallHost(env: InstallerEnv, pkgRoot: string, targets: InstallTargets, apps: readonly AgentApp[]): Promise<string[]>;
export declare function defaultExec(): ExecFn;
export declare function detectTargets(platform: NodeJS.Platform): InstallTargets;
//# sourceMappingURL=platforms.d.ts.map