import Pyroscope from "@pyroscope/nodejs";
import type { WorkerConfig } from "./config.js";
import type { Logger } from "./logger.js";

// Continuous profiling (issue #185, #103 Phase 2/3). No-op when
// PYROSCOPE_ENABLED is unset — see config.ts for why that's the default.
// tags.service matches the `service` label Alloy already attaches to this
// process's metrics/logs, so a flamegraph lines up with an existing panel.
// This is the process worth profiling: it runs the long agent calls where a
// runaway loop or a memory climb would actually show up in a flamegraph.
export function initProfiling(config: WorkerConfig, logger: Logger) {
  if (!config.PYROSCOPE_ENABLED) return;

  Pyroscope.init({
    appName: "nexus-scheduler-worker",
    serverAddress: config.PYROSCOPE_SERVER_ADDRESS,
    tags: { service: "worker" },
    wall: { samplingIntervalMicros: Math.round(1_000_000 / config.PYROSCOPE_SAMPLE_RATE_HZ) },
  });
  Pyroscope.start();
  logger.info(
    { serverAddress: config.PYROSCOPE_SERVER_ADDRESS, sampleRateHz: config.PYROSCOPE_SAMPLE_RATE_HZ },
    "continuous profiling enabled",
  );
}

export async function stopProfiling(config: WorkerConfig) {
  if (!config.PYROSCOPE_ENABLED) return;
  await Pyroscope.stop();
}
