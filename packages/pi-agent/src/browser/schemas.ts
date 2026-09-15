/**
 * TypeBox parameter schemas for the browser tools.
 *
 * These MUST stay in sync with the JSON Schemas in
 * @pi-browser/protocol (browser-tools.ts) — the JSON is what the Firefox
 * side serves over MCP, the TypeBox schemas are what Pi validates against.
 * test/tool-schemas.test.ts enforces the sync.
 */
import { Type, type TSchema } from "typebox";
import { BROWSER_FRAME_DESCRIPTION, BROWSER_TOOLS, CONTROL_TOOLS, REPL_TOOLS } from "@pi-browser/protocol";

const empty = () => Type.Object({}, { additionalProperties: false });

/**
 * Shared `frame` parameter for the content-frame tools. MUST stay in sync
 * with FRAME_PROPERTY in @pi-browser/protocol (enforced by
 * test/tool-schemas.test.ts — the description is imported, not duplicated).
 */
const frame = () => Type.Union([Type.Number(), Type.String()], { description: BROWSER_FRAME_DESCRIPTION });

const SCHEMAS: Record<string, TSchema> = {
  browser_get_page: empty(),

  browser_get_selection: Type.Object(
    {
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false },
  ),

  browser_get_dom: Type.Object(
    {
      maxElements: Type.Optional(Type.Number({
        description: "Maximum number of elements to return (default 600, hard cap 2000).",
      })),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false },
  ),

  browser_screenshot: Type.Object(
    {
      format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], {
        description: "Image format (default png).",
      })),
      quality: Type.Optional(Type.Number({ description: "JPEG quality 1-100 (jpeg only, default 80)." })),
    },
    { additionalProperties: false },
  ),

  browser_reload: empty(),

  browser_click: Type.Object(
    {
      ref: Type.String({ description: "Element reference, e.g. el-183 (from browser_get_dom)." }),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["ref"] },
  ),

  browser_type: Type.Object(
    {
      ref: Type.String({ description: "Element reference, e.g. el-183 (from browser_get_dom)." }),
      text: Type.String({ description: "Text to type." }),
      submit: Type.Optional(Type.Boolean({ description: "Submit the element's form after typing (default false)." })),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["ref", "text"] },
  ),

  browser_wait_for: Type.Object(
    {
      selector: Type.String({ description: "CSS selector to wait for." }),
      state: Type.Optional(Type.Union([Type.Literal("visible"), Type.Literal("hidden")], {
        description: "Wait until the element is visible (default) or hidden.",
      })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait in milliseconds (default 10000, max 60000)." })),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["selector"] },
  ),

  browser_evaluate: Type.Object(
    {
      expression: Type.String({
        description: "JavaScript expression or function, e.g. \"document.title\" or \"(sel) => document.querySelector(sel)?.value\".",
      }),
      arg: Type.Optional(Type.Any({
        description: "Optional JSON value passed as the single argument when the expression is a function.",
      })),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["expression"] },
  ),

  browser_get_accessibility_tree: Type.Object(
    {
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("nodes")], {
        description:
          '\"text\" (default) = the indented outline; \"nodes\" = structured node objects with refs and rects.',
      })),
      maxNodes: Type.Optional(Type.Number({
        description: "Maximum outline nodes to return (default 300, hard cap 2000).",
      })),
      maxDepth: Type.Optional(Type.Number({
        description: "Maximum outline depth (default 16, hard cap 40).",
      })),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false },
  ),

  browser_get_console: Type.Object(
    {
      level: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("error"),
        Type.Literal("warn"),
        Type.Literal("log"),
        Type.Literal("info"),
        Type.Literal("debug"),
      ], {
        description: 'Only messages at this level (default "all"); "error" includes window errors and unhandled rejections.',
      })),
      limit: Type.Optional(Type.Number({ description: "Maximum messages to return, newest first (default 50, max 200)." })),
      since: Type.Optional(Type.Number({ description: "Only messages captured at or after this Unix timestamp (ms)." })),
      clear: Type.Optional(Type.Boolean({ description: "Clear the captured buffer after reading (default false)." })),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false },
  ),

  browser_get_network: Type.Object(
    {
      filter: Type.Optional(Type.String({ description: "Only requests whose URL contains this substring (case-insensitive)." })),
      method: Type.Optional(Type.String({ description: 'Only requests with this HTTP method, e.g. "POST".' })),
      errorsOnly: Type.Optional(Type.Boolean({
        description: "Only failed requests or responses with status >= 400 (default false).",
      })),
      limit: Type.Optional(Type.Number({ description: "Maximum requests to return, newest first (default 50, max 200)." })),
    },
    { additionalProperties: false },
  ),

  browser_element_at: Type.Object(
    {
      x: Type.Number({ description: "X coordinate in CSS pixels from the viewport's left edge." }),
      y: Type.Number({ description: "Y coordinate in CSS pixels from the viewport's top edge." }),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["x", "y"] },
  ),

  browser_navigate: Type.Object(
    {
      url: Type.String({ description: 'Absolute URL to navigate to, e.g. "http://localhost:5173/login".' }),
    },
    { additionalProperties: false, required: ["url"] },
  ),

  browser_download: Type.Object(
    {
      url: Type.String({
        description: 'Absolute http(s) URL to download, e.g. the src of an image on the current page.',
      }),
      maxBytes: Type.Optional(Type.Number({
        description:
          "Maximum bytes to download (default 10485760, cap 52428800). Larger files are rejected, not truncated.",
      })),
    },
    { additionalProperties: false, required: ["url"] },
  ),

  browser_click_at: Type.Object(
    {
      x: Type.Number({ description: "X coordinate in CSS pixels from the viewport's left edge." }),
      y: Type.Number({ description: "Y coordinate in CSS pixels from the viewport's top edge." }),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["x", "y"] },
  ),

  browser_focus: Type.Object(
    {
      ref: Type.String({ description: "Element reference, e.g. el-183." }),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["ref"] },
  ),

  browser_scroll: Type.Object(
    {
      ref: Type.String({ description: "Element reference, e.g. el-183." }),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["ref"] },
  ),

  browser_type_focused: Type.Object(
    {
      text: Type.String({ description: "Text to type into the focused element." }),
      frame: Type.Optional(frame()),
    },
    { additionalProperties: false, required: ["text"] },
  ),

  browser_open_tab: Type.Object(
    {
      url: Type.String({ description: 'URL for the new tab (default about:blank), e.g. "https://example.com".' }),
    },
    { additionalProperties: false, required: ["url"] },
  ),

  browser_close_tab: Type.Object(
    {
      tabId: Type.Number({ description: "Firefox tab id (from browser_list_tabs / browser_open_tab)." }),
    },
    { additionalProperties: false, required: ["tabId"] },
  ),

  browser_list_tabs: empty(),
};

export interface BrowserToolSchema {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
}

/** One entry per protocol browser tool, with its TypeBox parameter schema. */
export const BROWSER_TOOL_SCHEMAS: readonly BrowserToolSchema[] = BROWSER_TOOLS.map((def) => {
  const parameters = SCHEMAS[def.name];
  if (!parameters) throw new Error(`missing TypeBox schema for tool ${def.name}`);
  return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});

// ---------------------------------------------------------------------------
// Host-side REPL tools (executed by the native host, never the add-on)
// ---------------------------------------------------------------------------

const REPL_SCHEMAS: Record<string, TSchema> = {
  javascript: Type.Object(
    {
      code: Type.String({
        description:
          "JavaScript to run as one REPL cell. Top-level await allowed. Example: " +
          "`const s = await page.snapshot(); await page.click(s.nodes.find(n => n.name === 'Go').ref)`",
      }),
      timeoutMs: Type.Optional(Type.Number({
        description: "Kill the cell after this many milliseconds (default 30000, max 120000).",
      })),
    },
    { additionalProperties: false, required: ["code"] },
  ),
};

/** One entry per protocol REPL tool, with its TypeBox parameter schema. */
export const REPL_TOOL_SCHEMAS: readonly BrowserToolSchema[] = REPL_TOOLS.map((def) => {
  const parameters = REPL_SCHEMAS[def.name];
  if (!parameters) throw new Error(`missing TypeBox schema for repl tool ${def.name}`);
  return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});

// ---------------------------------------------------------------------------
// Control tools (pi_*)
// ---------------------------------------------------------------------------

const sessionId = Type.String({ description: "ACP session id (e.g. from pi_get_state)." });

const CONTROL_SCHEMAS: Record<string, TSchema> = {
  pi_get_state: empty(),

  pi_new_session: Type.Object(
    {
      cwd: Type.String({ description: "Working directory for the new session (absolute path)." }),
    },
    { additionalProperties: false, required: ["cwd"] },
  ),

  pi_select_session: Type.Object(
    { sessionId },
    { additionalProperties: false, required: ["sessionId"] },
  ),

  pi_prompt: Type.Object(
    {
      sessionId,
      text: Type.String({ description: "Prompt text." }),
    },
    { additionalProperties: false, required: ["sessionId", "text"] },
  ),

  pi_cancel: Type.Object(
    { sessionId },
    { additionalProperties: false, required: ["sessionId"] },
  ),

  pi_close_session: Type.Object(
    { sessionId },
    { additionalProperties: false, required: ["sessionId"] },
  ),

  pi_set_config_option: Type.Object(
    {
      sessionId,
      configId: Type.String({ description: "Config option id, e.g. \"model\" or \"thinking\"." }),
      value: Type.Union([Type.String(), Type.Boolean()], {
        description: "Value id (string) or flag (boolean) for the option.",
      }),
    },
    { additionalProperties: false, required: ["sessionId", "configId", "value"] },
  ),

  pi_bind_current_tab: Type.Object(
    { sessionId },
    { additionalProperties: false, required: ["sessionId"] },
  ),

  pi_unbind_tab: Type.Object(
    { sessionId },
    { additionalProperties: false, required: ["sessionId"] },
  ),

  pi_open_bound_tab: Type.Object(
    { sessionId },
    { additionalProperties: false, required: ["sessionId"] },
  ),
};

/** One entry per protocol control tool, with its TypeBox parameter schema. */
export const CONTROL_TOOL_SCHEMAS: readonly BrowserToolSchema[] = CONTROL_TOOLS.map((def) => {
  const parameters = CONTROL_SCHEMAS[def.name];
  if (!parameters) throw new Error(`missing TypeBox schema for tool ${def.name}`);
  return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});
