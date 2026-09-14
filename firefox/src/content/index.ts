/**
 * Content script: DOM access, stable element references, and page
 * interaction (PRODUCT.md §32–34).
 *
 * Runs per top-level document. Element references are document-scoped: a
 * navigation replaces the document (and thus all refs), which is exactly
 * the stale-ref semantics the spec requires.
 *
 * The page-world side of the house (console ring buffer + page-world
 * evaluate) lives in console-capture.ts (MAIN world, document_start); this
 * script talks to it over window.postMessage round-trips.
 *
 * Everything the page shows us is UNTRUSTED data: it is returned to the
 * agent as tool output, never concatenated into a user prompt (PRODUCT.md
 * §37).
 */
import { isFunctionExpression, toJsonSafe } from "./shared.js";

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
  /** input element: the exact `type` (text, password, number, ...). */
  type?: string;
  /** checkbox/radio: current checked state. */
  checked?: boolean;
  /** h1–h6: heading level. */
  level?: number;
  /** Up to three CSS classes (for correlating with page source). */
  classes?: string;
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
  if (!(el instanceof HTMLElement)) return false;
  const html = el;
  const style = getComputedStyle(html);
  if (style.display === "none" || style.visibility === "hidden") return false;
  // getBoundingClientRect catches what offsetParent misses: display:none
  // ANCESTORS, detached nodes, and zero-size elements — while correctly
  // keeping position:fixed elements (modals, sticky headers) visible.
  const rect = html.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

// Coverage note: [onclick] alone misses modern SPAs — React/Vue delegate
// events at the root, so interactive divs/span carry ARIA roles or
// data-testid instead. The selector set therefore anchors on element kinds
// an LLM needs (text, tables, forms, interactive) plus any ARIA-role and
// explicit-hook attribute.
const SELECTOR = [
  // headings and text
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "label",
  // landmarks and structure
  "nav",
  "main",
  "aside",
  "header",
  "footer",
  "section",
  "article",
  "figure",
  "details",
  "summary",
  "form",
  // tables
  "table",
  "tr",
  "th",
  "td",
  // native interactive elements
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  // ARIA roles (framework widgets built from div/span)
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=combobox]",
  "[role=listbox]",
  "[role=option]",
  "[role=searchbox]",
  "[role=slider]",
  "[role=spinbutton]",
  "[role=gridcell]",
  "[role=row]",
  "[role=dialog]",
  "[role=alert]",
  "[role=treeitem]",
  // explicit hooks
  "[onclick]",
  "[contenteditable]",
  "[tabindex]",
  "[aria-label]",
  "[data-testid]",
  "img[alt]",
].join(",");

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Find the first non-empty img alt in this element (directly, in its light
 * DOM, or in its open shadow root). Icon-only links/buttons often carry
 * their only name there.
 */
function imgAltOf(root: Element): string {
  const direct = root.getAttribute("alt");
  if (direct) return direct;
  const candidates: Array<ParentNode | null> = [root];
  const sr = (root as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (sr) candidates.push(sr);
  for (const c of candidates) {
    if (!c) continue;
    try {
      const img = c.querySelector("img[alt]");
      if (img) {
        const alt = img.getAttribute("alt");
        if (alt) return alt;
      }
    } catch {
      // cross-world or otherwise inaccessible node: ignore
    }
  }
  return "";
}

function summarize(el: Element): ElementSummary {
  const html = el as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const summary: ElementSummary = {
    ref: assignRef(el),
    role: inferRole(el),
    tag,
    text: visibleText(el).slice(0, 120),
    visible: isVisible(el),
  };
  const imgAlt = tag === "img" ? html.getAttribute("alt") ?? "" : "";
  const name =
    html.getAttribute("name") ||
    (imgAlt ? imgAlt : null) ||
    html.getAttribute("id") ||
    html.getAttribute("placeholder") ||
    html.getAttribute("aria-label") ||
    html.getAttribute("title");
  if (name) summary.name = name.slice(0, 80);
  // Icon-only link/button: no visible text, no name attributes — the child
  // img's alt is the only name the user perceives.
  if (!summary.name && (tag === "a" || tag === "button")) {
    const alt = imgAltOf(el);
    if (alt) summary.name = alt.slice(0, 80);
  }
  const href = html.getAttribute("href");
  if (href) summary.href = href.slice(0, 200);
  const disabler = el as HTMLInputElement;
  if ("disabled" in el && disabler.disabled) summary.disabled = true;
  if (el instanceof HTMLInputElement) {
    if (el.type) summary.type = el.type;
    if (el.type === "checkbox" || el.type === "radio") summary.checked = el.checked;
  }
  const heading = /^h([1-6])$/.exec(el.tagName.toLowerCase());
  if (heading) summary.level = Number(heading[1]);
  if (typeof html.className === "string" && html.className) {
    const classes = html.className.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
    if (classes) summary.classes = classes.slice(0, 60);
  }
  return summary;
}

/**
 * Collect selector matches in document order, PIERCING open shadow roots:
 * querySelectorAll alone never sees web-component content. Every element is
 * scanned (and counted); a host element is always reported as a boundary
 * marker. Closed shadow roots are invisible to extensions — they are the
 * one case this cannot fix, and the dom() note says so when it matters.
 */
function collectMatches(): { elements: Element[]; scanned: number; shadowRoots: number } {
  const out: Element[] = [];
  const seen = new Set<Element>();
  let scanned = 0;
  let shadowRoots = 0;
  const push = (el: Element) => {
    if (!seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  };
  const visit = (root: ParentNode) => {
    let all: ArrayLike<Element>;
    try {
      all = root.querySelectorAll("*");
    } catch {
      return;
    }
    for (const el of Array.from(all)) {
      scanned++;
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) {
        shadowRoots++;
        push(el); // host marks the shadow boundary
        visit(sr); // shadow content, in document order
      }
      if (el.matches(SELECTOR)) push(el);
    }
  };
  visit(document);
  return { elements: out, scanned, shadowRoots };
}

interface FrameInfo {
  index: number;
  src: string;
  sameOrigin: boolean;
  title?: string;
}

/** Iframes in this frame — the map the agent uses to target child frames. */
function listFrames(): FrameInfo[] {
  const out: FrameInfo[] = [];
  let els: ArrayLike<Element>;
  try {
    els = document.querySelectorAll("iframe,frame");
  } catch {
    return out;
  }
  let index = 0;
  for (const el of Array.from(els)) {
    const html = el as HTMLIFrameElement;
    let sameOrigin = false;
    let title: string | undefined;
    try {
      // Accessing location.href throws for cross-origin frames.
      if (html.contentWindow) {
        void html.contentWindow.location.href;
        sameOrigin = true;
        title = html.contentDocument?.title;
      }
    } catch {
      sameOrigin = false;
    }
    out.push({
      index: index++,
      src: (html.src || el.getAttribute("src") || "").slice(0, 200),
      sameOrigin,
      ...(title ? { title } : {}),
    });
  }
  return out;
}

function dom(maxElements?: number): {
  refCount: number;
  elements: ElementSummary[];
  stats: { scanned: number; matched: number; shadowRoots: number; iframes: number };
  frames?: FrameInfo[];
  note?: string;
} {
  const max = Math.min(Math.max(typeof maxElements === "number" ? maxElements : 600, 20), 2000);
  refs.clear();
  refCounter = 0;
  const { elements: matches, scanned, shadowRoots } = collectMatches();
  const elements: ElementSummary[] = [];
  for (const el of matches) {
    if (elements.length >= max) break;
    elements.push(summarize(el));
  }
  const frames = listFrames();
  let note: string | undefined;
  if (elements.length < 10) {
    if (frames.length > 0) {
      note =
        `only ${elements.length} element(s) matched in this frame — the page content likely lives in a child frame; ` +
        "re-run browser_get_dom with the frame parameter (a frameId or URL substring from the frames list); " +
        "browser_click/browser_type/browser_wait_for/browser_evaluate/browser_get_console accept frame too";
    } else if (shadowRoots > 0) {
      note =
        `only ${elements.length} element(s) matched; ${shadowRoots} open shadow root(s) were traversed — ` +
        "any remaining content is in closed web-component shadow roots, which extensions cannot access";
    } else {
      note =
        `only ${elements.length} element(s) matched — the page may not have finished rendering (try browser_wait_for) ` +
        "or hides content in closed web-component shadow roots (not accessible)";
    }
  }
  return {
    refCount: elements.length,
    elements,
    stats: { scanned, matched: elements.length, shadowRoots, iframes: frames.length },
    ...(frames.length > 0 ? { frames } : {}),
    ...(note ? { note } : {}),
  };
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

/** The proven typing path (value-setter + input/change, else insertText). */
function typeInto(el: Element, text: string): { typed: { tag: string; role: string }; chars: number } {
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
  return { typed: describe(el), chars: text.length };
}

function type(ref: unknown, text: unknown, submit?: boolean): { typed: { tag: string; role: string }; chars: number; submitted: boolean } {
  const el = refOf(ref);
  if (!el || !el.isConnected) stale(String(ref));
  if (typeof text !== "string") throw new ContentError("INTERNAL", "type requires a text string");
  const result = typeInto(el, text);

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
  return { ...result, submitted };
}

/** Type into the currently focused element (no ref needed). */
function typeFocused(text: unknown): { typed: { tag: string; role: string }; chars: number } {
  if (typeof text !== "string") throw new ContentError("INTERNAL", "typeFocused requires a text string");
  const el = document.activeElement;
  if (!el || el === document.body) {
    throw new ContentError("BROWSER_ELEMENT_STALE", "no focused element — focus an input first (page.focus(ref) or click it)");
  }
  if (!el.isConnected) {
    throw new ContentError("BROWSER_ELEMENT_STALE", "the focused element is no longer in the document");
  }
  return typeInto(el, text);
}

/** Focus an element by ref. */
function focus(ref: unknown): { focused: { tag: string; role: string } } {
  const el = refOf(ref);
  if (!el || !el.isConnected) stale(String(ref));
  (el as HTMLElement).focus?.();
  return { focused: describe(el) };
}

/** Scroll an element by ref into view (centered). */
function scrollInto(ref: unknown): { scrolled: { tag: string; role: string } } {
  const el = refOf(ref);
  if (!el || !el.isConnected) stale(String(ref));
  try {
    (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  } catch {
    (el as HTMLElement).scrollIntoView?.({ block: "center" });
  }
  return { scrolled: describe(el) };
}

/**
 * Real (content-script) click at viewport coordinates: elementFromPoint +
 * focus + click in ONE run, so an overlay that appears between the agent's
 * inspection and the click still gets the click it deserves. Returns what
 * was hit (with a stable ref for follow-up actions).
 */
function clickAt(x: unknown, y: unknown): {
  found: boolean;
  x: number;
  y: number;
  clicked?: ElementSummary & { ref: string };
} {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ContentError("INTERNAL", "clickAt requires numeric x and y (viewport CSS pixels)");
  }
  const el = document.elementFromPoint(x, y);
  if (!el) return { found: false, x, y };
  const html = el as HTMLElement;
  try {
    html.focus?.({ preventScroll: false });
    html.click();
  } catch (err) {
    throw new ContentError("BROWSER_PERMISSION_DENIED", `clickAt failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { found: true, x, y, clicked: { ...summarize(el), ref: assignRef(el) } };
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
// browser_evaluate
// ---------------------------------------------------------------------------

const PAGE_EVAL_TIMEOUT_MS = 15_000;
let pageEvalSeq = 0;

interface PageEvalResult {
  __piBrowserEvalResult: true;
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Ask the MAIN-world helper (console-capture.js) to run the expression in
 * the PAGE's JS world, where page globals (window.*) are visible.
 * Resolves "unavailable" when the helper is not answering (older Firefox,
 * blocked injection) so the caller can fall back to the isolated world.
 */
function requestPageEval(expression: string, arg: unknown): Promise<PageEvalResult | "unavailable"> {
  return new Promise((resolve) => {
    const id = ++pageEvalSeq;
    let settled = false;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as PageEvalResult | null;
      if (d && d.__piBrowserEvalResult === true && d.id === id) {
        settled = true;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(d);
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve("unavailable");
      }
    }, PAGE_EVAL_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    try {
      window.postMessage({ __piBrowserEval: true, id, expression, arg }, "*");
    } catch {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve("unavailable");
    }
  });
}

/** Run the expression in this (isolated) world: shared DOM, no page JS globals. */
async function evalIsolated(expression: string, arg: unknown): Promise<unknown> {
  const factory = new Function(
    "arg",
    isFunctionExpression(expression) ? `return (${expression})(arg);` : `return (${expression});`,
  );
  let result: unknown = factory(arg);
  if (result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    result = await result;
  }
  return toJsonSafe(result);
}

/**
 * browser_evaluate: page world first (page globals visible), isolated world
 * as fallback. A throwing expression is reported as data ({error}) so the
 * agent can react — only a malformed TOOL call (non-string expression) is
 * a protocol error.
 */
function evaluate(expression: unknown, arg: unknown): Promise<{ value: unknown; error?: string; world: string }> {
  if (typeof expression !== "string" || expression.trim() === "") {
    return Promise.reject(new ContentError("INTERNAL", "evaluate requires a non-empty expression string"));
  }
  return requestPageEval(expression, arg).then(async (page) => {
    if (page !== "unavailable") {
      return page.ok ? { value: page.value, world: "page" } : { value: null, error: page.error, world: "page" };
    }
    try {
      return { value: await evalIsolated(expression, arg), world: "isolated (page-world helper unavailable)" };
    } catch (err) {
      return {
        value: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        world: "isolated (page-world helper unavailable)",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// browser_get_accessibility_tree
// ---------------------------------------------------------------------------

const A11Y_INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "treeitem",
  "listbox",
]);
const A11Y_ALWAYS = new Set([
  "navigation",
  "main",
  "complementary",
  "banner",
  "contentinfo",
  "form",
  "region",
  "search",
  "table",
  "row",
  "list",
  "dialog",
  "alert",
  "group",
]);
const A11Y_TEXT_ROLES = new Set(["paragraph", "listitem", "columnheader", "cell", "term", "definition", "text"]);

function a11yRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  switch (tag) {
    case "button":
      return "button";
    case "a":
      return el.hasAttribute("href") ? "link" : "anchor";
    case "input": {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      return "textbox";
    }
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "p":
      return "paragraph";
    case "li":
      return "listitem";
    case "ul":
    case "ol":
    case "dl":
      return "list";
    case "dt":
      return "term";
    case "dd":
      return "definition";
    case "table":
      return "table";
    case "tr":
      return "row";
    case "th":
      return "columnheader";
    case "td":
      return "cell";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "aside":
      return "complementary";
    case "header":
      return "banner";
    case "footer":
      return "contentinfo";
    case "section":
      return "section";
    case "article":
      return "article";
    case "figure":
      return "figure";
    case "form":
      return "form";
    case "img":
      return "image";
    case "iframe":
      return "iframe";
    case "label":
      return "label";
    case "details":
      return "group";
    case "summary":
      return "text";
    case "figcaption":
      return "text";
    case "video":
    case "audio":
    case "canvas":
    case "svg":
      return tag;
    default:
      return "generic";
  }
}

/** Compute an accessible-name-style label for a node (best effort, ≤120 chars). */
function accessibleName(el: Element): string {
  const byLabelledby = el.getAttribute("aria-labelledby");
  if (byLabelledby) {
    const parts = byLabelledby
      .split(/\s+/)
      .map((id) => {
        const n = document.getElementById(id);
        return n ? visibleText(n) : "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join(" ").slice(0, 120);
  }
  const label = el.getAttribute("aria-label");
  if (label) return label.slice(0, 120);
  const tag = el.tagName.toLowerCase();
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    if (alt) return alt.slice(0, 120);
  }
  if (tag === "input" || tag === "textarea") {
    const html = el as HTMLInputElement;
    if (html.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(html.id)}"]`);
      if (forLabel) {
        const t = visibleText(forLabel);
        if (t) return t.slice(0, 120);
      }
    }
    if (html.placeholder) return html.placeholder.slice(0, 120);
    if (html.name) return html.name.slice(0, 120);
    if (html.id) return html.id.slice(0, 120);
  }
  const wrappingLabel = el.closest?.("label");
  if (wrappingLabel) {
    const t = visibleText(wrappingLabel);
    if (t && t !== visibleText(el)) return t.slice(0, 120);
  }
  if (tag === "a" || tag === "button" || tag === "label") {
    // Icon-only controls name themselves through the child img's alt.
    const t = visibleText(el) || imgAltOf(el);
    if (t) return t.slice(0, 120);
  }
  return "";
}

/**
 * Indented accessibility-style outline. Unnamed containers that hold no
 * interesting children collapse to a single text line; hidden subtrees
 * (display:none / visibility:hidden / aria-hidden) are pruned.
 */
function a11yTree(
  maxNodes?: number,
  maxDepth?: number,
): { tree: string; nodeCount: number; truncated: boolean; note?: string } {
  const maxN = Math.min(Math.max(typeof maxNodes === "number" ? maxNodes : 300, 10), 2000);
  const maxD = Math.min(Math.max(typeof maxDepth === "number" ? maxDepth : 16, 1), 40);
  const budget = { left: maxN, truncated: false };
  let sawIframe = false;

  const walk = (el: Element, depth: number): string[] => {
    if (budget.left <= 0 || depth > maxD) {
      budget.truncated = true;
      return [];
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "head" || tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return [];
    if (el.getAttribute("aria-hidden") === "true") return [];
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(el as HTMLElement);
    } catch {
      return [];
    }
    if (style.display === "none" || style.visibility === "hidden") return [];

    const role = a11yRole(el);
    const name = accessibleName(el);
    const interactive = A11Y_INTERACTIVE.has(role);
    const hasOnclick = el.getAttribute("onclick") !== null;

    // Leaves: emitted without recursing. (Lines are RELATIVE to this node's
    // indent: the own line has no leading spaces, children are +2 per level.
    // A node without an own line promotes its children's block up one level,
    // so unnamed containers (div/span) never leave orphaned indentation.)
    if (tag === "iframe") {
      sawIframe = true;
      const src = (el as HTMLIFrameElement).src || el.getAttribute("title") || "";
      if (budget.left > 0) {
        budget.left--;
        return [`iframe${src ? ` "${src.slice(0, 120)}"` : ""}`];
      }
      budget.truncated = true;
      return [];
    }
    if (role === "image") {
      if (budget.left > 0) {
        budget.left--;
        return [`image${name ? ` "${name}"` : ""}`];
      }
      budget.truncated = true;
      return [];
    }
    if (role === "heading") {
      // Headings name by content (accessibleName only covers aria/label sources).
      const headingName = name || visibleText(el);
      const level = Number(/^h([1-6])$/.exec(tag)?.[1] ?? 1);
      if (budget.left > 0) {
        budget.left--;
        return [`heading${headingName ? ` "${headingName.slice(0, 120)}"` : ""} (level ${level})`];
      }
      budget.truncated = true;
      return [];
    }

    let own: string | undefined;
    if (interactive) {
      own = `${role}${name ? ` "${name}"` : ""}`;
      const html = el as HTMLInputElement;
      if ((role === "checkbox" || role === "radio") && "checked" in html && (html as HTMLInputElement).checked) {
        own += " [checked]";
      }
      const href = el.getAttribute("href");
      if (role === "link" && href) own += ` → ${href.slice(0, 80)}`;
      own += ` [${assignRef(el)}]`;
    } else if (A11Y_ALWAYS.has(role)) {
      own = `${role}${name ? ` "${name}"` : ""}`;
    } else if (A11Y_TEXT_ROLES.has(role)) {
      const t = visibleText(el);
      if (t) own = `${role} "${t.slice(0, 120)}"`;
    } else if (role === "generic") {
      own = name ? `generic "${name}"` : undefined;
    } else {
      // section / article / figure / label / anchor / ...: only when named.
      own = name ? `${role} "${name}"` : undefined;
    }
    // A plain div/span with an explicit click handler still gets a handle.
    if (own === undefined && hasOnclick) {
      own = `generic [${assignRef(el)}]`;
    } else if (own !== undefined && hasOnclick) {
      own += ` [${assignRef(el)}]`;
    }

    const childLines: string[] = [];
    if (!interactive) {
      // Light DOM first, then the element's open shadow root (web components).
      const sources: ArrayLike<Element>[] = [el.children];
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) sources.push(sr.children);
      for (const source of sources) {
        for (const child of Array.from(source)) {
          if (budget.left <= 0) break;
          const sub = walk(child, depth + 1);
          childLines.push(...sub.map((l) => `  ${l}`));
          if (budget.truncated) break;
        }
      }
    }
    // Interactive nodes: their text is already the name; don't recurse.

    if (own === undefined && childLines.length === 0) {
      const t = visibleText(el);
      if (t) own = `text "${t.slice(0, 120)}"`;
    }

    if (own !== undefined) {
      // The own line is always emitted together with the children already
      // collected: dropping a full block when the budget ran out mid-tree
      // would turn "partial outline" into "empty outline" (the children were
      // already counted, so the own line is a 1-node overage, and
      // `truncated` signals the cut).
      if (budget.left > 0) {
        budget.left--;
      } else {
        budget.truncated = true;
      }
      return [own, ...childLines];
    }
    // No own line: promote the children's block up one indentation level.
    return childLines.map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  };

  const root = document.body ?? document.documentElement;
  const lines = walk(root, 0);
  const tree = [`WebArea "${(document.title || "").slice(0, 120)}"`, ...lines].join("\n");
  const nodeCount = maxN - budget.left;
  let note: string | undefined;
  if (nodeCount < 10 && sawIframe) {
    note =
      "the outline is small and contains iframe leaves — the page content likely lives in a child frame; " +
      "re-run with the frame parameter (a frameId or URL substring from the frames list in browser_get_dom)";
  }
  return { tree, nodeCount, truncated: budget.truncated, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// browser_get_accessibility_tree (structured nodes) — REPL snapshot()
// ---------------------------------------------------------------------------

export interface A11yNode {
  /** Stable element ref (valid until the page navigates) — click/type by this. */
  ref?: string;
  role: string;
  name?: string;
  /** input/textarea: the current value. */
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  href?: string;
  /** input element: the exact `type` (text, password, ...). */
  type?: string;
  /** h1–h6: heading level. */
  level?: number;
  /** Viewport CSS-pixel rect (interactive nodes) — for clickAt. */
  rect?: { x: number; y: number; width: number; height: number };
}

function nodeRect(el: Element): { x: number; y: number; width: number; height: number } | undefined {
  try {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x * 10) / 10,
      y: Math.round(r.y * 10) / 10,
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
    };
  } catch {
    return undefined;
  }
}

/**
 * Structured twin of a11yTree: the SAME walk (pruning, roles, names, ref
 * assignment, budgets) but emitting A11yNode objects instead of text lines.
 * Used by page.snapshot() in the javascript REPL; the text outline is
 * unchanged.
 */
function a11yNodes(maxNodes?: number, maxDepth?: number): {
  nodes: A11yNode[];
  nodeCount: number;
  truncated: boolean;
  note?: string;
} {
  const maxN = Math.min(Math.max(typeof maxNodes === "number" ? maxNodes : 300, 10), 2000);
  const maxD = Math.min(Math.max(typeof maxDepth === "number" ? maxDepth : 16, 1), 40);
  const budget = { left: maxN, truncated: false };
  let sawIframe = false;
  const nodes: A11yNode[] = [];

  /** Consume budget for one node; returns false (and marks truncation) when out. */
  const withinBudget = (): boolean => {
    if (budget.left <= 0) {
      budget.truncated = true;
      return false;
    }
    budget.left--;
    return true;
  };

  /**
   * Mirrors the text walk: the own node is pushed before the children (in
   * order); an unnamed container promotes its children; the text fallback
   * applies only when no child node was produced (same as the outline).
   */
  const walk = (el: Element, depth: number): void => {
    if (budget.left <= 0 || depth > maxD) {
      budget.truncated = true;
      return;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "head" || tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;
    if (el.getAttribute("aria-hidden") === "true") return;
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(el as HTMLElement);
    } catch {
      return;
    }
    if (style.display === "none" || style.visibility === "hidden") return;

    const role = a11yRole(el);
    const name = accessibleName(el);
    const interactive = A11Y_INTERACTIVE.has(role);
    const hasOnclick = el.getAttribute("onclick") !== null;

    // Leaves (emitted without recursing).
    if (tag === "iframe") {
      sawIframe = true;
      if (withinBudget()) nodes.push({ role: "iframe", name: (el as HTMLIFrameElement).src || el.getAttribute("title") || undefined });
      return;
    }
    if (role === "image") {
      if (withinBudget()) nodes.push({ role: "image", ...(name ? { name } : {}) });
      return;
    }
    if (role === "heading") {
      const headingName = name || visibleText(el);
      if (withinBudget()) {
        nodes.push({
          role: "heading",
          level: Number(/^h([1-6])$/.exec(tag)?.[1] ?? 1),
          ...(headingName ? { name: headingName.slice(0, 120) } : {}),
        });
      }
      return;
    }

    let own: A11yNode | undefined;
    if (interactive) {
      const html = el as HTMLInputElement;
      const node: A11yNode = { role, ...(name ? { name } : {}) };
      if ((role === "checkbox" || role === "radio") && "checked" in html && (html as HTMLInputElement).checked) node.checked = true;
      if (html.disabled) node.disabled = true;
      const href = el.getAttribute("href");
      if (role === "link" && href) node.href = href.slice(0, 160);
      if ("type" in html && typeof (html as HTMLInputElement).type === "string" && (html as HTMLInputElement).type) {
        node.type = (html as HTMLInputElement).type;
      }
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && (html as HTMLInputElement).value) {
        node.value = String((html as HTMLInputElement).value).slice(0, 120);
      }
      const rect = nodeRect(el);
      if (rect) node.rect = rect;
      own = { ...node, ref: assignRef(el) };
    } else if (A11Y_ALWAYS.has(role)) {
      own = { role, ...(name ? { name } : {}) };
    } else if (A11Y_TEXT_ROLES.has(role)) {
      const t = visibleText(el);
      if (t) own = { role, name: t.slice(0, 120) };
    } else if (role === "generic") {
      own = name ? { role: "generic", name } : undefined;
    } else {
      // section / article / figure / label / anchor / ...: only when named.
      own = name ? { role, name } : undefined;
    }
    if (own === undefined && hasOnclick) {
      const rect = nodeRect(el);
      own = { role: "generic", ref: assignRef(el), ...(rect ? { rect } : {}) };
    } else if (own !== undefined && hasOnclick) {
      own = { ...own, ref: assignRef(el) };
      if (!own.rect) {
        const rect = nodeRect(el);
        if (rect) own.rect = rect;
      }
    }

    if (own !== undefined) {
      // The own node comes before the children, as in the text outline.
      if (withinBudget()) nodes.push(own);
    }
    if (!interactive) {
      // Light DOM first, then the element's open shadow root (web components).
      const sources: ArrayLike<Element>[] = [el.children];
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) sources.push(sr.children);
      let anyChild = false;
      outer: for (const source of sources) {
        for (const child of Array.from(source)) {
          if (budget.left <= 0) {
            // More siblings were left unvisited: the snapshot is partial.
            budget.truncated = true;
            break outer;
          }
          const beforeChild = nodes.length;
          walk(child, depth + 1);
          if (nodes.length > beforeChild) anyChild = true;
          if (budget.truncated) break outer;
        }
      }
      if (own === undefined && !anyChild) {
        // No own node and no children: fall back to a text node (same as
        // the outline's `text "..."` line).
        const t = visibleText(el);
        if (t && withinBudget()) nodes.push({ role: "text", name: t.slice(0, 120) });
      }
      return;
    }
    // Interactive nodes: their text is already the name; don't recurse.
    // (An interactive element with no own node is impossible — interactive
    // always produced one above.)
  };

  const root = document.body ?? document.documentElement;
  walk(root, 0);
  const nodeCount = maxN - budget.left;
  let note: string | undefined;
  if (nodeCount < 10 && sawIframe) {
    note =
      "the outline is small and contains iframe leaves — the page content likely lives in a child frame; " +
      "re-run with the frame parameter (a frameId or URL substring from the frames list in browser_get_dom)";
  }
  return { nodes, nodeCount, truncated: budget.truncated, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// browser_get_console
// ---------------------------------------------------------------------------

interface ConsoleMessageEntry {
  t: number;
  level: string;
  source: string;
  text: string;
}

let consoleReadSeq = 0;

/**
 * Read the page-world console ring buffer. Primary path: direct cross-world
 * read of window.__PI_BROWSER_CONSOLE__ (works in Gecko). Fallback: a
 * postMessage round-trip asking the MAIN-world helper for a cloned copy.
 */
function readConsole(
  level: unknown,
  limit: unknown,
  since: unknown,
  clear: unknown,
): Promise<{ messages: ConsoleMessageEntry[]; total: number; dropped: number; cleared: boolean }> {
  const want = typeof level === "string" && level !== "all" && level !== "" ? level : null;
  const sinceN = typeof since === "number" ? since : null;
  const maxN = Math.min(Math.max(typeof limit === "number" ? limit : 50, 1), 200);
  const doClear = clear === true;

  const deliver = (entries: ConsoleMessageEntry[], dropped: number) => {
    const out = entries
      .filter((m) => (!want || m.level === want) && (sinceN === null || m.t >= sinceN))
      .slice()
      .sort((a, b) => b.t - a.t)
      .slice(0, maxN);
    return { messages: out, total: entries.length, dropped, cleared: doClear };
  };

  const page = (window as unknown as { __PI_BROWSER_CONSOLE__?: { messages?: unknown; dropped?: unknown } }).__PI_BROWSER_CONSOLE__;
  if (page && Array.isArray(page.messages)) {
    const result = deliver(page.messages as ConsoleMessageEntry[], typeof page.dropped === "number" ? page.dropped : 0);
    if (doClear) window.postMessage({ __piBrowserConsoleClear: true }, "*");
    return Promise.resolve(result);
  }

  return new Promise((resolve) => {
    const id = ++consoleReadSeq;
    let settled = false;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { __piBrowserConsoleData?: boolean; id?: number; messages?: unknown; dropped?: unknown } | null;
      if (!d || d.__piBrowserConsoleData !== true || d.id !== id) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(
        deliver(
          Array.isArray(d.messages) ? (d.messages as ConsoleMessageEntry[]) : [],
          typeof d.dropped === "number" ? d.dropped : 0,
        ),
      );
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve({ messages: [], total: 0, dropped: 0, cleared: doClear });
      }
    }, 3000);
    window.addEventListener("message", onMessage);
    window.postMessage({ __piBrowserConsoleRead: true, id }, "*");
    // Sent AFTER the read request: the helper answers the read with the
    // pre-clear copy, then empties the buffer.
    if (doClear) window.postMessage({ __piBrowserConsoleClear: true }, "*");
  });
}

// ---------------------------------------------------------------------------
// browser_element_at
// ---------------------------------------------------------------------------

function elementAt(x: unknown, y: unknown): { found: boolean; x: number; y: number; element?: ElementSummary } {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ContentError("INTERNAL", "element_at requires numeric x and y (viewport CSS pixels)");
  }
  const el = document.elementFromPoint(x, y);
  if (!el) return { found: false, x, y };
  return { found: true, x, y, element: summarize(el) };
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
    case "pi:evaluate":
      return await evaluate(msg.expression, msg.arg);
    case "pi:a11y":
      return a11yTree(msg.maxNodes as number | undefined, msg.maxDepth as number | undefined);
    case "pi:a11yNodes":
      return a11yNodes(msg.maxNodes as number | undefined, msg.maxDepth as number | undefined);
    case "pi:clickAt":
      return clickAt(msg.x, msg.y);
    case "pi:focus":
      return focus(msg.ref);
    case "pi:scroll":
      return scrollInto(msg.ref);
    case "pi:typeFocused":
      return typeFocused(msg.text);
    case "pi:console":
      return await readConsole(msg.level, msg.limit, msg.since, msg.clear);
    case "pi:elementAt":
      return elementAt(msg.x, msg.y);
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
