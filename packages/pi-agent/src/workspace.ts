/**
 * TaskWorkspace — per-task (per-ACP-session) filesystem scratch.
 *
 * Every task the agent runs gets its own private directory. It becomes the
 * Pi session's cwd, so the model's native file tools (read/write/edit/bash)
 * operate inside the task's scratch by default, and the `javascript` REPL is
 * bound to the same directory (AcpAgent.bindWorkspace) so cell artifacts,
 * checkpoints, images and documents all land in one place per task.
 *
 * A directory is provisioned before the Pi session is created (the cwd is a
 * creation-time argument), so its name is a timestamp+random slug, not the
 * Pi session id. The session-id -> directory mapping is owned by AcpAgent
 * (state.cwd) and pushed to the REPL provider via ReplProvider.bindWorkspace.
 */
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface TaskWorkspaceOptions {
  /** Root for per-task workspaces (default ~/.pi/workspaces, env PI_BROWSER_WORKSPACE_DIR). */
  root?: string;
}

/** A cwd that carries no user intent — the add-on's "create with empty field" fallback. */
export function isNeutralCwd(cwd: string | undefined | null): boolean {
  if (typeof cwd !== "string") return true;
  const trimmed = cwd.trim();
  if (trimmed === "") return true;
  if (trimmed === "/" || trimmed === "\\") return true;
  // A bare home directory is not a meaningful task scratch.
  if (trimmed === os.homedir()) return true;
  return false;
}

export class TaskWorkspace {
  readonly root: string;

  constructor(opts: TaskWorkspaceOptions = {}) {
    this.root = opts.root ?? process.env.PI_BROWSER_WORKSPACE_DIR ?? path.join(os.homedir(), ".pi", "workspaces");
  }

  /**
   * Provision a fresh per-task directory and return its absolute path.
   * Named `YYYYMMDD-HHMMSS-<6hex>` so listings sort by creation time and two
   * fast creations can never collide.
   */
  async create(): Promise<string> {
    const name = this.freshName();
    const dir = path.join(this.root, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Deterministic directory for a session id (resume/load + legacy REPL fallback). */
  for(sessionId: string): string {
    return path.join(this.root, this.sanitize(sessionId));
  }

  /** mkdir 0700 the session-id-keyed directory and return its path. */
  async ensure(sessionId: string): Promise<string> {
    const dir = this.for(sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private freshName(): string {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const stamp =
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${stamp}-${randomBytes(3).toString("hex")}`;
  }

  private sanitize(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, "_");
  }
}
