/** Application-neutral host name (manifest `name`). */
export declare const NATIVE_HOST_NAME: "dev.pi.agent";
/** Legacy Firefox host name; removed on uninstall for cleanup. */
export declare const LEGACY_NATIVE_HOST_NAME: "dev.pi.browser";
/** All add-on IDs the host manifest authorizes (plan §2). */
export declare const ALLOWED_EXTENSIONS: string[];
export type AgentApp = "firefox" | "thunderbird";
/** CLI target: one app or both. */
export type InstallAppTarget = AgentApp | "mozilla";
export declare const AGENT_APPS: readonly AgentApp[];
export interface NativeHostManifest {
    name: string;
    description: string;
    path: string;
    type: "stdio";
    allowed_extensions: string[];
}
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;
export interface InstallerEnv {
    homeDir: string;
    /** Injectable for Windows registry access and tests. */
    exec: ExecFn;
    platform: NodeJS.Platform | "linux" | "darwin" | "win32";
}
export declare function buildManifest(launcherPath: string): NativeHostManifest;
/**
 * Per-app, per-platform manifest file paths. On Linux and Windows both apps
 * share one location (plan §23); on macOS the two applications use
 * different per-user directories.
 */
export declare function manifestPathsForApps(apps: readonly AgentApp[], homeDir: string, platform: string): Record<AgentApp, string>;
/**
 * Distinct manifest files to write for the requested apps (on shared
 * platforms both apps resolve to one file). Each entry names the apps it
 * serves so status can report per-app.
 */
export declare function distinctManifestLocations(apps: readonly AgentApp[], homeDir: string, platform: string): Array<{
    path: string;
    apps: AgentApp[];
}>;
/** Legacy (dev.pi.browser) manifest path for the given app — cleanup only. */
export declare function legacyManifestPath(app: AgentApp, homeDir: string, platform: string): string | undefined;
/** Windows registry key (per-user; no admin required). Both apps share it. */
export declare const WINDOWS_REGISTRY_KEY: string;
/** Legacy Windows registry key (removed during uninstall cleanup). */
export declare const WINDOWS_LEGACY_REGISTRY_KEY: string;
export declare function shLauncherContent(nodePath: string, mainJs: string): string;
export declare function cmdLauncherContent(nodePath: string, mainJs: string): string;
/** Friendly load-instructions for an app's built add-on (status/install output). */
export declare function addonLoadHint(app: AgentApp): string;
//# sourceMappingURL=common.d.ts.map