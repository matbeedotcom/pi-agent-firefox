const STORAGE_KEY = "piBrowserState";
export class SessionStore {
    sessions = new Map();
    bindings = new Map();
    lastSessionId;
    hydrated = false;
    async hydrate() {
        if (this.hydrated)
            return;
        this.hydrated = true;
        try {
            const stored = (await browser.storage.local.get(STORAGE_KEY));
            const state = stored[STORAGE_KEY];
            if (state?.bindings) {
                for (const [sessionId, binding] of Object.entries(state.bindings)) {
                    this.bindings.set(sessionId, binding);
                }
            }
            if (state?.lastSessionId)
                this.lastSessionId = state.lastSessionId;
        }
        catch {
            // storage read failures are non-fatal
        }
    }
    persist() {
        const state = {
            bindings: Object.fromEntries(this.bindings),
            ...(this.lastSessionId ? { lastSessionId: this.lastSessionId } : {}),
        };
        browser.storage.local.set({ [STORAGE_KEY]: state }).catch(() => { });
    }
    /** Merge a session/list response into the view (preserving open-session state). */
    upsertFromList(sessions) {
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
    upsertCreated(sessionId, cwd, configOptions) {
        const view = {
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
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    all() {
        return [...this.sessions.values()].sort((a, b) => {
            const au = a.updatedAt ?? "";
            const bu = b.updatedAt ?? "";
            return au < bu ? 1 : -1;
        });
    }
    setStreaming(sessionId, streaming) {
        const v = this.sessions.get(sessionId);
        if (v)
            v.streaming = streaming;
    }
    markLoaded(sessionId) {
        const v = this.sessions.get(sessionId);
        if (v)
            v.loaded = true;
    }
    setConfigOptions(sessionId, options) {
        const v = this.sessions.get(sessionId);
        if (v)
            v.configOptions = options;
    }
    rename(sessionId, title) {
        const v = this.sessions.get(sessionId);
        if (v)
            v.title = title;
    }
    // ------------------------------------------------------------------
    // Bindings (session ↔ tab)
    // ------------------------------------------------------------------
    bind(sessionId, binding) {
        this.bindings.set(sessionId, binding);
        this.persist();
    }
    unbind(sessionId) {
        this.bindings.delete(sessionId);
        this.persist();
    }
    getBinding(sessionId) {
        return this.bindings.get(sessionId);
    }
    /** Find the session bound to a tab (for lifecycle event routing). */
    sessionForTab(tabId) {
        for (const [sessionId, b] of this.bindings) {
            if (b.tabId === tabId)
                return sessionId;
        }
        return undefined;
    }
    // ------------------------------------------------------------------
    // Last session
    // ------------------------------------------------------------------
    get lastSession() {
        return this.lastSessionId;
    }
    setLastSession(sessionId) {
        this.lastSessionId = sessionId;
        this.persist();
    }
    // ------------------------------------------------------------------
    // Snapshot for the sidebar
    // ------------------------------------------------------------------
    snapshot() {
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
