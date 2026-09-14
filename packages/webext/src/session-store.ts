/**
 * Session presentation state (PRODUCT.md §20, §24; THUNDERBIRD-PLAN.md §8).
 *
 * The add-on owns ONLY presentation/binding state. Conversation history and
 * session semantics live in Pi (ACP is authoritative). Persisted state is
 * deliberately small: bindings + last session.
 *
 * Shared by Firefox (tab bindings) and Thunderbird (message bindings land in
 * T2; the binding map is simply unused until then).
 */
import type { SessionInfo, SessionConfigOption } from "@pi-browser/protocol";

/**
 * App-specific context attached to a session (Firefox: tab, TB: message/folder).
 *
 * `ref`/`refId`/`label` are the canonical generic fields. The `tabId` and
 * `tabTitle` fields are kept for backward compatibility with bindings
 * persisted by earlier Firefox builds (and the still-shipped Firefox code).
 */
export interface Binding {
  /** Opaque app-specific id (Firefox tabId / Thunderbird messageId, ...). */
  ref?: number | string;
  /** Numeric form when the app uses ids (undefined for string refs). */
  refId?: number;
  /** Window/space handle where the ref lives (optional). */
  windowId?: number;
  /** Human-readable label for the UI. */
  label?: string;
  /**
   * Firefox: who owns the bound tab (BROWSER-USE-REPL-PLAN.md Phase 2).
   * "bound" = the user bound it (sidebar); "repl" = opened by the session's
   * javascript REPL (tabs.open) — closed automatically when the session
   * unbinds or ends. Absent (legacy) = "bound".
   */
  owner?: "bound" | "repl";
  /** @deprecated legacy Firefox tab id (=== refId for tabs). */
  tabId?: number;
  /** @deprecated legacy Firefox tab title (=== label for tabs). */
  tabTitle?: string;
}

/** "bound" unless the binding says otherwise (legacy bindings have no flag). */
export function bindingOwner(b: Binding): "bound" | "repl" {
  return b.owner === "repl" ? "repl" : "bound";
}

/** The numeric handle a binding refers to (refId, falling back to legacy tabId). */
export function bindingRefId(b: Binding): number | undefined {
  if (typeof b.refId === "number") return b.refId;
  if (typeof b.tabId === "number") return b.tabId;
  if (typeof b.ref === "number") return b.ref;
  return undefined;
}

/** The display label for a binding (label, falling back to legacy tabTitle). */
export function bindingLabel(b: Binding): string | undefined {
  return b.label ?? b.tabTitle;
}

export interface SessionView {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  messageCount?: number;
  streaming: boolean;
  /** True once the UI has the transcript (fresh create or session/load replay). */
  loaded: boolean;
  configOptions?: SessionConfigOption[];
}

export interface PersistedState {
  bindings: Record<string, Binding>;
  lastSessionId?: string;
}

const DEFAULT_STORAGE_KEY = "piBrowserState";

export class SessionStore {
  /**
   * Storage key for persisted state. Firefox keeps its original key so
   * existing users' last-session/bindings survive the shared-store refactor;
   * Thunderbird uses its own.
   */
  private readonly storageKey: string;
  private sessions = new Map<string, SessionView>();
  private bindings = new Map<string, Binding>();
  private lastSessionId: string | undefined;
  private hydrated = false;

  constructor(storageKey: string = DEFAULT_STORAGE_KEY) {
    this.storageKey = storageKey;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const stored = (await browser.storage.local.get(this.storageKey)) as Record<string, PersistedState | undefined>;
      const state = stored[this.storageKey];
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
    browser.storage.local.set({ [this.storageKey]: state }).catch(() => {});
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
  // Bindings (session ↔ app context)
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

  /** Find the session whose binding refers to the given numeric app id. */
  sessionForRef(refId: number): string | undefined {
    for (const [sessionId, b] of this.bindings) {
      if (bindingRefId(b) === refId) return sessionId;
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
  // Snapshot for the UI
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
