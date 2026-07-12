import { z } from "zod";

// LibreChat API key entry — REQUIREMENTS.md §2/§4: entered per-user via
// the web UI, or held by a Team for shared/durable schedules (§2.1).
export const createApiKeySchema = z
  .object({
    label: z.string().max(100).optional(),
    key: z.string().min(1), // raw key — encrypted server-side before storage, never echoed back
    expiresAt: z.string().datetime().optional(),
    ownerType: z.enum(["USER", "TEAM"]),
    ownerTeamId: z.string().uuid().optional(), // required when ownerType === "TEAM"
  })
  .refine((v) => v.ownerType !== "TEAM" || !!v.ownerTeamId, {
    message: "ownerTeamId is required when ownerType is TEAM",
    path: ["ownerTeamId"],
  });
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
