/**
 * External ACP agents in the add-on UI (openspec sidebar-acp-agents D9):
 * the agent list from the host, the remembered choice per app, and the
 * rendering helpers for what those agents send that pi never did (plans,
 * diffs, terminal output).
 */
import {
  AGENTS_METHOD,
  JSONRPC_ERROR,
  PI_AGENT_ID,
  type AgentsResult,
  type AgentApplication,
} from "@trusted-ua/protocol";

/**
 * Ask the host which agents a new session can use. Undefined when the host
 * predates `x-trusted-ua/agents` (the panel then shows no choice).
 */
export async function fetchAgents(
  request: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>,
): Promise<AgentsResult | undefined> {
  try {
    const res = await request<AgentsResult>(AGENTS_METHOD, {}, 10_000);
    if (!res || !Array.isArray(res.agents) || res.agents.length === 0) return undefined;
    return res;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === JSONRPC_ERROR.METHOD_NOT_FOUND) return undefined;
    if (/unknown method/i.test(String((err as { message?: unknown })?.message ?? ""))) return undefined;
    throw err;
  }
}

const CHOICE_KEY = "piAgentChoice";

/** The agent last used for a new session in this app (pi when none). */
export async function loadAgentChoice(app: AgentApplication): Promise<string> {
  try {
    const stored = (await browser.storage.local.get(CHOICE_KEY)) as Record<string, Record<string, string> | undefined>;
    return stored[CHOICE_KEY]?.[app] ?? PI_AGENT_ID;
  } catch {
    return PI_AGENT_ID;
  }
}

export async function saveAgentChoice(app: AgentApplication, agentId: string): Promise<void> {
  try {
    const stored = (await browser.storage.local.get(CHOICE_KEY)) as Record<string, Record<string, string> | undefined>;
    await browser.storage.local.set({ [CHOICE_KEY]: { ...(stored[CHOICE_KEY] ?? {}), [app]: agentId } });
  } catch {
    /* best effort */
  }
}

/** One ACP plan entry. */
export interface PlanEntryLike {
  content?: unknown;
  status?: unknown;
  priority?: unknown;
}

/** A plan as the text of a "Plan" card: one line per entry with its status. */
export function planText(entries: PlanEntryLike[]): string {
  return entries
    .map((e) => {
      const mark = e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○";
      return `${mark} ${typeof e.content === "string" ? e.content : ""}`;
    })
    .join("\n");
}

/** The card status for a plan: completed once every entry is. */
export function planStatus(entries: PlanEntryLike[]): "completed" | "in_progress" {
  return entries.length > 0 && entries.every((e) => e.status === "completed") ? "completed" : "in_progress";
}

/** Tool call id of the per-session plan card. */
export const PLAN_CARD_ID = "pi-browser-plan";

const MAX_DIFF_LINES = 400;

/**
 * A readable line diff for an ACP `diff` tool-call content: a header with the
 * path, then unchanged lines with "  ", removed with "- ", added with "+ ".
 */
export function diffText(path: string, oldText: string | null | undefined, newText: string): string {
  const a = (oldText ?? "").split("\n");
  const b = newText.split("\n");
  if (a[a.length - 1] === "") a.pop();
  if (b[b.length - 1] === "") b.pop();
  const header = oldText === null || oldText === undefined ? `new file ${path}` : path;
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `${header}\n(${a.length} → ${b.length} lines; too long to show)`;
  }
  // LCS table, then walk it.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [header];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  return out.join("\n");
}

/** One option of the new-session panel's agent selector. */
export interface AgentChoice {
  id: string;
  label: string;
  disabled: boolean;
  /** Why it can't be chosen (tooltip). */
  title?: string;
}

/**
 * The agent selector for a host's answer: no selector for an older host (or
 * pi alone); unavailable agents disabled with their reason; the remembered
 * choice preselected while it is still available, else the host's default.
 */
export function agentChoices(
  result: AgentsResult | undefined,
  remembered: string | undefined,
): { show: boolean; options: AgentChoice[]; selected: string } {
  if (!result || result.agents.length <= 1) return { show: false, options: [], selected: PI_AGENT_ID };
  const options = result.agents.map((a) => ({
    id: a.id,
    label: a.available ? a.name : `${a.name} — ${a.reason ?? "not available"}`,
    disabled: !a.available,
    ...(a.available ? {} : { title: a.reason ?? "not available" }),
  }));
  const usable = (id: string | undefined) => id !== undefined && options.some((o) => o.id === id && !o.disabled);
  const selected = usable(remembered) ? remembered! : usable(result.defaultAgent) ? result.defaultAgent : PI_AGENT_ID;
  return { show: true, options, selected };
}
