/**
 * Workspace-scoped `fs` global for the `javascript` REPL realm
 * (BROWSER-USE-REPL-PLAN.md).
 *
 * The cell code runs with full Node privileges in the worker child (the
 * realm is a convenience boundary, not a privilege boundary — PRODUCT.md
 * §49.11). The `fs` global is the curated exception for filesystem work:
 * every path is resolved against the session's task workspace and rejected
 * when it escapes it — lexically (`..`, absolute paths outside the root,
 * NUL bytes) and against symlinked ancestors (a symlinked directory inside
 * the workspace pointing out of it is refused). The same root `artifact()`
 * and `checkpoint()` write into, so `fs` can read what a cell saved and
 * what the agent's native tools wrote to the session cwd.
 *
 * Pure and worker-free so it is unit-testable without the V8 realm.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";

/** Error thrown for any path that cannot be resolved inside the workspace. */
export class ReplFsError extends Error {
  constructor(
    message: string,
    readonly code: "ESCAPE" | "INVALID_PATH",
  ) {
    super(message);
    this.name = "ReplFsError";
  }
}

export interface ReplFsEntry {
  name: string;
  /** Path relative to the workspace root (forward slashes). */
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
}

export interface ReplFsStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * The `fs` object exposed to the REPL realm. All paths are relative to the
 * workspace root (absolute paths are accepted only when they stay inside
 * it); every method is async and rejects with ReplFsError for escapes.
 */
export interface ReplFs {
  /** The workspace root (absolute path). */
  cwd(): Promise<string>;
  /** Read a file: utf8 string by default, Buffer with "buffer". */
  read(filePath: string, encoding?: "utf8" | "buffer"): Promise<string | Buffer>;
  /** Write a file (string is utf8, Buffer as-is); creates parent dirs. Returns bytes written. */
  write(filePath: string, data: string | Buffer, encoding?: "utf8" | "buffer"): Promise<number>;
  /** Append to a file (creates it and parent dirs when missing). Returns bytes written. */
  append(filePath: string, data: string | Buffer, encoding?: "utf8" | "buffer"): Promise<number>;
  /** Create a directory (recursive by default). */
  mkdir(dirPath: string, opts?: { recursive?: boolean }): Promise<string>;
  /** List a directory (workspace root when path omitted). */
  list(dirPath?: string): Promise<ReplFsEntry[]>;
  /** Stat a file/directory; null when it does not exist. */
  stat(filePath: string): Promise<ReplFsStat | null>;
  /** True when the path exists (no throw for missing paths). */
  exists(filePath: string): Promise<boolean>;
  /** Rename/move within the workspace. */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file. */
  unlink(filePath: string): Promise<void>;
  /** Delete a file, or a directory tree (recursive by default). Never the workspace root. */
  rm(target: string, opts?: { recursive?: boolean }): Promise<void>;
}

export function createReplFs(workspace: string): ReplFs {
  const root = path.resolve(workspace);
  let realRoot: string | undefined;

  function resolveInside(p: string, label: string): string {
    if (typeof p !== "string" || p.length === 0) {
      throw new ReplFsError(`fs.${label}: path must be a non-empty string`, "INVALID_PATH");
    }
    if (p.includes("\0")) {
      throw new ReplFsError(`fs.${label}: path contains a NUL byte`, "INVALID_PATH");
    }
    const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new ReplFsError(`fs.${label}: path escapes the workspace: ${p}`, "ESCAPE");
    }
    assertRealPathInside(resolved, p, label);
    return resolved;
  }

  /**
   * Symlink containment: find the deepest existing ancestor of `resolved`,
   * realpath it, and require it to stay inside the real workspace root.
   * Catches symlinked directories (or files) inside the workspace that
   * point outside of it.
   */
  function assertRealPathInside(resolved: string, p: string, label: string): void {
    if (realRoot === undefined) {
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        return; // root missing (created before first use); lexical check already passed
      }
    }
    let ancestor = resolved;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break; // reached the filesystem root
      ancestor = parent;
    }
    if (ancestor === root) return;
    let real: string;
    try {
      real = fs.realpathSync(ancestor);
    } catch {
      return; // raced with deletion; lexical check stands
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new ReplFsError(`fs.${label}: path escapes the workspace (symlink): ${p}`, "ESCAPE");
    }
  }

  function toRel(resolved: string): string {
    return path.relative(root, resolved).split(path.sep).join("/");
  }

  function toData(data: string | Buffer): Buffer {
    return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  }

  return {
    async cwd() {
      return root;
    },

    async read(filePath, encoding = "utf8") {
      const resolved = resolveInside(filePath, "read");
      try {
        if (encoding === "buffer") return await fsp.readFile(resolved);
        return await fsp.readFile(resolved, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ReplFsError(`fs.read: no such file: ${filePath}`, "INVALID_PATH");
        }
        throw err;
      }
    },

    async write(filePath, data, encoding = "utf8") {
      const resolved = resolveInside(filePath, "write");
      // Agent-ergonomic: nested paths create their parent directories.
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      const payload = encoding === "buffer" && typeof data === "string" ? Buffer.from(data, "utf8") : toData(data);
      await fsp.writeFile(resolved, payload);
      return payload.byteLength;
    },

    async append(filePath, data, encoding = "utf8") {
      const resolved = resolveInside(filePath, "append");
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      const payload = encoding === "buffer" && typeof data === "string" ? Buffer.from(data, "utf8") : toData(data);
      await fsp.appendFile(resolved, payload);
      return payload.byteLength;
    },

    async mkdir(dirPath, opts = {}) {
      const resolved = resolveInside(dirPath, "mkdir");
      await fsp.mkdir(resolved, { recursive: opts.recursive ?? true });
      return toRel(resolved);
    },

    async list(dirPath = ".") {
      const resolved = resolveInside(dirPath, "list");
      const entries = await fsp.readdir(resolved, { withFileTypes: true });
      return entries.map((e) => {
        const st = e.isSymbolicLink() ? undefined : fs.statSync(path.join(resolved, e.name));
        return {
          name: e.name,
          path: toRel(path.join(resolved, e.name)),
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
          isSymbolicLink: e.isSymbolicLink(),
          size: st?.size ?? 0,
        };
      });
    },

    async stat(filePath) {
      const resolved = resolveInside(filePath, "stat");
      try {
        const st = await fsp.stat(resolved); // follows symlinks (validated above)
        return {
          size: st.size,
          mtimeMs: st.mtimeMs,
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          isSymbolicLink: (await fsp.lstat(resolved)).isSymbolicLink(),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async exists(filePath) {
      const resolved = resolveInside(filePath, "exists");
      try {
        await fsp.access(resolved);
        return true;
      } catch {
        return false;
      }
    },

    async rename(from, to) {
      const resolvedFrom = resolveInside(from, "rename");
      const resolvedTo = resolveInside(to, "rename");
      await fsp.rename(resolvedFrom, resolvedTo);
    },

    async unlink(filePath) {
      const resolved = resolveInside(filePath, "unlink");
      await fsp.unlink(resolved);
    },

    async rm(target, opts = {}) {
      const resolved = resolveInside(target, "rm");
      if (resolved === root) {
        throw new ReplFsError("fs.rm: refusing to delete the workspace root", "ESCAPE");
      }
      const recursive = opts.recursive ?? true;
      await fsp.rm(resolved, { recursive, force: false });
    },
  };
}
