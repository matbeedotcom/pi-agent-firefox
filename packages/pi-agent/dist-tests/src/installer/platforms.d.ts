import { type ExecFn, type InstallerEnv } from "./common.js";
export interface InstallTargets {
    id: "linux" | "macos" | "windows";
    /** Where the native host manifest lives (Windows: manifest file in the package). */
    manifestPath(homeDir: string, pkgRoot: string): string;
    /** Absolute launcher path the manifest must point at. */
    launcherPath(pkgRoot: string): string;
    /** Render the launcher script content. */
    launcherContent(nodePath: string, mainJs: string): string;
    needsChmod: boolean;
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
}
export interface InstallReport {
    ok: boolean;
    lines: string[];
    manifestPath: string;
    launcherPath: string;
}
export declare function installHost(opts: InstallOptions, targets: InstallTargets): Promise<InstallReport>;
export interface StatusReport {
    installed: boolean;
    lines: string[];
    manifestPath?: string;
    launcherPath?: string;
    issues: string[];
}
export declare function statusHost(env: InstallerEnv, pkgRoot: string, targets: InstallTargets): Promise<StatusReport>;
export declare function uninstallHost(env: InstallerEnv, pkgRoot: string, targets: InstallTargets): Promise<string[]>;
export declare function defaultExec(): ExecFn;
export declare function detectTargets(platform: NodeJS.Platform): InstallTargets;
//# sourceMappingURL=platforms.d.ts.map