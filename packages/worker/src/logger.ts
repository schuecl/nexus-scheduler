import pino from "pino";
import type { WorkerConfig } from "./config.js";

export function createLogger(config: WorkerConfig) {
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
