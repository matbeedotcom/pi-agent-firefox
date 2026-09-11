/**
 * TypeBox parameter schemas for the browser tools.
 *
 * These MUST stay in sync with the JSON Schemas in
 * @pi-browser/protocol (browser-tools.ts) — the JSON is what the Firefox
 * side serves over MCP, the TypeBox schemas are what Pi validates against.
 * test/tool-schemas.test.ts enforces the sync.
 */
import { Type } from "typebox";
import { BROWSER_TOOLS, CONTROL_TOOLS } from "@pi-browser/protocol";
const empty = () => Type.Object({}, { additionalProperties: false });
const SCHEMAS = {
    browser_get_page: empty(),
    browser_get_selection: empty(),
    browser_get_dom: Type.Object({
        maxElements: Type.Optional(Type.Number({
            description: "Maximum number of elements to return (default 400, hard cap 2000).",
        })),
    }, { additionalProperties: false }),
    browser_screenshot: Type.Object({
        format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], {
            description: "Image format (default png).",
        })),
        quality: Type.Optional(Type.Number({ description: "JPEG quality 1-100 (jpeg only, default 80)." })),
    }, { additionalProperties: false }),
    browser_reload: empty(),
    browser_click: Type.Object({
        ref: Type.String({ description: "Element reference, e.g. el-183 (from browser_get_dom)." }),
    }, { additionalProperties: false, required: ["ref"] }),
    browser_type: Type.Object({
        ref: Type.String({ description: "Element reference, e.g. el-183 (from browser_get_dom)." }),
        text: Type.String({ description: "Text to type." }),
        submit: Type.Optional(Type.Boolean({ description: "Submit the element's form after typing (default false)." })),
    }, { additionalProperties: false, required: ["ref", "text"] }),
    browser_wait_for: Type.Object({
        selector: Type.String({ description: "CSS selector to wait for." }),
        state: Type.Optional(Type.Union([Type.Literal("visible"), Type.Literal("hidden")], {
            description: "Wait until the element is visible (default) or hidden.",
        })),
        timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait in milliseconds (default 10000, max 60000)." })),
    }, { additionalProperties: false, required: ["selector"] }),
};
/** One entry per protocol browser tool, with its TypeBox parameter schema. */
export const BROWSER_TOOL_SCHEMAS = BROWSER_TOOLS.map((def) => {
    const parameters = SCHEMAS[def.name];
    if (!parameters)
        throw new Error(`missing TypeBox schema for tool ${def.name}`);
    return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});
// ---------------------------------------------------------------------------
// Control tools (pi_*)
// ---------------------------------------------------------------------------
const sessionId = Type.String({ description: "ACP session id (e.g. from pi_get_state)." });
const CONTROL_SCHEMAS = {
    pi_get_state: empty(),
    pi_new_session: Type.Object({
        cwd: Type.String({ description: "Working directory for the new session (absolute path)." }),
    }, { additionalProperties: false, required: ["cwd"] }),
    pi_select_session: Type.Object({ sessionId }, { additionalProperties: false, required: ["sessionId"] }),
    pi_prompt: Type.Object({
        sessionId,
        text: Type.String({ description: "Prompt text." }),
    }, { additionalProperties: false, required: ["sessionId", "text"] }),
    pi_cancel: Type.Object({ sessionId }, { additionalProperties: false, required: ["sessionId"] }),
    pi_close_session: Type.Object({ sessionId }, { additionalProperties: false, required: ["sessionId"] }),
    pi_set_config_option: Type.Object({
        sessionId,
        configId: Type.String({ description: "Config option id, e.g. \"model\" or \"thinking\"." }),
        value: Type.Union([Type.String(), Type.Boolean()], {
            description: "Value id (string) or flag (boolean) for the option.",
        }),
    }, { additionalProperties: false, required: ["sessionId", "configId", "value"] }),
    pi_bind_current_tab: Type.Object({ sessionId }, { additionalProperties: false, required: ["sessionId"] }),
    pi_unbind_tab: Type.Object({ sessionId }, { additionalProperties: false, required: ["sessionId"] }),
    pi_open_bound_tab: Type.Object({ sessionId }, { additionalProperties: false, required: ["sessionId"] }),
};
/** One entry per protocol control tool, with its TypeBox parameter schema. */
export const CONTROL_TOOL_SCHEMAS = CONTROL_TOOLS.map((def) => {
    const parameters = CONTROL_SCHEMAS[def.name];
    if (!parameters)
        throw new Error(`missing TypeBox schema for tool ${def.name}`);
    return { name: def.name, description: def.description, parameters, readOnly: def.readOnly };
});
//# sourceMappingURL=schemas.js.map