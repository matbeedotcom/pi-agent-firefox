#!/usr/bin/env node
/**
 * Bundle the workspace package @trusted-ua/protocol into the published
 * trusted-user-agent tarball (bundleDependencies).
 *
 * In the monorepo the protocol package is hoisted to the root node_modules
 * as a workspace symlink, which `npm pack` does not bundle. prepack copies
 * the packages into packages/trusted-user-agent/node_modules; postpack removes the
 * copies again so development keeps resolving the live workspace packages.
 *
 * The bundled copy's package.json has NO `dependencies`: npm treats the
 * dependencies (and peers) of a bundled package as part of the bundle and
 * never fetches them — a global install got empty @agentclientprotocol/sdk
 * and zod directories. Instead every protocol dependency must be declared by
 * trusted-user-agent itself (checked here), so npm installs it next to the
 * bundle and Node resolves it by walking up from the bundled copy.
 *
 *   node scripts/bundle-protocol.mjs copy | clean
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = path.join(pkgRoot, "node_modules");
const MARKER = ".bundled-by-trusted-user-agent";

const BUNDLED = [
  { name: "@trusted-ua/protocol", source: () => path.resolve(pkgRoot, "..", "protocol"), entries: ["dist"] },
];
const parentDeps = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")).dependencies ?? {};

const mode = process.argv[2];
if (mode === "clean") {
  for (const { name } of BUNDLED) {
    const target = path.join(nodeModules, ...name.split("/"));
    if (existsSync(path.join(target, MARKER))) rmSync(target, { recursive: true, force: true });
    for (const dir of [path.dirname(target)]) {
      try {
        rmdirSync(dir);
      } catch {
        /* not empty or absent */
      }
    }
  }
  try {
    rmdirSync(nodeModules);
  } catch {
    /* not empty or absent */
  }
  process.exit(0);
}
if (mode !== "copy") {
  process.stderr.write("usage: bundle-protocol.mjs copy|clean\n");
  process.exit(2);
}

for (const { name, source, entries } of BUNDLED) {
  const target = path.join(nodeModules, ...name.split("/"));
  if (existsSync(target) && !existsSync(path.join(target, MARKER))) {
    const kind = lstatSync(target).isSymbolicLink() ? "a symlink" : "a directory";
    process.stderr.write(`refusing to replace ${target}: it is ${kind} this script did not create\n`);
    process.exit(1);
  }
  const from = source();
  if (!existsSync(path.join(from, "dist"))) {
    process.stderr.write(`build ${name} first (${from}/dist missing)\n`);
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(from, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!(dep in parentDeps)) {
      process.stderr.write(`${name} depends on ${dep}: add it to trusted-user-agent's dependencies (bundled packages' dependencies are not installed)\n`);
      process.exit(1);
    }
  }
  delete pkg.dependencies;
  delete pkg.scripts;
  delete pkg.devDependencies;
  delete pkg.private;
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const entry of entries) {
    if (!existsSync(path.join(from, entry))) continue;
    cpSync(path.join(from, entry), path.join(target, entry), {
      recursive: true,
      filter: (src) => !src.endsWith(".map") && !src.includes(`${path.sep}test${path.sep}`),
    });
  }
  writeFileSync(path.join(target, MARKER), "");
  // stderr: `npm pack --json` owns stdout.
  process.stderr.write(`bundled ${name} ${pkg.version} into ${path.relative(pkgRoot, target)}\n`);
}
