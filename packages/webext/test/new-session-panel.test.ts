import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolutePath } from "../src/new-session-panel.js";

test("new-session panel: only absolute working directories are sent to the host", () => {
  for (const p of ["/home/me/project", "C:\\code\\project", "c:/code/project", "\\\\server\\share\\dir"]) {
    assert.equal(isAbsolutePath(p), true, p);
  }
  // A relative cwd would resolve against the host process's own directory.
  for (const p of ["relative/dir", "project", "~/project", ".\\here", "C:relative", "\\\\"]) {
    assert.equal(isAbsolutePath(p), false, p);
  }
});
