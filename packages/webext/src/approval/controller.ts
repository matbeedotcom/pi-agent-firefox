/**
 * Approval window for external MCP callers (openspec external-mcp-callers,
 * D6). Shared by the Firefox and Thunderbird backgrounds.
 *
 * A permission request that carries `_meta.piBrowser.caller` comes from an
 * agent outside the add-on (Claude Code, Codex, ...). The user is usually in
 * that other program, so the prompt never goes to the sidebar / Space: the
 * background opens (or focuses) ONE popup window per app, which shows the
 * waiting prompts one at a time, oldest first, and closes itself when none
 * are left. Closing the window answers every waiting prompt "cancelled"
 * (deny once, never remembered). While anything waits, the toolbar / Space
 * button shows a badge; clicking it focuses the window.
 *
 * Browser APIs are injected so the controller is unit-testable.
 */
import type { RequestPermissionRequest } from "@pi-browser/protocol";
import { permissionRequestMeta } from "@pi-browser/protocol";

export interface ApprovalWindowApi {
  /** Open the approval page as a focused popup; resolves its window id. */
  open(url: string): Promise<number | undefined>;
  /** Bring a window to the front. Rejects when it no longer exists. */
  focus(windowId: number): Promise<void>;
  /** Close a window (ignore errors when already gone). */
  close(windowId: number): Promise<void>;
}

export interface ApprovalWindowOptions {
  api: ApprovalWindowApi;
  /** The approval page URL (runtime.getURL("approval/approval.html")). */
  url: string;
  /** Show the waiting count on the toolbar / Space button ("" clears it). */
  setBadge(text: string): void;
  /** Tell an open approval page that the queue changed. */
  notifyPage(requests: RequestPermissionRequest[]): void;
  /** Answer one waiting prompt as cancelled (the window was closed). */
  cancel(permId: string): void;
  /**
   * How long an emptied window stays open for a follow-up prompt (a caller
   * approval is usually followed by the tool's own prompt). Default 1500 ms.
   */
  closeDelayMs?: number;
}

/** True for prompts from external MCP callers (they go to the approval window). */
export function isCallerPermissionRequest(request: RequestPermissionRequest): boolean {
  return permissionRequestMeta(request).caller !== undefined;
}

export class ApprovalWindowController {
  private readonly queue: RequestPermissionRequest[] = [];
  private windowId: number | undefined;
  private opening: Promise<void> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Window ids we closed ourselves (their onRemoved is not a user "close"). */
  private readonly closedByUs = new Set<number>();

  constructor(private readonly opts: ApprovalWindowOptions) {}

  /** Waiting prompts, oldest first. */
  pending(): RequestPermissionRequest[] {
    return [...this.queue];
  }

  has(permId: string): boolean {
    return this.queue.some((r) => r.toolCall.toolCallId === permId);
  }

  /** The approval window's id while it is open. */
  get currentWindowId(): number | undefined {
    return this.windowId;
  }

  /** Queue a caller prompt and make sure the window is showing. */
  add(request: RequestPermissionRequest): void {
    if (this.has(request.toolCall.toolCallId)) return;
    this.cancelPendingClose();
    this.queue.push(request);
    this.changed();
    void this.show();
  }

  /** A prompt was answered, timed out or withdrawn: drop it; close the window when empty. */
  remove(permId: string): void {
    const i = this.queue.findIndex((r) => r.toolCall.toolCallId === permId);
    if (i === -1) return;
    this.queue.splice(i, 1);
    this.changed();
    if (this.queue.length === 0) this.scheduleClose();
  }

  /** Close the emptied window after the grace period, unless a prompt arrives. */
  private scheduleClose(): void {
    this.cancelPendingClose();
    const delay = this.opts.closeDelayMs ?? 1500;
    if (delay <= 0) {
      void this.closeWindow();
      return;
    }
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      if (this.queue.length === 0) void this.closeWindow();
    }, delay);
  }

  private cancelPendingClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  /**
   * The toolbar / Space button was clicked: bring the window to the front.
   * Returns false when nothing is waiting (the caller does its usual thing).
   */
  focus(): boolean {
    if (this.queue.length === 0) return false;
    void this.show();
    return true;
  }

  /** windows.onRemoved: the user closed the approval window → deny everything waiting. */
  onWindowRemoved(windowId: number): void {
    if (this.closedByUs.delete(windowId)) return;
    if (windowId !== this.windowId) return;
    this.windowId = undefined;
    this.cancelPendingClose();
    for (const request of [...this.queue]) this.opts.cancel(request.toolCall.toolCallId);
    // cancel() normally calls remove(); make sure nothing lingers either way.
    this.queue.length = 0;
    this.changed();
  }

  private changed(): void {
    this.opts.setBadge(this.queue.length > 0 ? String(this.queue.length) : "");
    this.opts.notifyPage(this.pending());
  }

  /** Open the window, or focus it when already open. */
  private async show(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (this.windowId !== undefined) {
        try {
          await this.opts.api.focus(this.windowId);
          return;
        } catch {
          this.windowId = undefined; // gone without onRemoved: reopen
        }
      }
      if (this.queue.length === 0) return;
      try {
        this.windowId = await this.opts.api.open(this.opts.url);
      } catch (err) {
        console.warn("[pi] could not open the approval window; the badge stays as a fallback", err);
      }
      // Everything may have been answered while the window was opening.
      if (this.queue.length === 0) this.scheduleClose();
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async closeWindow(): Promise<void> {
    const id = this.windowId;
    if (id === undefined) return;
    this.windowId = undefined;
    this.closedByUs.add(id);
    try {
      await this.opts.api.close(id);
    } catch {
      this.closedByUs.delete(id);
    }
  }
}
