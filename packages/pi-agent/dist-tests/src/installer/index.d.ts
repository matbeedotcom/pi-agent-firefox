import { PI_BROWSER_META } from "@pi-browser/protocol";
import { type AgentApp, type ExecFn, type InstallerEnv, type InstallAppTarget } from "./common.js";
import { type InstallTargets } from "./platforms.js";
export type InstallerCommand = "install" | "status" | "doctor" | "uninstall";
/** Expand a CLI target (firefox | thunderbird | mozilla) to app list. */
export declare function expandAppTarget(target: InstallAppTarget | undefined): AgentApp[];
export type PlatformName = NodeJS.Platform | "linux" | "macos" | "windows";
export declare function normalizePlatform(p: PlatformName): "linux" | "darwin" | "win32";
export interface InstallerContext {
    /** Root of the installed @pi-browser/agent package (defaults to this package's root). */
    pkgRoot?: string;
    /** Override the native platform (tests). */
    platform?: PlatformName;
    /** Override home dir (tests). */
    homeDir?: string;
    /** Injectable exec (tests). */
    exec?: ExecFn;
    /** Injectable log sink. */
    log?: (line: string) => void;
    /** Override the built host entrypoint (defaults to <pkgRoot>/dist/native-host/main.js). */
    mainJs?: string;
    /** Applications to target: firefox | thunderbird | mozilla (both, default). */
    apps?: InstallAppTarget;
}
export interface CommandResult {
    ok: boolean;
    lines: string[];
}
export declare function defaultPkgRoot(): string;
export declare function buildEnv(ctx?: InstallerContext): {
    env: InstallerEnv;
    targets: InstallTargets;
    pkgRoot: string;
    mainJs: string;
};
export declare function runCommand(command: InstallerCommand, ctx?: InstallerContext): Promise<CommandResult>;
/**
 * Spawn the installed launcher and exchange one framed x-pi-browser/ping.
 * This verifies: manifest path is executable, the host boots, and framing
 * + JSON-RPC work end-to-end.
 */
export declare function probeHost(env: InstallerEnv, status: {
    manifestPath?: string;
    launcherPath?: string;
}, timeoutMs?: number): Promise<{
    ok: boolean;
    lines: string[];
}>;
export { PI_BROWSER_META };
/** Read the package version (for version-mismatch diagnostics). */
export declare function packageVersion(pkgRoot: string): string;
//# sourceMappingURL=index.d.ts.map