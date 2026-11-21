/**
 * In-process skills bridge (skills-runtime-design.md §10).
 *
 * Same pattern as the browser tool bridge: the native host installs a
 * SkillsBridge here at startup (createSkillsHost). A Pi extension loaded
 * into an ACP session — see extensions/trusted-ua-skills.ts — reads the bridge from
 * this module instance and registers commands/tools. The bridge is
 * undefined outside a host process, so the extension registers nothing in a
 * plain pi session. Isolated job sessions never load the extension at all
 * (noExtensions in the job's resource loader).
 *
 * The bridge is the extension-facing surface only. The host (which owns the
 * SkillsService and the registry) exposes submit() for host-side callers.
 */
import type { SkillJobOutcome, SkillsServiceStats } from "./skills-service.js";
import type { SkillJobSpec } from "./isolated-runner.js";

/** What the host scopes onto the current chat session. */
export interface SkillsSessionBinding {
  /** Explicitly selected skill paths for resources_discover. */
  skillPaths: string[];
  /** Selected task instructions injected at before_agent_start. */
  instructions?: { skillKey: string; instructions: string };
  /** Tool allowlist for tool_call gating; undefined = no gating. */
  allowedTools?: string[];
}

export interface SkillsBridge {
  /** Active skill invocation: resolve the key from the host registry and
   *  submit an active job. Unknown keys settle "unavailable". */
  runActive(skillKey: string, instructions?: string): Promise<SkillJobOutcome>;
  /** Cancel a key's running/pending job. Returns how many were cancelled. */
  cancel(key: string): number;
  readonly stats: SkillsServiceStats;
  /** Scope the current session (selections, instructions, tool gating). */
  bindSession(binding: SkillsSessionBinding): void;
  unbindSession(): void;
  currentBinding(): SkillsSessionBinding | undefined;
  /** Idempotent attach/detach driven by session_start / session_shutdown. */
  sessionAttached(): void;
  sessionDetached(): void;
  /** Subscribe to job outcomes (local integration events + audit). */
  onJobResult(cb: (result: { key: string; outcome: SkillJobOutcome }) => void): () => void;
}

let bridge: SkillsBridge | undefined;

export function setSkillsBridge(b: SkillsBridge | undefined): void {
  bridge = b;
}

export function getSkillsBridge(): SkillsBridge | undefined {
  return bridge;
}

export type { SkillJobSpec };
