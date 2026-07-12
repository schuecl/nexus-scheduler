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
import { createJobsRouter } from "./routes/jobs.js";
import { createAuthRouter } from "./routes/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp(config: AppConfig, logger: Logger): Express {
  const app = express();
  const redisClient = new Redis(config.REDIS_URL);

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
  app.use("/api/jobs", createJobsRouter());

  app.use(errorHandler(logger));

  return app;
}
