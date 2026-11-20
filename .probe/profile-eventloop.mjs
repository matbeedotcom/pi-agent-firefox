// How badly does building pi session services block the host's event loop?
// Ticks every 10 ms during a build and reports the longest gap.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";
const runtime = await ModelRuntime.create({});
for (const label of ["build 1", "build 2"]) {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-prof-"));
  let last = performance.now(), maxGap = 0, gaps = [];
  const iv = setInterval(() => { const now = performance.now(); const g = now - last; if (g > 50) gaps.push(Math.round(g)); maxGap = Math.max(maxGap, g); last = now; }, 10);
  const t0 = performance.now();
  await createAgentSessionServices({ cwd, modelRuntime: runtime });
  clearInterval(iv);
  const total = performance.now() - t0;
  const blocked = gaps.reduce((a, b) => a + b, 0);
  console.log(`${label}: ${Math.round(total)} ms total; longest event-loop stall ${Math.round(maxGap)} ms; stalls >50 ms: ${gaps.length} (sum ${blocked} ms)`);
}
process.exit(0);
