/**
 * Per-tab network request log for browser_get_network (PRODUCT.md §36).
 *
 * Observes the bound tab's requests through webRequest (Firefox MV3 keeps
 * the non-blocking webRequest API) and keeps a ring buffer per tab:
 * URL, method, request type, status, and duration where available. This is
 * request METADATA only — no bodies, no headers (broader capture is a
 * later phase per §36).
 *
 * Runs in the background event page; started once at boot from index.ts.
 */

/** One observed request (or its failure). */
export interface NetworkRequest {
  /** Monotonic per-log id (newest = highest). */
  id: number;
  /** Request start, Unix ms. */
  time: number;
  url: string;
  method: string;
  /** webRequest type: "xmlhttprequest", "script", "image", "main_frame", ... */
  type: string;
  /** HTTP status when the request completed. */
  status?: number;
  statusText?: string;
  /** Start→end duration in ms (completed or failed requests). */
  durationMs?: number;
  /** True when the request failed before a response (network error, blocked, ...). */
  failed?: boolean;
  /** Browser error string for failed requests (e.g. "NS_ERROR_OFFLINE"). */
  error?: string;
}

interface QueryOptions {
  filter?: unknown;
  method?: unknown;
  errorsOnly?: unknown;
  limit?: unknown;
}

const MAX_ENTRIES_PER_TAB = 500;
const MAX_TRACKED_TABS = 64;

interface TabState {
  entries: NetworkRequest[];
  inflight: Map<string, { url: string; method: string; type: string; start: number }>;
}

export class NetworkLog {
  private tabs = new Map<number, TabState>();
  private nextId = 1;
  private started = false;

  /** Attach the webRequest listeners. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Observe all requests: the filter arg is required by the event typing;
    // <all_urls> is the unrestricted URL-pattern wildcard.
    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (typeof details.tabId !== "number" || details.tabId < 0) return;
        const t = this.tabState(details.tabId);
        t.inflight.set(details.requestId, {
          url: details.url,
          method: details.method,
          type: details.type,
          start: details.timeStamp,
        });
      },
      { urls: ["<all_urls>"] },
    );

    browser.webRequest.onCompleted.addListener(
      (details) => {
        if (typeof details.tabId !== "number" || details.tabId < 0) return;
        const t = this.tabState(details.tabId);
        const started = t.inflight.get(details.requestId);
        t.inflight.delete(details.requestId);
        // "HTTP/1.1 200 OK" -> "OK"
        const statusText = (details.statusLine ?? "").split(/\s+/).slice(2).join(" ") || undefined;
        const entry: NetworkRequest = {
          id: this.nextId++,
          time: started?.start ?? details.timeStamp,
          url: details.url,
          method: details.method,
          type: details.type,
          status: details.statusCode,
          ...(statusText ? { statusText } : {}),
          durationMs: Math.max(0, Math.round(details.timeStamp - (started?.start ?? details.timeStamp))),
        };
        t.entries.push(entry);
        this.trim(t);
      },
      { urls: ["<all_urls>"] },
    );

    browser.webRequest.onErrorOccurred.addListener(
      (details) => {
        if (typeof details.tabId !== "number" || details.tabId < 0) return;
        const t = this.tabState(details.tabId);
        const started = t.inflight.get(details.requestId);
        t.inflight.delete(details.requestId);
        t.entries.push({
          id: this.nextId++,
          time: started?.start ?? details.timeStamp,
          url: details.url,
          method: details.method,
          type: details.type,
          failed: true,
          error: details.error,
          durationMs: started ? Math.max(0, Math.round(details.timeStamp - started.start)) : undefined,
        });
        this.trim(t);
      },
      { urls: ["<all_urls>"] },
    );

    browser.tabs.onRemoved.addListener((tabId) => {
      this.tabs.delete(tabId);
    });
  }

  /** Query a tab's recent requests (newest first after filtering). */
  get(tabId: number, opts: QueryOptions = {}): {
    requests: NetworkRequest[];
    total: number;
    returned: number;
    truncated: boolean;
  } {
    const t = this.tabs.get(tabId);
    const entries = t ? t.entries : [];
    const f = typeof opts.filter === "string" && opts.filter !== "" ? opts.filter.toLowerCase() : null;
    const m = typeof opts.method === "string" && opts.method !== "" ? opts.method.toUpperCase() : null;
    const matched = entries.filter(
      (e) =>
        (!f || e.url.toLowerCase().includes(f)) &&
        (!m || e.method.toUpperCase() === m) &&
        (!opts.errorsOnly || e.failed === true || (typeof e.status === "number" && e.status >= 400)),
    );
    matched.sort((a, b) => b.time - a.time);
    const limit = Math.min(Math.max(typeof opts.limit === "number" ? opts.limit : 50, 1), 200);
    const page = matched.slice(0, limit);
    return { requests: page, total: entries.length, returned: page.length, truncated: matched.length > page.length };
  }

  private tabState(tabId: number): TabState {
    let t = this.tabs.get(tabId);
    if (!t) {
      // Bound the memory: drop the oldest tracked tab when full.
      if (this.tabs.size >= MAX_TRACKED_TABS) {
        const oldest = this.tabs.keys().next().value;
        if (oldest !== undefined) this.tabs.delete(oldest);
      }
      t = { entries: [], inflight: new Map() };
      this.tabs.set(tabId, t);
    }
    return t;
  }

  private trim(t: TabState): void {
    const over = t.entries.length - MAX_ENTRIES_PER_TAB;
    if (over > 0) t.entries.splice(0, over);
  }
}

/** Singleton used by the ToolDispatcher. */
export const networkLog = new NetworkLog();
