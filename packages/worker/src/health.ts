import { createServer } from "node:http";
import { prisma } from "./db.js";
import type { WorkerConfig } from "./config.js";
import type { Logger } from "./logger.js";

// Minimal liveness/readiness server for the Worker container
// (REQUIREMENTS.md §10/§11) — deliberately dependency-free (no Express)
// since the Worker's job is queue processing, not serving HTTP.
export function startHealthServer(config: WorkerConfig, logger: Logger) {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200).end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/readyz") {
      prisma.$queryRaw`SELECT 1`
        .then(() => res.writeHead(200).end(JSON.stringify({ status: "ready" })))
        .catch(() => res.writeHead(503).end(JSON.stringify({ status: "not ready" })));
      return;
    }
    if (req.url === "/metrics") {
      // TODO: real Prometheus metrics (queue depth, run success/failure
      // rate, LibreChat latency) — see REQUIREMENTS.md §10.
      res.writeHead(200, { "content-type": "text/plain" }).end("# metrics not yet implemented\n");
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(config.HEALTH_PORT, () => {
    logger.info({ port: config.HEALTH_PORT }, "worker health server listening");
  });

  return server;
}
