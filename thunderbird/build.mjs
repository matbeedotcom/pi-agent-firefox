/**
 * Thunderbird add-on build: bundle the TypeScript sources into classic scripts
 * (MV3 background event page + the Pi Space page) with esbuild, then copy the
 * static assets into dist/.
 *
 * Mirrors firefox/build.mjs. esbuild does not type-check, so we run tsc first
 * and fail the build on any type error before anything ships to Thunderbird.
 */
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

function findTsc(from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("typescript not found in node_modules tree");
    dir = parent;
  }
}
execFileSync(process.execPath, [findTsc(root), "-p", "tsconfig.json", "--noEmit"], {
  cwd: root,
  stdio: "inherit",
});

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(path.join(dist, "space"), { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["firefox115"],
  sourcemap: true,
  logLevel: "silent",
};

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, "src", "background", "index.ts")],
  outfile: path.join(dist, "background.js"),
});

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, "src", "space", "index.ts")],
  outfile: path.join(dist, "space", "space.js"),
});

await cp(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
await cp(path.join(root, "src", "space", "index.html"), path.join(dist, "space", "index.html"));
await cp(path.join(root, "src", "space", "style.css"), path.join(dist, "space", "style.css"));

// The piPane pane page: a WebExtension page (TypeScript, like the Space) mounted
// in a <browser> by the Experiment. It reaches the background over a runtime
// Port (name "pi-pane") for per-tab, streaming chat — the compact, message-inline
// view that sits beside the email (the full Space stays the expanded view).
await mkdir(path.join(dist, "pane"), { recursive: true });
await esbuild.build({
  ...common,
  entryPoints: [path.join(root, "src", "pane", "index.ts")],
  outfile: path.join(dist, "pane", "pane.js"),
});
await cp(path.join(root, "src", "pane", "index.html"), path.join(dist, "pane", "index.html"));
await cp(path.join(root, "src", "pane", "pane.css"), path.join(dist, "pane", "pane.css"));

// The Experiment APIs are raw JS/JSON (loaded by the WebExtension module
// system, not bundled by esbuild): copy each schema + implementation verbatim.
for (const name of readdirSync(path.join(root, "src", "experiments"))) {
  await mkdir(path.join(dist, "experiments", name), { recursive: true });
  await cp(
    path.join(root, "src", "experiments", name, "schema.json"),
    path.join(dist, "experiments", name, "schema.json"),
  );
  await cp(
    path.join(root, "src", "experiments", name, "implementation.js"),
    path.join(dist, "experiments", name, "implementation.js"),
  );
}

console.log("thunderbird add-on built to", dist);

for (const surface of ["pane", "space"]) {
  await cp(path.join(root, "..", "packages", "webext", "src", "activity", "activity.css"), path.join(dist, surface, "activity.css"));
}
