/**
 * Pi extension: browser tools for in-process sibling sessions.
 *
 * Pi subagent sessions are created inside the broker process (pi-subagents
 * children never get the session-level customTools that ACP sessions get).
 * This extension plugs that gap: when it loads in a process with an active
 * tool bridge (the Pi Browser native-host broker), it registers the same
 * browser tool surface, with execution routed through the provider's
 * standard path — same routing, permission prompts, and activity tracking
 * as the parent session's tools.
 *
 * Loaded explicitly via an agent's `extensions:` list, e.g.:
 *
 *   ---
 *   name: browser
 *   extensions: ["<repo>/packages/pi-agent/extensions/pi-browser-tools.ts"]
 *   tools: ext:pi-browser-tools
 *   ---
 *
 * In a plain Pi session (no broker) the bridge is undefined and the
 * extension registers nothing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBrowserToolBridge } from "../dist/tool-bridge.js";
import { BROWSER_TOOL_SCHEMAS } from "../dist/browser/schemas.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const bridge = getBrowserToolBridge();
    if (!bridge) return; // plain pi session — no broker, nothing to register
    for (const tool of BROWSER_TOOL_SCHEMAS) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (toolCallId, params) => {
          const result = await bridge.call({
            tool: tool.name,
            args: params as Record<string, unknown>,
            toolCallId,
          });
          return {
            content: result.content,
            details: { piBrowser: true, tool: tool.name },
            ...(result.isError ? { isError: true } : {}),
          };
        },
      });
    }
  });
}
