/**
 * TypeBox parameter schemas for the browser tools.
 *
 * These MUST stay in sync with the JSON Schemas in
 * @pi-browser/protocol (browser-tools.ts) — the JSON is what the Firefox
 * side serves over MCP, the TypeBox schemas are what Pi validates against.
 * test/tool-schemas.test.ts enforces the sync.
 */
import { type TSchema } from "typebox";
export interface BrowserToolSchema {
    name: string;
    description: string;
    parameters: TSchema;
    readOnly: boolean;
}
/** One entry per protocol browser tool, with its TypeBox parameter schema. */
export declare const BROWSER_TOOL_SCHEMAS: readonly BrowserToolSchema[];
//# sourceMappingURL=schemas.d.ts.map