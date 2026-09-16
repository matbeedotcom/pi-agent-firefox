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
 * Only tools with a non-default decision are stored; absence means "ask".
 * v1 files ({"tools": {"name": true}}) are migrated on load (true → allow).
 * The file is small (one key per tool), so synchronous fs calls are fine;
 * writes are atomic (tmp + rename) so a crash never leaves a truncated file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionToolState } from "@pi-browser/protocol";

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
}

interface PermissionFileV1 {
  version: 1;
  tools: Record<string, boolean>;
}

export function defaultPermissionFilePath(): string {
  return process.env.PI_BROWSER_PERMISSIONS_FILE
    ? process.env.PI_BROWSER_PERMISSIONS_FILE
    : join(homedir(), ".pi", "browser", "permissions.json");
}

export class PermissionStore {
  private readonly filePath: string;
  /** Only non-default decisions are kept; absence = "ask". */
  private readonly tools = new Map<string, "allow" | "deny">();
  private loaded = false;

  constructor(options: PermissionStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultPermissionFilePath();
  }

  /** The backing file (tests, diagnostics). */
  get file(): string {
    return this.filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as
        | Partial<PermissionFileV2>
        | Partial<PermissionFileV1>;
      if (typeof raw.tools !== "object" || raw.tools === null) return;
      if (raw.version === 2) {
        for (const [name, state] of Object.entries(raw.tools as Record<string, unknown>)) {
          if (state === "allow" || state === "deny") this.tools.set(name, state);
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

  private persist(): void {
    const file: PermissionFileV2 = {
      version: 2,
      tools: Object.fromEntries([...this.tools.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
    renameSync(tmp, this.filePath);
  }
}
