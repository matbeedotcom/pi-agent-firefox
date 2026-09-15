export const RECOVERY_PROMPT = "The native host connection was interrupted. Continue the user's unfinished task from the saved conversation. First inspect the current page and any saved checkpoints: the last tool may have completed before the connection dropped. Do not blindly repeat clicks, submissions, or other actions. JavaScript state may have reset; observe again before using old references. If the task is already complete, report the result and stop.";

interface RecoveryEntry { attempts: number; pending: boolean; running: boolean }
interface RecoveryActions {
  ready(): boolean;
  restore(sessionId: string): Promise<void>;
  prompt(sessionId: string, text: string): Promise<void>;
  notice(sessionId: string, message: string): void;
  changed?(): void;
}

/** One recovery per interrupted turn, bounded across repeated host crashes. */
export class PromptRecovery {
  private readonly entries = new Map<string, RecoveryEntry>();
  constructor(private readonly actions: RecoveryActions, private readonly limit = 3) {}

  begin(sessionId: string): void {
    this.entries.set(sessionId, { attempts: 0, pending: false, running: false });
  }

  cancel(sessionId: string): void { this.entries.delete(sessionId); }

  pendingSessions(): string[] {
    return [...this.entries].filter(([, entry]) => entry.pending || entry.running).map(([id]) => id);
  }

  interrupt(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.pending = entry.attempts < this.limit;
    this.actions.notice(sessionId, entry.pending
      ? "Connection lost. I’ll continue automatically after reconnecting."
      : "Automatic recovery paused after three attempts. Send a message to try again.");
  }

  async resumePending(): Promise<void> {
    await Promise.all([...this.entries].map(([id, entry]) => this.resume(id, entry)));
  }

  private async resume(id: string, entry: RecoveryEntry): Promise<void> {
    if (!entry.pending || entry.running || !this.actions.ready()) return;
    entry.running = true;
    entry.attempts++;
    try {
      await this.actions.restore(id);
      // A new user message or Stop invalidates an in-flight restore.
      if (this.entries.get(id) !== entry) return;
      if (!this.actions.ready()) throw new Error("Connection dropped during restore");
      entry.pending = false;
      this.actions.notice(id, "Reconnected. Checking the page and continuing…");
      await this.actions.prompt(id, RECOVERY_PROMPT);
    } catch {
      if (this.entries.get(id) !== entry) return;
      entry.pending = !this.actions.ready() && entry.attempts < this.limit;
      if (!entry.pending) this.actions.notice(id, "Automatic recovery couldn’t continue. Send a message to try again.");
    } finally {
      entry.running = false;
      this.actions.changed?.();
      // Reconnection can finish while the old request is still unwinding.
      if (this.entries.get(id) === entry && entry.pending && this.actions.ready()) void this.resume(id, entry);
    }
  }
}
