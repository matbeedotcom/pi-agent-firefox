/**
 * stderr-only diagnostics logger (PRODUCT.md §43).
 *
 * `stdout` belongs exclusively to the Firefox Native Messaging protocol.
 * Everything the host wants to log goes to stderr (which Firefox forwards
 * to browser debugging output). Optionally mirrors to a log file.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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
  stderr?: { write(s: string): boolean };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (envLevel() ?? "info");
  const stderr = options.stderr ?? process.stderr;
  let logFile: import("node:fs").WriteStream | undefined;
  if (options.filePath) {
    try {
      mkdirSync(dirname(options.filePath), { recursive: true });
      logFile = createWriteStream(options.filePath, { flags: "a" });
    } catch {
      // Logging file is best-effort; never break the host over it.
      logFile = undefined;
    }
  }

  function emit(lvl: LogLevel, msg: string, data?: unknown): void {
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
    const line =
      `[${new Date().toISOString()}] [${lvl}] [pi-browser-host] ${msg}` +
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

function envLevel(): LogLevel | undefined {
  const v = (process.env.PI_BROWSER_LOG_LEVEL ?? "").toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : undefined;
}

function safeStringify(data: unknown): string {
  try {
    if (data instanceof Error) return `${data.name}: ${data.message}`;
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
