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
export declare const BROWSER_TOOLS: readonly BrowserToolDef[];
export declare function getBrowserTool(name: string): BrowserToolDef | undefined;
export declare function isBrowserTool(name: string): boolean;
export declare function isMutatingBrowserTool(name: string): boolean;
export declare const BROWSER_TOOL_NAMES: readonly string[];
//# sourceMappingURL=browser-tools.d.ts.map