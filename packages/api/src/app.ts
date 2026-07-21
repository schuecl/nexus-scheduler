import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import session from "express-session";
import RedisStore from "connect-redis";
import { Redis } from "ioredis";
import { pinoHttp } from "pino-http";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { createHealthRouter } from "./routes/health.js";
import { createJobsRouter, createProjectJobsRouter } from "./routes/jobs.js";
import { createAuthRouter } from "./routes/auth.js";
import { createTeamsRouter } from "./routes/teams.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createUsersRouter } from "./routes/users.js";
import { createClassificationLabelsRouter } from "./routes/classificationLabels.js";
import { createProjectPromptsRouter, createPromptsRouter } from "./routes/prompts.js";
import { createApiKeysRouter } from "./routes/apiKeys.js";
import { createJobSchedulesRouter, createSchedulesRouter } from "./routes/schedules.js";
import { createJobRunsRouter, createRunsRouter } from "./routes/runs.js";
import { createJobAttachmentsRouter } from "./routes/attachments.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createWebhookDestinationsRouter } from "./routes/webhookDestinations.js";
import { createMailingListsRouter } from "./routes/mailingLists.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createCostRatesRouter } from "./routes/costRates.js";
import { createAdminReportsRouter } from "./routes/adminReports.js";
import { createSystemStatusRouter } from "./routes/systemStatus.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createRunsQueue } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";
import { createMetrics, metricsMiddleware } from "./metrics.js";

export function createApp(config: AppConfig, logger: Logger): Express {
  const app = express();
  const redisClient = new Redis(config.REDIS_URL);
  const runsQueue = createRunsQueue(parseRedisConnectionOptions(config.REDIS_URL));
  const metrics = createMetrics();

  // Exposed via app-locals so a caller that boots the app directly
  // without app.listen() (integration tests via supertest) can close
  // these real Redis/BullMQ connections in teardown — createApp() has
  // no shutdown hook of its own, since index.ts's only caller never
  // needs one (process exit closes them for free).
  app.set("redisClient", redisClient);
  app.set("runsQueue", runsQueue);

  // This app always sits behind exactly one reverse proxy (nginx —
  // docker-compose's own instance locally, the target environment's
  // pre-existing one in production; REQUIREMENTS §9.1) which terminates
  // TLS, so Express itself only ever sees plain HTTP. Without this,
  // req.secure is always false, and with cookie.secure: true below
  // (production), express-session silently refuses to persist the
  // session cookie at all — login appears to succeed but every
  // subsequent request 401s, since the browser never received a cookie
  // to send back. `1` = trust exactly one hop's X-Forwarded-* headers.
  app.set("trust proxy", 1);

  // Security headers baseline — REQUIREMENTS.md §10 (OWASP hardening).
  app.use(helmet());
  app.use(cors({ origin: false })); // same-origin via nginx in production; adjust for local dev if needed
  // Attachment uploads are base64 JSON: a 15MB file is ~20MB encoded,
  // which the global 1mb parser would reject before the route's own
  // size checks ever ran. The attachments route brings its own 21mb
  // parser — but AFTER its auth/access middleware, so an unauthenticated
  // request never gets a 21MB body buffered. The global parser must
  // therefore skip that path (express.json parses a body only once, so
  // whichever runs first wins).
  const jsonParser = express.json({ limit: "1mb" });
  const attachmentsPath = /^\/api\/jobs\/[^/]+\/attachments\/?$/;
  app.use((req, res, next) => (attachmentsPath.test(req.path) ? next() : jsonParser(req, res, next)));
  app.use(
    pinoHttp({
      logger,
      // Default genReqId is only unique within one process (a plain
      // incrementing counter) — not useful as a cross-request/service
      // correlation id. Honor an inbound X-Request-Id from the reverse
      // proxy/ingress when present so a request can be traced across
      // hops, otherwise mint a real UUID (§41); recordAuditEvent reads
      // this back off req.id to populate the audit event's requestId.
      genReqId: (req, res) => {
        const inbound = req.headers["x-request-id"];
        const id = typeof inbound === "string" && inbound ? inbound : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
    }),
  );
  app.use(metricsMiddleware(metrics));

  app.use(
    session({
      store: new RedisStore({ client: redisClient, prefix: "nexus-sess:" }),
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      // Explicit rather than relying solely on the "trust proxy" app
      // setting above — makes express-session's own secure-cookie
      // decision independent of any future change to that setting.
      proxy: true,
      cookie: {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "lax",
        // TODO(§4): finalize idle-timeout/absolute-session-lifetime values
        // (NIST 800-53 AC-11-style controls) and apply them here.
        maxAge: 1000 * 60 * 60 * 8,
      },
    }),
  );

  // Liveness/readiness/metrics are unauthenticated by design (cluster probes/scrape).
  app.use(createHealthRouter(metrics));
  app.use("/auth", createAuthRouter(config, logger));
  app.use("/api/teams", createTeamsRouter());
  app.use("/api/projects", createProjectsRouter());
  app.use("/api/projects/:projectId/prompts", createProjectPromptsRouter());
  app.use("/api/projects/:projectId/jobs", createProjectJobsRouter());
  app.use("/api/prompts", createPromptsRouter());
  app.use("/api/jobs/:jobId/schedules", createJobSchedulesRouter());
  app.use("/api/jobs/:jobId/runs", createJobRunsRouter(runsQueue));
  app.use("/api/jobs/:jobId/attachments", createJobAttachmentsRouter());
  app.use("/api/jobs", createJobsRouter());
  app.use("/api/schedules", createSchedulesRouter());
  app.use("/api/runs", createRunsRouter(config, redisClient));
  app.use("/api/dashboard", createDashboardRouter());
  app.use("/api/system-status", createSystemStatusRouter(config, redisClient));
  app.use("/api/users", createUsersRouter(config, logger));
  app.use("/api/classification-labels", createClassificationLabelsRouter());
  app.use("/api/api-keys", createApiKeysRouter(config));
  app.use("/api/webhook-destinations", createWebhookDestinationsRouter(config));
  app.use("/api/mailing-lists", createMailingListsRouter());
  app.use("/api/settings", createSettingsRouter(config));
  app.use("/api/cost-rates", createCostRatesRouter());
  app.use("/api/admin", createAdminReportsRouter(config));

  app.use(errorHandler(logger));

  return app;
}
