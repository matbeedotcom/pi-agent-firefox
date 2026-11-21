/**
 * Isolated skill job runner (skills-runtime-design.md §10).
 *
 * Triggered and Passive evaluations run in an ISOLATED Pi execution context:
 * - explicit resource loading only: the resource loader disables ambient
 *   extension and skill discovery (`noExtensions`/`noSkills`) and injects
 *   the single selected skill via `skillsOverride`. This prevents the
 *   manager's own extension from being recursively loaded into workers.
 * - minimal toolset: an explicit `tools` allowlist — never the default
 *   read/bash/edit/write set. A simple comment review gets ONLY skill_report.
 * - in-memory session: job traffic never lands in a persisted session file.
 * - verified reporting: the job resolves "ok" only when the model calls
 *   skill_report with a payload that parses against the protocol
 *   ReviewResult AND matches the immutable job identity (jobId/eventId/
 *   skillKey/skillRevision) — the model cannot report for another job.
 *
 * The runner never talks to the user's chat session: no sendUserMessage,
 * no sendMessage. Results are returned to the caller (SkillsService) and
 * surfaced deliberately.
 */
import path from "node:path";
import Type from "typebox";
import {
  createAgentSession,
  createSyntheticSourceInfo,
  defineTool,
  DefaultResourceLoader,
  SessionManager,
  type ModelRuntime,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { parseReviewResult, type RegisteredSkill, type ReviewResult } from "@trusted-ua/protocol";
import { BROWSER_TOOL_SCHEMAS } from "../browser/schemas.js";
import type { BrowserToolBridge } from "../tool-bridge.js";
import type { Logger } from "../logger.js";

/** One job submission. Optional fields default from the skill definition. */
export interface SkillJobSpec {
  skill: RegisteredSkill;
  /** Scoped context payload for the event (JSON text). */
  context: string;
  eventId: string;
  jobId: string;
  /** Browser tool names the plan grants this job (routed through the bridge). */
  grantedTools: string[];
  /** Scheduler deduplication key; default `${skill.key}:${eventId}`. */
  key?: string;
  /** Scheduler kind; default from definition.type (triggered→gate). */
  kind?: "gate" | "active" | "speculative" | "passive";
  /** Review deadline override (ms); default definition.execution.timeoutMs. */
  timeoutMs?: number;
}

export interface SkillJobRunResult {
  ok: boolean;
  /** Verified report (only when ok). */
  report?: ReviewResult;
  /** Final assistant text, for audit. */
  transcript?: string;
  error?: string;
}

/** The session surface the runner needs (the SDK AgentSession satisfies it). */
export interface IsolatedAgentSession {
  prompt(text: string, options?: { images?: unknown[] }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly messages: unknown[];
}

export interface CreateIsolatedSessionOptions {
  cwd: string;
  agentDir: string;
  modelRuntime?: ModelRuntime;
  model?: unknown;
  /** The single explicitly selected skill. */
  skill: RegisteredSkill;
  /** Isolation flags — always true; asserted by tests. */
  noExtensions: boolean;
  noSkills: boolean;
  inMemorySession: boolean;
  /** System-prompt blocks (skill instructions + job contract). */
  systemPromptAppend: string[];
  /** First (and only) user prompt: the scoped context + task. */
  taskPrompt: string;
  /** Explicit tool allowlist — the minimal toolset for this job. */
  tools: string[];
  /** skill_report plus any granted browser tools. */
  customTools: ToolDefinition[];
}

export type IsolatedSessionFactory = (opts: CreateIsolatedSessionOptions) => Promise<IsolatedAgentSession>;

function skillBlock(spec: SkillJobSpec): string {
  return [
    `# Skill: ${spec.skill.key} (revision ${spec.skill.revision})`,
    "",
    spec.skill.instructions,
  ].join("\n");
}

function contractBlock(spec: SkillJobSpec): string {
  return [
    "## Job contract",
    `jobId: ${spec.jobId}`,
    `eventId: ${spec.eventId}`,
    `skillKey: ${spec.skill.key}`,
    `skillRevision: ${spec.skill.revision}`,
    'When done, call skill_report EXACTLY ONCE with a decision ("clear" | "suggest" | "abstain"), a one-sentence explanation, and replacementText only when decision is "suggest". Do NOT provide jobId/eventId/skillKey/skillRevision: the runtime binds the job identity for you. Then stop. You have no access to the user\'s chat session.',
  ].join("\n");
}

function taskPrompt(spec: SkillJobSpec): string {
  return [
    `## Context (event ${spec.eventId})`,
    spec.context,
    "",
    "Perform the skill's task now using this context.",
  ].join("\n");
}

/** Synthetic loader entry so the selected skill is explicitly loaded. Its
 *  instructions are injected via the system prompt; the file does not exist,
 *  so model-invocation (file re-reads) is disabled. */
function syntheticSkill(skill: RegisteredSkill): Skill {
  const baseDir = path.join(".pi", "browser-skills", ...skill.key.split("/"));
  const filePath = path.join(baseDir, "SKILL.md");
  return {
    name: skill.key,
    description: `Skill job ${skill.key}`,
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "sdk" }),
    disableModelInvocation: true,
  };
}

function reportTool(spec: SkillJobSpec, onReport: (raw: Record<string, unknown>) => void): ToolDefinition {
  return defineTool({
    name: "skill_report",
    label: "Skill Report",
    description:
      "Report the verified result of this skill job. Call exactly once with a decision, then stop. The job identity (jobId/eventId/skillKey/skillRevision) is bound by the runtime; you do not need to provide it.",
    parameters: Type.Object({
      decision: Type.Union([Type.Literal("clear"), Type.Literal("suggest"), Type.Literal("abstain")]),
      explanation: Type.Optional(Type.String()),
      replacementText: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => {
      const raw = { ...(params as Record<string, unknown>) };
      // The job identity is immutable and known to the runner: ALWAYS bind it
      // from the spec, ignoring whatever the model echoes. Small local models
      // hallucinate opaque identity strings (jobId/revision) reliably enough
      // to make echo-verification a dead end; the security property (a report
      // can never name a foreign job) is preserved because the identity is the
      // spec's, never the model's. The model supplies only decision,
      // explanation, and replacementText.
      raw.jobId = spec.jobId;
      raw.eventId = spec.eventId;
      raw.skillKey = spec.skill.key;
      raw.skillRevision = spec.skill.revision;
      onReport(raw);
      return { content: [{ type: "text" as const, text: "Report recorded. Stop now." }], details: { recorded: true } };
    },
  });
}

/** Verify shape via the protocol parser, then bind to the immutable job identity. */
export function verifyReport(raw: Record<string, unknown>, spec: SkillJobSpec): ReviewResult {
  const report = parseReviewResult(raw);
  if (report.jobId !== spec.jobId) throw new Error("report jobId does not match the job");
  if (report.eventId !== spec.eventId) throw new Error("report eventId does not match the job");
  if (report.skillKey !== spec.skill.key) throw new Error("report skillKey does not match the job");
  if (report.skillRevision !== spec.skill.revision) throw new Error("report skillRevision does not match the job");
  return report;
}

function extractTranscript(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== "assistant") continue;
    const text = Array.isArray(msg.content)
      ? (msg.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("")
      : "";
    if (text) return text;
  }
  return undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface IsolatedSkillRunnerOptions {
  log: Logger;
  modelRuntime?: ModelRuntime;
  model?: unknown;
  /** Job working directory; default process.cwd(). */
  cwd?: string;
  /** Pi agent dir; default the SDK default. */
  agentDir?: string;
  /** Routes granted browser tools through the broker provider. */
  browserBridge?: BrowserToolBridge;
  /** Injectable SDK seam (tests). */
  sessionFactory?: IsolatedSessionFactory;
}

export class IsolatedSkillRunner {
  private readonly factory: IsolatedSessionFactory;

  constructor(private readonly opts: IsolatedSkillRunnerOptions) {
    this.factory = opts.sessionFactory ?? defaultSessionFactory;
  }

  async run(spec: SkillJobSpec, signal: AbortSignal): Promise<SkillJobRunResult> {
    if (signal.aborted) return { ok: false, error: "aborted" };

    let rawReport: Record<string, unknown> | undefined;
    const granted = this.grantBrowserTools(spec);
    const options: CreateIsolatedSessionOptions = {
      cwd: this.opts.cwd ?? process.cwd(),
      agentDir: this.opts.agentDir ?? path.join(process.env.HOME ?? "/tmp", ".pi", "agent"),
      ...(this.opts.modelRuntime ? { modelRuntime: this.opts.modelRuntime } : {}),
      ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      skill: spec.skill,
      noExtensions: true,
      noSkills: true,
      inMemorySession: true,
      systemPromptAppend: [skillBlock(spec), contractBlock(spec)],
      taskPrompt: taskPrompt(spec),
      tools: ["skill_report", ...granted.map((t) => t.name)],
      customTools: [reportTool(spec, (raw) => { rawReport = raw; }), ...granted],
    };

    let session: IsolatedAgentSession;
    try {
      session = await this.factory(options);
    } catch (err) {
      this.opts.log.warn(`skill job ${spec.jobId}: failed to start isolated session: ${message(err)}`);
      return { ok: false, error: `failed to start isolated session: ${message(err)}` };
    }
    this.opts.log.info(`skill job ${spec.jobId}: isolated session running (tools=${options.tools.join(",")})`);

    const onAbort = () => { void session.abort().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(options.taskPrompt);
    } catch (err) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      this.opts.log.warn(`skill job ${spec.jobId}: session failed: ${message(err)}`);
      return { ok: false, error: `job session failed: ${message(err)}` };
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { session.dispose(); } catch { /* best-effort teardown */ }
    }

    return this.settle(rawReport, session.messages, spec);
  }

  /** Bind the recorded report to the job identity; absence is a failure. */
  private settle(rawReport: Record<string, unknown> | undefined, messages: unknown[], spec: SkillJobSpec): SkillJobRunResult {
    const transcript = extractTranscript(messages);
    if (!rawReport) {
      this.opts.log.warn(`skill job ${spec.jobId}: finished without a verified report`);
      return { ok: false, transcript, error: "job finished without a verified report" };
    }
    try {
      const report = verifyReport(rawReport, spec);
      this.opts.log.info(`skill job ${spec.jobId}: report accepted (decision=${report.decision})`);
      return { ok: true, report, transcript };
    } catch (err) {
      this.opts.log.warn(`skill job ${spec.jobId}: invalid report: ${message(err)} raw=${JSON.stringify(rawReport)}`);
      return { ok: false, transcript, error: `invalid report: ${message(err)}` };
    }
  }

  /** Map granted browser tool names onto bridge-routed custom tools. Unknown
   *  names are skipped (the allowlist can never grant tools the host lacks). */
  private grantBrowserTools(spec: SkillJobSpec): ToolDefinition[] {
    const bridge = this.opts.browserBridge;
    if (!bridge || spec.grantedTools.length === 0) return [];
    return spec.grantedTools.flatMap((name) => {
      const schema = BROWSER_TOOL_SCHEMAS.find((t) => t.name === name);
      if (!schema) {
        this.opts.log.warn(`skill job ${spec.jobId}: skipping unknown granted tool ${name}`);
        return [];
      }
      const definition = schema;
      return [
        defineTool({
          name: definition.name,
          label: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          execute: async (toolCallId, params) => {
            const result = await bridge.call({ tool: definition.name, args: params as Record<string, unknown>, toolCallId });
            return {
              content: result.content,
              details: { piBrowser: true, tool: definition.name },
              ...(result.isError ? { isError: true } : {}),
            };
          },
        }),
      ];
    });
  }
}

/** SDK default: explicit resource loading, in-memory session, minimal tools. */
async function defaultSessionFactory(opts: CreateIsolatedSessionOptions): Promise<IsolatedAgentSession> {
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: opts.systemPromptAppend,
    skillsOverride: (base) => ({ skills: [syntheticSkill(opts.skill)], diagnostics: base.diagnostics }),
  });
  const created = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    ...(opts.modelRuntime ? { modelRuntime: opts.modelRuntime } : {}),
    ...(opts.model !== undefined ? { model: opts.model as never } : {}),
    // Skill jobs run under a hard execution deadline (protocol cap 10 s):
    // reasoning burns most of that budget before the first token, so the
    // isolated job session always runs with reasoning off.
    thinkingLevel: "off",
    tools: opts.tools,
    customTools: opts.customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });
  return created.session;
}
