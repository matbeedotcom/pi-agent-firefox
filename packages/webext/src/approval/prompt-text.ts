/**
 * Human-facing text for a permission request — "codex wants to take a
 * screenshot", "Allow codex to use Firefox tools?" — shared by the approval
 * window and any other surface that shows caller prompts.
 */
import { resultParts } from "../activity/tool-activity.js";
import {
  applicationShortName,
  permissionPromptDescription,
  permissionRequestMeta,
  type RequestPermissionRequest,
} from "@pi-browser/protocol";

export interface PermissionPromptText {
  title: string;
  description: string;
  /** The external caller's name, when the request came from one. */
  caller?: string;
  /** The tool being approved (absent for caller approvals). */
  tool?: string;
  /** True for the one-time "allow this app" prompt. */
  callerApproval: boolean;
  /** The external ACP agent asking for its own action (sidebar-acp-agents). */
  agent?: string;
  /** What the agent wants to do: the command, the diff, ... (agent requests). */
  detail?: string;
}

const AGENT_ACTION: Record<string, string> = {
  execute: "run a command",
  edit: "edit a file",
  delete: "delete a file",
  move: "move a file",
  read: "read a file",
  search: "search files",
  fetch: "fetch from the web",
};

/** The command, diff or text an agent's tool call carries, for its prompt. */
export function agentToolCallDetail(toolCall: unknown): string {
  const tc = (toolCall ?? {}) as { content?: unknown; rawInput?: unknown };
  const { text } = resultParts(tc.content);
  if (text) return text;
  const raw = tc.rawInput as { command?: unknown } | undefined;
  if (raw && typeof raw.command === "string") return raw.command;
  if (raw && Array.isArray(raw.command)) return raw.command.map(String).join(" ");
  return "";
}

const APP_SCOPE: Record<"firefox" | "thunderbird", string> = {
  firefox: "read and act on Firefox tabs (pages, clicks, typing, screenshots)",
  thunderbird: "search and read your mail, prepare drafts, organize messages and read contacts in Thunderbird",
};

export function describePermissionRequest(request: RequestPermissionRequest): PermissionPromptText {
  const meta = permissionRequestMeta(request);
  if (meta.agent) {
    // The agent's own request (edit a file, run a command): its wording and
    // options, labelled with its name. Never remembered by the add-on.
    const tc = request.toolCall as { kind?: unknown; title?: unknown };
    const kind = typeof tc.kind === "string" ? tc.kind : "other";
    const title = typeof tc.title === "string" && tc.title ? tc.title : "an action";
    const action = AGENT_ACTION[kind];
    const detail = agentToolCallDetail(request.toolCall);
    return {
      title: action ? `${meta.agent.name} wants to ${action}` : `${meta.agent.name}: ${title}`,
      description: action ? title : `${meta.agent.name} asks before it continues.`,
      callerApproval: false,
      agent: meta.agent.name,
      ...(detail ? { detail } : {}),
    };
  }
  const caller = meta.caller?.name;
  if (meta.callerApproval && caller) {
    const app = meta.application ?? "firefox";
    const name = applicationShortName(app);
    return {
      title: `Allow ${caller} to use ${name} tools?`,
      description:
        `${caller} is a program on this computer connecting through the pi-browser MCP server. ` +
        `If you allow it, it can ask to ${APP_SCOPE[app]}. Every tool call still asks unless you set that tool to Always approve.` +
        (meta.triggerTool ? ` First request: ${meta.triggerTool}.` : ""),
      caller,
      callerApproval: true,
    };
  }
  const tool = meta.tool ?? request.toolCall.title ?? "an action";
  const base = permissionPromptDescription(tool);
  if (caller) {
    return {
      title: `${caller} wants to run ${tool}`,
      description: base.replace(/^Pi wants to/, `${caller} wants to`).replace(/\bPi\b(?= (?:needs|can continue))/g, caller),
      caller,
      tool,
      callerApproval: false,
    };
  }
  return {
    title: tool === "browser_evaluate" ? "Enable UI automation?" : "Allow this action?",
    description: base,
    tool,
    callerApproval: false,
  };
}
