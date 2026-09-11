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
export declare const CONTROL_TOOLS: readonly ControlToolDef[];
export declare function getControlTool(name: string): ControlToolDef | undefined;
export declare function isControlTool(name: string): boolean;
export declare function isMutatingControlTool(name: string): boolean;
export declare const CONTROL_TOOL_NAMES: readonly string[];
//# sourceMappingURL=control-tools.d.ts.map