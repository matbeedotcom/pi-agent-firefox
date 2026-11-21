/**
 * The approval window page (approval/approval.html) for external MCP
 * callers' permission prompts. Bundled by both add-ons' build.mjs.
 *
 * Shows the waiting prompts one at a time (oldest first), answers through
 * the background ("pi/permission_response"), and closes itself when the
 * queue is empty. The background owns the queue: it pushes
 * "pi/approval_state" on every change, and closing this window answers the
 * waiting prompts "deny once" (handled by the background's windows.onRemoved).
 */
import type { PermissionOption, RequestPermissionRequest } from "@trusted-ua/protocol";
import { describePermissionRequest } from "./prompt-text.js";

const OPTION_ORDER = ["allow_once", "allow_session", "allow_always", "reject_once"];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`approval page: #${id} missing`);
  return el;
}

let requests: RequestPermissionRequest[] = [];
/** Prompts answered from this page, hidden until the background confirms. */
const answered = new Set<string>();
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function visible(): RequestPermissionRequest[] {
  return requests.filter((r) => !answered.has(r.toolCall.toolCallId));
}

function render(): void {
  const waiting = visible();
  const card = $("card");
  const empty = $("empty");
  if (waiting.length === 0) {
    card.classList.add("hidden");
    empty.classList.remove("hidden");
    // The background closes the window (after a short grace period for a
    // follow-up prompt); this only covers a lost message.
    closeTimer ??= setTimeout(() => window.close(), 5000);
    return;
  }
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  empty.classList.add("hidden");
  card.classList.remove("hidden");
  const request = waiting[0];
  const text = describePermissionRequest(request);
  document.title = text.title;
  $("caller").textContent = text.caller ?? "Pi";
  $("title").textContent = text.title;
  $("desc").textContent = text.description;
  $("queue").textContent = waiting.length > 1 ? `1 of ${waiting.length} waiting` : "";
  const options = $("options");
  options.textContent = "";
  const rank = (o: PermissionOption) => {
    const i = OPTION_ORDER.indexOf(o.optionId);
    return i === -1 ? OPTION_ORDER.indexOf(o.kind) : i;
  };
  for (const opt of [...request.options].sort((a, b) => rank(a) - rank(b))) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.name;
    btn.dataset.optionId = opt.optionId;
    btn.className = opt.optionId === "allow_once" ? "primary" : opt.kind.startsWith("allow") ? "secondary" : "reject";
    btn.addEventListener("click", () => answer(request, opt, text.tool));
    options.append(btn);
  }
  (options.querySelector("button.primary") as HTMLButtonElement | null)?.focus();
}

function answer(request: RequestPermissionRequest, opt: PermissionOption, tool: string | undefined): void {
  const permId = request.toolCall.toolCallId;
  const send = (optionId: string) => {
    answered.add(permId);
    void browser.runtime.sendMessage({ type: "pi/permission_response", permId, optionId }).catch(() => undefined);
    render();
  };
  if (tool === "browser_evaluate" && opt.kind.startsWith("allow")) {
    // Firefox requires the userScripts request to come from this click.
    let granted: Promise<boolean>;
    try {
      granted = browser.permissions.request({ permissions: ["userScripts" as never] });
    } catch {
      granted = Promise.resolve(false);
    }
    $("options").querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    void granted.then((ok) => send(ok ? opt.optionId : "cancelled"), () => send("cancelled"));
    return;
  }
  send(opt.optionId);
}

function applyState(next: unknown): void {
  if (!Array.isArray(next)) return;
  requests = next as RequestPermissionRequest[];
  // Forget answers the background has already applied.
  for (const id of [...answered]) {
    if (!requests.some((r) => r.toolCall.toolCallId === id)) answered.delete(id);
  }
  render();
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; requests?: unknown } | null;
  if (msg?.type === "pi/approval_state") applyState(msg.requests);
});

void browser.runtime
  .sendMessage({ type: "pi/approval_get" })
  .then((res: unknown) => applyState((res as { requests?: unknown } | undefined)?.requests))
  .catch(() => applyState([]));
