/**
 * Permission-request helpers (PRODUCT.md §43: sensitive tools require
 * explicit user approval).
 *
 * The host asks the ACP client (Firefox) for permission before running a
 * sensitive tool (currently browser_screenshot, whose pixel capture needs a
 * live user gesture to grant `activeTab` host access). The request is the
 * canonical ACP `session/request_permission` method.
 */
import { type RequestPermissionRequest, type RequestPermissionResponse } from "./acp.js";
/** Wire method name the host uses to request permission from the client. */
export declare const REQUEST_PERMISSION_METHOD: "session/request_permission";
/**
 * Option ids the add-on's Approve/Deny UI understands. The host builds these
 * options and the client echoes back the selected id.
 */
export declare const PERMISSION_ALLOW_ONCE = "allow_once";
export declare const PERMISSION_ALLOW_ALWAYS = "allow_always";
export declare const PERMISSION_REJECT = "reject_once";
/**
 * Build a `session/request_permission` request for a single tool call.
 *
 * @param sessionId  The ACP session the tool call belongs to.
 * @param toolCallId The tool call id (from the backend event stream).
 * @param title      Human-readable title (defaults to the tool name).
 * @param toolName   Tool name, placed in _meta for the client UI.
 */
export declare function buildPermissionRequest(params: {
    sessionId: string;
    toolCallId: string;
    title?: string;
    toolName: string;
}): RequestPermissionRequest;
/** True when the user allowed the tool (allow_once or allow_always). */
export declare function permissionAllowed(response: RequestPermissionResponse | undefined): boolean;
//# sourceMappingURL=permission.d.ts.map