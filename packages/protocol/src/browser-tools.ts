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
    inputSchema: { ...OBJECT_SCHEMA_BASE, properties: {} },
    readOnly: true,
  },
  {
    name: "browser_get_dom",
    description:
      "Get a compact semantic representation of the page in the bound tab with stable element references (ref). " +
      "References are valid until the page navigates or the DOM changes significantly; after that, call this tool again. " +
      "Use the returned refs with browser_click and browser_type.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        maxElements: {
          type: "number",
          description: "Maximum number of elements to return (default 400, hard cap 2000).",
        },
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
      },
      required: ["selector"],
    },
    readOnly: true,
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
