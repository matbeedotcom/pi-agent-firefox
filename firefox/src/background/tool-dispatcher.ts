/**
 * Browser tool dispatcher (PRODUCT.md §25, §32–34, §38).
 *
 * Executes the MCP-compatible browser tools on the Firefox side. Every call
 * resolves sessionId -> bound tab first, and mutates ONLY that tab. A web
 * page can never initiate these — they are driven by Pi through the native
 * host.
 *
 * DOM-level tools (get_dom, get_selection, click, type, wait_for, viewport)
 * are executed by the content script; page/screenshot/reload run in the
 * background.
 */
import {
  PI_BROWSER_ERROR,
  PiBrowserProtocolError,
  getBrowserTool,
  type BrowserToolCallParams,
} from "@pi-browser/protocol";
import { bindingOwner, bindingRefId, type SessionStore } from "@pi-browser/webext";
import { networkLog } from "./network-log.js";
import { ReplTabs } from "./repl-tabs.js";

interface ContentResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; data?: unknown };
}

function textResult(payload: unknown) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function imageResult(dataUrl: string, mimeType: string, via?: string) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "bad capture data URL");
  const content: Array<Record<string, unknown>> = [{ type: "image", data: match[2], mimeType: match[1] }];
  // A short note records which capture API produced the image (useful for
  // diagnosing which path works in a given browser build).
  if (via) content.push({ type: "text", text: `screenshot via ${via}` });
  return { content };
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class ToolDispatcher {
  /** Last capture error (from captureTab) so the fallback path can report it. */
  private lastCaptureError: unknown;

  constructor(
    private readonly store: SessionStore,
    private readonly replTabs: ReplTabs = new ReplTabs(),
  ) {}

  private async openTab(sessionId: string, args?: Record<string, unknown>): Promise<unknown> {
    const url = args?.url;
    if (typeof url !== "string" || !url.trim()) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "browser_open_tab requires a url string");
    }
    const current = this.store.getBinding(sessionId);
    // The user's tab is the restore point; re-binding to a REPL tab (or
    // back to the user's tab) keeps the FIRST user binding as home.
    if (current && bindingOwner(current) === "bound") this.replTabs.rememberHome(sessionId, current);
    const created = await browser.tabs.create({ url, active: true });
    const tabId = created.id as number;
    this.replTabs.open(sessionId, tabId);
    this.store.bind(sessionId, {
      ref: tabId,
      refId: tabId,
      label: url,
      windowId: created.windowId ?? 0,
      owner: "repl",
      tabId,
      tabTitle: url,
    });
    return textResult({ tabId, url });
  }

  private async closeTab(sessionId: string, args?: Record<string, unknown>): Promise<unknown> {
    const tabId = args?.tabId;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "browser_close_tab requires a tabId number");
    }
    if (!this.replTabs.has(sessionId, tabId)) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
        `tab ${tabId} is not owned by this session's REPL — the bound tab is released by unbinding in the sidebar`,
      );
    }
    await browser.tabs.remove(tabId);
    this.replTabs.close(sessionId, tabId);
    // If the session's binding pointed at the closed tab, restore the
    // user's home tab (or unbind when there is none).
    const binding = this.store.getBinding(sessionId);
    if (binding && bindingRefId(binding) === tabId) {
      const home = this.replTabs.takeHome(sessionId);
      if (home) this.store.bind(sessionId, home);
      else this.store.unbind(sessionId);
    }
    return textResult({ closed: tabId });
  }

  private async listTabs(sessionId: string): Promise<unknown> {
    const binding = this.store.getBinding(sessionId);
    const boundId = binding ? bindingRefId(binding) : undefined;
    const tabs = await browser.tabs.query({});
    return textResult({
      tabs: tabs
        .filter((t) => typeof t.id === "number")
        .map((t) => ({
          id: t.id as number,
          url: t.url ?? "",
          title: t.title ?? "",
          bound: t.id === boundId,
          ...(t.windowId !== undefined ? { windowId: t.windowId } : {}),
        })),
    });
  }

  /** Entry point for x-pi-browser/tool requests from the host. */
  async handleToolCall(params: BrowserToolCallParams): Promise<unknown> {
    const { sessionId, tool, arguments: args } = params;
    const def = getBrowserTool(tool);
    if (!def) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown browser tool: ${tool}`);
    }

    const binding = this.store.getBinding(sessionId);
    const tabId = binding ? bindingRefId(binding) : undefined;
    if (tabId === undefined) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_NOT_BOUND,
        `session ${sessionId} has no bound Firefox tab`,
      );
    }

    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_TAB_CLOSED,
        `bound tab ${tabId} no longer exists`,
      );
    }

    const timeoutMs = Math.min(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000);
    switch (tool) {
      case "browser_get_page":
        return this.getPage(tab);
      case "browser_get_selection": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult((await this.content(tab, { type: "pi:selection" }, timeoutMs, frameId)).data ?? { text: "" });
      }
      case "browser_get_dom": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult(
          (await this.content(tab, { type: "pi:dom", maxElements: args?.maxElements }, timeoutMs, frameId)).data,
        );
      }
      case "browser_screenshot":
        return this.screenshot(tab, args);
      case "browser_reload":
        await browser.tabs.reload(tab.id as number);
        return textResult({ reloaded: tab.url });
      case "browser_click": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult((await this.content(tab, { type: "pi:click", ref: args?.ref }, timeoutMs, frameId)).data);
      }
      case "browser_type": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult(
          (
            await this.content(
              tab,
              { type: "pi:type", ref: args?.ref, text: args?.text, submit: args?.submit },
              timeoutMs,
              frameId,
            )
          ).data,
        );
      }
      case "browser_wait_for": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult(
          (
            await this.content(
              tab,
              { type: "pi:wait", selector: args?.selector, state: args?.state ?? "visible", timeoutMs: args?.timeoutMs },
              Math.max(timeoutMs, 5_000),
              frameId,
            )
          ).data,
        );
      }
      case "browser_evaluate": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        // Page-world eval has its own 15 s internal deadline plus the
        // isolated-world fallback, so give the round-trip some slack.
        return textResult(
          (
            await this.content(
              tab,
              { type: "pi:evaluate", expression: args?.expression, arg: args?.arg },
              Math.max(timeoutMs, 25_000),
              frameId,
            )
          ).data,
        );
      }
      case "browser_get_accessibility_tree": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        // format "nodes" (REPL page.snapshot()) returns structured nodes;
        // the default "text" outline is unchanged.
        const format = args?.format === "nodes" ? "nodes" : "text";
        return textResult(
          (
            await this.content(
              tab,
              {
                type: format === "nodes" ? "pi:a11yNodes" : "pi:a11y",
                maxNodes: args?.maxNodes,
                maxDepth: args?.maxDepth,
              },
              timeoutMs,
              frameId,
            )
          ).data,
        );
      }
      case "browser_click_at": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult(
          (await this.content(tab, { type: "pi:clickAt", x: args?.x, y: args?.y }, timeoutMs, frameId)).data,
        );
      }
      case "browser_focus": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult((await this.content(tab, { type: "pi:focus", ref: args?.ref }, timeoutMs, frameId)).data);
      }
      case "browser_scroll": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult((await this.content(tab, { type: "pi:scroll", ref: args?.ref }, timeoutMs, frameId)).data);
      }
      case "browser_type_focused": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult(
          (await this.content(tab, { type: "pi:typeFocused", text: args?.text }, timeoutMs, frameId)).data,
        );
      }
      case "browser_get_console": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult(
          (
            await this.content(
              tab,
              { type: "pi:console", level: args?.level, limit: args?.limit, since: args?.since, clear: args?.clear },
              timeoutMs,
              frameId,
            )
          ).data,
        );
      }
      case "browser_get_network":
        return textResult(
          networkLog.get(tab.id as number, {
            filter: args?.filter,
            method: args?.method,
            errorsOnly: args?.errorsOnly === true,
            limit: args?.limit,
          }),
        );
      case "browser_element_at": {
        const frameId = await this.resolveFrameId(tab.id as number, args?.frame);
        return textResult(
          (await this.content(tab, { type: "pi:elementAt", x: args?.x, y: args?.y }, timeoutMs, frameId)).data,
        );
      }
      case "browser_navigate":
        return this.navigate(tab, args);
      case "browser_open_tab":
        return this.openTab(sessionId, args);
      case "browser_close_tab":
        return this.closeTab(sessionId, args);
      case "browser_list_tabs":
        return this.listTabs(sessionId);
      default:
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `no handler for ${tool}`);
    }
  }

  /**
   * Resolve the optional `frame` tool argument to a concrete frameId.
   * Absent / null / "top" means the top frame (0). A number must be an
   * existing frameId; a string is a case-insensitive URL substring (first
   * match wins). Failures carry the tab's current frame list in `data`
   * so the caller can self-correct.
   */
  private async resolveFrameId(tabId: number, frame: unknown): Promise<number> {
    if (frame === undefined || frame === null || frame === 0 || frame === "top") return 0;
    const frames = await this.listFrames(tabId);
    if (typeof frame === "number") {
      if (frames.some((f) => f.frameId === frame)) return frame;
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_FRAME_NOT_FOUND,
        `frame ${frame} not found in this tab (it may have navigated away)`,
        { frames },
      );
    }
    if (typeof frame === "string" && frame.length > 0) {
      const needle = frame.toLowerCase();
      const hit = frames.find((f) => f.url.toLowerCase().includes(needle));
      if (hit) return hit.frameId;
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_FRAME_NOT_FOUND,
        `no frame URL contains "${frame}" in this tab`,
        { frames },
      );
    }
    throw new PiBrowserProtocolError(
      PI_BROWSER_ERROR.INTERNAL,
      "frame must be a frameId number or a URL substring string",
    );
  }

  private async listFrames(tabId: number): Promise<Array<{ frameId: number; url: string }>> {
    try {
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      return (frames ?? []).map((f) => ({ frameId: f.frameId, url: (f.url ?? "").slice(0, 300) }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `could not list frames of tab ${tabId}: ${message}`);
    }
  }

  private async navigate(tab: browser.tabs.Tab, args: Record<string, unknown> | undefined): Promise<unknown> {
    const url = typeof args?.url === "string" ? args.url.trim() : "";
    // Only absolute http(s)/file URLs: no javascript:, data:, or scheme-less
    // values (tabs.update would happily navigate to relative junk).
    if (!/^(https?|file):\/\//i.test(url)) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.INTERNAL,
        "browser_navigate requires an absolute http(s) or file URL",
      );
    }
    await browser.tabs.update(tab.id as number, { url });
    return textResult({ navigatingTo: url });
  }

  private async getPage(tab: browser.tabs.Tab): Promise<unknown> {
    let viewport = { width: 0, height: 0 };
    try {
      const res = await this.content(tab, { type: "pi:viewport" }, 5_000);
      if (res.data) viewport = res.data as { width: number; height: number };
    } catch {
      // viewport is best-effort (e.g. chrome:// pages)
    }
    return textResult({ url: tab.url, title: tab.title, viewport });
  }

  private async screenshot(tab: browser.tabs.Tab, args: Record<string, unknown> | undefined): Promise<unknown> {
    const format = args?.format === "jpeg" ? "jpeg" : "png";
    const quality = typeof args?.quality === "number" ? args.quality : 80;
    const opts = { format, quality } as { format: "png" | "jpeg"; quality?: number };
    const mime = format === "jpeg" ? "image/jpeg" : "image/png";

    // 1) captureTab(tabId) — captures the SPECIFIC tab's surface; no OS-focus
    //    dependency. Requires <all_urls>. Try it first; the result note records
    //    which API produced the image.
    try {
      const dataUrl = await browser.tabs.captureTab(tab.id as number, opts);
      return imageResult(dataUrl, mime, "captureTab");
    } catch (err) {
      // Fall through to captureVisibleTab below; remember the error for the
      // final failure message if that also fails.
      this.lastCaptureError = err;
    }

    // 2) captureVisibleTab(windowId) — captures the window's selected (visible)
    //    tab. Before each attempt we make the bound tab the selected tab and
    //    focus its window; retried with growing settle delays because window
    //    focus is delivered asynchronously by the WM on Linux, and the user's
    //    approval of the (permission-gated) screenshot is what makes the tab's
    //    host access (activeTab) live at capture time.
    const isVisibilityError = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      return /visible|active|not visible|focus|permission/i.test(message);
    };
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const delays = [300, 700, 1200, 2000, 3000];
    let lastErr: unknown = this.lastCaptureError;
    for (let i = 0; i < delays.length; i++) {
      await this.makeVisible(tab).catch(() => {});
      await settle(delays[i]);
      try {
        const shot = await browser.tabs.captureVisibleTab(tab.windowId as number, opts);
        return imageResult(shot, mime, "captureVisibleTab");
      } catch (err) {
        lastErr = err;
        if (!isVisibilityError(err)) break;
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    if (lastErr && !isVisibilityError(lastErr)) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, `screenshot failed: ${message}`);
    }
    throw new PiBrowserProtocolError(
      PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
      `cannot capture tab ${tab.id}: tried captureTab and captureVisibleTab ` +
        "(the tab was activated and its window focused before each attempt): " + message,
    );
  }

  /**
   * Make the bound tab the active tab of its window and request OS focus for
   * that window. Focus is delivered asynchronously by the window manager
   * (especially on Linux), so the caller must settle before capturing — this
   * method only asserts the desired state and returns.
   */
  private async makeVisible(tab: browser.tabs.Tab): Promise<void> {
    const tabId = tab.id as number;
    const windowId = tab.windowId as number;
    await browser.tabs.update(tabId, { active: true });
    if (windowId) {
      await browser.windows.update(windowId, { focused: true }).catch(() => {
        // Some windows (e.g. pinned) reject focus updates; the capture retry
        // path will surface a real failure if visibility was not achieved.
      });
    }
  }

  /**
   * Send a message to the tab's content script. If the content script is not
   * injected (privileged pages, pre-injection), try programmatic injection
   * once; if that is not allowed, surface a structured permission error.
   */
  private async content(
    tab: browser.tabs.Tab,
    msg: Record<string, unknown>,
    timeoutMs: number,
    frameId?: number,
  ): Promise<ContentResult> {
    const tabId = tab.id as number;

    const reply = await this.sendMessageToTab(tabId, msg, timeoutMs, frameId).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/receiving end does not exist|could not establish connection/i.test(message)) {
        // Attempt programmatic injection for http(s)/file pages.
        if (/^https?:|^file:/.test(tab.url ?? "")) {
          try {
            await browser.scripting.executeScript({
              target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
              files: ["content.js"],
            });
            // Give the content script a beat to register.
            await new Promise((r) => setTimeout(r, 150));
            return await this.sendMessageToTab(tabId, msg, timeoutMs, frameId);
          } catch (injectErr) {
            const im = injectErr instanceof Error ? injectErr.message : String(injectErr);
            if (frameId !== undefined && /frame/i.test(im)) {
              throw new PiBrowserProtocolError(
                PI_BROWSER_ERROR.BROWSER_FRAME_NOT_FOUND,
                `frame ${frameId} is no longer available: ${im}`,
              );
            }
            throw new PiBrowserProtocolError(
              PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
              `cannot access this page (${tab.url}): ${im}`,
            );
          }
        }
        if (frameId !== undefined) {
          throw new PiBrowserProtocolError(
            PI_BROWSER_ERROR.BROWSER_FRAME_NOT_FOUND,
            `no content script in frame ${frameId} of ${tab.url ?? "this page"} — the frame may have navigated away; re-run browser_get_dom for fresh frame ids`,
          );
        }
        throw new PiBrowserProtocolError(
          PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
          `content script unavailable on ${tab.url ?? "privileged page"}`,
        );
      }
      if (err instanceof PiBrowserProtocolError) throw err;
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT, message);
    });

    const result = reply as ContentResult | undefined;
    if (!result) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED, `no reply from content script on ${tab.url}`);
    }
    if (!result.ok) {
      const code = (result.error?.code as PiBrowserErrorCodeString) ?? PI_BROWSER_ERROR.INTERNAL;
      throw new PiBrowserProtocolError(code, result.error?.message ?? "content script error", result.error?.data);
    }
    return result;
  }

  private sendMessageToTab(
    tabId: number,
    msg: Record<string, unknown>,
    timeoutMs: number,
    frameId?: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT, `content script timed out: ${msg.type}`)),
        timeoutMs,
      );
      browser.tabs
        .sendMessage(tabId, msg, frameId === undefined ? undefined : { frameId })
        .then(
          (resp) => {
            clearTimeout(timer);
            resolve(resp);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
    });
  }
}

type PiBrowserErrorCodeString =
  | "BROWSER_TAB_CLOSED"
  | "BROWSER_PERMISSION_DENIED"
  | "BROWSER_ELEMENT_STALE"
  | "BROWSER_TOOL_TIMEOUT"
  | "INTERNAL";
