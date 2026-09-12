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

/** Heartbeat file location (env override for tests; default under $HOME). */
export function heartbeatPathForHome(homeDir: string): string {
  return process.env.PI_BROWSER_HEARTBEAT_FILE || path.join(homeDir, ".pi-browser", "client.heartbeat");
}

export function heartbeatPath(): string {
  return heartbeatPathForHome(os.homedir());
}

/**
 * Record add-on presence. No-op for non-add-on clients (e.g. test harnesses).
 * Best-effort: never throws.
 */
export function touchClientHeartbeat(clientName: string | undefined, clientVersion?: string): void {
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
  } catch {
    // best-effort only — the protocol path must never break on this
  }
}

/** Read the latest add-on heartbeat, or undefined when absent/unreadable. */
export function readClientHeartbeat(homeDir: string): (ClientHeartbeat & { ageMs: number }) | undefined {
  try {
    const file = heartbeatPathForHome(homeDir);
    if (!existsSync(file)) return undefined;
    const raw = JSON.parse(readFileSync(file, "utf8")) as ClientHeartbeat;
    if (typeof raw.ts !== "number" || !isKnownAddonClient(raw.client)) return undefined;
    return { ...raw, ageMs: Date.now() - raw.ts };
  } catch {
    return undefined;
  }
}
