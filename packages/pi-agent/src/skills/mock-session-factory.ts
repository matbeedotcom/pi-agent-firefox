/**
 * Scripted isolated-session factory for the mock host (test seam).
 *
 * Production skill jobs run a real Pi agent session that reads the skill
 * instructions and calls `skill_report` with an identity-bound payload. In
 * controlled tests (PI_BROWSER_BACKEND=mock + PI_BROWSER_SKILLS_CONFIG) the
 * job "model" is scripted: it calls skill_report with a deterministic
 * payload (or fails / stays silent), exercising the full runner + service +
 * protocol path without a model.
 *
 * The factory is only ever wired in by the mock-mode config path in
 * native-host/main.ts; the real host never sees it.
 */
import type { IsolatedAgentSession, IsolatedSessionFactory, CreateIsolatedSessionOptions } from "./isolated-runner.js";

/** One scripted job outcome. */
export interface ScriptedJob {
  /** The report the fake model submits via skill_report. Omit for a
   *  no-report run (settles as unavailable: "finished without a verified report"). */
  report?: {
    decision: "clear" | "suggest" | "abstain";
    explanation?: string;
    /** Only legal when decision is "suggest" (protocol rule). */
    replacementText?: string;
  };
  /** Reject the session prompt (simulates a crashed/failed model session). */
  fail?: string;
  /** Delay before the report (ms). */
  delayMs?: number;
}

function field(block: string, name: string): string {
  const line = block.split("\n").find((l) => l.startsWith(`${name}: `));
  return line ? line.slice(name.length + 2) : "";
}

/**
 * Build a factory whose sessions play the scripted model. Job identity is
 * parsed from the runner's own contract block, so a scripted report can
 * never drift from the identity the runner verified.
 */
export function createScriptedSessionFactory(job: ScriptedJob): IsolatedSessionFactory {
  return async (opts: CreateIsolatedSessionOptions): Promise<IsolatedAgentSession> => {
    const contract = opts.systemPromptAppend.find((b) => b.includes("## Job contract")) ?? "";
    const identity = {
      jobId: field(contract, "jobId"),
      eventId: field(contract, "eventId"),
      skillKey: field(contract, "skillKey"),
      skillRevision: field(contract, "skillRevision"),
    };
    const reportTool = opts.customTools.find((t) => t.name === "skill_report");

    const messages: unknown[] = [
      { role: "assistant", content: [{ type: "text", text: `scripted job finished (${identity.jobId})` }] },
    ];

    return {
      messages,
      async prompt(): Promise<void> {
        if (job.fail) throw new Error(job.fail);
        if (job.delayMs) await new Promise((r) => setTimeout(r, job.delayMs));
        if (!job.report) return; // no report -> unavailable outcome
        if (!reportTool) throw new Error("scripted job: skill_report tool missing from job options");
        // defineTool is an identity wrapper: the job's skill_report execute
        // is the runner's two-argument closure (toolCallId, params).
        const run = reportTool.execute as (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
        await run("scripted-report", {
          ...identity,
          decision: job.report.decision,
          ...(job.report.explanation !== undefined ? { explanation: job.report.explanation } : {}),
          ...(job.report.replacementText !== undefined ? { replacementText: job.report.replacementText } : {}),
        });
      },
      async abort(): Promise<void> {},
      dispose(): void {},
    };
  };
}
