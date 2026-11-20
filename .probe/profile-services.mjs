// Profile pi session-services creation with the REAL pi config.
// Run with PI_TIMING=1. Builds services for two different fresh folders and
// reloads one, printing pi's own per-extension timings (top 10).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";

const timingsUrl = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/timings.js", import.meta.url);
const timings = await import(timingsUrl.href);
const runtime = await ModelRuntime.create({});

async function build(label) {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-prof-"));
  timings.resetTimings("extensions");
  const t0 = performance.now();
  const services = await createAgentSessionServices({ cwd, modelRuntime: runtime });
  console.log(`${label}: ${Math.round(performance.now() - t0)} ms`);
  return services;
}

const a = await build("folder A, first build");
const b = await build("folder B, first build");
const t0 = performance.now();
await b.resourceLoader.reload();
console.log(`folder B, reload: ${Math.round(performance.now() - t0)} ms`);
const t1 = performance.now();
await a.resourceLoader.reload();
console.log(`folder A, reload after B: ${Math.round(performance.now() - t1)} ms`);
console.log(`extensions loaded: ${b.resourceLoader.getExtensions().extensions.length}`);

// pi's own per-extension timings for the last load (folder A reload)
const ns = new Map();
const orig = console.error;
const lines = [];
console.error = (s) => lines.push(String(s));
timings.printTimings();
console.error = orig;
const rows = lines.join("\n").split("\n").filter((l) => /: \d+ms$/.test(l.trim()) && !/TOTAL/.test(l))
  .map((l) => { const m = l.trim().match(/^(.*): (\d+)ms$/); return { label: m[1], ms: Number(m[2]) }; })
  .sort((x, y) => y.ms - x.ms).slice(0, 10);
console.log("slowest steps in the last load:");
for (const r of rows) console.log(`  ${String(r.ms).padStart(5)} ms  ${r.label.replace(/^.*[\\/](node_modules|git|npm)[\\/]/, "…/$1/").slice(0, 110)}`);
process.exit(0);
