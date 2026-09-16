/**
 * Pi skills extension core (skills-runtime-design.md §10).
 *
 * Registered capabilities (factory only — no global watchers, no background
 * loops; the host owns the SkillsService):
 * - session_start / session_shutdown: idempotent session attach/detach
 * - resources_discover: contribute EXPLICITLY selected skill paths only
 * - before_agent_start: inject selected task instructions as a custom
 *   message (never sendUserMessage — browser observations are not user input)
 * - tool_call: additional gating of agent tool calls (not DOM events)
 * - appendEntry: session-local audit entries outside model context
 * - pi.events: local integration events between extensions
 * - /pi-skills command: Active skill invocation and management
 *
 * Plain pi sessions (no host bridge) get nothing; isolated job sessions
 * never load this extension at all (noExtensions in the job's loader).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSkillsBridge, type SkillsBridge } from "./pi-bridge.js";

export const SKILL_AUDIT_TYPE = "pi-browser:skill";
export const SKILL_INSTRUCTIONS_TYPE = "pi-browser:skill-instructions";
export const SKILL_JOB_RESULT_CHANNEL = "pi-browser:skill-job-result";

async function handleSkillsCommand(bridge: SkillsBridge, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const [command = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
  if (command === "status") {
    const s = bridge.stats;
    ctx.ui.notify(
      `skills: running=${s.running} queued=${s.queued} closed=${s.closed} outcomes=${JSON.stringify(s.outcomes)}`,
      "info",
    );
    return;
  }
  if (command === "run") {
    const skillKey = rest[0];
    if (!skillKey) {
      ctx.ui.notify("usage: /pi-skills run <skillKey> [instructions]", "warning");
      return;
    }
    const instructions = rest.slice(1).join(" ") || undefined;
    ctx.ui.notify(`starting skill job: ${skillKey}`, "info");
    const outcome = await bridge.runActive(skillKey, instructions);
    if (outcome.status === "done" && outcome.value) {
      const report = outcome.value as { decision: string; explanation?: string };
      ctx.ui.notify(`skill ${skillKey}: ${report.decision}${report.explanation ? ` — ${report.explanation}` : ""}`, "info");
    } else {
      ctx.ui.notify(
        `skill job ${skillKey}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}${outcome.error ? ` (${outcome.error.message})` : ""}`,
        outcome.status === "failed" ? "error" : "warning",
      );
    }
    return;
  }
  if (command === "cancel") {
    const key = rest[0];
    if (!key) {
      ctx.ui.notify("usage: /pi-skills cancel <key>", "warning");
      return;
    }
    const cancelled = bridge.cancel(key);
    ctx.ui.notify(cancelled > 0 ? `cancelled ${cancelled} job(s) for ${key}` : `no pending job for ${key}`, "info");
    return;
  }
  ctx.ui.notify("usage: /pi-skills [run <skillKey> [instructions] | status | cancel <key>]", "warning");
}

export function createSkillsExtensionFactory(): (pi: ExtensionAPI) => void {
  return function piSkillsExtension(pi: ExtensionAPI) {
    // The host installs the bridge once per process, before any session
    // spawns, so capturing it at load time is stable for the session's life.
    const bridge = getSkillsBridge();
    if (!bridge) return; // plain pi session — no host, nothing to register

    // Idempotent attach/detach: a session change or reload detaches only its
    // binding; host shutdown clears everything via close().
    pi.on("session_start", () => {
      bridge.sessionAttached();
    });
    pi.on("session_shutdown", () => {
      bridge.sessionDetached();
    });

    // Only explicitly selected skill paths — never ambient discovery output.
    pi.on("resources_discover", () => {
      const skillPaths = bridge.currentBinding()?.skillPaths ?? [];
      return skillPaths.length > 0 ? { skillPaths } : {};
    });

    // Inject selected task instructions as a custom message into the turn.
    pi.on("before_agent_start", () => {
      const instructions = bridge.currentBinding()?.instructions;
      if (!instructions) return;
      return {
        message: {
          customType: SKILL_INSTRUCTIONS_TYPE,
          content: instructions.instructions,
          display: true,
          details: { skillKey: instructions.skillKey },
        },
      };
    });

    // Gate agent tool calls when the host scoped this session's tools.
    pi.on("tool_call", (event) => {
      const allowed = bridge.currentBinding()?.allowedTools;
      if (!allowed) return;
      if (allowed.includes(event.toolName)) return;
      return { block: true, reason: `tool "${event.toolName}" is not permitted in the current skill session` };
    });

    // Session-local audit entries (outside model context) + local events.
    const audit = (data: Record<string, unknown>) => {
      pi.appendEntry(SKILL_AUDIT_TYPE, data);
    };
    bridge.onJobResult(({ key, outcome }) => {
      audit({ key, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) });
      pi.events.emit(SKILL_JOB_RESULT_CHANNEL, { key, outcome });
    });

    pi.registerCommand("pi-skills", {
      description: "Run an Active skill job: /pi-skills run <skillKey> [instructions] | status | cancel <key>",
      handler: (args, ctx) => handleSkillsCommand(bridge, args, ctx),
    });
  };
}
