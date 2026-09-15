import {
  PERMISSION_ALLOW_ONCE,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@pi-browser/protocol";

/** Check Firefox on every call so revocation and host restarts work correctly. */
export async function requestBrowserToolPermission(
  request: RequestPermissionRequest,
  prompt: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
): Promise<RequestPermissionResponse> {
  const tool = (request._meta?.piBrowser as { tool?: string } | undefined)?.tool;
  if (tool !== "browser_evaluate") return prompt(request);
  const permission = { permissions: ["userScripts" as const] };
  if (await browser.permissions.contains(permission)) {
    return { outcome: { outcome: "selected", optionId: PERMISSION_ALLOW_ONCE } };
  }
  const response = await prompt(request);
  // A sidebar response alone cannot grant a browser permission.
  if (response.outcome.outcome === "selected" &&
      response.outcome.optionId === PERMISSION_ALLOW_ONCE &&
      await browser.permissions.contains(permission)) return response;
  return { outcome: { outcome: "cancelled" } };
}

/** Called directly in the permission button's click handler (user gesture). */
export function grantEvaluationPermission(): Promise<boolean> {
  try {
    return browser.permissions.request({ permissions: ["userScripts"] });
  } catch (error) {
    return Promise.reject(error);
  }
}
