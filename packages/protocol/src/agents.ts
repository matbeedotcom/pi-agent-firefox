/**
 * External ACP agents in the sidebar (openspec change `sidebar-acp-agents`).
 *
 * A sidebar, Space or pane session runs either on the built-in pi agent or
 * on an external ACP agent (Claude Code, Codex, or one the user configures
 * in `~/.trusted-ua/agents.json`). The host relays such a session to the
 * agent's ACP adapter and gives it the pi-browser tools through the stdio
 * bridge, tied to the sidebar session.
 *
 * All of this is additive: an add-on that never asks `x-trusted-ua/agents`
 * and never sets `_meta.trustedUa.agent` keeps getting pi sessions; a host
 * that doesn't answer `x-trusted-ua/agents` makes new add-ons show no choice.
 */

/** Client → host: the agents a new session can run on. */
export const AGENTS_METHOD = "x-trusted-ua/agents";

/** Id of the built-in agent. A session without an agent id runs on pi. */
export const PI_AGENT_ID = "pi";

/** Environment variable naming the sidebar session a bridge belongs to. */
export const PARENT_SESSION_ENV = "TRUSTED_UA_PARENT_SESSION";
/** v0.4.0 name of PARENT_SESSION_ENV (still set, and read as a fallback). */
export const LEGACY_PARENT_SESSION_ENV = "PI_BROWSER_PARENT_SESSION";

/** One agent the user can pick in the new-session panel. */
export interface AgentInfo {
  /** Stable id (`pi`, `claude`, `codex`, or an `agents.json` key). */
  id: string;
  /** Display name ("Claude Code"). */
  name: string;
  /** Whether a session can be started on it now. */
  available: boolean;
  /** Why it isn't available (for example the missing command). */
  reason?: string;
}

/** Result of `x-trusted-ua/agents`. */
export interface AgentsResult {
  agents: AgentInfo[];
  /** The agent the panel preselects when it has no remembered choice. */
  defaultAgent: string;
  /** Problem reading `agents.json` (the built-in agents are still listed). */
  configError?: string;
}

/** `{id, name}` of an agent, as carried in `_meta.trustedUa.agent`. */
export interface AgentRef {
  id: string;
  name: string;
}

/**
 * Read the requested agent id from `session/new` params
 * (`_meta.trustedUa.agent`, a string id). Undefined means pi.
 */
export function requestedAgentId(params: unknown): string | undefined {
  const meta = (params as { _meta?: { trustedUa?: { agent?: unknown } } } | undefined)?._meta?.trustedUa?.agent;
  if (typeof meta === "string" && meta.trim()) return meta.trim();
  if (typeof meta === "object" && meta !== null && typeof (meta as { id?: unknown }).id === "string") {
    const id = ((meta as { id: string }).id).trim();
    return id || undefined;
  }
  return undefined;
}

/** Read `_meta.trustedUa.agent` (`{id, name}`) from a listed session or a permission request. */
export function agentRefOf(value: unknown): AgentRef | undefined {
  const a = (value as { _meta?: { trustedUa?: { agent?: unknown } } } | undefined)?._meta?.trustedUa?.agent;
  if (typeof a !== "object" || a === null) return undefined;
  const r = a as { id?: unknown; name?: unknown };
  if (typeof r.id !== "string" || !r.id) return undefined;
  return { id: r.id, name: typeof r.name === "string" && r.name ? r.name : r.id };
}
