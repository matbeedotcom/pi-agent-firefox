/**
 * REPL-owned tab registry (BROWSER-USE-REPL-PLAN.md, P2.3).
 *
 * The javascript REPL can open auxiliary tabs for a session (tabs.open).
 * Those tabs are OWNED by the REPL: closed automatically when the session
 * unbinds or ends. The "home" binding is the last user-bound (owner "bound")
 * tab — restored when a REPL tab is closed out from under the session.
 *
 * In-memory on purpose: if the add-on restarts mid-session, orphaned REPL
 * tabs stay open (the user closes them manually) — a documented v1 limit.
 */
import type { Binding } from "@pi-browser/webext";

export class ReplTabs {
  private owned = new Map<string, Set<number>>();
  private home = new Map<string, Binding>();

  /** Remember the user's binding as the restore point (called on bind/open). */
  rememberHome(sessionId: string, binding: Binding): void {
    this.home.set(sessionId, binding);
  }

  /** Take the home binding (restoring it consumes it). */
  takeHome(sessionId: string): Binding | undefined {
    const b = this.home.get(sessionId);
    this.home.delete(sessionId);
    return b;
  }

  /** Track a newly opened REPL tab. */
  open(sessionId: string, tabId: number): void {
    let set = this.owned.get(sessionId);
    if (!set) {
      set = new Set();
      this.owned.set(sessionId, set);
    }
    set.add(tabId);
  }

  has(sessionId: string, tabId: number): boolean {
    return this.owned.get(sessionId)?.has(tabId) ?? false;
  }

  /** The session that owns the tab (undefined when not REPL-owned). */
  ownerOf(tabId: number): string | undefined {
    for (const [sessionId, set] of this.owned) {
      if (set.has(tabId)) return sessionId;
    }
    return undefined;
  }

  /** Drop one tab (closed explicitly or by the user). */
  close(sessionId: string, tabId: number): void {
    this.owned.get(sessionId)?.delete(tabId);
  }

  /** All owned (possibly orphaned) tab ids for the session. */
  all(sessionId: string): number[] {
    return [...(this.owned.get(sessionId) ?? [])];
  }

  /** Forget everything for the session (session unbinds / ends). */
  clear(sessionId: string): number[] {
    const ids = this.all(sessionId);
    this.owned.delete(sessionId);
    this.home.delete(sessionId);
    return ids;
  }
}
