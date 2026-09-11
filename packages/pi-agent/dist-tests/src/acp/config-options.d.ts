/**
 * ACP session configuration options (PRODUCT.md §39).
 *
 * Firefox must not hard-code Pi's model list; the UI is populated from
 * these options. Changes flow through session/set_config_option.
 */
import type { ModelOption } from "./backend.js";
import type { SessionConfigOption } from "@pi-browser/protocol";
export declare const CONFIG_ID_MODEL = "model";
export declare const CONFIG_ID_THINKING = "thinking";
export declare const THINKING_LEVELS: readonly string[];
export declare function buildConfigOptions(opts: {
    models: ModelOption[];
    currentModel: string | undefined;
    currentThinking: string;
}): SessionConfigOption[];
//# sourceMappingURL=config-options.d.ts.map