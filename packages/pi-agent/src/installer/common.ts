/**
 * Native Messaging host installation (PRODUCT.md §9–11; THUNDERBIRD-PLAN.md
 * §2, §23 — application-neutral `dev.pi.agent` host shared by Firefox and
 * Thunderbird).
 *
 * One host implementation, per-app manifest locations:
 *
 *   Linux:   ~/.mozilla/native-messaging-hosts/dev.pi.agent.json
 *            (single file: both Firefox and Thunderbird read this directory)
 *   macOS:   Firefox:     ~/Library/Application Support/Mozilla/NativeMessagingHosts/dev.pi.agent.json
 *            Thunderbird: ~/Library/Mozilla/NativeMessagingHosts/dev.pi.agent.json
 *   Windows: manifest inside the package +
 *            HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\dev.pi.agent
 *            (single key: both applications read the same registry location)
 *
 * No separately downloaded bridge: the launcher execs the bundled Node
 * host (same JS implementation on every platform).
 */
import { PI_AGENT, PI_BROWSER } from "@pi-browser/protocol";

/** Application-neutral host name (manifest `name`). */
export const NATIVE_HOST_NAME = PI_AGENT.nativeHost;
/** Legacy Firefox host name; removed on uninstall for cleanup. */
export const LEGACY_NATIVE_HOST_NAME = PI_AGENT.legacyNativeHost;
/** All add-on IDs the host manifest authorizes (plan §2). */
export const ALLOWED_EXTENSIONS: string[] = [...PI_AGENT.authorizedExtensions];

export type AgentApp = "firefox" | "thunderbird";
/** CLI target: one app or both. */
export type InstallAppTarget = AgentApp | "mozilla";

export const AGENT_APPS: readonly AgentApp[] = ["firefox", "thunderbird"];

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

export function buildManifest(launcherPath: string): NativeHostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: "Pi Agent Desktop Integration",
    path: launcherPath,
    type: "stdio",
    allowed_extensions: ALLOWED_EXTENSIONS,
  };
}

/**
 * Per-app, per-platform manifest file paths. On Linux and Windows both apps
 * share one location (plan §23); on macOS the two applications use
 * different per-user directories.
 */
export function manifestPathsForApps(apps: readonly AgentApp[], homeDir: string, platform: string): Record<AgentApp, string> {
  const firefox =
    platform === "darwin"
      ? `${homeDir}/Library/Application Support/Mozilla/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`
      : `${homeDir}/.mozilla/native-messaging-hosts/${NATIVE_HOST_NAME}.json`;
  const thunderbird =
    platform === "darwin"
      ? `${homeDir}/Library/Mozilla/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`
      : `${homeDir}/.mozilla/native-messaging-hosts/${NATIVE_HOST_NAME}.json`;
  const paths: Record<AgentApp, string> = { firefox, thunderbird };
  for (const app of apps) if (!(app in paths)) throw new Error(`unknown app: ${app}`);
  return paths;
}

/**
 * Distinct manifest files to write for the requested apps (on shared
 * platforms both apps resolve to one file). Each entry names the apps it
 * serves so status can report per-app.
 */
export function distinctManifestLocations(
  apps: readonly AgentApp[],
  homeDir: string,
  platform: string,
): Array<{ path: string; apps: AgentApp[] }> {
  const perApp = manifestPathsForApps(apps, homeDir, platform);
  const byPath = new Map<string, AgentApp[]>();
  for (const app of apps) {
    const p = perApp[app];
    byPath.set(p, [...(byPath.get(p) ?? []), app]);
  }
  return [...byPath.entries()].map(([path, apps]) => ({ path, apps }));
}

/** Legacy (dev.pi.browser) manifest path for the given app — cleanup only. */
export function legacyManifestPath(app: AgentApp, homeDir: string, platform: string): string | undefined {
  if (platform === "win32") return undefined; // legacy Windows registration used the same shared key
  const dir = app === "firefox" ? "Library/Application Support/Mozilla/NativeMessagingHosts" : "Library/Mozilla/NativeMessagingHosts";
  if (platform === "darwin") return `${homeDir}/${dir}/${LEGACY_NATIVE_HOST_NAME}.json`;
  return `${homeDir}/.mozilla/native-messaging-hosts/${LEGACY_NATIVE_HOST_NAME}.json`;
}

/** Windows registry key (per-user; no admin required). Both apps share it. */
export const WINDOWS_REGISTRY_KEY = `SOFTWARE\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
/** Legacy Windows registry key (removed during uninstall cleanup). */
export const WINDOWS_LEGACY_REGISTRY_KEY = `SOFTWARE\\Mozilla\\NativeMessagingHosts\\${LEGACY_NATIVE_HOST_NAME}`;

export function shLauncherContent(nodePath: string, mainJs: string): string {
  return `#!/bin/sh\nexec "${nodePath}" "${mainJs}" "$@"\n`;
}

export function cmdLauncherContent(nodePath: string, mainJs: string): string {
  return `@echo off\n"${nodePath}" "${mainJs}" %*\n`;
}

/** Friendly load-instructions for an app's built add-on (status/install output). */
export function addonLoadHint(app: AgentApp): string {
  return app === "firefox"
    ? "load the Firefox add-on (firefox/dist/manifest.json, id " + PI_BROWSER.extensionId + "): Firefox → about:debugging#aboutThisFirefoxBrowser → “Load Temporary Add-on…” → pick firefox/dist/manifest.json"
    : "load the Thunderbird add-on (thunderbird/dist/manifest.json, id pi-agent-thunderbird@matbee.com): Thunderbird → about:debugging#aboutThisThunderbird → “Load Temporary Add-on…” → pick thunderbird/dist/manifest.json";
}
