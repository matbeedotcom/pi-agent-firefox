/**
 * Content script: DOM access, stable element references, and page
 * interaction (PRODUCT.md §32–34).
 *
 * Runs per top-level document. Element references are document-scoped: a
 * navigation replaces the document (and thus all refs), which is exactly
 * the stale-ref semantics the spec requires.
 *
 * Everything the page shows us is UNTRUSTED data: it is returned to the
 * agent as tool output, never concatenated into a user prompt (PRODUCT.md
 * §37).
 */

// ---------------------------------------------------------------------------
// Stable element references
// ---------------------------------------------------------------------------

const refs = new Map<string, Element>();
let refCounter = 0;

interface ElementSummary {
  ref: string;
  role: string;
  tag: string;
  text: string;
  name?: string;
  disabled?: boolean;
  href?: string;
  visible: boolean;
}

function assignRef(el: Element): string {
  for (const [ref, existing] of refs) {
    if (existing === el) return ref;
  }
  const ref = `el-${++refCounter}`;
  refs.set(ref, el);
  return ref;
}

function refOf(param: unknown): Element | undefined {
  if (typeof param !== "string") return undefined;
  return refs.get(param);
}

function stale(ref: string): never {
  throw new ContentError("BROWSER_ELEMENT_STALE", `element reference ${ref} is stale (page changed or element removed)`);
}

function describe(el: Element): { tag: string; role: string; text: string } {
  return {
    tag: el.tagName.toLowerCase(),
    role: inferRole(el),
    text: visibleText(el).slice(0, 120),
  };
}

function visibleText(el: Element): string {
  const source = el instanceof HTMLElement && el.innerText !== undefined ? el.innerText : el.textContent;
  return (source ?? "").replace(/\s+/g, " ").trim();
}

function inferRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a") return el.hasAttribute("href") ? "link" : "anchor";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "submit" ? "button" : "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "aside") return "complementary";
  if (tag === "form") return "form";
  if ((el as HTMLElement).isContentEditable) return "textbox";
  return tag;
}

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.offsetParent !== null) return true;
  const style = getComputedStyle(html);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

const SELECTOR = [
  "h1",
  "h2",
  "h3",
  "nav",
  "main",
  "aside",
  "form",
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[onclick]",
  "[contenteditable=true]",
  "img[alt]",
].join(",");

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function dom(maxElements?: number): { refCount: number; elements: ElementSummary[] } {
  const max = Math.min(Math.max(typeof maxElements === "number" ? maxElements : 400, 20), 2000);
  refs.clear();
  refCounter = 0;
  const seen = new Set<Element>();
  const elements: ElementSummary[] = [];
  const nodes = document.querySelectorAll(SELECTOR);
  for (const el of Array.from(nodes)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (elements.length >= max) break;
    const html = el as HTMLElement;
    const summary: ElementSummary = {
      ref: assignRef(el),
      role: inferRole(el),
      tag: el.tagName.toLowerCase(),
      text: visibleText(el).slice(0, 120),
      visible: isVisible(el),
    };
    const name = html.getAttribute("name") || html.getAttribute("id") || html.getAttribute("placeholder") || html.getAttribute("aria-label");
    if (name) summary.name = name.slice(0, 80);
    const href = html.getAttribute("href");
    if (href) summary.href = href.slice(0, 200);
    const disabler = el as HTMLInputElement;
    if ("disabled" in el && disabler.disabled) summary.disabled = true;
    elements.push(summary);
  }
  return { refCount: elements.length, elements };
}

function selection(): { text: string } {
  const sel = window.getSelection();
  return { text: sel ? sel.toString() : "" };
}

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function click(ref: unknown): { clicked: { tag: string; role: string; text: string } } {
  const el = refOf(ref);
  if (!el || !el.isConnected) stale(String(ref));
  try {
    (el as HTMLElement).focus?.({ preventScroll: false });
    (el as HTMLElement).click();
  } catch (err) {
    throw new ContentError("BROWSER_PERMISSION_DENIED", `click failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { clicked: describe(el) };
}

function type(ref: unknown, text: unknown, submit?: boolean): { typed: { tag: string; role: string }; chars: number; submitted: boolean } {
  const el = refOf(ref);
  if (!el || !el.isConnected) stale(String(ref));
  if (typeof text !== "string") throw new ContentError("INTERNAL", "type requires a text string");
  const html = el as HTMLElement;

  const isTextInput =
    el instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "reset", "file"].includes(el.type) ||
    el instanceof HTMLTextAreaElement;

  if (isTextInput) {
    const target = el as HTMLInputElement | HTMLTextAreaElement;
    const setter =
      target instanceof HTMLTextAreaElement
        ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
        : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    target.focus();
    if (setter) setter.call(target, text);
    else target.value = text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    html.focus?.();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      html.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, data: text, inputType: "insertText" }),
      );
      html.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
  }

  let submitted = false;
  if (submit) {
    const form =
      (el as HTMLInputElement).form ?? (el as HTMLElement).closest("form");
    if (form) {
      try {
        (form as HTMLFormElement).requestSubmit();
        submitted = true;
      } catch (err) {
        throw new ContentError("BROWSER_PERMISSION_DENIED", `form submit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { typed: describe(el), chars: text.length, submitted };
}

function waitFor(selector: unknown, state: unknown, timeoutMs: unknown): Promise<{ found: boolean; waitedMs: number; state: string }> {
  if (typeof selector !== "string" || !selector) {
    return Promise.reject(new ContentError("INTERNAL", "wait_for requires a CSS selector"));
  }
  const wantState = state === "hidden" ? "hidden" : "visible";
  const timeout = Math.min(Math.max(typeof timeoutMs === "number" ? timeoutMs : 10_000, 200), 60_000);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const el = document.querySelector(selector);
      const visible = el !== null && isVisible(el);
      const satisfied = wantState === "visible" ? visible : !visible;
      if (satisfied) {
        resolve({ found: true, waitedMs: Date.now() - start, state: wantState });
        return;
      }
      if (Date.now() - start >= timeout) {
        reject(new ContentError("BROWSER_TOOL_TIMEOUT", `timeout waiting for ${selector} to be ${wantState}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Errors + message router
// ---------------------------------------------------------------------------

class ContentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContentError";
  }
}

type ContentMessage = {
  type: string;
  [key: string]: unknown;
};

async function handle(msg: ContentMessage): Promise<unknown> {
  switch (msg.type) {
    case "pi:dom":
      return dom(msg.maxElements as number | undefined);
    case "pi:selection":
      return selection();
    case "pi:viewport":
      return viewport();
    case "pi:click":
      return click(msg.ref);
    case "pi:type":
      return type(msg.ref, msg.text, msg.submit as boolean | undefined);
    case "pi:wait":
      return await waitFor(msg.selector, msg.state, msg.timeoutMs as number | undefined);
    default:
      throw new ContentError("INTERNAL", `unknown content message: ${msg.type}`);
  }
}

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as ContentMessage;
  if (typeof msg.type !== "string" || !msg.type.startsWith("pi:")) return;
  void handle(msg)
    .then((data) => {
      sendResponse({ ok: true, data });
    })
    .catch((err: unknown) => {
      if (err instanceof ContentError) {
        sendResponse({ ok: false, error: { code: err.code, message: err.message } });
      } else {
        sendResponse({ ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } });
      }
    });
  return true; // async sendResponse
});
