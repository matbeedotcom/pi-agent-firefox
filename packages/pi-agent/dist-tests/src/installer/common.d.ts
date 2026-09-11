export declare const NATIVE_HOST_NAME: "dev.pi.browser";
export declare const ALLOWED_EXTENSIONS: string[];
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
export declare function linuxManifestPath(homeDir: string): string;
export declare function macosManifestPath(homeDir: string): string;
/** Windows registry key (per-user; no admin required). */
export declare const WINDOWS_REGISTRY_KEY: string;
export declare function shLauncherContent(nodePath: string, mainJs: string): string;
export declare function cmdLauncherContent(nodePath: string, mainJs: string): string;
//# sourceMappingURL=common.d.ts.map