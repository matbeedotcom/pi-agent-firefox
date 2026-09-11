/**
 * Native Messaging host installation (PRODUCT.md §9–11).
 *
 * One shared implementation, per-platform launcher + manifest locations:
 *
 *   Linux:   ~/.mozilla/native-messaging-hosts/dev.pi.browser.json
 *   macOS:   ~/Library/Application Support/Mozilla/NativeMessagingHosts/dev.pi.browser.json
 *   Windows: manifest inside the package + HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\dev.pi.browser
 *
 * No separately downloaded bridge: the launcher execs the bundled Node
 * host (same JS implementation on every platform).
 */
import { PI_BROWSER } from "@pi-browser/protocol";
export const NATIVE_HOST_NAME = PI_BROWSER.nativeHost;
export const ALLOWED_EXTENSIONS = [PI_BROWSER.extensionId];
export function buildManifest(launcherPath) {
    return {
        name: NATIVE_HOST_NAME,
        description: "Pi Coding Agent Browser Integration",
        path: launcherPath,
        type: "stdio",
        allowed_extensions: ALLOWED_EXTENSIONS,
    };
}
export function linuxManifestPath(homeDir) {
    return `${homeDir}/.mozilla/native-messaging-hosts/${NATIVE_HOST_NAME}.json`;
}
export function macosManifestPath(homeDir) {
    return `${homeDir}/Library/Application Support/Mozilla/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`;
}
/** Windows registry key (per-user; no admin required). */
export const WINDOWS_REGISTRY_KEY = `SOFTWARE\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
export function shLauncherContent(nodePath, mainJs) {
    return `#!/bin/sh\nexec "${nodePath}" "${mainJs}" "$@"\n`;
}
export function cmdLauncherContent(nodePath, mainJs) {
    return `@echo off\n"${nodePath}" "${mainJs}" %*\n`;
}
//# sourceMappingURL=common.js.map