/**
 * Firefox add-on build: bundle the TypeScript sources into classic scripts
 * (MV3 background event page, content script, sidebar page) with esbuild,
 * then copy the static assets into dist/.
 */
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(path.join(dist, "sidebar"), { recursive: true });

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
  entryPoints: [path.join(root, "src", "content", "index.ts")],
  outfile: path.join(dist, "content.js"),
});

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, "src", "sidebar", "index.ts")],
  outfile: path.join(dist, "sidebar", "sidebar.js"),
});

await cp(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
await cp(path.join(root, "src", "sidebar", "index.html"), path.join(dist, "sidebar", "index.html"));
await cp(path.join(root, "src", "sidebar", "style.css"), path.join(dist, "sidebar", "style.css"));

console.log("firefox add-on built to", dist);
