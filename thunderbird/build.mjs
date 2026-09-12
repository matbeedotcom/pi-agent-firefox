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
import { existsSync } from "node:fs";
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

console.log("thunderbird add-on built to", dist);
