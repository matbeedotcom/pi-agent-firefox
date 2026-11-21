/**
 * ReplFs workspace-sandbox tests (the `fs` global of the `javascript` REPL).
 *
 * Pure node tests of createReplFs — no worker, no V8 realm. The realm wiring
 * is covered by repl.test.ts (real worker) and tests/src/e2e.test.mjs
 * (real host).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReplFs, ReplFsError } from "../src/repl/fs-sandbox.js";

async function makeWorkspace() {
  const outside = await mkdtemp(path.join(tmpdir(), "pi-repl-fs-out-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-repl-fs-"));
  // A secret outside the workspace, reachable by absolute path and by a
  // symlink planted inside it.
  await writeFile(path.join(outside, "secret.txt"), "top-secret");
  return {
    workspace,
    outside,
    cleanup: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

test("fs: read/write/append round-trip (utf8 + Buffer)", async () => {
  const { workspace, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    const n = await fs.write("notes.txt", "hello");
    assert.equal(n, 5);
    assert.equal(await fs.read("notes.txt"), "hello");
    await fs.append("notes.txt", " world");
    assert.equal(await fs.read("notes.txt"), "hello world");
    const bytes = await fs.write("bin.dat", Buffer.from([1, 2, 3]), "buffer");
    assert.equal(bytes, 3);
    const buf = await fs.read("bin.dat", "buffer");
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual([...buf], [1, 2, 3]);
    // Paths always resolve from the workspace root, never from a nested cwd.
    await fs.mkdir("deep/nested");
    await fs.write("deep/nested/f.txt", "rooted");
    assert.equal(readFileSync(path.join(workspace, "deep/nested/f.txt"), "utf8"), "rooted");
    assert.equal(await fs.read("deep/nested/f.txt"), "rooted");
  } finally {
    await cleanup();
  }
});

test("fs: list/stat/exists", async () => {
  const { workspace, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    await fs.write("a.txt", "x");
    await fs.mkdir("dir");
    const entries = (await fs.list()).map((e) => e.name).sort();
    assert.deepEqual(entries, ["a.txt", "dir"]);
    const a = (await fs.list()).find((e) => e.name === "a.txt");
    assert.equal(a?.isFile, true);
    assert.equal(a?.size, 1);
    const dir = (await fs.list()).find((e) => e.name === "dir");
    assert.equal(dir?.isDirectory, true);
    const st = await fs.stat("a.txt");
    assert.equal(st?.isFile, true);
    assert.equal(st?.size, 1);
    assert.equal(await fs.stat("missing.txt"), null);
    assert.equal(await fs.exists("a.txt"), true);
    assert.equal(await fs.exists("missing.txt"), false);
  } finally {
    await cleanup();
  }
});

test("fs: rename/unlink/rm", async () => {
  const { workspace, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    await fs.write("one.txt", "1");
    await fs.rename("one.txt", "two.txt");
    assert.equal(await fs.exists("one.txt"), false);
    assert.equal(await fs.read("two.txt"), "1");
    await fs.unlink("two.txt");
    assert.equal(await fs.exists("two.txt"), false);
    await fs.mkdir("tree/sub");
    await fs.write("tree/sub/file.txt", "x");
    await fs.rm("tree");
    assert.equal(await fs.exists("tree"), false);
  } finally {
    await cleanup();
  }
});

test("fs: lexical escapes are rejected", async () => {
  const { workspace, outside, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    for (const p of ["../escape.txt", "./a/../../escape.txt", "a/../b/../../escape.txt", path.join(outside, "secret.txt"), "/etc/passwd"]) {
      await assert.rejects(() => fs.read(p), (err: unknown) => {
        assert.ok(err instanceof ReplFsError, `expected ReplFsError, got ${err}`);
        return true;
      }, `read(${p})`);
      await assert.rejects(() => fs.write(p, "x"), (err: unknown) => err instanceof ReplFsError, `write(${p})`);
      await assert.rejects(() => fs.stat(p), (err: unknown) => err instanceof ReplFsError, `stat(${p})`);
      await assert.rejects(() => fs.list(p), (err: unknown) => err instanceof ReplFsError, `list(${p})`);
    }
    // NUL byte and non-string paths.
    await assert.rejects(() => fs.read("a\0b"), (err: unknown) => err instanceof ReplFsError, "NUL byte");
    await assert.rejects(() => fs.read(42 as never), (err: unknown) => err instanceof ReplFsError, "non-string");
    await assert.rejects(() => fs.read(""), (err: unknown) => err instanceof ReplFsError, "empty string");
    // The outside file was never touched.
    assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "top-secret");
  } finally {
    await cleanup();
  }
});

test("fs: symlink escapes are rejected", async () => {
  const { workspace, outside, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    // Directory symlink pointing outside.
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"), "file");
    await assert.rejects(() => fs.read("link.txt"), (err: unknown) => err instanceof ReplFsError && err.code === "ESCAPE", "file symlink");
    const linkDir = path.join(workspace, "dirlink");
    await symlink(path.dirname(path.join(outside, "secret.txt")), linkDir, "dir");
    await assert.rejects(() => fs.read("dirlink/secret.txt"), (err: unknown) => err instanceof ReplFsError && err.code === "ESCAPE", "dir symlink");
    await assert.rejects(() => fs.write("dirlink/new.txt", "x"), (err: unknown) => err instanceof ReplFsError && err.code === "ESCAPE", "write through dir symlink");
    // A symlink pointing INSIDE the workspace is fine.
    await fs.write("inner.txt", "in");
    await symlink(path.join(workspace, "inner.txt"), path.join(workspace, "inner-link.txt"), "file");
    assert.equal(await fs.read("inner-link.txt"), "in");
    // The outside file was never touched.
    assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "top-secret");
  } finally {
    await cleanup();
  }
});

test("fs: rm/unlink of the workspace root is refused", async () => {
  const { workspace, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    await assert.rejects(() => fs.rm("."), (err: unknown) => err instanceof ReplFsError, "rm root (relative)");
    await assert.rejects(() => fs.rm(workspace), (err: unknown) => err instanceof ReplFsError, "rm root (absolute)");
    await assert.rejects(() => fs.rm(".."), (err: unknown) => err instanceof ReplFsError, "rm ..");
    // The root is still intact.
    assert.ok(statSync(workspace).isDirectory());
  } finally {
    await cleanup();
  }
});

test("fs: cwd reports the workspace root", async () => {
  const { workspace, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    assert.equal(await fs.cwd(), path.resolve(workspace));
  } finally {
    await cleanup();
  }
});

test("fs: mkdir returns a relative path and list shows nested entries", async () => {
  const { workspace, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    const rel = await fs.mkdir("a/b/c");
    assert.equal(rel, "a/b/c");
    await fs.write("a/b/c/x.txt", "deep");
    const mid = await fs.list("a/b");
    assert.deepEqual(mid.map((e) => e.name), ["c"]);
    assert.equal((await fs.read("a/b/c/x.txt")), "deep");
    // mkdir on an existing directory is a no-op (recursive default).
    await fs.mkdir("a");
  } finally {
    await cleanup();
  }
});

test("fs: missing-file read gives a model-readable error", async () => {
  const { workspace, cleanup } = await makeWorkspace();
  const fs = createReplFs(workspace);
  try {
    await assert.rejects(() => fs.read("nope.txt"), (err: unknown) => {
      assert.ok(err instanceof ReplFsError);
      assert.match((err as Error).message, /no such file/);
      return true;
    });
  } finally {
    await cleanup();
  }
});
