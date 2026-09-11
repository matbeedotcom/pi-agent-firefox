/**
 * Permission-request helpers (PRODUCT.md §43: sensitive tools require
 * explicit user approval).
 *
 * The host asks the ACP client (Firefox) for permission before running a
 * sensitive tool (currently browser_screenshot, whose pixel capture needs a
 * live user gesture to grant `activeTab` host access). The request is the
 * canonical ACP `session/request_permission` method.
 */
import {
  CLIENT_METHODS,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "./acp.js";

/** Wire method name the host uses to request permission from the client. */
export const REQUEST_PERMISSION_METHOD = CLIENT_METHODS.session_request_permission;

/**
 * Option ids the add-on's Approve/Deny UI understands. The host builds these
 * options and the client echoes back the selected id.
 */
export const PERMISSION_ALLOW_ONCE = "allow_once";
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
    { optionId: PERMISSION_ALLOW_ALWAYS, name: "Always allow", kind: "allow_always" },
    { optionId: PERMISSION_REJECT, name: "Deny", kind: "reject_once" },
  ];
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

/** True when the user allowed the tool (allow_once or allow_always). */
export function permissionAllowed(response: RequestPermissionResponse | undefined): boolean {
  if (!response) return false;
  const o = response.outcome;
  if (o.outcome !== "selected") return false;
  return o.optionId === PERMISSION_ALLOW_ONCE || o.optionId === PERMISSION_ALLOW_ALWAYS;
}
