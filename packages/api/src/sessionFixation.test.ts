import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import RedisStore from "connect-redis";
import { sign, unsign } from "cookie-signature";
import bcrypt from "bcryptjs";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { AppConfig } from "./config.js";
import { prisma } from "./db.js";

// Regression test for the session-fixation fix (§12/§45): a session id
// established *before* login must not survive into the authenticated
// state. Doing this faithfully means manufacturing a real, validly
// signed, store-backed (if still anonymous) session first — not just an
// arbitrary client-chosen cookie value, which express-session would
// already refuse to adopt regardless of whether regenerateSession() is
// called at all. That's why this gets its own file: it talks to the
// session store (connect-redis) and signs cookies by hand
// (cookie-signature, the same library express-session uses internally),
// rather than only driving the app through supertest like authz.test.ts.
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.API_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  SESSION_SECRET: "fixation-test-session-secret-at-least-32-chars",
  APP_BASE_URL: undefined,
  OIDC_ISSUER_URL: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_REDIRECT_URI: undefined,
  LOCAL_AUTH_ENABLED: true,
  BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
  API_KEY_ENCRYPTION_KEY: "fixation-test-encryption-key-32-chars!!",
  LIBRECHAT_BASE_URL: undefined,
  PDF_SERVICE_URL: "http://placeholder.invalid",
  PDF_SERVICE_SHARED_SECRET: undefined,
  LOG_LEVEL: "error",
};

const PASSWORD = "correct horse battery staple";

function extractSidFromSetCookie(setCookie: string[] | undefined): string {
  const raw = setCookie?.find((c) => c.startsWith("connect.sid="));
  if (!raw) throw new Error("no connect.sid cookie in response");
  const cookiePair = raw.split(";")[0]!;
  const encodedValue = cookiePair.slice(cookiePair.indexOf("=") + 1);
  const value = decodeURIComponent(encodedValue);
  if (!value.startsWith("s:")) throw new Error(`expected a signed cookie, got: ${value}`);
  const sid = unsign(value.slice(2), config.SESSION_SECRET);
  if (sid === false) throw new Error("cookie signature did not verify against the app's SESSION_SECRET");
  return sid;
}

describe("session fixation protection (§12/§45)", () => {
  let app: Express;
  let redisClient: Redis;
  let runsQueue: Queue;
  let store: RedisStore;

  beforeAll(() => {
    app = createApp(config, createLogger(config));
    redisClient = app.get("redisClient");
    runsQueue = app.get("runsQueue");
    store = new RedisStore({ client: redisClient, prefix: "nexus-sess:" });
  });

  beforeEach(async () => {
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.user.deleteMany({});
    await runsQueue.close();
    await redisClient.quit();
    await prisma.$disconnect();
  });

  it("regenerates the session id on successful login and destroys the pre-existing session", async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await prisma.user.create({
      data: {
        email: "fixation-victim@example.test",
        authSource: "LOCAL",
        role: "EDITOR",
        active: true,
        passwordHash,
      },
    });

    // A real, server-recognized (but still-anonymous) session — stands in
    // for one an attacker fixed on the victim's browser before login
    // (e.g. cookie injection on a shared subdomain).
    const fixedSid = "attacker-fixed-session-id-0123456789";
    await new Promise<void>((resolve, reject) => {
      store.set(fixedSid, { cookie: {} } as never, (err) => (err ? reject(err) : resolve()));
    });
    const signedCookieValue = `s:${sign(fixedSid, config.SESSION_SECRET)}`;

    const res = await request(app)
      .post("/auth/local-login")
      .set("Cookie", `connect.sid=${encodeURIComponent(signedCookieValue)}`)
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    const newSid = extractSidFromSetCookie(res.headers["set-cookie"] as string[] | undefined);

    // The post-login session id must differ from the one fixed before
    // login — reusing it would let whoever fixed it hijack the now-
    // authenticated session.
    expect(newSid).not.toBe(fixedSid);

    // And the fixed session itself must be gone from the store, not just
    // superseded — otherwise an attacker who also captured the *new*
    // cookie some other way could still find the old one still "live".
    const oldSessionStillExists = await new Promise<boolean>((resolve, reject) => {
      store.get(fixedSid, (err, data) => {
        if (err) reject(err);
        else resolve(data != null);
      });
    });
    expect(oldSessionStillExists).toBe(false);
  });
});
