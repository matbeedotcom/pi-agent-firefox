/**
 * MCP-compatible Pi session control tool definitions (PRODUCT.md §26, Phase 5).
 *
 * Complement to BROWSER_TOOLS: browser tools operate the session's bound
 * tab, control tools operate the add-on's Pi session surface (lifecycle,
 * tab binding, state). Like browser tools they are:
 *
 *   - served by the Firefox add-on through its MCP server on the
 *     ACP channel (same tools/list + tools/call surface),
 *   - invoked only by the Pi agent through the native host — a web page
 *     can never call them (§49 invariant 4),
 *   - transport-independent: identical names, arguments, and results on
 *     every BrowserToolTransport.
 *
 * Every argument carries an explicit sessionId (or targets the bound tab
 * of one); there is never a silent fallback to another session or tab
 * (§49 invariant 5).
 */

export interface ControlToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible) for the tool arguments. */
  inputSchema: Record<string, unknown>;
  /** Read-only tools only report state; mutating tools change sessions/binding. */
  readOnly: boolean;
}

const OBJECT_SCHEMA_BASE = {
  type: "object" as const,
  additionalProperties: false,
};

const SESSION_ID = {
  type: "string",
  description: "ACP session id (e.g. from pi_get_state).",
};

export const CONTROL_TOOLS: readonly ControlToolDef[] = [
  {
    name: "pi_get_state",
    description:
      "Get the state of the Pi Browser integration: connection status, the known Pi sessions " +
      "(id, title, cwd, streaming flag, config options, bound tab) and the currently active session.",
    inputSchema: { ...OBJECT_SCHEMA_BASE, properties: {} },
    readOnly: true,
  },
  {
    name: "pi_new_session",
    description:
      "Create a new Pi session (ACP session/new) with the given working directory. " +
      "Returns the new session id. The session immediately has the browser tools available " +
      "once a tab is bound to it.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        cwd: { type: "string", description: "Working directory for the new session (absolute path)." },
      },
      required: ["cwd"],
    },
    readOnly: false,
  },
  {
    name: "pi_select_session",
    description:
      "Make a Pi session the active one in the Firefox sidebar. Loads (or re-resumes) its " +
      "transcript on the host. Use before prompting a session that is not currently active.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    readOnly: false,
  },
  {
    name: "pi_prompt",
    description:
      "Send a prompt to a Pi session (ACP session/prompt). Returns immediately with " +
      "{accepted: true}; the turn then streams via session updates. Poll pi_get_state " +
      "(streaming flag) or wait for the turn to finish.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        sessionId: SESSION_ID,
        text: { type: "string", description: "Prompt text." },
      },
      required: ["sessionId", "text"],
    },
    readOnly: false,
  },
  {
    name: "pi_cancel",
    description: "Cancel the currently streaming turn of a Pi session (ACP session/cancel).",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    readOnly: false,
  },
  {
    name: "pi_close_session",
    description: "Close a Pi session on the host (ACP session/close). It can be resumed later.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    readOnly: false,
  },
  {
    name: "pi_set_config_option",
    description:
      "Set a session config option (ACP session/set_config_option), e.g. configId \"model\" or " +
      "\"thinking\" with a value id reported by pi_get_state.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        sessionId: SESSION_ID,
        configId: { type: "string", description: "Config option id, e.g. \"model\" or \"thinking\"." },
        value: {
          anyOf: [{ type: "string" }, { type: "boolean" }],
          description: "Value id (string) or flag (boolean) for the option.",
        },
      },
      required: ["sessionId", "configId", "value"],
    },
    readOnly: false,
  },
  {
    name: "pi_bind_current_tab",
    description:
      "Bind the currently active Firefox tab to a Pi session. After this, the session's " +
      "browser tools (browser_get_page, browser_click, ...) operate on that tab only.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    readOnly: false,
  },
  {
    name: "pi_bind_tab",
    description:
      "Bind an existing Firefox tab to a Pi session: the session's browser tools (browser_get_page, " +
      "browser_click, ...) operate on that tab. The tab id comes from pi_list_tabs. Replaces the " +
      "session's current binding and releases the tab from any other session bound to it.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        sessionId: SESSION_ID,
        tabId: { type: "number", description: "Firefox tab id (from pi_list_tabs)." },
      },
      required: ["sessionId", "tabId"],
    },
    readOnly: false,
  },
  {
    name: "pi_open_tab",
    description:
      "Open a new browser tab at the given URL and bind the session to it — works even when the " +
      "session has no bound tab. The new tab is owned by the session and closed automatically when " +
      "the session unbinds; the previously bound tab (if any) stays open and is restored when the " +
      "new tab is closed. Returns {tabId, url}.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: {
        sessionId: SESSION_ID,
        url: { type: "string", description: 'URL for the new tab, e.g. "https://example.com".' },
      },
      required: ["sessionId", "url"],
    },
    readOnly: false,
  },
  {
    name: "pi_list_tabs",
    description:
      "List all open Firefox tabs: {tabs: [{id, url, title, bound}]} — bound marks the session's " +
      "current tab. Use with pi_bind_tab to bind a specific tab. Works without a bound tab " +
      "(unlike browser_list_tabs).",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    readOnly: true,
  },
  {
    name: "pi_unbind_tab",
    description: "Remove the tab binding of a Pi session; its browser tools fail until re-bound.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    readOnly: false,
  },
  {
    name: "pi_open_bound_tab",
    description:
      "Activate the tab bound to a Pi session (focus its window and make the tab visible). " +
      "Use before browser_screenshot, which can only capture the visible tab.",
    inputSchema: {
      ...OBJECT_SCHEMA_BASE,
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    readOnly: false,
  },
];

const TOOL_BY_NAME = new Map(CONTROL_TOOLS.map((t) => [t.name, t]));

export function getControlTool(name: string): ControlToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

export function isControlTool(name: string): boolean {
  return TOOL_BY_NAME.has(name);
}

export function isMutatingControlTool(name: string): boolean {
  const tool = TOOL_BY_NAME.get(name);
  return tool !== undefined && !tool.readOnly;
}

export const CONTROL_TOOL_NAMES: readonly string[] = CONTROL_TOOLS.map((t) => t.name);
