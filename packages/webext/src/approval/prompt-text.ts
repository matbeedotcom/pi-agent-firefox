/**
 * Human-facing text for a permission request — "codex wants to take a
 * screenshot", "Allow codex to use Firefox tools?" — shared by the approval
 * window and any other surface that shows caller prompts.
 */
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
}

const APP_SCOPE: Record<"firefox" | "thunderbird", string> = {
  firefox: "read and act on Firefox tabs (pages, clicks, typing, screenshots)",
  thunderbird: "search and read your mail, prepare drafts, organize messages and read contacts in Thunderbird",
};

export function describePermissionRequest(request: RequestPermissionRequest): PermissionPromptText {
  const meta = permissionRequestMeta(request);
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
