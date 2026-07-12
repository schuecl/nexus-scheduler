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

  // Local-account fallback (break-glass path, §4) is enabled/disabled by
  // whether this is set — no separate boolean flag to drift out of sync.
  LOCAL_AUTH_ENABLED: z.coerce.boolean().default(true),

  // Symmetric key used to encrypt LibreChat API keys at rest (§4).
  // In production this comes from a K8s Secret, never a default value.
  API_KEY_ENCRYPTION_KEY: z.string().min(32),

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
