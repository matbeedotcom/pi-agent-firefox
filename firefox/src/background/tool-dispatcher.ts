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
import type { SessionStore } from "./session-store.js";

interface ContentResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; data?: unknown };
}

function textResult(payload: unknown) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function imageResult(dataUrl: string, mimeType: string) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) throw new PiBrowserProtocolError(PI_BROWSER_ERROR.INTERNAL, "bad capture data URL");
  return { content: [{ type: "image", data: match[2], mimeType: match[1] }] };
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class ToolDispatcher {
  constructor(private readonly store: SessionStore) {}

  /** Entry point for x-pi-browser/tool requests from the host. */
  async handleToolCall(params: BrowserToolCallParams): Promise<unknown> {
    const { sessionId, tool, arguments: args } = params;
    const def = getBrowserTool(tool);
    if (!def) {
      throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `unknown browser tool: ${tool}`);
    }

    const binding = this.store.getBinding(sessionId);
    if (!binding) {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_NOT_BOUND,
        `session ${sessionId} has no bound Firefox tab`,
      );
    }

    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(binding.tabId);
    } catch {
      throw new PiBrowserProtocolError(
        PI_BROWSER_ERROR.BROWSER_TAB_CLOSED,
        `bound tab ${binding.tabId} no longer exists`,
      );
    }

    const timeoutMs = Math.min(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000);
    switch (tool) {
      case "browser_get_page":
        return this.getPage(tab);
      case "browser_get_selection":
        return textResult((await this.content(tab, { type: "pi:selection" }, timeoutMs)).data ?? { text: "" });
      case "browser_get_dom":
        return textResult((await this.content(tab, { type: "pi:dom", maxElements: args?.maxElements }, timeoutMs)).data);
      case "browser_screenshot":
        return this.screenshot(tab, args);
      case "browser_reload":
        await browser.tabs.reload(tab.id as number);
        return textResult({ reloaded: tab.url });
      case "browser_click":
        return textResult((await this.content(tab, { type: "pi:click", ref: args?.ref }, timeoutMs)).data);
      case "browser_type":
        return textResult(
          (await this.content(tab, { type: "pi:type", ref: args?.ref, text: args?.text, submit: args?.submit }, timeoutMs)).data,
        );
      case "browser_wait_for":
        return textResult(
          (
            await this.content(
              tab,
              { type: "pi:wait", selector: args?.selector, state: args?.state ?? "visible", timeoutMs: args?.timeoutMs },
              Math.max(timeoutMs, 5_000),
            )
          ).data,
        );
      default:
        throw new PiBrowserProtocolError(PI_BROWSER_ERROR.MCP_TOOL_NOT_FOUND, `no handler for ${tool}`);
    }
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

    // captureVisibleTab(windowId) captures the selected tab of that window.
    // Before capturing we make the bound tab the selected tab and focus its
    // window; the capture is retried with growing settle delays because
    // window focus is delivered asynchronously by the WM on Linux, and the
    // user's approval of the (permission-gated) screenshot is what makes the
    // tab's host access (activeTab) live at capture time.
    const isVisibilityError = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      return /visible|active|not visible|focus|permission/i.test(message);
    };

    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const delays = [300, 700, 1200, 2000, 3000];
    let lastErr: unknown;
    for (let i = 0; i < delays.length; i++) {
      await this.makeVisible(tab).catch(() => {});
      await settle(delays[i]);
      try {
        const shot = await browser.tabs.captureVisibleTab(tab.windowId as number, opts);
        return imageResult(shot, format === "jpeg" ? "image/jpeg" : "image/png");
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
      `cannot capture tab ${tab.id}: it must be the visible tab of a focused window ` +
        "(the tab was activated and its window focused before each attempt)",
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
  private async content(tab: browser.tabs.Tab, msg: Record<string, unknown>, timeoutMs: number): Promise<ContentResult> {
    const tabId = tab.id as number;

    const reply = await this.sendMessageToTab(tabId, msg, timeoutMs).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/receiving end does not exist|could not establish connection/i.test(message)) {
        // Attempt programmatic injection for http(s)/file pages.
        if (/^https?:|^file:/.test(tab.url ?? "")) {
          try {
            await browser.scripting.executeScript({
              target: { tabId },
              files: ["content.js"],
            });
            // Give the content script a beat to register.
            await new Promise((r) => setTimeout(r, 150));
            return await this.sendMessageToTab(tabId, msg, timeoutMs);
          } catch (injectErr) {
            const im = injectErr instanceof Error ? injectErr.message : String(injectErr);
            throw new PiBrowserProtocolError(
              PI_BROWSER_ERROR.BROWSER_PERMISSION_DENIED,
              `cannot access this page (${tab.url}): ${im}`,
            );
          }
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

  private sendMessageToTab(tabId: number, msg: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PiBrowserProtocolError(PI_BROWSER_ERROR.BROWSER_TOOL_TIMEOUT, `content script timed out: ${msg.type}`)),
        timeoutMs,
      );
      browser.tabs
        .sendMessage(tabId, msg)
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
