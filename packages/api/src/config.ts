import { z } from "zod";

// Fails fast on missing/invalid config instead of surfacing a confusing
// runtime error three layers deep later.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),

  // OIDC / Keycloak — REQUIREMENTS.md §4. CAC/PIV auth happens upstream in
  // Keycloak; this app only ever consumes the resulting OIDC token/claims.
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),

  // Gates *ordinary* local accounts (login, forgot/reset-password,
  // admin-provisioning new ones) — §4. Does NOT gate the built-in
  // BOOTSTRAP_ADMIN_EMAIL account below: that one has to keep working
  // even if an operator turns this off, or there'd be no way back in
  // without DB access, defeating the point of a break-glass account.
  LOCAL_AUTH_ENABLED: z.coerce.boolean().default(true),

  // Built-in break-glass admin account. The env var is the *ongoing*
  // source of truth, not just a one-time seed: its password is
  // re-synced to this value on every startup (same pattern as e.g.
  // Grafana's GF_SECURITY_ADMIN_PASSWORD), so access can always be
  // recovered by changing the env var and restarting, without needing
  // DB access. Optional — if unset, no built-in admin is created/synced,
  // for deployments that intend to rely on OIDC exclusively.
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default("admin@nexus-scheduler.local"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),

  // Symmetric key used to encrypt LibreChat API keys at rest (§4).
  // In production this comes from a K8s Secret, never a default value.
  API_KEY_ENCRYPTION_KEY: z.string().min(32),

  // Same LibreChat instance the Worker calls (§2.1) — used here only
  // for Agent discovery when building a Job (GET /api/api-keys/:id/
  // agents). Optional: discovery is explicitly a best-effort nicety
  // that falls back to hand-typing an agent ID, never a hard
  // dependency for the API to start.
  LIBRECHAT_BASE_URL: z.string().url().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
