/**
 * Smoke probe: runs the REAL built content-script bundles (firefox/dist) in
 * Node against a small fake DOM + window, and drives the content message
 * router exactly like the background ToolDispatcher does.
 *
 * Covers the logic that unit tests can't reach (no DOM in node):
 *   - pi:dom        (expanded selector summary: types, checked, level, classes)
 *   - pi:a11y       (accessibility outline: roles, names, refs, pruning)
 *   - pi:elementAt  (elementFromPoint hit summary)
 *   - pi:evaluate   (page-world round-trip via the REAL console-capture.js
 *                    MAIN-world helper, incl. function expressions + errors)
 *   - pi:console    (ring buffer read, level filter, clear)
 *
 * Run:  node .probe/smoke-content-dom.mjs          (fast paths)
 *       SLOW=1 node .probe/smoke-content-dom.mjs   (+ 15 s isolated fallback)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "firefox", "dist");

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

class HTMLElement {}
class HTMLInputElement extends HTMLElement {}
class HTMLTextAreaElement extends HTMLElement {}
class HTMLIFrameElement extends HTMLElement {
  get src() {
    return this.getAttribute("src") ?? "";
  }
}

/** Minimal CSS matching for the fake elements: tag, tag[attr], [attr], [attr=value]. */
function matchSimple(node, s) {
  s = s.trim();
  const bm = /^(.*?)(\[[^\]]*\])?$/.exec(s);
  const tagPart = (bm[1] ?? "").trim();
  const attrPart = bm[2] ? bm[2].slice(1, -1).trim() : null;
  if (tagPart && node.tagName.toUpperCase() !== tagPart.toUpperCase()) return false;
  if (attrPart) {
    if (attrPart.includes("=")) {
      const [k, v] = attrPart.split("=");
      const val = node.attributes[k.trim()];
      return val !== undefined && String(val) === v.trim();
    }
    return node.attributes[attrPart] !== undefined;
  }
  return true;
}

let nextId = 0;
function el(tag, attrs = {}, opts = {}) {
  const proto = tag === "input" ? HTMLInputElement : tag === "iframe" ? HTMLIFrameElement : HTMLElement;
  const node = Object.create(proto.prototype);
  node.tagName = tag.toUpperCase();
  node.nodeType = 1;
  node.attributes = attrs;
  node.children = opts.children ?? [];
  node.parent = null;
  for (const c of node.children) c.parent = node;
  node.textContent =
    opts.textContent ?? node.children.map((c) => c.textContent).join(" ");
  node.innerText = node.textContent;
  node.id = attrs.id ?? undefined;
  node.checked = Boolean(attrs.checked);
  node.type = attrs.type ?? "text";
  node.value = attrs.value ?? "";
  node.placeholder = attrs.placeholder ?? "";
  node.disabled = false;
  node.className = attrs.class ?? "";
  node.isConnected = true;
  node.isContentEditable = false;
  node._hidden = opts.hidden ?? false;
  node._top = opts.top ?? false;
  node._id = ++nextId;
  node.getAttribute = (k) => (k in node.attributes ? node.attributes[k] : null);
  node.hasAttribute = (k) => k in node.attributes;
  node.matches = (sel) => String(sel).split(",").some((s) => matchSimple(node, s));
  node.querySelector = (sel) => {
    if (sel !== "img[alt]") return null;
    const walkKids = (n) => {
      for (const c of n.children) {
        if (c.tagName === "IMG" && c.attributes.alt) return c;
        const deep = walkKids(c);
        if (deep) return deep;
      }
      return null;
    };
    return walkKids(node);
  };
  node.closest = (sel) => {
    if (sel !== "label") return null;
    let p = node.parent;
    while (p) {
      if (p.tagName === "LABEL") return p;
      p = p.parent;
    }
    return null;
  };
  node.getBoundingClientRect = () =>
    node._hidden ? { x: 0, y: 0, width: 0, height: 0 } : { x: 0, y: 0, width: 120, height: 24 };
  node.focus = () => {};
  node.click = () => {
    node.clicked = true;
  };
  node.form = null;
  node.dispatchEvent = (e) => {
    node.events = [...(node.events ?? []), e];
  };
  node.scrollIntoView = (opts) => {
    node.scrolled = opts;
  };
  return node;
}

const loginButton = el("button", { type: "submit", class: "btn btn-primary" }, { textContent: "Login", top: true });
const emailInput = el("input", { id: "email", name: "email", type: "email", placeholder: "you@example.com" });
const subCheck = el("input", { id: "sub", type: "checkbox", checked: "true", "aria-label": "Subscribe" });
const emailLabel = el("label", { for: "email" }, { textContent: "Email" });
const form = el("form", {}, { children: [emailLabel, emailInput, subCheck, loginButton] });
const h1 = el("h1", {}, { textContent: "Salvage Rush" });
const para = el("p", {}, { textContent: "Welcome back, pilot." });
const heroDiv = el("div", { class: "card", "data-testid": "hero" }, { children: [el("span", {}, { textContent: "Hero text" })] });
const list = el("ul", {}, { children: [el("li", {}, { textContent: "Item one" }), el("li", {}, { textContent: "Item two" })] });
const table = el("table", {}, {
  children: [el("tr", {}, { children: [el("th", {}, { textContent: "Name" }), el("td", {}, { textContent: "Alpha" })] })],
});
const main = el("main", {}, { children: [h1, para, form, heroDiv, list, table] });
const hiddenButton = el("button", {}, { textContent: "Hidden", hidden: true });
const hiddenDiv = el("div", {}, { hidden: true, children: [hiddenButton] });

// Icon-only link: no visible text — its name comes from the child img's alt
// (the exact case from real-world footer pages).
const logoImg = el("img", { src: "logo.svg", alt: "Pilot logo" });
const logoLink = el("a", { href: "/" }, { children: [logoImg] });

// A child frame: the top document's content script must report it so the
// agent can target it with the frame parameter.
const frameEl = el("iframe", { src: "https://embed.test/app?x=1" });

// A web component with an OPEN shadow root: content inside is only visible
// through shadow-root traversal, never through a plain querySelectorAll.
const shadowButton = el("button", { type: "button" }, { textContent: "Shadow Action" });
const shadowRoot = {
  children: [shadowButton],
  querySelectorAll: (sel) =>
    sel === "*" ? [shadowButton] : [shadowButton].filter((n) => n.matches(sel)),
};
const host = el("my-widget", { "data-testid": "widget" }, { children: [] });
host.shadowRoot = shadowRoot;

main.children.push(logoLink, frameEl);
const body = el("body", {}, { children: [main, hiddenDiv, host] });

const allElements = [];
(function collect(n) {
  allElements.push(n);
  for (const c of n.children) collect(c);
})(body);
// NOTE: shadowButton intentionally NOT in allElements — it lives only in the
// shadow root, exactly like in a real document. The code under test must find
// it via shadow-root traversal, not via document.querySelectorAll.

const document = {
  title: "Salvage Rush — Login",
  body,
  documentElement: body,
  getElementById: (id) => allElements.find((e) => e.attributes.id === id) ?? null,
  querySelector: (sel) => {
    // The a11y name lookup asks for label[for="<id>"]; support that shape.
    const m = /^label\[for="([^"]*)"\]$/.exec(String(sel));
    if (m) {
      const id = m[1];
      return allElements.find((e) => e.tagName === "LABEL" && e.attributes.for === id) ?? null;
    }
    return null;
  },
  querySelectorAll: (sel) =>
    sel === "*" ? allElements : allElements.filter((n) => n.matches(sel)),
  elementFromPoint: () => loginButton,
  activeElement: null,
  execCommand: undefined,
};

// ---------------------------------------------------------------------------
// Fake window (postMessage bus + MAIN-world console buffer)
// ---------------------------------------------------------------------------

const window = {
  innerWidth: 1280,
  innerHeight: 800,
  _listeners: new Set(),
  addEventListener: (t, fn) => {
    if (t === "message") window._listeners.add(fn);
  },
  removeEventListener: (t, fn) => {
    if (t === "message") window._listeners.delete(fn);
  },
  postMessage: (data) => {
    queueMicrotask(() => {
      for (const fn of [...window._listeners]) fn({ data, source: window });
    });
  },
};
window.window = window;

function getComputedStyle(node) {
  return node._hidden
    ? { display: "none", visibility: "visible" }
    : { display: "block", visibility: "visible" };
}

const CSS = { escape: (s) => s.replace(/(["\\])/g, "\\$1") };
const postedMessages = [];
const originalPostMessage = window.postMessage.bind(window);
window.postMessage = (data) => {
  postedMessages.push(data);
  return originalPostMessage(data);
};

// ---------------------------------------------------------------------------
// Load the REAL bundles into this context
// ---------------------------------------------------------------------------

const contentHandler = { fn: undefined };
const browser = {
  runtime: {
    onMessage: {
      addListener(fn) {
        contentHandler.fn = fn;
      },
    },
  },
};

class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.data = opts.data;
  }
}

class FakeInputEvent extends FakeEvent {}

const context = {
  browser,
  window,
  document,
  getComputedStyle,
  HTMLElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLIFrameElement,
  CSS,
  Event: FakeEvent,
  InputEvent: FakeInputEvent,
  console,
  // Node globals the bundles expect from the browser runtime
  setTimeout,
  clearTimeout,
  queueMicrotask,
  Date,
};
vm.createContext(context);
// The MAIN-world helper first (document_start), then the content script.
vm.runInContext(readFileSync(path.join(DIST, "console-capture.js"), "utf8"), context, { filename: "console-capture.js" });
vm.runInContext(readFileSync(path.join(DIST, "content.js"), "utf8"), context, { filename: "content.js" });
assert.equal(typeof contentHandler.fn, "function", "content script registered its message handler");

function call(msg) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const r = contentHandler.fn(msg, {}, (resp) => done(() => resolve(resp)));
    if (r === true) {
      // async response: safety timer (the real dispatcher has its own timeout)
      setTimeout(() => done(() => reject(new Error(`no response for ${msg.type}`))), 30_000);
    } else {
      done(() => reject(new Error(`unexpected sync return for ${msg.type}`)));
    }
  });
}

const tick = () => new Promise((r) => setTimeout(r, 25));

// ---------------------------------------------------------------------------
// pi:dom — expanded summary
// ---------------------------------------------------------------------------

{
  const res = await call({ type: "pi:dom", maxElements: 100 });
  assert.equal(res.ok, true, `dom ok: ${JSON.stringify(res)}`);
  const els = Object.fromEntries(res.data.elements.map((e) => [e.ref, e]));
  const byTag = (t) => res.data.elements.filter((e) => e.tag === t);

  assert.ok(byTag("h1").length === 1, "h1 present");
  assert.equal(byTag("h1")[0].level, 1, "heading level exposed");
  assert.ok(byTag("p").length === 1, "paragraph present");
  assert.equal(byTag("li").length, 2, "list items present");
  assert.equal(byTag("label").length, 1, "label present");
  assert.equal(byTag("th").length, 1, "th present");
  assert.equal(byTag("td").length, 1, "td present");

  const email = byTag("input").find((e) => e.name === "email");
  assert.equal(email.type, "email", "input type exposed");
  assert.equal(email.name, "email");

  const sub = byTag("input").find((e) => e.type === "checkbox");
  assert.equal(sub.checked, true, "checkbox state exposed");

  const btn = byTag("button").find((e) => e.text === "Login");
  assert.equal(btn.disabled, undefined);
  assert.ok(btn.classes.includes("btn"), `classes exposed: ${btn.classes}`);

  const hidden = byTag("button").find((e) => e.text === "Hidden");
  assert.equal(hidden.visible, false, "display:none subtree reported hidden");
  assert.equal(byTag("button").find((e) => e.text === "Login").visible, true, "normal element visible");

  // Icon-only link: empty text, name recovered from the child img's alt.
  const logo = byTag("a").find((e) => e.href === "/");
  assert.equal(logo.text, "", "icon link has no visible text");
  assert.equal(logo.name, "Pilot logo", `img alt became the link name: ${JSON.stringify(logo)}`);

  // Shadow-DOM traversal: the button inside the open shadow root is listed.
  const shadowBtn = byTag("button").find((e) => e.text === "Shadow Action");
  assert.ok(shadowBtn, `shadow-root button found: ${JSON.stringify(byTag("button"))}`);
  assert.ok(shadowBtn.ref, "shadow element got a stable ref");
  assert.equal(res.data.stats.shadowRoots, 1, "shadow root counted in stats");
  assert.ok(res.data.stats.scanned > 0, "scanned count reported");

  // Iframe reporting: the frames list points the agent at the child frame.
  assert.equal(res.data.stats.iframes, 1, "iframe counted in stats");
  assert.equal(res.data.frames[0].src, "https://embed.test/app?x=1", "frames list carries the src");
  process.stdout.write(`ok pi:dom (${res.data.refCount} elements, shadow + iframe aware)\n`);
}

// ---------------------------------------------------------------------------
// pi:a11y — accessibility outline
// ---------------------------------------------------------------------------

{
  const res = await call({ type: "pi:a11y", maxNodes: 200 });
  assert.equal(res.ok, true, `a11y ok: ${JSON.stringify(res)}`);
  const tree = res.data.tree;
  process.stdout.write(`--- a11y tree ---\n${tree}\n------------------\n`);

  assert.ok(tree.startsWith('WebArea "Salvage Rush — Login"'), "root WebArea line");
  assert.ok(tree.includes('heading "Salvage Rush" (level 1)'), "heading with level");
  assert.ok(tree.includes('paragraph "Welcome back, pilot."'), "paragraph text");
  assert.ok(/textbox "Email" \[el-\d+\]/.test(tree), `labelled textbox with ref: \n${tree}`);
  assert.ok(/checkbox "Subscribe" \[checked\] \[el-\d+\]/.test(tree), "checkbox with state + ref");
  assert.ok(/button "Login" \[el-\d+\]/.test(tree), "button with ref");
  assert.ok(tree.includes("list"), "list node");
  assert.ok(tree.includes('listitem "Item one"'), "listitem text");
  assert.ok(tree.includes("table"), "table node");
  assert.ok(tree.includes("row"), "row node");
  assert.ok(tree.includes('columnheader "Name"'), "th as columnheader");
  assert.ok(tree.includes('cell "Alpha"'), "td as cell");
  assert.ok(tree.includes('text "Hero text"'), "unnamed div collapsed to text");
  assert.ok(!tree.includes("Hidden"), "display:none subtree pruned");
  assert.ok(tree.includes('link "Pilot logo"'), `icon link named via img alt: \n${tree}`);
  assert.ok(/button "Shadow Action" \[el-\d+\]/.test(tree), `shadow-root button in tree: \n${tree}`);
  assert.ok(tree.includes('iframe "https://embed.test/app?x=1"'), `iframe leaf with src: \n${tree}`);
  assert.equal(res.data.truncated, false);
  assert.ok(res.data.nodeCount >= 12, `nodeCount sane: ${res.data.nodeCount}`);

  // depth budget: maxNodes is clamped to a minimum of 10; a partial
  // outline must be emitted (never an empty tree) with truncated=true.
  const shallow = await call({ type: "pi:a11y", maxNodes: 4 });
  assert.equal(shallow.ok, true);
  assert.equal(shallow.data.truncated, true, "budget overrun flagged");
  if (process.env.DEBUG) console.log("DEBUG a11y shallow lines:", shallow.data.tree.split("\n").length, shallow.data.tree);
  const shallowLines = shallow.data.tree.split("\n").length;
  assert.ok(shallowLines > 2, `partial outline emitted (got ${shallowLines} lines)`);
  assert.ok(shallowLines <= 13, `budget respected (got ${shallowLines} lines)`);
  process.stdout.write(`ok pi:a11y (${res.data.nodeCount} nodes, partial budget ok)\n`);
}

// ---------------------------------------------------------------------------
// pi:elementAt
// ---------------------------------------------------------------------------

{
  const res = await call({ type: "pi:elementAt", x: 10, y: 10 });
  assert.equal(res.ok, true, `elementAt ok: ${JSON.stringify(res)}`);
  assert.equal(res.data.found, true);
  assert.equal(res.data.element.text, "Login");
  assert.match(res.data.element.ref, /^el-\d+$/);
  const bad = await call({ type: "pi:elementAt", x: "10", y: 10 });
  assert.equal(bad.ok, false, "non-numeric x rejected");
  assert.equal(bad.error.code, "INTERNAL");
  process.stdout.write("ok pi:elementAt\n");
}

// ---------------------------------------------------------------------------
// pi:evaluate — page world via the REAL console-capture.js helper
// ---------------------------------------------------------------------------

{
  // 1) function expression + arg, executed by the MAIN-world helper
  const fnRes = await call({ type: "pi:evaluate", expression: "(t) => t + '-ok'", arg: "hi" });
  assert.equal(fnRes.ok, true, `eval fn: ${JSON.stringify(fnRes)}`);
  assert.equal(fnRes.data.value, "hi-ok");
  assert.equal(fnRes.data.world, "page");

  // 2) plain expression
  const plain = await call({ type: "pi:evaluate", expression: "1 + 2" });
  assert.equal(plain.data.value, 3);
  assert.equal(plain.data.world, "page");

  // 3) throwing expression -> reported as data, not a protocol error
  const errRes = await call({ type: "pi:evaluate", expression: "nopeIsDefined()" });
  assert.equal(errRes.ok, true, "eval errors are data");
  assert.equal(errRes.data.value, null);
  assert.match(errRes.data.error, /ReferenceError: nopeIsDefined is not defined/);
  assert.equal(errRes.data.world, "page");

  // 4) promise is awaited
  const asyncRes = await call({ type: "pi:evaluate", expression: "async () => 'later'" });
  assert.equal(asyncRes.data.value, "later");

  process.stdout.write("ok pi:evaluate (page world: fn/arg, error-as-data, async)\n");

  if (process.env.SLOW) {
    // 5) helper unreachable -> isolated-world fallback (15 s internal deadline)
    for (const fn of [...window._listeners]) {
      if (fn.toString().includes("__piBrowserEval")) window._listeners.delete(fn);
    }
    const t0 = Date.now();
    const slow = await call({ type: "pi:evaluate", expression: "40 + 2" });
    const tookMs = Date.now() - t0;
    assert.equal(slow.ok, true);
    assert.equal(slow.data.value, 42, "isolated fallback computed the value");
    assert.match(slow.data.world, /isolated/);
    assert.ok(tookMs >= 14_000, `waited for the page-eval deadline (${tookMs}ms)`);
    process.stdout.write(`ok pi:evaluate (isolated fallback after ${tookMs}ms)\n`);
  }
}

// ---------------------------------------------------------------------------
// pi:console — ring buffer read + clear (REAL buffer from console-capture.js)
// ---------------------------------------------------------------------------

{
  const buf = window.__PI_BROWSER_CONSOLE__;
  assert.ok(buf, "MAIN helper published the buffer");

  // Emit messages through the REAL console wrappers (page-world capture).
  console.log("hello log");
  console.warn("hello warn");
  console.error("hello error");
  await tick();

  const all = await call({ type: "pi:console" });
  assert.equal(all.ok, true, `console ok: ${JSON.stringify(all)}`);
  const texts = all.data.messages.map((m) => m.text);
  assert.ok(texts.includes("hello log"), `log captured: ${texts}`);
  assert.ok(texts.includes("hello error"), "error captured");
  assert.equal(all.data.messages[0].t >= all.data.messages.at(-1).t, true, "newest first");

  const errors = await call({ type: "pi:console", level: "error" });
  assert.ok(errors.data.messages.every((m) => m.level === "error"), "level filter");
  assert.ok(errors.data.messages.some((m) => m.text === "hello error"));

  // window-error capture: dispatch a real ErrorEvent on the fake window?
  // (The helper listens with capture=true; our fake window only models
  // message events, so the error-path is covered by the real browser.)

  const cleared = await call({ type: "pi:console", clear: true });
  assert.equal(cleared.data.cleared, true);
  assert.ok(postedMessages.some((m) => m.__piBrowserConsoleClear === true), "clear reached the MAIN helper");
  await tick();
  const after = await call({ type: "pi:console" });
  assert.equal(after.data.messages.length, 0, `buffer cleared: ${JSON.stringify(after.data)}`);
  assert.equal(after.data.cleared, false, "no clear requested on the follow-up read");
  process.stdout.write(`ok pi:console (captured=${all.data.total}, cleared)\n`);
}

// ---------------------------------------------------------------------------
// pi:a11yNodes — structured snapshot (REPL page.snapshot())
// ---------------------------------------------------------------------------

{
  const res = await call({ type: "pi:a11yNodes", maxNodes: 200 });
  assert.equal(res.ok, true, `a11yNodes ok: ${JSON.stringify(res)}`);
  const { nodes } = res.data;

  const byRole = (r) => nodes.filter((n) => n.role === r);

  // Heading with level
  const h = byRole("heading")[0];
  assert.equal(h.name, "Salvage Rush");
  assert.equal(h.level, 1);

  // Labelled textbox: ref, type, name, rect
  const textbox = byRole("textbox").find((n) => n.name === "Email");
  assert.ok(textbox, `textbox node: ${JSON.stringify(byRole("textbox"))}`);
  assert.match(textbox.ref, /^el-\d+$/);
  assert.equal(textbox.type, "email");
  assert.ok(textbox.rect && textbox.rect.width > 0, "interactive node carries a rect");

  // Checkbox with checked state + ref
  const sub = byRole("checkbox")[0];
  assert.equal(sub.checked, true);
  assert.ok(sub.ref, "checkbox ref");

  // Button with ref
  const btn = byRole("button").find((n) => n.name === "Login");
  assert.ok(btn && btn.ref, "button with ref");

  // Icon link: name via img alt + href
  const link = byRole("link")[0];
  assert.equal(link.name, "Pilot logo");
  assert.equal(link.href, "/");

  // Text fallback for the unnamed div
  const hero = nodes.find((n) => n.role === "text" && n.name === "Hero text");
  assert.ok(hero, `div collapsed to text node: ${JSON.stringify(nodes)}`);

  // Shadow-root traversal
  const shadowBtn = byRole("button").find((n) => n.name === "Shadow Action");
  assert.ok(shadowBtn && shadowBtn.ref, `shadow button node: ${JSON.stringify(byRole("button"))}`);

  // Iframe leaf with src as name
  const frame = byRole("iframe")[0];
  assert.equal(frame.name, "https://embed.test/app?x=1");

  // Hidden subtree pruned
  assert.ok(!nodes.some((n) => n.name === "Hidden"), "display:none pruned");

  // Budget: clamped to a minimum of 10; partial nodes + truncated=true
  const shallow = await call({ type: "pi:a11yNodes", maxNodes: 4 });
  assert.equal(shallow.ok, true);
  if (process.env.DEBUG) console.log("DEBUG a11yNodes shallow:", shallow.data.nodes.length, shallow.data.truncated, JSON.stringify(shallow.data.nodes.map(n => n.role)));
  assert.ok(shallow.data.nodes.length > 0, "partial nodes emitted");
  assert.ok(shallow.data.nodes.length <= 10, `budget: ${shallow.data.nodes.length} nodes`);
  assert.equal(shallow.data.truncated, true, "truncated flagged");
  process.stdout.write(`ok pi:a11yNodes (${nodes.length} nodes, refs + rects, shadow + iframe, budgets)\n`);
}

// ---------------------------------------------------------------------------
// pi:clickAt — atomic elementFromPoint + focus + click
// ---------------------------------------------------------------------------

{
  // Default: elementFromPoint -> Login button
  const res = await call({ type: "pi:clickAt", x: 50, y: 20 });
  assert.equal(res.ok, true, `clickAt ok: ${JSON.stringify(res)}`);
  assert.equal(res.data.found, true);
  assert.equal(res.data.clicked.text, "Login");
  assert.match(res.data.clicked.ref, /^el-\d+$/);
  assert.equal(loginButton.clicked, true, "the hit element was clicked");

  // Overlay case: a floating element covers the button — the OVERLAY is hit
  const overlay = el("div", { class: "overlay" }, { textContent: "overlay" });
  document.elementFromPoint = () => overlay;
  const overlayRes = await call({ type: "pi:clickAt", x: 50, y: 20 });
  assert.equal(overlayRes.ok, true);
  assert.equal(overlayRes.data.found, true);
  assert.equal(overlayRes.data.clicked.text, "overlay", "overlay captured the click");
  assert.equal(loginButton.clicked, true, "button NOT clicked through the overlay");
  assert.equal(overlay.clicked, true, "overlay itself clicked");
  document.elementFromPoint = () => loginButton;

  // Miss: nothing at the point
  document.elementFromPoint = () => null;
  const miss = await call({ type: "pi:clickAt", x: 1, y: 1 });
  assert.equal(miss.ok, true);
  assert.equal(miss.data.found, false, "empty hit reported, not an error");
  document.elementFromPoint = () => loginButton;

  // Invalid coordinates
  const bad = await call({ type: "pi:clickAt", x: "50", y: 20 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "INTERNAL");
  process.stdout.write("ok pi:clickAt (atomic hit, overlay wins, miss + bad coords)\n");
}

// ---------------------------------------------------------------------------
// pi:focus / pi:scroll — ref-based view + focus primitives
// ---------------------------------------------------------------------------

{
  // Refs for focus/scroll come from the a11y ref table (assignRef),
  // not from pi:dom's element refs.
  const snap = await call({ type: "pi:a11yNodes" });
  const btn = snap.data.nodes.find((n) => n.role === "button" && n.name === "Login");
  assert.ok(btn && btn.ref, `login button ref: ${JSON.stringify(snap.data.nodes)}`);

  const focusRes = await call({ type: "pi:focus", ref: btn.ref });
  assert.equal(focusRes.ok, true, `focus ok: ${JSON.stringify(focusRes)}`);
  assert.equal(focusRes.data.focused.tag, "button");

  const scrollRes = await call({ type: "pi:scroll", ref: btn.ref });
  assert.equal(scrollRes.ok, true);
  assert.equal(scrollRes.data.scrolled.tag, "button");
  assert.equal(loginButton.scrolled?.block, "center", "scrollIntoView centered");

  const stale = await call({ type: "pi:focus", ref: "el-9999" });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "BROWSER_ELEMENT_STALE");
  process.stdout.write("ok pi:focus / pi:scroll (stale ref rejected)\n");
}

// ---------------------------------------------------------------------------
// pi:typeFocused — proven typing path on document.activeElement
// ---------------------------------------------------------------------------

{
  // 1) activeElement is an input: value-setter path + input/change events
  document.activeElement = emailInput;
  const inputRes = await call({ type: "pi:typeFocused", text: "pilot@example.com" });
  assert.equal(inputRes.ok, true, `typeFocused ok: ${JSON.stringify(inputRes)}`);
  assert.equal(emailInput.value, "pilot@example.com", "input value set");
  const evTypes = emailInput.events.map((e) => e.type);
  assert.ok(evTypes.includes("input"), `input event fired: ${evTypes}`);
  assert.ok(evTypes.includes("change"), `change event fired: ${evTypes}`);

  // 2) activeElement is a contenteditable: insertText/InputEvent path
  const editable = el("div", { "contenteditable": "true" });
  document.activeElement = editable;
  const ceRes = await call({ type: "pi:typeFocused", text: "notes" });
  assert.equal(ceRes.ok, true);
  const ceEvents = editable.events.map((e) => e.type);
  assert.ok(ceEvents.includes("input"), `contenteditable input event: ${ceEvents}`);

  // 3) nothing focused -> actionable error
  document.activeElement = null;
  const none = await call({ type: "pi:typeFocused", text: "x" });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "BROWSER_ELEMENT_STALE");
  assert.match(none.error.message, /no focused element/);

  // 4) body focused (never typeable)
  document.activeElement = document.body;
  const bodyRes = await call({ type: "pi:typeFocused", text: "x" });
  assert.equal(bodyRes.ok, false, "body is not a type target");
  process.stdout.write("ok pi:typeFocused (input, contenteditable, no-focus error)\n");
  document.activeElement = null;
}

process.stdout.write("\nsmoke-content-dom: all fake-DOM probes passed\n");
