import Pyroscope from "@pyroscope/nodejs";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

// Continuous profiling (issue #185, #103 Phase 2/3). No-op when
// PYROSCOPE_ENABLED is unset — see config.ts for why that's the default.
// tags.service matches the `service` label Alloy already attaches to this
// process's metrics/logs, so a flamegraph lines up with an existing panel.
export function initProfiling(config: AppConfig, logger: Logger) {
  if (!config.PYROSCOPE_ENABLED) return;

  Pyroscope.init({
    appName: "nexus-scheduler-api",
    serverAddress: config.PYROSCOPE_SERVER_ADDRESS,
    tags: { service: "api" },
    wall: { samplingIntervalMicros: Math.round(1_000_000 / config.PYROSCOPE_SAMPLE_RATE_HZ) },
  });
  Pyroscope.start();
  logger.info(
    { serverAddress: config.PYROSCOPE_SERVER_ADDRESS, sampleRateHz: config.PYROSCOPE_SAMPLE_RATE_HZ },
    "continuous profiling enabled",
  );
}
