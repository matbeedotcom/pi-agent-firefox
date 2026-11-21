/**
 * Persistent per-tool permission store (PRODUCT.md §55, 2026-09-15).
 *
 * Every add-on tool is approval-gated; the user's persistent decision for
 * each tool — "ask" (default), "deny", or "allow" — is remembered HERE, in a
 * small JSON file under ~/.pi/browser, so it survives host restarts and is
 * shared by every connected application (the broker process is the single
 * owner of this state). The add-on's Configuration page renders and edits
 * exactly this state.
 *
 * File format (v2):
 *   { "version": 2, "tools": { "mail_search": "allow", "mail_move": "deny" } }
 *
 * External MCP callers (v0.3.0) add two optional keys to the same v2 file:
 *   "callers": { "firefox": { "codex": "allow" }, "thunderbird": { "x": "deny" } }
 *   "externalAccess": false        (stored only when turned off; default on)
 * Older hosts ignore both keys.
 *
 * Only tools with a non-default decision are stored; absence means "ask".
 * v1 files ({"tools": {"name": true}}) are migrated on load (true → allow).
 * The file is small (one key per tool), so synchronous fs calls are fine;
 * writes are atomic (tmp + rename) so a crash never leaves a truncated file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentApplication,
  CallerPermissionEntry,
  CallerPermissionState,
  PermissionToolState,
} from "@trusted-ua/protocol";
import { dataFile, readableDataFile } from "./paths.js";

export interface PermissionStoreOptions {
  /**
   * File to persist to. Defaults to ~/.pi/browser/permissions.json;
   * PI_BROWSER_PERMISSIONS_FILE overrides (test seam / custom locations).
   */
  filePath?: string;
}

interface PermissionFileV2 {
  version: 2;
  tools: Record<string, "allow" | "deny">;
  callers?: Partial<Record<AgentApplication, Record<string, CallerPermissionState>>>;
  externalAccess?: boolean;
}

const CALLER_APPS: readonly AgentApplication[] = ["firefox", "thunderbird"];

interface PermissionFileV1 {
  version: 1;
  tools: Record<string, boolean>;
}

/** Where decisions are saved (TRUSTED_UA_PERMISSIONS_FILE overrides). */
export function defaultPermissionFilePath(): string {
  return dataFile("permissions.json", "PERMISSIONS_FILE");
}

/** Where saved decisions are read from: the saved file, else the v0.4.0 one in ~/.pi/browser. */
export function defaultPermissionReadPath(): string {
  return readableDataFile("permissions.json", "PERMISSIONS_FILE");
}

export class PermissionStore {
  private readonly filePath: string;
  /** Read from here when it differs from filePath (v0.4.0 file not migrated yet). */
  private readonly readPath: string;
  /** Only non-default decisions are kept; absence = "ask". */
  private readonly tools = new Map<string, "allow" | "deny">();
  /** Remembered caller decisions: "<app>\u0000<name>" → allow | deny. */
  private readonly callers = new Map<string, CallerPermissionState>();
  private externalAccess = true;
  private loaded = false;

  constructor(options: PermissionStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultPermissionFilePath();
    this.readPath = options.filePath ?? defaultPermissionReadPath();
  }

  /** The backing file (tests, diagnostics). */
  get file(): string {
    return this.filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.readPath)) return;
      const raw = JSON.parse(readFileSync(this.readPath, "utf8")) as
        | Partial<PermissionFileV2>
        | Partial<PermissionFileV1>;
      if (typeof raw.tools !== "object" || raw.tools === null) return;
      if (raw.version === 2) {
        for (const [name, state] of Object.entries(raw.tools as Record<string, unknown>)) {
          if (state === "allow" || state === "deny") this.tools.set(name, state);
        }
        const v2 = raw as Partial<PermissionFileV2>;
        if (v2.externalAccess === false) this.externalAccess = false;
        if (typeof v2.callers === "object" && v2.callers !== null) {
          for (const app of CALLER_APPS) {
            const byName = (v2.callers as Record<string, unknown>)[app];
            if (typeof byName !== "object" || byName === null) continue;
            for (const [name, state] of Object.entries(byName as Record<string, unknown>)) {
              if (state === "allow" || state === "deny") this.callers.set(callerKey(app, name), state);
            }
          }
        }
      } else if (raw.version === 1) {
        // v1 stored only allows (true); migrate to the tri-state file.
        for (const [name, allowed] of Object.entries(raw.tools as Record<string, unknown>)) {
          if (allowed === true) this.tools.set(name, "allow");
        }
      }
    } catch {
      // Corrupt/unreadable file: start clean rather than crashing the host.
      // The user's decisions are lost, which is safe (worst case: prompts).
    }
  }

  /** The tool's persistent state ("ask" when no decision was stored). */
  getState(tool: string): PermissionToolState {
    this.ensureLoaded();
    return this.tools.get(tool) ?? "ask";
  }

  /** True when the tool is persistently allowed ("Always approve"). */
  isAllowed(tool: string): boolean {
    return this.getState(tool) === "allow";
  }

  /** True when the tool is persistently denied (refuse without asking). */
  isDenied(tool: string): boolean {
    return this.getState(tool) === "deny";
  }

  /**
   * Set the tool's persistent state. "ask" removes any stored decision.
   */
  setState(tool: string, state: PermissionToolState): void {
    this.ensureLoaded();
    if (state === "ask") this.tools.delete(tool);
    else this.tools.set(tool, state);
    this.persist();
  }

  /** Grant (state="allow") or revoke (state="ask") a tool's persistent allow. */
  setAllowed(tool: string, allowed: boolean): void {
    this.setState(tool, allowed ? "allow" : "ask");
  }

  /** Clear one tool's persistent decision (no-op when it was "ask"). */
  clear(tool: string): void {
    this.ensureLoaded();
    if (this.tools.delete(tool)) this.persist();
  }

  /** Clear every persistent decision. Returns the names that were cleared. */
  clearAll(): string[] {
    this.ensureLoaded();
    const cleared = [...this.tools.keys()].sort();
    this.tools.clear();
    if (cleared.length > 0) this.persist();
    return cleared;
  }

  /** Sorted list of currently-allowed tool names. */
  allowedTools(): string[] {
    this.ensureLoaded();
    return [...this.tools.entries()]
      .filter(([, s]) => s === "allow")
      .map(([t]) => t)
      .sort();
  }

  // ------------------------------------------------------------------
  // External MCP callers
  // ------------------------------------------------------------------

  /** Whether external MCP callers may use the tools at all (default true). */
  getExternalAccess(): boolean {
    this.ensureLoaded();
    return this.externalAccess;
  }

  setExternalAccess(on: boolean): void {
    this.ensureLoaded();
    this.externalAccess = on;
    this.persist();
  }

  /** A caller's remembered decision for one app (undefined = ask). */
  getCallerState(app: AgentApplication, name: string): CallerPermissionState | undefined {
    this.ensureLoaded();
    return this.callers.get(callerKey(app, name));
  }

  /** Remember (allow | deny) or forget ("ask") a caller's decision for one app. */
  setCallerState(app: AgentApplication, name: string, state: CallerPermissionState | "ask"): void {
    this.ensureLoaded();
    if (state === "ask") {
      if (!this.callers.delete(callerKey(app, name))) return;
    } else {
      this.callers.set(callerKey(app, name), state);
    }
    this.persist();
  }

  /** Every remembered caller decision, sorted by app then name. */
  listCallers(): CallerPermissionEntry[] {
    this.ensureLoaded();
    return [...this.callers.entries()]
      .map(([key, state]) => {
        const [application, name] = splitCallerKey(key);
        return { application, name, state };
      })
      .sort((a, b) => a.application.localeCompare(b.application) || a.name.localeCompare(b.name));
  }

  private persist(): void {
    const callers: NonNullable<PermissionFileV2["callers"]> = {};
    for (const { application, name, state } of this.listCallers()) {
      (callers[application] ??= {})[name] = state;
    }
    const file: PermissionFileV2 = {
      version: 2,
      tools: Object.fromEntries([...this.tools.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ...(Object.keys(callers).length > 0 ? { callers } : {}),
      ...(this.externalAccess ? {} : { externalAccess: false }),
    };
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
    renameSync(tmp, this.filePath);
  }
}

function callerKey(app: AgentApplication, name: string): string {
  return `${app}\u0000${name}`;
}

function splitCallerKey(key: string): [AgentApplication, string] {
  const i = key.indexOf("\u0000");
  return [key.slice(0, i) as AgentApplication, key.slice(i + 1)];
}
