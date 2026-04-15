/**
 * Structured logger for agent-core.
 *
 * 用法:
 *   import { createLogger } from "./logger.js";
 *   const log = createLogger("http");
 *   log.info("request", { method: "POST", path: "/runs" });
 *   log.error("handler failed", { error: err.message });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

let globalMinLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  globalMinLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalMinLevel;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  function emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalMinLevel]) return;

    const ts = new Date().toISOString();
    const label = LEVEL_LABEL[level];
    const prefix = `${ts} [${label}] [${module}]`;

    if (data && Object.keys(data).length > 0) {
      const pairs = Object.entries(data)
        .map(([k, v]) => {
          if (v === undefined) return "";
          const str = typeof v === "string" ? v : JSON.stringify(v);
          return `${k}=${str}`;
        })
        .filter(Boolean)
        .join(" ");
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`${prefix} ${message} ${pairs}`);
    } else {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`${prefix} ${message}`);
    }
  }

  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}
