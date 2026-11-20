#!/usr/bin/env node
/**
 * Fake native host for the skills fault matrix (test/skills-host).
 *
 * This is the REAL native host (dist/native-host/main.js) running with
 * PI_BROWSER_BACKEND=mock: a scripted Pi backend plays the LLM, and
 * PI_BROWSER_SKILLS_CONFIG arms the plan compiler with deterministic
 * grants/adapters plus a scripted isolated-job factory. The native
 * messaging framing on stdin/stdout is the real one — the process is a
 * drop-in stand-in for the production host, launched the same way Firefox
 * launches com.matbee.agent.
 *
 * Env:
 *   FAKE_HOST_SCENARIO     required. Scenario JSON (tests/skills-host/scenarios/).
 *                          Agent-side steps become the mock script;
 *                          skillsConfig/job become PI_BROWSER_SKILLS_CONFIG.
 *   PI_BROWSER_SKILL_ROOTS skill package roots (default: tests/skills-host/packages)
 *   PI_BROWSER_DATA_ROOT   host data root (default: a private temp dir)
 *   PI_BROWSER_LOG_FILE    host log file (default: off)
 *
 * stdout carries ONLY the framed native-messaging protocol; all logs go to
 * stderr.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/pi-agent/test/skills-host -> repo root is four levels up.
const repoRoot = path.resolve(here, "../../../../");

const scenarioPath = process.env.FAKE_HOST_SCENARIO?.trim();
// Plain stub mode (tests/skills-e2e/mock-host.mjs --stub): no scenario —
// the mock backend starts with an empty script and an inert skills config.
const stubMode = process.env.PI_BROWSER_FAKE_HOST_STUB === "1" && !scenarioPath;
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : stubMode ? { steps: [] } : null;
if (!scenario) {
  process.stderr.write("fake-host: FAKE_HOST_SCENARIO (scenario JSON path) is required\n");
  process.exit(2);
}

// {{page_url}} is a scenario-level variable; agent-side tool args carry it
// as a placeholder and are substituted here (mirrors the in-process runner).
function substitutePageUrl(value, pageUrl) {
  if (typeof value === "string") return value.replace(/\{\{(page_url|fixture_url)\}\}/g, pageUrl);
  if (Array.isArray(value)) return value.map((v) => substitutePageUrl(v, pageUrl));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitutePageUrl(v, pageUrl);
    return out;
  }
  return value;
}

// Agent-side scenario steps -> MockBackend script entries (one entry per
// prompt; say/tool/wait attach to the most recent prompt).
const entries = [];
for (const step of scenario.steps) {
  if (step.side !== "agent") continue;
  if (step.type === "prompt") {
    entries.push({ match: step.text ?? "", events: [], toolCalls: [] });
    continue;
  }
  const entry = entries[entries.length - 1];
  if (!entry) {
    process.stderr.write(`fake-host: agent step "${step.type}" before any prompt\n`);
    process.exit(2);
  }
  if (step.type === "say") entry.events.push({ type: "text_delta", delta: step.text ?? "" });
  else if (step.type === "tool") entry.toolCalls.push({ toolName: step.tool, args: substitutePageUrl(step.args, scenario.pageUrl) });
  else if (step.type === "wait") entry.delayMs = (entry.delayMs ?? 0) + (step.ms ?? 0);
}

const tmp = mkdtempSync(path.join(tmpdir(), "fake-host-"));
writeFileSync(path.join(tmp, "mock-script.json"), JSON.stringify(entries));
if (stubMode) {
  // Honor an externally provided skills config; otherwise inert (no grants).
  if (!process.env.PI_BROWSER_SKILLS_CONFIG) {
    writeFileSync(path.join(tmp, "skills-config.json"), JSON.stringify({ grants: [], job: {} }));
    process.env.PI_BROWSER_SKILLS_CONFIG = path.join(tmp, "skills-config.json");
  }
} else {
  writeFileSync(
    path.join(tmp, "skills-config.json"),
    JSON.stringify({
      grants: scenario.skillsConfig?.grants ?? [],
      adapters: scenario.skillsConfig?.adapters ?? [],
      job: scenario.job ?? {},
    }),
  );
  process.env.PI_BROWSER_SKILLS_CONFIG = path.join(tmp, "skills-config.json");
}

process.env.PI_BROWSER_BACKEND = "mock";
process.env.PI_BROWSER_MOCK_SCRIPT = path.join(tmp, "mock-script.json");
process.env.PI_BROWSER_SKILL_ROOTS ??= path.resolve(repoRoot, "tests/skills-host/packages");
process.env.PI_BROWSER_DATA_ROOT ??= path.join(tmp, "data");
// Isolate the broker/MCP IPC sockets from any real running host — the fake
// host must never EADDRINUSE on the shared ~/.pi/run/agent-broker.sock.
process.env.PI_BROWSER_BROKER_DIR ??= path.join(tmp, "run");
process.env.PI_BROWSER_LOG_FILE ??= "off";

// The real host entry point (runs its main() on import; logs to stderr only).
await import(pathToFileURL(path.join(here, "../../dist/native-host/main.js")).href);
