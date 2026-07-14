import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Optional defense-in-depth on top of NetworkPolicy (this service's
  // primary access control) — when set, only requests carrying the same
  // value in X-Internal-Auth are served. Left unset, the service behaves
  // exactly as before; API/Worker only send the header when they're
  // configured with the same value (see their own PDF_SERVICE_SHARED_SECRET).
  PDF_SERVICE_SHARED_SECRET: z.string().optional(),
});

export type PdfServiceConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PdfServiceConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
