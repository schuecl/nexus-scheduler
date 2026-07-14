import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { AppConfig } from "./config.js";
import { prisma } from "./db.js";

// Regression test for the auth-endpoint rate limiting fix (§13/§45).
// Gets its own file (and its own freshly created app/limiter state, via
// its own beforeAll) rather than sharing an app instance with
// authz.test.ts/sessionFixation.test.ts — express-rate-limit's default
// in-memory store is keyed by IP and shared across every request that
// hits a rate-limited route on one app instance, so reusing an app
// already exercised by other login-driven tests would make this test's
// exact request count fragile and would risk tripping 429s in those
// other tests too.
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.API_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  SESSION_SECRET: "ratelimit-test-session-secret-at-least-32-chars",
  APP_BASE_URL: undefined,
  OIDC_ISSUER_URL: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_REDIRECT_URI: undefined,
  LOCAL_AUTH_ENABLED: true,
  BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
  API_KEY_ENCRYPTION_KEY: "ratelimit-test-encryption-key-32-chars!!",
  LIBRECHAT_BASE_URL: undefined,
  PDF_SERVICE_URL: "http://placeholder.invalid",
  PDF_SERVICE_SHARED_SECRET: undefined,
  LOG_LEVEL: "error",
};

describe("auth endpoint rate limiting (§13/§45)", () => {
  let app: Express;
  let redisClient: Redis;
  let runsQueue: Queue;

  beforeAll(() => {
    app = createApp(config, createLogger(config));
    redisClient = app.get("redisClient");
    runsQueue = app.get("runsQueue");
  });

  afterAll(async () => {
    await runsQueue.close();
    await redisClient.quit();
    await prisma.$disconnect();
  });

  it(
    "allows up to the configured limit of login attempts and 429s past it",
    async () => {
      // loginRateLimiter's configured limit (packages/api/src/routes/auth.ts) — kept
      // in sync manually since it's not exported; a future change to that
      // constant should update this too.
      const LIMIT = 20;

      const attempt = () =>
        request(app).post("/auth/local-login").send({ email: "nobody@example.test", password: "wrong" });

      for (let i = 0; i < LIMIT; i++) {
        const res = await attempt();
        expect(res.status).toBe(401);
      }

      const res = await attempt();
      expect(res.status).toBe(429);
    },
    // Each failed attempt deliberately costs ~100ms (bcrypt.compare
    // against DUMMY_HASH, a constant-time defense against account
    // enumeration — see auth.ts) — 21 sequential attempts comfortably
    // exceed vitest's default 5s test timeout.
    20_000,
  );
});
