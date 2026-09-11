/**
 * Session presentation state + browser bindings (PRODUCT.md §20, §24).
 *
 * Firefox owns ONLY presentation/binding state. Conversation history and
 * session semantics live in Pi (ACP is authoritative). Persisted state is
 * deliberately small: bindings + last session + sidebar prefs.
 */
import type { SessionInfo, SessionConfigOption } from "@pi-browser/protocol";

export interface Binding {
  tabId: number;
  windowId: number;
  tabTitle?: string;
}

export interface SessionView {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  messageCount?: number;
  streaming: boolean;
  /** True once the sidebar has the transcript (fresh create or session/load replay). */
  loaded: boolean;
  configOptions?: SessionConfigOption[];
}

export interface PersistedState {
  bindings: Record<string, Binding>;
  lastSessionId?: string;
}

const STORAGE_KEY = "piBrowserState";

export class SessionStore {
  private sessions = new Map<string, SessionView>();
  private bindings = new Map<string, Binding>();
  private lastSessionId: string | undefined;
  private hydrated = false;

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const stored = (await browser.storage.local.get(STORAGE_KEY)) as { [STORAGE_KEY]?: PersistedState };
      const state = stored[STORAGE_KEY];
      if (state?.bindings) {
        for (const [sessionId, binding] of Object.entries(state.bindings)) {
          this.bindings.set(sessionId, binding);
        }
      }
      if (state?.lastSessionId) this.lastSessionId = state.lastSessionId;
    } catch {
      // storage read failures are non-fatal
    }
  }

  private persist(): void {
    const state: PersistedState = {
      bindings: Object.fromEntries(this.bindings),
      ...(this.lastSessionId ? { lastSessionId: this.lastSessionId } : {}),
    };
    browser.storage.local.set({ [STORAGE_KEY]: state }).catch(() => {});
  }

  /** Merge a session/list response into the view (preserving open-session state). */
  upsertFromList(sessions: SessionInfo[]): void {
    for (const s of sessions) {
      const existing = this.sessions.get(s.sessionId);
      this.sessions.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title ?? undefined,
        updatedAt: s.updatedAt ?? undefined,
        streaming: existing?.streaming ?? false,
        loaded: existing?.loaded ?? false,
        configOptions: existing?.configOptions,
      });
    }
  }

  upsertCreated(sessionId: string, cwd: string, configOptions?: SessionConfigOption[]): SessionView {
    const view: SessionView = {
      sessionId,
      cwd,
      updatedAt: new Date().toISOString(),
      streaming: false,
      loaded: true,
      configOptions,
    };
    this.sessions.set(sessionId, view);
    return view;
  }

  get(sessionId: string): SessionView | undefined {
    return this.sessions.get(sessionId);
  }

  all(): SessionView[] {
    return [...this.sessions.values()].sort((a, b) => {
      const au = a.updatedAt ?? "";
      const bu = b.updatedAt ?? "";
      return au < bu ? 1 : -1;
    });
  }

  setStreaming(sessionId: string, streaming: boolean): void {
    const v = this.sessions.get(sessionId);
    if (v) v.streaming = streaming;
  }

  markLoaded(sessionId: string): void {
    const v = this.sessions.get(sessionId);
    if (v) v.loaded = true;
  }

  setConfigOptions(sessionId: string, options: SessionConfigOption[]): void {
    const v = this.sessions.get(sessionId);
    if (v) v.configOptions = options;
  }

  rename(sessionId: string, title: string): void {
    const v = this.sessions.get(sessionId);
    if (v) v.title = title;
  }

  // ------------------------------------------------------------------
  // Bindings (session ↔ tab)
  // ------------------------------------------------------------------

  bind(sessionId: string, binding: Binding): void {
    this.bindings.set(sessionId, binding);
    this.persist();
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
    this.persist();
  }

  getBinding(sessionId: string): Binding | undefined {
    return this.bindings.get(sessionId);
  }

  /** Find the session bound to a tab (for lifecycle event routing). */
  sessionForTab(tabId: number): string | undefined {
    for (const [sessionId, b] of this.bindings) {
      if (b.tabId === tabId) return sessionId;
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // Last session
  // ------------------------------------------------------------------

  get lastSession(): string | undefined {
    return this.lastSessionId;
  }

  setLastSession(sessionId: string): void {
    this.lastSessionId = sessionId;
    this.persist();
  }

  // ------------------------------------------------------------------
  // Snapshot for the sidebar
  // ------------------------------------------------------------------

  snapshot(): {
    sessions: Array<{
      sessionId: string;
      cwd: string;
      title?: string;
      updatedAt?: string;
      streaming: boolean;
      loaded: boolean;
      binding?: Binding;
      configOptions?: SessionConfigOption[];
    }>;
    lastSessionId?: string;
  } {
    return {
      sessions: this.all().map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title,
        updatedAt: s.updatedAt,
        streaming: s.streaming,
        loaded: s.loaded,
        configOptions: s.configOptions,
        binding: this.bindings.get(s.sessionId),
      })),
      ...(this.lastSessionId ? { lastSessionId: this.lastSessionId } : {}),
    };
  }
}
