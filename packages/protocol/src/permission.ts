/**
 * Permission-request helpers (PRODUCT.md §43: sensitive tools require
 * explicit user approval).
 *
 * The host asks the ACP client for permission before running a tool the
 * policy marks as requiring approval:
 *
 *   - Firefox: browser_screenshot (pixel capture needs a live user gesture
 *     to grant `activeTab` host access).
 *   - Thunderbird: every mail/compose/mutation/contacts tool — they read or
 *     write the user's real mailbox and address book, so each tool's first
 *     call asks for approval. "Always allow" (per host lifetime) keeps the
 *     UI friction down after the first approval of a tool.
 *
 * The request is the canonical ACP `session/request_permission` method.
 */
import {
  CLIENT_METHODS,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "./acp.js";
import { isComposeTool } from "./compose-tools.js";
import { isContactsTool } from "./contacts-tools.js";
import { isMailTool } from "./mail-tools.js";
import { isMailMutationTool } from "./mail-mutation-tools.js";
import type { AgentApplication } from "./integration.js";

/** Wire method name the host uses to request permission from the client. */
export const REQUEST_PERMISSION_METHOD = CLIENT_METHODS.session_request_permission;

/**
 * Option ids the add-on's Approve/Deny UI understands. The host builds these
 * options and the client echoes back the selected id.
 */
export const PERMISSION_ALLOW_ONCE = "allow_once";
/**
 * Allow for the remainder of the ACP session (between "once" and "always").
 * Encoded as a custom optionId: the canonical ACP `PermissionOptionKind`
 * enum has no session scope, so the kind carries the closest hint
 * (`allow_once` — scoped, non-persistent) and the host disambiguates on the
 * optionId, which is free-form per the ACP schema.
 */
export const PERMISSION_ALLOW_SESSION = "allow_session";
export const PERMISSION_ALLOW_ALWAYS = "allow_always";
export const PERMISSION_REJECT = "reject_once";

/**
 * Build a `session/request_permission` request for a single tool call.
 *
 * @param sessionId  The ACP session the tool call belongs to.
 * @param toolCallId The tool call id (from the backend event stream).
 * @param title      Human-readable title (defaults to the tool name).
 * @param toolName   Tool name, placed in _meta for the client UI.
 */
export function buildPermissionRequest(params: {
  sessionId: string;
  toolCallId: string;
  title?: string;
  toolName: string;
}): RequestPermissionRequest {
  const options: PermissionOption[] = [
    { optionId: PERMISSION_ALLOW_ONCE, name: "Allow once", kind: "allow_once" },
    { optionId: PERMISSION_ALLOW_SESSION, name: "Allow for this session", kind: "allow_once" },
    { optionId: PERMISSION_ALLOW_ALWAYS, name: "Always allow", kind: "allow_always" },
    { optionId: PERMISSION_REJECT, name: "Deny", kind: "reject_once" },
  ];
  if (params.toolName === "browser_evaluate") {
    // Firefox owns this persistent extension permission, not the host cache.
    options.splice(0, options.length,
      { optionId: PERMISSION_ALLOW_ONCE, name: "Enable page evaluation", kind: "allow_once" },
      { optionId: PERMISSION_REJECT, name: "Not now", kind: "reject_once" },
    );
  }
  return {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: params.toolCallId,
      title: params.title ?? params.toolName,
      status: "pending",
      kind: "fetch",
    },
    options,
    _meta: { piBrowser: { tool: params.toolName } },
  };
}

/** True when the user allowed the tool (any allow_* option). */
export function permissionAllowed(response: RequestPermissionResponse | undefined): boolean {
  if (!response) return false;
  const o = response.outcome;
  if (o.outcome !== "selected") return false;
  return (
    o.optionId === PERMISSION_ALLOW_ONCE ||
    o.optionId === PERMISSION_ALLOW_SESSION ||
    o.optionId === PERMISSION_ALLOW_ALWAYS
  );
}

/**
 * Whether a tool call must be approved by the user before it runs, keyed on
 * the application of the client that EXECUTES the tool (not the session
 * owner — in broker mode a call is routed to the peer that serves it).
 *
 *   - firefox: browser_screenshot and browser_evaluate (Firefox checks its user-scripts grant).
 *   - thunderbird: every tool on the mail surface (read-only mail, compose,
 *     mail mutations, contacts) — the LLM's access to the user's mailbox and
 *     address book is approval-gated per tool.
 */
export function toolRequiresApproval(application: AgentApplication, toolName: string): boolean {
  if (application === "thunderbird") {
    return (
      isMailTool(toolName) ||
      isComposeTool(toolName) ||
      isMailMutationTool(toolName) ||
      isContactsTool(toolName)
    );
  }
  return toolName === "browser_screenshot" || toolName === "browser_evaluate";
}

/** Short human-facing labels for the permission prompt's description line. */
const TOOL_PROMPT_TEXT: Record<string, string> = {
  // Browser
  browser_evaluate:
    "In order to automate the UI on this page, Pi needs permission to run browser scripts. " +
    "Firefox will ask you to allow user scripts. Once enabled, Pi can continue automatically; " +
    "you can revoke this permission in Firefox’s extension settings.",
  browser_screenshot:
    "Pi wants to take a screenshot of the bound tab. Approving brings the tab to the front and captures what is visible.",
  // Read-only mail
  mail_get_context: "Pi wants to read the current mail tab context (current folder, selected messages).",
  mail_get_selected_messages: "Pi wants to read the messages selected in the current mail tab.",
  mail_get_displayed_messages: "Pi wants to read the messages displayed in the current mail tab.",
  mail_get_message: "Pi wants to read one email (headers and body summary).",
  mail_get_message_body: "Pi wants to read the full body of an email.",
  mail_search: "Pi wants to search your mailbox for messages.",
  mail_list_attachments: "Pi wants to list the attachments of an email.",
  mail_get_attachment: "Pi wants to download an email attachment. It will be returned to Pi as data.",
  mail_list_accounts: "Pi wants to list your mail accounts.",
  mail_list_folders: "Pi wants to list the folders of a mail account.",
  mail_list_tags: "Pi wants to list your message tags.",
  // Compose (draft-first: nothing is sent without the user pressing Send)
  compose_prepare_new: "Pi wants to open a new email draft (nothing is sent — you review and press Send).",
  compose_prepare_reply: "Pi wants to open a reply draft (nothing is sent — you review and press Send).",
  compose_prepare_forward: "Pi wants to open a forward draft (nothing is sent — you review and press Send).",
  compose_get: "Pi wants to read the draft open in the compose window.",
  compose_update: "Pi wants to edit the draft in the compose window (nothing is sent).",
  compose_add_attachment: "Pi wants to attach a local file to the draft in the compose window (nothing is sent).",
  // Mail mutations
  mail_mark_read: "Pi wants to change the read/unread status of messages.",
  mail_set_tags: "Pi wants to add or remove tags on messages.",
  mail_archive: "Pi wants to archive messages.",
  mail_move: "Pi wants to move messages to another folder.",
  // Contacts
  contacts_search: "Pi wants to search your address book for contacts.",
  contacts_get: "Pi wants to read one contact from your address book.",
  contacts_list: "Pi wants to list contacts from your address book.",
};

/**
 * One-line description for the permission prompt. Falls back to the bare
 * tool name for tools without an entry (keeps the UI safe for new tools).
 */
export function permissionPromptDescription(tool: string): string {
  return TOOL_PROMPT_TEXT[tool] ?? `Pi wants to run: ${tool}.`;
}
