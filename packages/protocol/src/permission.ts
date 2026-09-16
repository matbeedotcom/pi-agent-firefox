/**
 * Permission-request helpers (PRODUCT.md §55: sensitive tools require
 * explicit user approval).
 *
 * EVERY tool the add-ons provide is approval-gated: the host asks the ACP
 * client for permission before running any browser, REPL (`javascript`),
 * control (`pi_*`), mail, compose, contacts, or mail-mutation tool — in
 * both Firefox and Thunderbird. "Always allow" is remembered persistently
 * (host-side store, shared across apps) so the UI friction stays down after
 * the first approval of a tool; the add-on's Configuration page lists every
 * tool and lets the user toggle or clear that state.
 *
 * The one special case is browser_evaluate: Firefox owns the revocable
 * `userScripts` grant, so it is NEVER cached host-side — every call asks
 * (with its own option set), and the Configuration page shows the row as
 * "managed by Firefox".
 *
 * The request is the canonical ACP `session/request_permission` method.
 */
import {
  CLIENT_METHODS,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "./acp.js";
import { BROWSER_TOOLS, REPL_TOOLS } from "./browser-tools.js";
import { CONTROL_TOOLS } from "./control-tools.js";
import { COMPOSE_TOOLS } from "./compose-tools.js";
import { CONTACTS_TOOLS } from "./contacts-tools.js";
import { MAIL_TOOLS } from "./mail-tools.js";
import { MAIL_MUTATION_TOOLS } from "./mail-mutation-tools.js";
import type { AgentApplication, PermissionToolGroup } from "./integration.js";

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
 * Whether a tool call must be approved by the user before it runs.
 * Every add-on-provided tool is gated in every application (2026-09-15):
 * the `application` parameter is kept for API stability (the policy is
 * application-agnostic now — the LLM's access to the user's browser and
 * mailbox alike is approval-gated per tool).
 */
export function toolRequiresApproval(application: AgentApplication, toolName: string): boolean {
  void application;
  void toolName;
  return true;
}

// ---------------------------------------------------------------------------
// Gated-tool inventory (Configuration page, PRODUCT.md §55)
// ---------------------------------------------------------------------------

/** Canonical group order for the Configuration page. */
export const PERMISSION_TOOL_GROUPS: readonly PermissionToolGroup[] = [
  "browser",
  "repl",
  "control",
  "mail",
  "compose",
  "mail-mutations",
  "contacts",
];

/** Human-facing group labels (Configuration page headings). */
export const PERMISSION_TOOL_GROUP_LABELS: Record<PermissionToolGroup, string> = {
  browser: "Browser",
  repl: "JavaScript REPL",
  control: "Pi controls",
  mail: "Mail (read-only)",
  compose: "Compose (drafts)",
  "mail-mutations": "Mail mutations",
  contacts: "Contacts",
};

/** One approval-gated tool in the canonical inventory. */
export interface GatedToolEntry {
  name: string;
  description: string;
  group: PermissionToolGroup;
  /** Set when the application owns the grant (browser_evaluate → Firefox). */
  managedBy?: AgentApplication;
  /** Extra one-line note for the Configuration page (row has no toggle). */
  note?: string;
}

/**
 * The complete, canonical list of approval-gated tools (browser, REPL,
 * control, mail, compose, mail mutations, contacts) in stable group order.
 * Both the host (x-pi-browser/permissions) and the add-on UIs derive their
 * tool list from here, so the page can never drift from the real surface.
 */
export function listGatedTools(): GatedToolEntry[] {
  const out: GatedToolEntry[] = [];
  for (const t of BROWSER_TOOLS) {
    out.push({
      name: t.name,
      description: t.description,
      group: "browser",
      // Firefox owns the revocable userScripts grant — never host-cached.
      ...(t.name === "browser_evaluate" ? { managedBy: "firefox" as const } : {}),
    });
  }
  for (const t of REPL_TOOLS) {
    out.push({
      name: t.name,
      description: t.description,
      group: "repl",
      // The cell itself is not gated — every page.* / tabs.* primitive inside
      // it goes through the normal per-tool gate, so toggling the cell would
      // be a no-op; the row is informational.
      note: "Cells are gated per primitive — approve the page.*/tabs.* tools they call.",
    });
  }
  for (const t of CONTROL_TOOLS) out.push({ name: t.name, description: t.description, group: "control" });
  for (const t of MAIL_TOOLS) out.push({ name: t.name, description: t.description, group: "mail" });
  for (const t of COMPOSE_TOOLS) out.push({ name: t.name, description: t.description, group: "compose" });
  for (const t of MAIL_MUTATION_TOOLS) out.push({ name: t.name, description: t.description, group: "mail-mutations" });
  for (const t of CONTACTS_TOOLS) out.push({ name: t.name, description: t.description, group: "contacts" });
  return out;
}

/** True when `name` is in the canonical gated-tool inventory. */
export function isGatedTool(name: string): boolean {
  return listGatedTools().some((t) => t.name === name);
}

/** The gated-tool entry for `name` (undefined for unknown tools). */
export function getGatedTool(name: string): GatedToolEntry | undefined {
  return listGatedTools().find((t) => t.name === name);
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
