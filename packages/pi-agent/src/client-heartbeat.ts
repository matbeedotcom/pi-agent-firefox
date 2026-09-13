/**
 * Client (add-on) heartbeat: the host-side presence signal for onboarding
 * (PRODUCT.md §8, onboarding/auto-detection).
 *
 * The add-on holds the Native Messaging port, so the host cannot enumerate
 * add-ons; instead the host records when the add-on connects (ACP
 * initialize) and on every keepalive ping. The installer CLI
 * (/pi-browser status|doctor) reads the file to report whether the add-on
 * side of the onboarding is complete, in either install order:
 *
 *   - plugin first:  doctor shows "add-on: not detected" until it is loaded
 *   - add-on first:  the add-on auto-detects the installed host; once it
 *     connects, the heartbeat appears and status flips to "detected"
 *
 * The file is best-effort: a filesystem hiccup must never break the protocol
 * path. Contents are non-sensitive (timestamp, client identity, pid).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Client names the add-ons send in ACP `initialize` (acp-client.ts).
 * The host records a heartbeat for any recognized client so the installer
 * can report per-app add-on presence (plan §23: both apps share the host).
 */
export const ADDON_CLIENT_NAMES: readonly string[] = [
  "pi-browser-firefox",
  "pi-firefox",
  "pi-thunderbird",
];
/** Legacy single-client constant (kept for tests/references). */
export const ADDON_CLIENT_NAME = "pi-browser-firefox";

export function isKnownAddonClient(name: string | undefined): name is string {
  return typeof name === "string" && ADDON_CLIENT_NAMES.includes(name);
}

/** A heartbeat younger than this counts as "add-on connected" (3x the 10s ping). */
export const ADDON_HEARTBEAT_FRESH_MS = 90_000;

export interface ClientHeartbeat {
  ts: number;
  client: string;
  version?: string;
  pid: number;
}

/** Application a client name belongs to (for per-app heartbeat files). */
export function applicationForClient(name: string | undefined): "firefox" | "thunderbird" | undefined {
  if (name === "pi-thunderbird") return "thunderbird";
  if (name === "pi-browser-firefox" || name === "pi-firefox") return "firefox";
  return undefined;
}

/**
 * Heartbeat file locations (env override for tests; default under $HOME).
 * Legacy single file (latest client) + per-app files so status/doctor can
 * report both applications independently (plan §23, cross-app broker).
 */
export function heartbeatPathForHome(homeDir: string): string {
  return process.env.PI_BROWSER_HEARTBEAT_FILE || path.join(homeDir, ".pi-browser", "client.heartbeat");
}

export function heartbeatPath(): string {
  return heartbeatPathForHome(os.homedir());
}

/** Per-app heartbeat file (e.g. client.heartbeat.thunderbird). */
export function appHeartbeatPath(homeDir: string, application: "firefox" | "thunderbird"): string {
  const dir = process.env.PI_BROWSER_HEARTBEAT_FILE
    ? path.dirname(process.env.PI_BROWSER_HEARTBEAT_FILE)
    : path.join(homeDir, ".pi-browser");
  return path.join(dir, `client.heartbeat.${application}`);
}

/**
 * Record add-on presence. No-op for non-add-on clients (e.g. test harnesses).
 * Writes the legacy single file (latest client) AND the per-app file so
 * /pi-browser status|doctor can report both applications (plan §23).
 * Best-effort: never throws.
 */
export function touchClientHeartbeat(
  clientName: string | undefined,
  clientVersion?: string,
  application?: "firefox" | "thunderbird",
): void {
  try {
    if (!isKnownAddonClient(clientName)) return;
    const file = heartbeatPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const hb: ClientHeartbeat = {
      ts: Date.now(),
      client: clientName,
      ...(clientVersion ? { version: clientVersion } : {}),
      pid: process.pid,
    };
    writeFileSync(file, JSON.stringify(hb));
    const app = application ?? applicationForClient(clientName);
    if (app) {
      writeFileSync(appHeartbeatPath(os.homedir(), app), JSON.stringify(hb));
    }
  } catch {
    // best-effort only — the protocol path must never break on this
  }
}

/**
 * Read the add-on heartbeat, or undefined when absent/unreadable.
 * With `application`, reads the per-app file (falling back to the legacy
 * file when its client belongs to that application).
 */
export function readClientHeartbeat(
  homeDir: string,
  application?: "firefox" | "thunderbird",
): (ClientHeartbeat & { ageMs: number }) | undefined {
  const files: string[] = application
    ? [appHeartbeatPath(homeDir, application), heartbeatPathForHome(homeDir)]
    : [heartbeatPathForHome(homeDir)];
  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      const raw = JSON.parse(readFileSync(file, "utf8")) as ClientHeartbeat;
      if (typeof raw.ts !== "number" || !isKnownAddonClient(raw.client)) continue;
      if (application && applicationForClient(raw.client) !== application) continue;
      return { ...raw, ageMs: Date.now() - raw.ts };
    } catch {
      // try the next file
    }
  }
  return undefined;
}
