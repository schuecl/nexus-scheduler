import pino from "pino";
import type { AppConfig } from "./config.js";

// Structured JSON logs are the source feed for both the Postgres audit
// trail and the RFC 5424 syslog mirror (REQUIREMENTS.md §7.1) — keep the
// shape stable and machine-parseable rather than free-text.
export function createLogger(config: AppConfig) {
  return pino({
    level: config.LOG_LEVEL,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
