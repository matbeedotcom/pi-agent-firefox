/**
 * Where the host keeps its files (openspec rename-trusted-user-agent D4).
 *
 * Everything lives under `~/.trusted-ua/` (v0.4.0: `~/.pi/browser`,
 * `~/.pi/run`, `~/.pi/workspaces`, `~/.pi/browser-repl`, `~/.pi-browser`).
 * A data file that doesn't exist in the new place is read from the old one;
 * writes always go to the new place, so the first write migrates it. Old
 * files are never deleted. Environment overrides (tests, custom setups) are
 * used as given, with no fallback.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envValue } from "./env.js";

/** Name of the per-user directory under $HOME. */
export const HOME_DIR_NAME = ".trusted-ua";

/** `~/.trusted-ua` (or `homeDir/.trusted-ua`). */
export function homeRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, HOME_DIR_NAME);
}

/** The v0.4.0 data root, `~/.pi/browser`. */
export function legacyDataRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".pi", "browser");
}

/** Data root: TRUSTED_UA_DATA_ROOT / PI_BROWSER_DATA_ROOT, else `~/.trusted-ua`. */
export function dataRoot(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return envValue("DATA_ROOT", env)?.trim() || homeRoot(homeDir);
}

/**
 * A data file to write: `<data root>/<name>`, or the file an env override
 * names (`fileEnv`, e.g. "PERMISSIONS_FILE").
 */
export function dataFile(name: string, fileEnv?: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = fileEnv ? envValue(fileEnv, env)?.trim() : undefined;
  return override || path.join(dataRoot(env, homeDir), name);
}

/**
 * A data file to read: the new path when it exists or when an override
 * applies; otherwise the v0.4.0 file in `~/.pi/browser` if that exists.
 */
export function readableDataFile(name: string, fileEnv?: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const target = dataFile(name, fileEnv, env, homeDir);
  const overridden = (fileEnv && envValue(fileEnv, env)?.trim()) || envValue("DATA_ROOT", env)?.trim();
  if (overridden || existsSync(target)) return target;
  const legacy = path.join(legacyDataRoot(homeDir), name);
  return existsSync(legacy) ? legacy : target;
}

/** Broker run dir (sockets, pipes, state): TRUSTED_UA_BROKER_DIR / PI_BROWSER_BROKER_DIR, else `~/.trusted-ua/run`. */
export function runDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return envValue("BROKER_DIR", env)?.trim() || path.join(homeRoot(homeDir), "run");
}

/** Per-task workspaces for new sessions: TRUSTED_UA_WORKSPACE_DIR, else `~/.trusted-ua/workspaces`. */
export function workspacesRoot(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return envValue("WORKSPACE_DIR", env)?.trim() || path.join(homeRoot(homeDir), "workspaces");
}

/** `javascript` REPL scratch for unbound sessions: TRUSTED_UA_REPL_DIR, else `~/.trusted-ua/repl`. */
export function replRoot(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return envValue("REPL_DIR", env)?.trim() || path.join(homeRoot(homeDir), "repl");
}

/** Host logs: `~/.trusted-ua/logs`. */
export function logsDir(homeDir: string = os.homedir()): string {
  return path.join(homeRoot(homeDir), "logs");
}

/** Add-on heartbeat file: TRUSTED_UA_HEARTBEAT_FILE, else `~/.trusted-ua/client.heartbeat`. */
export function heartbeatFile(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return envValue("HEARTBEAT_FILE", env)?.trim() || path.join(homeRoot(homeDir), "client.heartbeat");
}

/** The v0.4.0 heartbeat file, `~/.pi-browser/client.heartbeat` (status reads it when the new one is absent). */
export function legacyHeartbeatFile(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".pi-browser", "client.heartbeat");
}
