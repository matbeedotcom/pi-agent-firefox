/**
 * MCP-compatible browser tool definitions (PRODUCT.md §25).
 *
 * These schemas are transport-independent: the same names, arguments, and
 * results are used whether tools are invoked over the private
 * x-pi-browser/tool compatibility transport or over MCP (stdio/HTTP or
 * MCP-over-ACP). The Firefox side implements the tools; the Pi side
 * registers them as agent tools.
 */

export interface BrowserToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible) for the tool arguments. */
  inputSchema: Record<string, unknown>;
  /** Read-only tools never mutate the bound tab; mutating tools always target the session-bound tab. */
  readOnly: boolean;
}

const OBJECT_SCHEMA_BASE = {
  type: "object" as const,
  additionalProperties: false,
};

/**
 * Optional frame target for tools that run in a frame's content script.
 * A frameId (number) or a URL substring (string) — the frames list in
 * browser_get_dom's result is what the agent picks from. Absent = top frame.
 */
export const BROWSER_FRAME_DESCRIPTION =
  "Optional frame to operate in: a frameId (number) or a URL substring (string) — see the frames list in browser_get_dom. " +
  "Default: the top frame. Frame ids stay valid until the page navigates.";

const FRAME_PROPERTY: Record<string, unknown> = {
  anyOf: [{ type: "number" }, { type: "string" }],
  description: BROWSER_FRAME_DESCRIPTION,
};

export const BROWSER_TOOLS: readonly BrowserToolDef[] = [
  {
    name: "browser_get_page",
    description:
      "Get basic information about the page in the Firefox tab bound to this session: URL, title, and viewport size.",
    inputSchema: { ...OBJECT_SCHEMA_BASE, properties: {} },
    readOnly: true,
  },
  {
    name: "browser_get_selection",
    description:
      "Get the current text selection in the bound tab. Returns empty text when nothing is selected.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        frame: { ...FRAME_PROPERTY },
      },
    },
    readOnly: true,
  },
  {
    name: "browser_get_dom",
    description:
      "Get a compact semantic representation of the page in the bound tab with stable element references (ref). " +
      "Covers headings, paragraphs, list items, tables, forms, buttons, links, labels, and any element with an ARIA role, " +
      "tabindex, aria-label, or data-testid; open web-component shadow roots are traversed. Each element carries its tag, " +
      "role, visible text, and (where relevant) name, href, input type, checked state, heading level, and short class list. " +
      "The result includes stats (scanned/matched/shadow roots) and, when the frame contains iframes, a frames list — if few " +
      "elements match, the page content likely lives in a child frame: re-run with the frame parameter (frameId or URL from the " +
      "frames list). References are valid until the page navigates or the DOM changes significantly; after that, call this " +
      "tool again. Use the returned refs with browser_click and browser_type.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        maxElements: {
          type: "number",
          description: "Maximum number of elements to return (default 600, hard cap 2000).",
        },
        frame: { ...FRAME_PROPERTY },
      },
    },
    readOnly: true,
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of the bound tab as an image. Returns image data the agent can see.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        format: {
          anyOf: [{ type: "string", const: "png" }, { type: "string", const: "jpeg" }],
          description: "Image format (default png).",
        },
        quality: { type: "number", description: "JPEG quality 1-100 (jpeg only, default 80)." },
      },
    },
    readOnly: true,
  },
  {
    name: "browser_reload",
    description: "Reload the page in the bound tab.",
    inputSchema: { ...OBJECT_SCHEMA_BASE, properties: {} },
    readOnly: false,
  },
  {
    name: "browser_click",
    description:
      "Click an element referenced by a stable ref from browser_get_dom in the bound tab. " +
      "The ref becomes stale after navigation; refresh with browser_get_dom if a ref fails.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        ref: { type: "string", description: "Element reference, e.g. el-183 (from browser_get_dom)." },
        frame: { ...FRAME_PROPERTY },
      },
      required: ["ref"],
    },
    readOnly: false,
  },
  {
    name: "browser_type",
    description:
      "Type text into an element referenced by a stable ref from browser_get_dom in the bound tab. " +
      "Focuses the element, replaces any existing value for text inputs, and appends for other elements. " +
      "Optionally submits the surrounding form.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        ref: { type: "string", description: "Element reference, e.g. el-183 (from browser_get_dom)." },
        text: { type: "string", description: "Text to type." },
        submit: { type: "boolean", description: "Submit the element's form after typing (default false)." },
        frame: { ...FRAME_PROPERTY },
      },
      required: ["ref", "text"],
    },
    readOnly: false,
  },
  {
    name: "browser_wait_for",
    description:
      "Wait in the bound tab until a CSS selector matches (or stops matching) or a timeout elapses. " +
      "Use after actions that trigger async page changes (e.g. after browser_click on a submit button).",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        selector: { type: "string", description: "CSS selector to wait for." },
        state: {
          anyOf: [{ type: "string", const: "visible" }, { type: "string", const: "hidden" }],
          description: "Wait until the element is visible (default) or hidden.",
        },
        timeoutMs: { type: "number", description: "Maximum wait in milliseconds (default 10000, max 60000)." },
        frame: { ...FRAME_PROPERTY },
      },
      required: ["selector"],
    },
    readOnly: true,
  },
  {
    name: "browser_evaluate",
    description:
      "Run a JavaScript expression in the bound tab and return its JSON-serializable result. " +
      "Runs in the page's JS world when available (page globals such as window.* are visible); otherwise it falls back to " +
      "the extension's isolated world (shared DOM, no page JS globals) — the result says which world ran. " +
      "Functions are supported: pass a function and an arg, e.g. expression \"(sel) => document.querySelectorAll(sel).length\" " +
      "with arg \".nav a\". Promises are awaited. Use to inspect page state the DOM tools do not expose.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        expression: {
          type: "string",
          description:
            "JavaScript expression or function, e.g. \"document.title\" or \"(sel) => document.querySelector(sel)?.value\".",
        },
        arg: {
          description: "Optional JSON value passed as the single argument when the expression is a function.",
        },
        frame: { ...FRAME_PROPERTY },
      },
      required: ["expression"],
    },
    readOnly: false,
  },
  {
    name: "browser_get_accessibility_tree",
    description:
      "Get an indented, accessibility-style outline of the page in the bound tab: semantic roles with accessible names " +
      "and hierarchy. More compact than browser_get_dom and better for understanding page structure; interactive nodes " +
      "carry stable refs usable with browser_click and browser_type. Open web-component shadow roots are traversed; " +
      "iframes appear as leaf lines with their src — if the outline is thin, the content likely lives in a child frame: " +
      "re-run with the frame parameter (see the frames list in browser_get_dom).",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        maxNodes: {
          type: "number",
          description: "Maximum outline nodes to return (default 300, hard cap 2000).",
        },
        maxDepth: {
          type: "number",
          description: "Maximum outline depth (default 16, hard cap 40).",
        },
        frame: { ...FRAME_PROPERTY },
      },
    },
    readOnly: true,
  },
  {
    name: "browser_get_console",
    description:
      "Read the console of the bound tab: console output captured since page load, plus window errors, failed resource " +
      "loads, and unhandled promise rejections. Best for finding why a page interaction is broken. Returns the most recent messages.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        level: {
          anyOf: [
            { type: "string", const: "all" },
            { type: "string", const: "error" },
            { type: "string", const: "warn" },
            { type: "string", const: "log" },
            { type: "string", const: "info" },
            { type: "string", const: "debug" },
          ],
          description: 'Only messages at this level (default "all"); "error" includes window errors and unhandled rejections.',
        },
        limit: { type: "number", description: "Maximum messages to return, newest first (default 50, max 200)." },
        since: { type: "number", description: "Only messages captured at or after this Unix timestamp (ms)." },
        clear: { type: "boolean", description: "Clear the captured buffer after reading (default false)." },
        frame: { ...FRAME_PROPERTY },
      },
    },
    readOnly: true,
  },
  {
    name: "browser_get_network",
    description:
      "Read recent network requests made by the bound tab (XHR/fetch and resource loads, covering ALL frames of the tab) " +
      "with URL, method, status, and duration. Best for spotting failed API calls (4xx/5xx), blocked requests, or slow endpoints.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        filter: { type: "string", description: "Only requests whose URL contains this substring (case-insensitive)." },
        method: { type: "string", description: 'Only requests with this HTTP method, e.g. "POST".' },
        errorsOnly: {
          type: "boolean",
          description: "Only failed requests or responses with status >= 400 (default false).",
        },
        limit: { type: "number", description: "Maximum requests to return, newest first (default 50, max 200)." },
      },
    },
    readOnly: true,
  },
  {
    name: "browser_element_at",
    description:
      "Find the topmost DOM element at viewport coordinates in the bound tab and return its summary plus a stable ref " +
      "usable with browser_click and browser_type. Use when an element is visible in a screenshot but not easy to select " +
      "by name, or to verify what is under a point.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        x: { type: "number", description: "X coordinate in CSS pixels from the viewport's left edge." },
        y: { type: "number", description: "Y coordinate in CSS pixels from the viewport's top edge." },
        frame: { ...FRAME_PROPERTY },
      },
      required: ["x", "y"],
    },
    readOnly: true,
  },
  {
    name: "browser_navigate",
    description:
      "Navigate the bound tab to an absolute http(s) or file URL. Element refs become stale after navigation; " +
      "call browser_get_dom again afterwards.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        url: { type: "string", description: 'Absolute URL to navigate to, e.g. "http://localhost:5173/login".' },
      },
      required: ["url"],
    },
    readOnly: false,
  },
];

const TOOL_BY_NAME = new Map(BROWSER_TOOLS.map((t) => [t.name, t]));

export function getBrowserTool(name: string): BrowserToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

export function isBrowserTool(name: string): boolean {
  return TOOL_BY_NAME.has(name);
}

export function isMutatingBrowserTool(name: string): boolean {
  const tool = TOOL_BY_NAME.get(name);
  return tool !== undefined && !tool.readOnly;
}

export const BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOLS.map((t) => t.name);
