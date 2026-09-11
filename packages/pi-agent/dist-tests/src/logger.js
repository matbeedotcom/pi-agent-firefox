/**
 * stderr-only diagnostics logger (PRODUCT.md §43).
 *
 * `stdout` belongs exclusively to the Firefox Native Messaging protocol.
 * Everything the host wants to log goes to stderr (which Firefox forwards
 * to browser debugging output). Optionally mirrors to a log file.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(options = {}) {
    const level = options.level ?? (envLevel() ?? "info");
    const stderr = options.stderr ?? process.stderr;
    let logFile;
    if (options.filePath) {
        try {
            mkdirSync(dirname(options.filePath), { recursive: true });
            logFile = createWriteStream(options.filePath, { flags: "a" });
        }
        catch {
            // Logging file is best-effort; never break the host over it.
            logFile = undefined;
        }
    }
    function emit(lvl, msg, data) {
        if (LEVEL_RANK[lvl] < LEVEL_RANK[level])
            return;
        const line = `[${new Date().toISOString()}] [${lvl}] [pi-browser-host] ${msg}` +
            (data !== undefined ? ` ${safeStringify(data)}` : "");
        stderr.write(line + "\n");
        logFile?.write(line + "\n");
    }
    return {
        debug: (m, d) => emit("debug", m, d),
        info: (m, d) => emit("info", m, d),
        warn: (m, d) => emit("warn", m, d),
        error: (m, d) => emit("error", m, d),
    };
}
function envLevel() {
    const v = (process.env.PI_BROWSER_LOG_LEVEL ?? "").toLowerCase();
    return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : undefined;
}
function safeStringify(data) {
    try {
        if (data instanceof Error)
            return `${data.name}: ${data.message}`;
        return JSON.stringify(data);
    }
    catch {
        return String(data);
    }
}
//# sourceMappingURL=logger.js.map