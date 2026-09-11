export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
    debug(msg: string, data?: unknown): void;
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
}
export interface LoggerOptions {
    level?: LogLevel;
    /** Optional file to mirror logs to (e.g. ~/.pi/browser/logs/host-<ts>.log). */
    filePath?: string;
    /** Destination for stderr lines; defaults to process.stderr. */
    stderr?: {
        write(s: string): boolean;
    };
}
export declare function createLogger(options?: LoggerOptions): Logger;
//# sourceMappingURL=logger.d.ts.map