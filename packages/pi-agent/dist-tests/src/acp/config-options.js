export const CONFIG_ID_MODEL = "model";
export const CONFIG_ID_THINKING = "thinking";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function buildConfigOptions(opts) {
    const options = [];
    options.push({
        id: CONFIG_ID_MODEL,
        name: "Model",
        description: "LLM model for this session",
        category: "model",
        type: "select",
        currentValue: opts.currentModel ?? "",
        options: opts.models.map((m) => ({ value: m.valueId, name: m.name })),
    });
    options.push({
        id: CONFIG_ID_THINKING,
        name: "Reasoning",
        description: "Reasoning effort for this session",
        category: "thought_level",
        type: "select",
        currentValue: opts.currentThinking,
        options: THINKING_LEVELS.map((level) => ({ value: level, name: level })),
    });
    return options;
}
//# sourceMappingURL=config-options.js.map