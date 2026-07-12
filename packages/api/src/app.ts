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
import { createDashboardRouter } from "./routes/dashboard.js";
import { createWebhookDestinationsRouter } from "./routes/webhookDestinations.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createCostRatesRouter } from "./routes/costRates.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createRunsQueue } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";

export function createApp(config: AppConfig, logger: Logger): Express {
  const app = express();
  const redisClient = new Redis(config.REDIS_URL);
  const runsQueue = createRunsQueue(parseRedisConnectionOptions(config.REDIS_URL));

  // Security headers baseline — REQUIREMENTS.md §10 (OWASP hardening).
  app.use(helmet());
  app.use(cors({ origin: false })); // same-origin via nginx in production; adjust for local dev if needed
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  app.use(
    session({
      store: new RedisStore({ client: redisClient, prefix: "nexus-sess:" }),
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
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

  // Liveness/readiness are unauthenticated by design (cluster probes).
  app.use(createHealthRouter());
  app.use("/auth", createAuthRouter(config, logger));
  app.use("/api/teams", createTeamsRouter());
  app.use("/api/projects", createProjectsRouter());
  app.use("/api/projects/:projectId/prompts", createProjectPromptsRouter());
  app.use("/api/projects/:projectId/jobs", createProjectJobsRouter());
  app.use("/api/prompts", createPromptsRouter());
  app.use("/api/jobs/:jobId/schedules", createJobSchedulesRouter());
  app.use("/api/jobs/:jobId/runs", createJobRunsRouter(runsQueue));
  app.use("/api/jobs", createJobsRouter());
  app.use("/api/schedules", createSchedulesRouter());
  app.use("/api/runs", createRunsRouter());
  app.use("/api/dashboard", createDashboardRouter());
  app.use("/api/users", createUsersRouter(config, logger));
  app.use("/api/classification-labels", createClassificationLabelsRouter());
  app.use("/api/api-keys", createApiKeysRouter(config));
  app.use("/api/webhook-destinations", createWebhookDestinationsRouter(config));
  app.use("/api/settings", createSettingsRouter(config));
  app.use("/api/cost-rates", createCostRatesRouter());

  app.use(errorHandler(logger));

  return app;
}
